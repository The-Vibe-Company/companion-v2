"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
import type { LocalSkillRow, SkillFilterPreferences } from "@companion/contracts";
import {
  archiveSkill as archiveSkillRpc,
  fetchArchivedSkills,
  markSkillInstalled,
  markSkillUninstalled,
  restoreSkill as restoreSkillRpc,
  saveSkillFilterPreferences,
  setSkillOwner,
  toggleStar as toggleStarRpc,
} from "@/lib/queries";
import { fetchSettingsAppData } from "@/lib/settingsClient";
import { mapSkill, type MeVM, type OrgVM, type SkillVM, type TeamVM } from "@/lib/types";
import { Sidebar } from "./Sidebar";
import { ListView } from "./ListView";
import { ArchivedListView } from "./ArchivedListView";
import { DetailView } from "./DetailView";
import { LocalSkillsView } from "./LocalSkillsView";
import { CommandPalette } from "./CommandPalette";
import { UploadDialog, InstallDialog } from "./UploadDialog";
import {
  parseSkillsRoute,
  skillsRouteHref,
  skillsRouteKey,
  skillsRouteSource,
  skillsRouteWithSkill,
  skillsRouteWithoutSkill,
  type SkillsRoute,
  type SkillsRouteSource,
} from "./route";
import { Onboarding } from "../org/Onboarding";
import { settingsHref } from "../org/SettingsApp";
import { SettingsDrawer, SettingsDrawerError } from "../org/SettingsDrawer";
import { useOrgActions } from "../org/useOrgActions";
import type { SettingsAppData, SettingsDialog, SettingsIntent, SettingsRoute, SettingsView } from "../org/model";
import {
  BUILTIN_VIEWS,
  chipParts,
  filtersKey,
  makeFilter,
  matchFilters,
  type Filter,
  type ViewDef,
} from "./filters";

const SETTINGS_LOAD_ERROR =
  "Refresh the page to try again. If the problem continues, check that the API and database are reachable.";

type SettingsState = {
  initialRoute: SettingsRoute;
  initialDialog: SettingsDialog;
};

type LocalSettingsSurface =
  | ({ kind: "ready"; data: SettingsAppData } & SettingsState)
  | ({ kind: "error"; message: string; busy: boolean } & SettingsState);

const SETTINGS_VIEWS: readonly SettingsView[] = [
  "profile",
  "preferences",
  "apikeys",
  "general",
  "members",
  "invitations",
  "team-general",
  "team-members",
];

function isSettingsView(value: string | null): value is SettingsView {
  return value !== null && (SETTINGS_VIEWS as readonly string[]).includes(value);
}

function settingsStateFromIntent(intent?: SettingsIntent): SettingsState {
  const view: SettingsView = intent?.view ?? (intent?.dialog === "team" ? "general" : "profile");
  const teamId = view.startsWith("team-") ? intent?.teamId : undefined;
  return {
    initialRoute: { view, teamId },
    initialDialog: intent?.dialog ?? null,
  };
}

function settingsStateFromSearch(search: string): SettingsState {
  const params = new URLSearchParams(search);
  const viewRaw = params.get("view");
  const view: SettingsView = isSettingsView(viewRaw) ? viewRaw : "profile";
  const teamId = view.startsWith("team-") ? params.get("team") ?? undefined : undefined;
  const dialogRaw = params.get("dialog");
  return {
    initialRoute: { view, teamId },
    initialDialog: dialogRaw === "invite" || dialogRaw === "team" ? dialogRaw : null,
  };
}

function settingsErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : SETTINGS_LOAD_ERROR;
}

// "Mine" = skills I can edit, keyed by the owner PRINCIPAL id (my user id + the ids of teams I
// admin/edit) — never display names, so two people with the same name can't collide into each
// other's "My skills". Maps to owner filters whose value is `SkillOwnerVM.id`.
function mineOwnerIdsFor(me: MeVM, teams: TeamVM[]): string[] {
  const editableTeamIds = teams
    .filter((team) => team.role === "admin" || team.role === "editor")
    .map((team) => team.dbId)
    .filter((id): id is string => !!id);
  return [...new Set([me.id, ...editableTeamIds])];
}

function normalizeSkillsRoute(route: SkillsRoute, teams: TeamVM[]): SkillsRoute {
  if (route.kind !== "team") return route;
  return teams.some((team) => team.id === route.team) ? route : { kind: "all", skill: route.skill };
}

function filtersForSkillsRoute(route: SkillsRoute, mineOwnerIds: string[]): Filter[] {
  if (route.kind === "mine") return mineOwnerIds.map((id) => ({ type: "owner", value: id }));
  if (route.kind === "team") return [{ type: "team", value: route.team }];
  return [];
}

type SkillsView = "workspace" | "local" | "archived";

function skillsViewForRoute(route: SkillsRoute): SkillsView {
  if (route.kind === "local") return "local";
  if (route.kind === "archived") return "archived";
  return "workspace";
}

function applyRouteFilters(
  route: SkillsRoute,
  mineOwnerIds: string[],
  setFilters: (filters: Filter[]) => void,
  skipNextDebouncedPersistRef: MutableRefObject<boolean>,
) {
  skipNextDebouncedPersistRef.current = true;
  setFilters(filtersForSkillsRoute(route, mineOwnerIds));
}

function initialFiltersForSkillsRoute(
  route: SkillsRoute,
  routeSource: SkillsRouteSource,
  mineOwnerIds: string[],
  savedFilters: Filter[],
): Filter[] {
  if (routeSource === "default" && route.kind === "all") return savedFilters;
  return filtersForSkillsRoute(route, mineOwnerIds);
}

export function SkillsApp({
  initialSkills,
  initialLocalSkills,
  initialFilterPreferences,
  me,
  teams: initialTeams,
  orgs,
  currentOrg,
  initialRoute,
  initialRouteSource,
}: {
  initialSkills: SkillVM[];
  initialLocalSkills: LocalSkillRow[];
  initialFilterPreferences: SkillFilterPreferences;
  me: MeVM;
  teams: TeamVM[];
  orgs: OrgVM[];
  currentOrg: OrgVM;
  initialRoute: SkillsRoute;
  initialRouteSource: SkillsRouteSource;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const settingsWarmupRef = useRef<{ orgId: string; promise: Promise<SettingsAppData> } | null>(null);
  const initialNormalizedRoute = normalizeSkillsRoute(initialRoute, initialTeams);
  const initialMineOwnerNames = mineOwnerIdsFor(me, initialTeams);
  const [localSettings, setLocalSettings] = useState<LocalSettingsSurface | null>(null);
  const [skills, setSkills] = useState<SkillVM[]>(initialSkills);
  const [teams, setTeams] = useState<TeamVM[]>(initialTeams);
  const [localSkills, setLocalSkills] = useState<LocalSkillRow[]>(initialLocalSkills);
  const [currentView, setCurrentView] = useState<SkillsView>(() =>
    skillsViewForRoute(initialNormalizedRoute),
  );
  const [archivedSkills, setArchivedSkills] = useState<SkillVM[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [filters, setFilters] = useState<Filter[]>(() =>
    initialFiltersForSkillsRoute(
      initialNormalizedRoute,
      initialRouteSource,
      initialMineOwnerNames,
      initialFilterPreferences.active_filters,
    ),
  );
  useEffect(() => setSkills(initialSkills), [initialSkills]);
  useEffect(() => setTeams(initialTeams), [initialTeams]);
  useEffect(() => setLocalSkills(initialLocalSkills), [initialLocalSkills]);
  useEffect(() => {
    document.cookie = `companion_org=${encodeURIComponent(currentOrg.id)}; path=/; SameSite=Lax`;
  }, [currentOrg.id]);

  const loadSettingsData = useCallback(async () => {
    const data = await fetchSettingsAppData({ me, currentOrg });
    if (!data) throw new Error(SETTINGS_LOAD_ERROR);
    return data;
  }, [currentOrg, me]);

  const warmSettings = useCallback(() => {
    const cached = settingsWarmupRef.current;
    if (cached?.orgId === currentOrg.id) return cached.promise;
    const promise = loadSettingsData();
    settingsWarmupRef.current = { orgId: currentOrg.id, promise };
    promise.catch(() => {
      if (settingsWarmupRef.current?.promise === promise) settingsWarmupRef.current = null;
    });
    return promise;
  }, [currentOrg.id, loadSettingsData]);

  const refreshLocalSettingsData = useCallback(async () => {
    const data = await loadSettingsData();
    settingsWarmupRef.current = { orgId: currentOrg.id, promise: Promise.resolve(data) };
    setLocalSettings((surface) => (surface?.kind === "ready" ? { ...surface, data } : surface));
    return data;
  }, [currentOrg.id, loadSettingsData]);

  const showLocalSettings = useCallback(
    (state: SettingsState, pushHistory: boolean) => {
      void warmSettings()
        .then((data) => {
          if (!pushHistory && window.location.pathname !== "/settings") return;
          if (pushHistory) {
            window.history.pushState(window.history.state, "", settingsHref(state.initialRoute, state.initialDialog));
          }
          setLocalSettings({ kind: "ready", data, ...state });
        })
        .catch((error) => {
          if (!pushHistory && window.location.pathname !== "/settings") return;
          if (pushHistory) {
            window.history.pushState(window.history.state, "", settingsHref(state.initialRoute, state.initialDialog));
          }
          setLocalSettings({ kind: "error", message: settingsErrorMessage(error), busy: false, ...state });
        });
    },
    [warmSettings],
  );

  const openSettings = useCallback(
    (intent?: SettingsIntent) => {
      showLocalSettings(settingsStateFromIntent(intent), true);
    },
    [showLocalSettings],
  );

  const retryLocalSettings = useCallback(() => {
    const surface = localSettings;
    if (!surface || surface.kind !== "error") return;
    const state = { initialRoute: surface.initialRoute, initialDialog: surface.initialDialog };
    setLocalSettings({ ...surface, busy: true });
    void loadSettingsData()
      .then((data) => {
        settingsWarmupRef.current = { orgId: currentOrg.id, promise: Promise.resolve(data) };
        window.history.replaceState(window.history.state, "", settingsHref(state.initialRoute, state.initialDialog));
        setLocalSettings({ kind: "ready", data, ...state });
      })
      .catch((error) => {
        setLocalSettings({ kind: "error", message: settingsErrorMessage(error), busy: false, ...state });
      });
  }, [currentOrg.id, loadSettingsData, localSettings]);

  useEffect(() => {
    settingsWarmupRef.current = null;
    setLocalSettings(null);
  }, [currentOrg.id]);

  const [customViews, setCustomViews] = useState<ViewDef[]>(() =>
    initialFilterPreferences.custom_views.map((v) => ({ ...v, custom: true })),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  const [updateSkill, setUpdateSkill] = useState<SkillVM | null>(null);
  const [installSkill, setInstallSkill] = useState<SkillVM | null>(null);
  const [visNotice, setVisNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(() =>
    initialNormalizedRoute.kind === "local" ? null : initialNormalizedRoute.skill ?? null,
  );
  const [lastId, setLastId] = useState<string | null>(() =>
    initialNormalizedRoute.kind === "local" ? null : initialNormalizedRoute.skill ?? null,
  );
  const [preferenceStatus, setPreferenceStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [toast, setToast] = useState<string | null>(null);
  const viewSeq = useRef(0);
  const openIdRef = useRef<string | null>(null);
  const uploadReturnRef = useRef<HTMLElement | null>(null);
  const didInitializePersistenceRef = useRef(false);
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistInFlightRef = useRef(false);
  const queuedPreferencesRef = useRef<SkillFilterPreferences | null>(null);
  const skipNextDebouncedPersistRef = useRef(false);
  const preferenceKey = JSON.stringify(initialFilterPreferences);
  const initialRouteKey = skillsRouteKey(initialRoute);
  const writeSkillsUrl = useCallback((route: SkillsRoute, history: "push" | "replace") => {
    if (typeof window === "undefined" || window.location.pathname !== "/skills") return;
    const href = skillsRouteHref(route);
    const currentHref = `${window.location.pathname}${window.location.search}`;
    if (currentHref === href) return;
    const hasSkill = route.kind !== "local" && !!route.skill;
    const currentState =
      window.history.state && typeof window.history.state === "object"
        ? (window.history.state as Record<string, unknown>)
        : {};
    const { companionSkillsDetail: _detail, ...listState } = currentState;
    if (history === "push") {
      window.history.pushState(hasSkill ? { ...listState, companionSkillsDetail: true } : listState, "", href);
    } else {
      window.history.replaceState(hasSkill ? currentState : listState, "", href);
    }
  }, []);
  const replaceSkillsUrl = useCallback((route: SkillsRoute) => writeSkillsUrl(route, "replace"), [writeSkillsUrl]);
  const pushSkillsUrl = useCallback((route: SkillsRoute) => writeSkillsUrl(route, "push"), [writeSkillsUrl]);
  const clearCurrentSkillUrl = useCallback(() => {
    if (typeof window === "undefined" || window.location.pathname !== "/skills") return;
    replaceSkillsUrl(skillsRouteWithoutSkill(parseSkillsRoute(window.location.search)));
  }, [replaceSkillsUrl]);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => {
      setIsNarrowViewport(query.matches);
      if (!query.matches) setMobileSidebarOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    const route = normalizeSkillsRoute(initialRoute, initialTeams);
    const routeFilters = initialFiltersForSkillsRoute(
      route,
      initialRouteSource,
      mineOwnerIdsFor(me, initialTeams),
      initialFilterPreferences.active_filters,
    );
    if (initialRouteSource === "default" && route.kind === "all") {
      setFilters(routeFilters);
    } else {
      skipNextDebouncedPersistRef.current = true;
      setFilters(routeFilters);
    }
    setCustomViews(initialFilterPreferences.custom_views.map((v) => ({ ...v, custom: true })));
    didInitializePersistenceRef.current = false;
    setPreferenceStatus("idle");
    setOpenId(route.kind === "local" ? null : route.skill ?? null);
    setLastId(route.kind === "local" ? null : route.skill ?? null);
    setCurrentView(skillsViewForRoute(route));
    if (typeof window !== "undefined" && window.location.pathname === "/skills") {
      replaceSkillsUrl(route);
    }
  }, [currentOrg.id, preferenceKey, initialFilterPreferences, initialRoute, initialRouteKey, initialRouteSource, initialTeams, me, replaceSkillsUrl]);

  const flushPreferenceQueue = useCallback(async () => {
    if (persistInFlightRef.current) return;
    persistInFlightRef.current = true;
    try {
      while (queuedPreferencesRef.current) {
        const next = queuedPreferencesRef.current;
        queuedPreferencesRef.current = null;
        try {
          setPreferenceStatus("saving");
          await saveSkillFilterPreferences(next);
          if (!queuedPreferencesRef.current) setPreferenceStatus("saved");
        } catch (error) {
          queuedPreferencesRef.current = next;
          setPreferenceStatus("error");
          console.error("Could not save skill filter preferences", error);
          break;
        }
      }
    } finally {
      persistInFlightRef.current = false;
    }
  }, []);

  const persistPreferences = useCallback((activeFilters: Filter[], savedViews: ViewDef[]) => {
    queuedPreferencesRef.current = {
      active_filters: activeFilters.map((f) => ({ ...f })),
      custom_views: savedViews.map((v) => ({
        id: v.id,
        name: v.name,
        icon: v.icon,
        filters: v.filters.map((f) => ({ ...f })),
        custom: true,
      })),
    };
    void flushPreferenceQueue();
  }, [flushPreferenceQueue]);

  useEffect(() => {
    if (!didInitializePersistenceRef.current) {
      didInitializePersistenceRef.current = true;
      return;
    }
    if (skipNextDebouncedPersistRef.current) {
      skipNextDebouncedPersistRef.current = false;
      return;
    }
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => persistPreferences(filters, customViews), 350);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [filters, customViews, persistPreferences]);

  const openUpload = useCallback(() => {
    uploadReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUploadOpen(true);
  }, []);
  const closeUpload = useCallback(() => {
    setUploadOpen(false);
    queueMicrotask(() => uploadReturnRef.current?.focus());
  }, []);

  // --- Optimistic mutations --------------------------------------------------
  const toggleStar = useCallback((id: string) => {
    setSkills((arr) =>
      arr.map((s) =>
        s.id === id ? { ...s, starred: !s.starred, stars: s.stars + (s.starred ? -1 : 1) } : s,
      ),
    );
    toggleStarRpc(id).catch(() => {
      // revert
      setSkills((arr) =>
        arr.map((s) =>
          s.id === id ? { ...s, starred: !s.starred, stars: s.stars + (s.starred ? -1 : 1) } : s,
        ),
      );
    });
  }, []);

  // Optimistically move a skill between Personal and a Team, persist it, and revert + toast on
  // failure. The owner is the single access axis, so this is the one "share / unshare" action.
  const changeOwner = useCallback(
    (id: string, ownerTeam: string | null) => {
      let prev: SkillVM["owner"] | null = null;
      const team = ownerTeam ? teams.find((t) => t.id === ownerTeam) : null;
      setSkills((arr) =>
        arr.map((s) => {
          if (s.id !== id) return s;
          prev = s.owner;
          const nextOwner: SkillVM["owner"] = ownerTeam
            ? {
                kind: "team",
                id: team?.dbId ?? ownerTeam,
                userId: s.owner.userId,
                teamId: team?.dbId ?? null,
                name: team?.name ?? ownerTeam,
                initials: (team?.name ?? ownerTeam).slice(0, 2).toUpperCase(),
                handle: ownerTeam,
                team: team?.name ?? ownerTeam,
              }
            : {
                kind: "user",
                // "Personal" = private to the actor: making a skill Personal transfers ownership to
                // the person performing the change (mirrors setSkillOwner on the server).
                id: me.id,
                userId: me.id,
                teamId: null,
                name: me.name,
                initials: me.initials,
                handle: null,
                team: null,
              };
          return { ...s, owner: nextOwner, ownerId: nextOwner.id, teamSlugs: ownerTeam ? [ownerTeam] : [] };
        }),
      );
      // Keep the open skill visible if an active owner-kind filter would now hide it.
      if (id === openIdRef.current) {
        setFilters((fs) => {
          const nextKind = ownerTeam ? "team" : "personal";
          const hasVisibility = fs.some((f) => f.type === "visibility");
          if (hasVisibility && !fs.some((f) => f.type === "visibility" && f.value === nextKind)) {
            return fs.filter((f) => f.type !== "visibility");
          }
          return fs;
        });
      }
      return setSkillOwner(id, ownerTeam).catch((err: unknown) => {
        if (prev) {
          const restored = prev;
          setSkills((arr) =>
            arr.map((s) =>
              s.id === id
                ? { ...s, owner: restored, ownerId: restored.id, teamSlugs: restored.kind === "team" && restored.handle ? [restored.handle] : [] }
                : s,
            ),
          );
        }
        setVisNotice(err instanceof Error ? err.message : "Could not change the owner.");
      });
    },
    [teams, me],
  );

  // Mark a published skill installed / not installed for the current user. Optimistic, with rollback;
  // on success it reconciles with the server's computed status (so "update" stays accurate).
  const setInstalled = useCallback(
    (id: string, installed: boolean) => {
      // Derive from the current render snapshot, not from a side effect inside the state updater.
      const target = skills.find((s) => s.id === id);
      // Marking installed records the current published version, so a later release surfaces an
      // "update available" hint (and the persisted state matches this optimistic update).
      const markVersion = target?.version ?? null;
      const prev = target ? { status: target.installStatus, version: target.installedVersion } : null;
      setSkills((arr) =>
        arr.map((s) =>
          s.id === id
            ? installed
              ? { ...s, installStatus: "installed" as const, installedVersion: markVersion }
              : { ...s, installStatus: "none" as const, installedVersion: null }
            : s,
        ),
      );
      const request = installed ? markSkillInstalled(id, markVersion) : markSkillUninstalled(id);
      request
        .then((res) => {
          // res.installed discriminates the union: true → install result (carries the computed status).
          if (res.installed) {
            setSkills((arr) =>
              arr.map((s) =>
                s.id === id ? { ...s, installStatus: res.status, installedVersion: res.installed_version } : s,
              ),
            );
          }
          setToast(installed ? `Marked ${id} as installed` : `Marked ${id} as not installed`);
        })
        .catch((e) => {
          if (prev) {
            setSkills((arr) =>
              arr.map((s) =>
                s.id === id ? { ...s, installStatus: prev.status, installedVersion: prev.version } : s,
              ),
            );
          }
          orgActions.setError((e as Error).message);
        });
    },
    [orgActions, skills],
  );

  // Auto-dismiss the success toast.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  // Auto-dismiss the visibility notice toast.
  useEffect(() => {
    if (!visNotice) return;
    const t = setTimeout(() => setVisNotice(null), 5000);
    return () => clearTimeout(t);
  }, [visNotice]);

  // --- Archived skills -------------------------------------------------------
  const loadArchived = useCallback(async () => {
    setArchivedLoaded(false);
    try {
      const rows = (await fetchArchivedSkills()).map(mapSkill);
      setArchivedSkills(rows);
      setArchivedLoaded(true);
      return rows;
    } catch {
      setArchivedLoaded(true);
      return [] as SkillVM[];
    }
  }, []);

  // Load the archived list once for the sidebar count (and refresh whenever the org changes).
  useEffect(() => {
    setArchivedSkills([]);
    setArchivedLoaded(false);
    void loadArchived();
  }, [currentOrg.id, loadArchived]);

  const archiveSkillById = useCallback(
    (id: string) => {
      // Optimistically drop it from the normal list so it disappears before the server round-trip;
      // router.refresh() re-syncs `skills` from props (and restores it on failure).
      setSkills((arr) => arr.filter((s) => s.id !== id));
      setOpenId((cur) => {
        if (cur !== id) return cur;
        clearCurrentSkillUrl();
        return null;
      });
      archiveSkillRpc(id)
        .then(() => {
          loadArchived();
          router.refresh();
        })
        .catch(() => router.refresh());
    },
    [clearCurrentSkillUrl, loadArchived, router],
  );

  const restoreSkillById = useCallback(
    (id: string) => {
      // Optimistically drop it from the archived list; refresh both lists from the server.
      setArchivedSkills((arr) => arr.filter((s) => s.id !== id));
      setOpenId((cur) => {
        if (cur !== id) return cur;
        clearCurrentSkillUrl();
        return null;
      });
      restoreSkillRpc(id)
        .then(() => {
          loadArchived();
          router.refresh();
        })
        .catch(() => loadArchived());
    },
    [clearCurrentSkillUrl, loadArchived, router],
  );

  // --- Derived ---------------------------------------------------------------
  // Distinct skill owners, keyed by principal id (so same-named owners stay separate), label = name.
  const owners = useMemo(() => {
    const byId = new Map<string, string>();
    for (const s of skills) if (!byId.has(s.owner.id)) byId.set(s.owner.id, s.owner.name);
    return [...byId.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [skills]);
  const ownerNameById = useMemo(() => Object.fromEntries(owners.map((o) => [o.id, o.name])), [owners]);
  const teamCounts = useMemo(() => {
    const c: Record<string, number> = {};
    skills.forEach((s) => {
      for (const slug of s.teamSlugs) c[slug] = (c[slug] || 0) + 1;
    });
    return c;
  }, [skills]);

  const views = useMemo(() => [...BUILTIN_VIEWS, ...customViews], [customViews]);
  const viewCounts = useMemo(() => {
    const c: Record<string, number> = {};
    views.forEach((v) => {
      c[v.id] = skills.filter((s) => matchFilters(s, v.filters)).length;
    });
    return c;
  }, [views, skills]);

  const filtered = useMemo(() => skills.filter((s) => matchFilters(s, filters)), [skills, filters]);
  const key = filtersKey(filters);
  const activeViewId = views.find((v) => filtersKey(v.filters) === key)?.id ?? null;
  const canSaveView = filters.length > 0 && !activeViewId;
  const activeTeam = filters.find((f) => f.type === "team")?.value ?? null;
  const isAll = filters.length === 0;
  const editableTeams = useMemo(
    () => teams.filter((team) => team.role === "admin" || team.role === "editor"),
    [teams],
  );
  const mineOwnerIds = useMemo(
    () => mineOwnerIdsFor(me, teams),
    [me, teams],
  );
  const mineOwnerKey = useMemo(() => filtersKey(mineOwnerIds.map((name) => ({ type: "owner", value: name }))), [mineOwnerIds]);
  const isMine = filters.length > 0 && filters.every((f) => f.type === "owner") && filtersKey(filters) === mineOwnerKey;
  const routeForCurrentSurface = useCallback(
    (skillId?: string): SkillsRoute => {
      const teamFilter = filters.length === 1 && filters[0]?.type === "team" ? filters[0].value : null;
      const route: SkillsRoute =
        currentView === "archived"
          ? { kind: "archived" }
          : currentView === "workspace" && isMine
            ? { kind: "mine" }
            : currentView === "workspace" && teamFilter
              ? { kind: "team", team: teamFilter }
              : { kind: "all" };
      return skillId ? skillsRouteWithSkill(route, skillId) : route;
    },
    [currentView, filters, isMine],
  );
  const myCount = useMemo(
    () =>
      skills.filter((s) =>
        s.owner.kind === "user"
          ? s.owner.userId === me.id
          : editableTeams.some((team) => team.dbId === s.owner.teamId || team.id === s.owner.handle),
      ).length,
    [skills, me.id, editableTeams],
  );

  // --- View / filter actions -------------------------------------------------
  const selectView = useCallback(
    (id: string) => {
      const v = [...BUILTIN_VIEWS, ...customViews].find((x) => x.id === id);
      if (v) {
        setCurrentView("workspace");
        setFilters(v.filters.map((f) => ({ ...f })));
        setOpenId(null);
        replaceSkillsUrl({ kind: "all" });
      }
    },
    [customViews, replaceSkillsUrl],
  );
  const toggleFilter = useCallback((type: Filter["type"], value: string) => {
    setCurrentView("workspace");
    setOpenId(null);
    replaceSkillsUrl({ kind: "all" });
    setFilters((fs) =>
      fs.some((f) => f.type === type && f.value === value)
        ? fs.filter((f) => !(f.type === type && f.value === value))
        : (() => {
            const next = makeFilter(type, value);
            return next ? [...fs, next] : fs;
          })(),
    );
  }, [replaceSkillsUrl]);
  const removeFilter = useCallback(
    (f: Filter) => {
      setCurrentView("workspace");
      setOpenId(null);
      replaceSkillsUrl({ kind: "all" });
      setFilters((fs) => fs.filter((x) => !(x.type === f.type && x.value === f.value)));
    },
    [replaceSkillsUrl],
  );
  const clearFilters = useCallback(() => {
    setCurrentView("workspace");
    setOpenId(null);
    replaceSkillsUrl({ kind: "all" });
    setFilters([]);
  }, [replaceSkillsUrl]);
  const saveView = useCallback(() => {
    const name =
      filters
        .map((f) => chipParts(f).val)
        .map((v) => v[0]?.toUpperCase() + v.slice(1))
        .join(" · ") || "View";
    viewSeq.current += 1;
    const view = {
      id: `view-${Date.now()}-${viewSeq.current}`,
      name,
      icon: "bookmark",
      custom: true,
      filters: filters.map((f) => ({ ...f })),
    } satisfies ViewDef;
    const nextCustomViews = [...customViews, view];
    skipNextDebouncedPersistRef.current = true;
    setCustomViews(nextCustomViews);
    persistPreferences(filters, nextCustomViews);
  }, [customViews, filters, persistPreferences]);
  const renameView = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim().slice(0, 128);
      if (!trimmed) return;
      const next = customViews.map((v) => (v.id === id ? { ...v, name: trimmed } : v));
      skipNextDebouncedPersistRef.current = true;
      setCustomViews(next);
      persistPreferences(filters, next);
    },
    [customViews, filters, persistPreferences],
  );
  const deleteView = useCallback(
    (id: string) => {
      const target = customViews.find((v) => v.id === id);
      const next = customViews.filter((v) => v.id !== id);
      const wasActive = !!target && filtersKey(target.filters) === filtersKey(filters);
      if (wasActive) {
        setFilters([]);
        setOpenId(null);
        replaceSkillsUrl({ kind: "all" });
      }
      skipNextDebouncedPersistRef.current = true;
      setCustomViews(next);
      persistPreferences(wasActive ? [] : filters, next);
    },
    [customViews, filters, persistPreferences, replaceSkillsUrl],
  );
  const retryPreferenceSave = useCallback(() => {
    if (!queuedPreferencesRef.current) persistPreferences(filters, customViews);
    else void flushPreferenceQueue();
  }, [customViews, filters, flushPreferenceQueue, persistPreferences]);
  const applySkillsRoute = useCallback(
    (route: SkillsRoute, history: "push" | "replace" | "none") => {
      const normalized = normalizeSkillsRoute(route, teams);
      setCurrentView(skillsViewForRoute(normalized));
      applyRouteFilters(normalized, mineOwnerIds, setFilters, skipNextDebouncedPersistRef);
      const nextOpenId = normalized.kind === "local" ? null : normalized.skill ?? null;
      setOpenId(nextOpenId);
      setLastId(nextOpenId);
      if (history === "none" || typeof window === "undefined") return;
      const href = skillsRouteHref(normalized);
      const currentHref = `${window.location.pathname}${window.location.search}`;
      if (currentHref === href) return;
      if (history === "push") window.history.pushState(window.history.state, "", href);
      else window.history.replaceState(window.history.state, "", href);
    },
    [mineOwnerIds, teams],
  );
  const selectTeam = useCallback((teamId: string) => {
    applySkillsRoute({ kind: "team", team: teamId }, "push");
  }, [applySkillsRoute]);
  const selectAll = useCallback(() => {
    applySkillsRoute({ kind: "all" }, "push");
  }, [applySkillsRoute]);
  const selectMine = useCallback(() => {
    applySkillsRoute({ kind: "mine" }, "push");
  }, [applySkillsRoute]);
  const selectLocal = useCallback(() => {
    applySkillsRoute({ kind: "local" }, "push");
  }, [applySkillsRoute]);
  const selectArchived = useCallback(() => {
    loadArchived();
    applySkillsRoute({ kind: "archived" }, "push");
  }, [applySkillsRoute, loadArchived]);
  const localUpdateCount = useMemo(
    () => localSkills.filter((s) => s.status === "update").length,
    [localSkills],
  );

  useEffect(() => {
    const onPopState = () => {
      if (window.location.pathname === "/settings") {
        showLocalSettings(settingsStateFromSearch(window.location.search), false);
        return;
      }
      // Closing the drawer drops the warmed snapshot so the next open re-fetches current server
      // state (a hover re-warms it). Otherwise optimistic in-drawer mutations wouldn't survive a
      // close/reopen until a full page refresh.
      settingsWarmupRef.current = null;
      setLocalSettings(null);
      if (window.location.pathname === "/skills") {
        const route = parseSkillsRoute(window.location.search);
        const source = skillsRouteSource(window.location.search);
        if (source === "default" && route.kind === "all") {
          setCurrentView("workspace");
          if (!openIdRef.current) setFilters(initialFilterPreferences.active_filters);
          setOpenId(null);
          setLastId(null);
        } else {
          if (route.kind === "archived") void loadArchived();
          applySkillsRoute(route, "none");
        }
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applySkillsRoute, initialFilterPreferences.active_filters, loadArchived, showLocalSettings]);

  // --- Open / navigate -------------------------------------------------------
  // The detail view draws from the archived list when that view is active, else the filtered list.
  const detailPool = currentView === "archived" ? archivedSkills : filtered;
  const index = openId ? detailPool.findIndex((s) => s.id === openId) : -1;
  const skill = index >= 0 ? detailPool[index] : null;
  openIdRef.current = openId;

  const open = useCallback((id: string) => {
    const openingFromWorkspace = currentView === "workspace";
    if (!openingFromWorkspace) {
      setCurrentView("workspace");
      setFilters([]);
    }
    setUploadOpen(false);
    setOpenId(id);
    setLastId(id);
    pushSkillsUrl(openingFromWorkspace ? routeForCurrentSurface(id) : { kind: "all", skill: id });
  }, [currentView, pushSkillsUrl, routeForCurrentSurface]);

  const openArchived = useCallback((id: string) => {
    setCurrentView("archived");
    setUploadOpen(false);
    setOpenId(id);
    setLastId(id);
    pushSkillsUrl({ kind: "archived", skill: id });
  }, [pushSkillsUrl]);

  // Open a skill by slug from a dependency link. A visible dependency target is always in exactly
  // one list: if it is not in the live workspace list it is archived (archived skills stay viewable).
  // For an archived target we fetch the archived list and await it BEFORE setting openId, so the
  // detail pool already contains the skill and the "drop out of filter" effect can't close it first.
  const openSkillBySlug = useCallback(
    async (slug: string) => {
      setUploadOpen(false);
      if (skills.some((s) => s.id === slug)) {
        setCurrentView("workspace");
        setFilters([]);
        setOpenId(slug);
        setLastId(slug);
        pushSkillsUrl({ kind: "all", skill: slug });
        return;
      }
      await loadArchived();
      setCurrentView("archived");
      setOpenId(slug);
      setLastId(slug);
      pushSkillsUrl({ kind: "archived", skill: slug });
    },
    [loadArchived, pushSkillsUrl, skills],
  );
  const back = useCallback(() => {
    if (
      typeof window !== "undefined" &&
      window.history.state &&
      typeof window.history.state === "object" &&
      (window.history.state as { companionSkillsDetail?: unknown }).companionSkillsDetail
    ) {
      window.history.back();
      return;
    }
    setOpenId(null);
    replaceSkillsUrl(routeForCurrentSurface());
  }, [replaceSkillsUrl, routeForCurrentSurface]);
  const go = useCallback(
    (delta: number) => {
      setOpenId((cur) => {
        const i = detailPool.findIndex((s) => s.id === cur);
        const n = detailPool[i + delta];
        if (n) {
          setLastId(n.id);
          replaceSkillsUrl(routeForCurrentSurface(n.id));
          return n.id;
        }
        return cur;
      });
    },
    [detailPool, replaceSkillsUrl, routeForCurrentSurface],
  );

  // If the open skill drops out of the filter, fall back to the list.
  useEffect(() => {
    if (!openId || index >= 0) return;
    if (currentView === "archived" && !archivedLoaded) return;
    setOpenId(null);
    replaceSkillsUrl(routeForCurrentSurface());
  }, [archivedLoaded, currentView, index, openId, replaceSkillsUrl, routeForCurrentSurface]);

  useEffect(() => {
    const onTeamUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{
        id: string;
        slug: string;
        name: string;
        color: string | null;
        icon: string | null;
      }>).detail;
      if (!detail?.id || !detail.slug) return;
      const previousSlug = teams.find((team) => team.dbId === detail.id || team.id === detail.slug)?.id;
      setTeams((rows) =>
        rows.map((team) =>
          team.dbId === detail.id || team.id === detail.slug
            ? { ...team, id: detail.slug, dbId: detail.id, name: detail.name, color: detail.color, icon: detail.icon }
            : team,
        ),
      );
      setSkills((rows) =>
        rows.map((skill) => {
          // Owner is the single access axis: only team-owned skills track a team slug/name to update.
          if (skill.owner.kind !== "team") return skill;
          const matches =
            skill.owner.teamId === detail.id ||
            (previousSlug ? skill.owner.handle === previousSlug : skill.owner.handle === detail.slug);
          if (!matches) return skill;
          const nextOwner: SkillVM["owner"] = {
            ...skill.owner,
            teamId: detail.id,
            handle: detail.slug,
            name: detail.name,
            team: detail.name,
          };
          return { ...skill, owner: nextOwner, ownerId: nextOwner.id, teamSlugs: [detail.slug] };
        }),
      );
      setFilters((rows) =>
        rows.map((filter) =>
          filter.type === "team" && previousSlug && filter.value === previousSlug && previousSlug !== detail.slug
            ? { ...filter, value: detail.slug }
            : filter,
        ),
      );
      setCustomViews((rows) =>
        rows.map((view) => ({
          ...view,
          filters: view.filters.map((filter) =>
            filter.type === "team" && previousSlug && filter.value === previousSlug && previousSlug !== detail.slug
              ? { ...filter, value: detail.slug }
              : filter,
          ),
        })),
      );
      const route = parseSkillsRoute(window.location.search);
      if (route.kind === "team" && previousSlug && route.team === previousSlug && previousSlug !== detail.slug) {
        replaceSkillsUrl({ kind: "team", team: detail.slug, skill: route.skill });
      }
    };
    window.addEventListener("companion:team-updated", onTeamUpdated);
    return () => window.removeEventListener("companion:team-updated", onTeamUpdated);
  }, [replaceSkillsUrl, teams]);

  useEffect(() => {
    if (!mobileSidebarOpen) return;
    const side = document.querySelector<HTMLElement>(".side--mobile-open");
    const focusable = () =>
      Array.from(
        side?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((node) => !node.hasAttribute("disabled") && node.offsetParent !== null);
    const items = focusable();
    if (!side?.contains(document.activeElement) && items[0]) items[0].focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const nodes = focusable();
      if (!nodes.length) return;
      const first = nodes[0]!;
      const last = nodes[nodes.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
        return;
      }
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileSidebarOpen]);

  // Keyboard: ⌘K toggles palette; Esc back to list; ↑/↓ move between skills.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Modal dialogs own the keyboard while open (their own Esc closes them).
      if (uploadOpen || updateSkill || installSkill) return;
      if (mobileSidebarOpen && e.key === "Escape") {
        e.preventDefault();
        setMobileSidebarOpen(false);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setPaletteOpen((o) => !o);
        return;
      }
      if (paletteOpen) return;
      if (!openId) return;
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase() ?? "";
      if (tag === "input" || tag === "textarea") return;
      if (e.key === "Escape") {
        e.preventDefault();
        back();
      } else if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        go(1);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openId, paletteOpen, mobileSidebarOpen, uploadOpen, updateSkill, installSkill, back, go]);

  return (
    <div className={"app app--skills" + (mobileSidebarOpen ? " app--side-open" : "")}>
      <Sidebar
        orgs={orgs}
        currentOrg={currentOrg}
        onSwitchOrg={orgActions.switchOrg}
        onOnboard={(m) => orgActions.setOnboarding(m)}
        onOpenSettings={openSettings}
        onWarmSettings={() => {
          void warmSettings();
        }}
        teams={teams}
        totalCount={skills.length}
        myCount={myCount}
        teamCounts={teamCounts}
        activeTeam={currentView === "workspace" ? activeTeam : null}
        isMine={currentView === "workspace" && isMine}
        workspaceActive={currentView === "workspace" && isAll}
        onOpenPalette={() => setPaletteOpen(true)}
        onSelectMine={selectMine}
        onSelectAll={selectAll}
        onSelectTeam={selectTeam}
        onSelectLocal={selectLocal}
        onSelectArchived={selectArchived}
        localActive={currentView === "local"}
        localUpdateCount={localUpdateCount}
        archivedActive={currentView === "archived"}
        archivedCount={archivedSkills.length}
        mobileOpen={mobileSidebarOpen}
        compactRail={isNarrowViewport && !mobileSidebarOpen}
        onToggleMobile={() => setMobileSidebarOpen((open) => !open)}
        onCloseMobile={() => setMobileSidebarOpen(false)}
      />
      {mobileSidebarOpen && (
        <button
          type="button"
          className="side-scrim"
          aria-label="Close navigation"
          onClick={() => setMobileSidebarOpen(false)}
        />
      )}
      <div className="main" aria-hidden={mobileSidebarOpen || undefined} inert={mobileSidebarOpen ? true : undefined}>
        {currentView === "local" ? (
          <LocalSkillsView skills={localSkills} workspaceName={currentOrg.name} />
        ) : skill ? (
          <DetailView
            skill={skill}
            index={index}
            total={detailPool.length}
            me={me}
            myRole={currentOrg.myRole}
            teams={teams}
            onBack={back}
            onPrev={() => go(-1)}
            onNext={() => go(1)}
            onToggleStar={() => toggleStar(skill.id)}
            onToggleInstalled={() => setInstalled(skill.id, skill.installStatus === "none")}
            onChangeOwner={(ownerTeam) => changeOwner(skill.id, ownerTeam)}
            onInstall={() => setInstallSkill(skill)}
            onUpdate={() => setUpdateSkill(skill)}
            onOpenSkill={openSkillBySlug}
            onRestore={() => restoreSkillById(skill.id)}
            onArchive={() => archiveSkillById(skill.id)}
          />
        ) : currentView === "archived" ? (
          <ArchivedListView
            skills={archivedSkills}
            onOpen={openArchived}
            onRestore={restoreSkillById}
            onUpload={openUpload}
          />
        ) : (
          <ListView
            skills={filtered}
            onOpen={open}
            onToggleStar={toggleStar}
            onUpload={openUpload}
            lastId={lastId}
            views={views}
            activeViewId={activeViewId}
            onSelectView={selectView}
            onRenameView={renameView}
            onDeleteView={deleteView}
            filters={filters}
            onToggleFilter={toggleFilter}
            onRemoveFilter={removeFilter}
            canSaveView={canSaveView}
            onSaveView={saveView}
            onClearFilters={clearFilters}
            preferenceStatus={preferenceStatus}
            onRetryPreferences={retryPreferenceSave}
            owners={owners}
            ownerNameById={ownerNameById}
            teams={teams}
            viewCounts={viewCounts}
          />
        )}
      </div>
      {paletteOpen && (
        <CommandPalette
          allSkills={skills}
          onPick={(id) => {
            open(id);
            setPaletteOpen(false);
          }}
          onClose={() => setPaletteOpen(false)}
          onUpload={openUpload}
        />
      )}
      {uploadOpen && (
        <UploadDialog
          mode="create"
          teams={teams}
          defaultOwnerTeam={activeTeam}
          onClose={closeUpload}
          onPublished={() => router.refresh()}
        />
      )}
      {updateSkill && (
        <UploadDialog
          mode="update"
          skill={updateSkill}
          teams={teams}
          onClose={() => setUpdateSkill(null)}
          onPublished={() => router.refresh()}
        />
      )}
      {installSkill && (
        <InstallDialog skill={installSkill} onClose={() => setInstallSkill(null)} />
      )}
      {visNotice && (
        <div className="og-toast" role="alert" onClick={() => setVisNotice(null)}>
          {visNotice}
        </div>
      )}
      {orgActions.onboarding && (
        <Onboarding
          mode={orgActions.onboarding}
          onMode={orgActions.setOnboarding}
          onCreate={orgActions.createOrg}
          onJoin={orgActions.joinOrg}
          busy={orgActions.busy}
        />
      )}
      {orgActions.error && (
        <div className="og-toast" role="alert" onClick={() => orgActions.setError(null)}>
          {orgActions.error}
        </div>
      )}
      {toast && (
        <div className="og-toast og-toast--ok" role="status" onClick={() => setToast(null)}>
          {toast}
        </div>
      )}
      {localSettings?.kind === "ready" && (
        <SettingsDrawer
          data={localSettings.data}
          initialRoute={localSettings.initialRoute}
          initialDialog={localSettings.initialDialog}
          onRefreshData={refreshLocalSettingsData}
        />
      )}
      {localSettings?.kind === "error" && (
        <SettingsDrawerError
          message={localSettings.message}
          busy={localSettings.busy}
          onClose={() => window.history.back()}
          onRetry={retryLocalSettings}
        />
      )}
    </div>
  );
}
