"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useRouter } from "next/navigation";
import type { LocalSkillRow, SkillFilterPreferences, SkillVisibilityInput } from "@companion/contracts";
import {
  archiveSkill as archiveSkillRpc,
  fetchArchivedSkills,
  restoreSkill as restoreSkillRpc,
  saveSkillFilterPreferences,
  setSkillVisibility,
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
import { VisibilityWarningDialog, type VisWarnDirection } from "./VisibilityWarningDialog";
import { parseSkillsRoute, skillsRouteHref, skillsRouteKey, skillsRouteSource, type SkillsRoute, type SkillsRouteSource } from "./route";
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

function mineOwnerNamesFor(me: MeVM, teams: TeamVM[]): string[] {
  const editableTeams = teams.filter((team) => team.role === "admin" || team.role === "editor");
  return [...new Set([me.name, ...editableTeams.map((team) => team.name)])];
}

function normalizeSkillsRoute(route: SkillsRoute, teams: TeamVM[]): SkillsRoute {
  if (route.kind !== "team") return route;
  return teams.some((team) => team.id === route.team) ? route : { kind: "all" };
}

function filtersForSkillsRoute(route: SkillsRoute, mineOwnerNames: string[]): Filter[] {
  if (route.kind === "mine") return mineOwnerNames.map((name) => ({ type: "owner", value: name }));
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
  mineOwnerNames: string[],
  setFilters: (filters: Filter[]) => void,
  skipNextDebouncedPersistRef: MutableRefObject<boolean>,
) {
  skipNextDebouncedPersistRef.current = true;
  setFilters(filtersForSkillsRoute(route, mineOwnerNames));
}

function initialFiltersForSkillsRoute(
  route: SkillsRoute,
  routeSource: SkillsRouteSource,
  mineOwnerNames: string[],
  savedFilters: Filter[],
): Filter[] {
  if (routeSource === "default" && route.kind === "all") return savedFilters;
  return filtersForSkillsRoute(route, mineOwnerNames);
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
  const initialMineOwnerNames = mineOwnerNamesFor(me, initialTeams);
  const [localSettings, setLocalSettings] = useState<LocalSettingsSurface | null>(null);
  const [skills, setSkills] = useState<SkillVM[]>(initialSkills);
  const [teams, setTeams] = useState<TeamVM[]>(initialTeams);
  const [localSkills, setLocalSkills] = useState<LocalSkillRow[]>(initialLocalSkills);
  const [currentView, setCurrentView] = useState<SkillsView>(() =>
    skillsViewForRoute(initialNormalizedRoute),
  );
  const [archivedSkills, setArchivedSkills] = useState<SkillVM[]>([]);
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
  // A visibility change that would break the dependency cover invariant — offer to cascade it.
  const [visWarn, setVisWarn] = useState<{ slug: string; visibility: SkillVisibilityInput; direction: VisWarnDirection } | null>(null);
  const [visNotice, setVisNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const [preferenceStatus, setPreferenceStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
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
  const replaceSkillsUrl = useCallback((route: SkillsRoute) => {
    if (typeof window === "undefined" || window.location.pathname !== "/skills") return;
    const href = skillsRouteHref(route);
    const currentHref = `${window.location.pathname}${window.location.search}`;
    if (currentHref !== href) window.history.replaceState(window.history.state, "", href);
  }, []);

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
      mineOwnerNamesFor(me, initialTeams),
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
    setOpenId(null);
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

  // Optimistically set a skill's visibility, persist it (optionally cascading to dependencies), and
  // revert + rethrow on failure so the caller can react (e.g. open the cascade warning dialog).
  const commitVisibility = useCallback(
    (id: string, visibility: SkillVisibilityInput, cascade = false): Promise<{ cascaded: string[] }> => {
      let prev: SkillVM["visibility"] | null = null;
      setSkills((arr) =>
        arr.map((s) => {
          if (s.id === id) {
            prev = s.visibility;
            const nextTeams = visibility.teams.map((slug) => {
              const existing = s.teams.find((team) => team.slug === slug);
              const team = teams.find((t) => t.id === slug);
              return existing ?? { id: slug, slug, name: team?.name ?? slug, color: team?.color ?? null, icon: team?.icon ?? null };
            });
            return { ...s, visibility: { everyone: visibility.everyone, teams: nextTeams }, teams: nextTeams, teamSlugs: nextTeams.map((team) => team.slug) };
          }
          return s;
        }),
      );
      // Keep the open skill visible if an active visibility filter would now hide it.
      if (id === openIdRef.current) {
        setFilters((fs) => {
          const nextVisibility = new Set<string>();
          if (visibility.everyone) nextVisibility.add("everyone");
          if (visibility.teams.length) nextVisibility.add("team");
          if (!visibility.everyone && visibility.teams.length === 0) nextVisibility.add("private");
          const hasVisibility = fs.some((f) => f.type === "visibility");
          if (hasVisibility && !fs.some((f) => f.type === "visibility" && nextVisibility.has(f.value))) {
            return fs.filter((f) => f.type !== "visibility");
          }
          return fs;
        });
      }
      return setSkillVisibility(id, visibility, { cascade }).catch((err) => {
        if (prev) {
          setSkills((arr) => arr.map((s) => (s.id === id ? { ...s, visibility: prev!, teams: prev!.teams, teamSlugs: prev!.teams.map((team) => team.slug) } : s)));
        }
        throw err;
      });
    },
    [teams],
  );

  const changeVisibility = useCallback(
    (id: string, visibility: SkillVisibilityInput) => {
      commitVisibility(id, visibility, false).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : "Could not change visibility.";
        // A cover-invariant break → offer to cascade the change to the affected skills.
        if (/^cannot broaden visibility/.test(msg)) setVisWarn({ slug: id, visibility, direction: "broaden" });
        else if (/^cannot narrow visibility/.test(msg)) setVisWarn({ slug: id, visibility, direction: "narrow" });
        else setVisNotice(msg);
      });
    },
    [commitVisibility],
  );

  // Confirm a cascade: re-apply the change with cascade=true, then reconcile the affected skills
  // locally to mirror the server — union with the new audience when broadening, intersection when
  // narrowing (the same transforms the service applies).
  const confirmCascade = useCallback(async () => {
    if (!visWarn) return;
    const { slug, visibility, direction } = visWarn;
    const { cascaded } = await commitVisibility(slug, visibility, true);
    if (cascaded.length) {
      const set = new Set(cascaded);
      const targetSlugs = new Set(visibility.teams);
      setSkills((arr) =>
        arr.map((s) => {
          if (!set.has(s.id)) return s;
          let nextTeams: SkillVM["teams"];
          let everyone: boolean;
          if (direction === "broaden") {
            const have = new Set(s.teamSlugs);
            nextTeams = [...s.teams];
            for (const teamSlug of visibility.teams) {
              if (have.has(teamSlug)) continue;
              const team = teams.find((t) => t.id === teamSlug);
              nextTeams.push({ id: teamSlug, slug: teamSlug, name: team?.name ?? teamSlug, color: team?.color ?? null, icon: team?.icon ?? null });
            }
            everyone = s.visibility.everyone || visibility.everyone;
          } else {
            // Narrowing: keep only the teams within the new audience (or the audience itself if the
            // skill was Everyone), and drop the Everyone flag unless the target is still Everyone.
            nextTeams = visibility.everyone
              ? s.teams
              : s.visibility.everyone
                ? visibility.teams.map((teamSlug) => {
                    const team = teams.find((t) => t.id === teamSlug);
                    return { id: teamSlug, slug: teamSlug, name: team?.name ?? teamSlug, color: team?.color ?? null, icon: team?.icon ?? null };
                  })
                : s.teams.filter((t) => targetSlugs.has(t.slug));
            everyone = s.visibility.everyone && visibility.everyone;
          }
          return { ...s, visibility: { everyone, teams: nextTeams }, teams: nextTeams, teamSlugs: nextTeams.map((t) => t.slug) };
        }),
      );
    }
    setVisWarn(null);
    const noun = direction === "broaden" ? "sub-skill" : "dependent skill";
    setVisNotice(
      cascaded.length
        ? `Updated ${cascaded.length} ${noun}${cascaded.length === 1 ? "" : "s"} to match.`
        : "Visibility updated.",
    );
  }, [visWarn, commitVisibility, teams]);

  // Auto-dismiss the visibility notice toast.
  useEffect(() => {
    if (!visNotice) return;
    const t = setTimeout(() => setVisNotice(null), 5000);
    return () => clearTimeout(t);
  }, [visNotice]);

  // --- Archived skills -------------------------------------------------------
  const loadArchived = useCallback(() => {
    fetchArchivedSkills()
      .then((rows) => setArchivedSkills(rows.map(mapSkill)))
      .catch(() => {});
  }, []);

  // Load the archived list once for the sidebar count (and refresh whenever the org changes).
  useEffect(() => {
    setArchivedSkills([]);
    loadArchived();
  }, [currentOrg.id, loadArchived]);

  const archiveSkillById = useCallback(
    (id: string) => {
      // Optimistically drop it from the normal list so it disappears before the server round-trip;
      // router.refresh() re-syncs `skills` from props (and restores it on failure).
      setSkills((arr) => arr.filter((s) => s.id !== id));
      setOpenId((cur) => (cur === id ? null : cur));
      archiveSkillRpc(id)
        .then(() => {
          loadArchived();
          router.refresh();
        })
        .catch(() => router.refresh());
    },
    [loadArchived, router],
  );

  const restoreSkillById = useCallback(
    (id: string) => {
      // Optimistically drop it from the archived list; refresh both lists from the server.
      setArchivedSkills((arr) => arr.filter((s) => s.id !== id));
      setOpenId((cur) => (cur === id ? null : cur));
      restoreSkillRpc(id)
        .then(() => {
          loadArchived();
          router.refresh();
        })
        .catch(() => loadArchived());
    },
    [loadArchived, router],
  );

  // --- Derived ---------------------------------------------------------------
  const owners = useMemo(() => [...new Set(skills.map((s) => s.owner.name))].sort(), [skills]);
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
  const mineOwnerNames = useMemo(
    () => mineOwnerNamesFor(me, teams),
    [me, teams],
  );
  const mineOwnerKey = useMemo(() => filtersKey(mineOwnerNames.map((name) => ({ type: "owner", value: name }))), [mineOwnerNames]);
  const isMine = filters.length > 0 && filters.every((f) => f.type === "owner") && filtersKey(filters) === mineOwnerKey;
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
      applyRouteFilters(normalized, mineOwnerNames, setFilters, skipNextDebouncedPersistRef);
      setOpenId(null);
      if (history === "none" || typeof window === "undefined") return;
      const href = skillsRouteHref(normalized);
      const currentHref = `${window.location.pathname}${window.location.search}`;
      if (currentHref === href) return;
      if (history === "push") window.history.pushState(window.history.state, "", href);
      else window.history.replaceState(window.history.state, "", href);
    },
    [mineOwnerNames, teams],
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
          setFilters(initialFilterPreferences.active_filters);
          setOpenId(null);
        } else {
          applySkillsRoute(route, "none");
        }
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applySkillsRoute, initialFilterPreferences.active_filters, showLocalSettings]);

  // --- Open / navigate -------------------------------------------------------
  // The detail view draws from the archived list when that view is active, else the filtered list.
  const detailPool = currentView === "archived" ? archivedSkills : filtered;
  const index = openId ? detailPool.findIndex((s) => s.id === openId) : -1;
  const skill = index >= 0 ? detailPool[index] : null;
  openIdRef.current = openId;

  const open = useCallback((id: string) => {
    if (currentView === "local") replaceSkillsUrl({ kind: "all" });
    if (currentView !== "archived") setCurrentView("workspace");
    setUploadOpen(false);
    setOpenId(id);
    setLastId(id);
  }, [currentView, replaceSkillsUrl]);

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
        replaceSkillsUrl({ kind: "all" });
        setOpenId(slug);
        setLastId(slug);
        return;
      }
      const rows = await fetchArchivedSkills()
        .then((r) => r.map(mapSkill))
        .catch(() => archivedSkills);
      setArchivedSkills(rows);
      setCurrentView("archived");
      replaceSkillsUrl({ kind: "archived" });
      setOpenId(slug);
      setLastId(slug);
    },
    [replaceSkillsUrl, skills, archivedSkills],
  );
  const back = useCallback(() => setOpenId(null), []);
  const go = useCallback(
    (delta: number) => {
      setOpenId((cur) => {
        const i = detailPool.findIndex((s) => s.id === cur);
        const n = detailPool[i + delta];
        if (n) {
          setLastId(n.id);
          return n.id;
        }
        return cur;
      });
    },
    [detailPool],
  );

  // If the open skill drops out of the filter, fall back to the list.
  useEffect(() => {
    if (openId && index < 0) setOpenId(null);
  }, [openId, index]);

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
          const nextTeams = skill.teams.map((team) =>
            team.id === detail.id || team.slug === detail.slug
              ? { ...team, id: detail.id, slug: detail.slug, name: detail.name, color: detail.color, icon: detail.icon }
              : team,
          );
          return { ...skill, visibility: { ...skill.visibility, teams: nextTeams }, teams: nextTeams, teamSlugs: nextTeams.map((team) => team.slug) };
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
        replaceSkillsUrl({ kind: "team", team: detail.slug });
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
            onChangeVisibility={(sc) => changeVisibility(skill.id, sc)}
            onInstall={() => setInstallSkill(skill)}
            onUpdate={() => setUpdateSkill(skill)}
            onOpenSkill={openSkillBySlug}
            onRestore={() => restoreSkillById(skill.id)}
            onArchive={() => archiveSkillById(skill.id)}
          />
        ) : currentView === "archived" ? (
          <ArchivedListView
            skills={archivedSkills}
            onOpen={open}
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
      {visWarn && (
        <VisibilityWarningDialog
          slug={visWarn.slug}
          visibility={visWarn.visibility}
          direction={visWarn.direction}
          teams={teams}
          onCancel={() => setVisWarn(null)}
          onConfirm={confirmCascade}
        />
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
