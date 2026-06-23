"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  LabelColor,
  LabelIcon,
  LabelsResponse,
  LabelVM,
  LocalSkillRow,
  SkillFilterPreferences,
} from "@companion/contracts";
import {
  archiveSkill as archiveSkillRpc,
  assignSkillLabel,
  createLabel as createLabelRpc,
  deleteLabel as deleteLabelRpc,
  fetchArchivedSkills,
  markSkillInstalled,
  markSkillUninstalled,
  renameLabel as renameLabelRpc,
  restoreSkill as restoreSkillRpc,
  saveSkillFilterPreferences,
  setLabelColor as setLabelColorRpc,
  setLabelIcon as setLabelIconRpc,
  toggleStar as toggleStarRpc,
  unassignSkillLabel,
} from "@/lib/queries";
import { fetchSettingsAppData } from "@/lib/settingsClient";
import { mapSkill, type MeVM, type OrgVM, type SkillVM } from "@/lib/types";
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
import { matchFilters, type Filter } from "./filters";

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
];

function isSettingsView(value: string | null): value is SettingsView {
  return value !== null && (SETTINGS_VIEWS as readonly string[]).includes(value);
}

function settingsStateFromIntent(intent?: SettingsIntent): SettingsState {
  const view: SettingsView = intent?.view ?? "profile";
  return {
    initialRoute: { view },
    initialDialog: intent?.dialog ?? null,
  };
}

function settingsStateFromSearch(search: string): SettingsState {
  const params = new URLSearchParams(search);
  const viewRaw = params.get("view");
  const view: SettingsView = isSettingsView(viewRaw) ? viewRaw : "profile";
  const dialogRaw = params.get("dialog");
  return {
    initialRoute: { view },
    initialDialog: dialogRaw === "invite" ? dialogRaw : null,
  };
}

function settingsErrorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : SETTINGS_LOAD_ERROR;
}

/* --- Label tree derivation -------------------------------------------------- */

/**
 * One flattened node of the derived label tree (depth-ordered, stable lexicographic sort). Derived
 * in the client from skills + explicit `labels` rows so optimistic assigns / renames re-derive
 * without a refetch.
 */
export interface TreeRow {
  path: string;
  leafName: string;
  displayName: string | null;
  depth: number;
  count: number; // de-duped roll-up of skills filed at this path OR any descendant
  color: LabelColor | null;
  icon: LabelIcon | null;
  hasChildren: boolean;
}

const SCOPE_KINDS = ["all", "starred", "nolabel", "label"] as const;
type ScopeKind = (typeof SCOPE_KINDS)[number];
type Selection = { kind: ScopeKind; label?: string };

/**
 * Derive the flattened label tree from the live skills + explicit label appearances. Intermediate
 * parents are synthesized; roll-up counts are de-duped per skill (a skill filed under `a/b` counts
 * once for `a` and once for `a/b`). Sorted lexicographically by path for a stable (hydration-safe)
 * order regardless of insertion order.
 */
function deriveTreeRows(skills: SkillVM[], labels: LabelVM[]): TreeRow[] {
  const appearance = new Map<string, { displayName: string | null; color: LabelColor | null; icon: LabelIcon | null }>();
  const paths = new Set<string>();
  const childPaths = new Set<string>(); // any path that has at least one child (for chevrons)
  // Per-path set of skill ids contributing to its roll-up count (de-dupe across descendants).
  const counts = new Map<string, Set<string>>();

  const ensureAncestors = (path: string) => {
    const segs = path.split("/");
    for (let i = 1; i <= segs.length; i += 1) {
      const p = segs.slice(0, i).join("/");
      paths.add(p);
      if (i < segs.length) childPaths.add(p);
    }
  };

  for (const label of labels) {
    appearance.set(label.path, { displayName: label.displayName, color: label.color, icon: label.icon });
    ensureAncestors(label.path);
  }
  for (const skill of skills) {
    for (const raw of skill.labels ?? []) {
      if (!raw) continue;
      ensureAncestors(raw);
      const segs = raw.split("/");
      for (let i = 1; i <= segs.length; i += 1) {
        const p = segs.slice(0, i).join("/");
        let set = counts.get(p);
        if (!set) counts.set(p, (set = new Set()));
        set.add(skill.uuid);
      }
    }
  }

  return [...paths]
    .sort((a, b) => a.localeCompare(b))
    .map((path) => {
      const segs = path.split("/");
      const appr = appearance.get(path);
      return {
        path,
        leafName: segs[segs.length - 1] ?? path,
        displayName: appr?.displayName ?? null,
        depth: segs.length - 1,
        count: counts.get(path)?.size ?? 0,
        color: appr?.color ?? null,
        icon: appr?.icon ?? null,
        hasChildren: childPaths.has(path),
      };
    });
}

/** Whether a skill is filed under `path` OR any descendant of it. */
function skillUnderLabel(skill: SkillVM, path: string): boolean {
  return (skill.labels ?? []).some((p) => p === path || p.startsWith(path + "/"));
}

/** Does a skill belong to the active org-wide scope (sidebar selection)? */
function skillInSelection(skill: SkillVM, selection: Selection): boolean {
  if (selection.kind === "starred") return skill.starred;
  if (selection.kind === "nolabel") return (skill.labels ?? []).length === 0;
  if (selection.kind === "label") return selection.label ? skillUnderLabel(skill, selection.label) : true;
  return true;
}

type SkillsView = "workspace" | "local" | "archived";

function selectionFromRoute(route: SkillsRoute): Selection {
  if (route.kind === "starred") return { kind: "starred" };
  if (route.kind === "nolabel") return { kind: "nolabel" };
  if (route.kind === "label") return { kind: "label", label: route.label };
  return { kind: "all" };
}

function skillsViewForRoute(route: SkillsRoute): SkillsView {
  if (route.kind === "local") return "local";
  if (route.kind === "archived") return "archived";
  return "workspace";
}

function routeFromSelection(selection: Selection, skill?: string): SkillsRoute {
  let route: SkillsRoute;
  if (selection.kind === "starred") route = { kind: "starred" };
  else if (selection.kind === "nolabel") route = { kind: "nolabel" };
  else if (selection.kind === "label" && selection.label) route = { kind: "label", label: selection.label };
  else route = { kind: "all" };
  return skill ? skillsRouteWithSkill(route, skill) : route;
}

export function SkillsApp({
  initialSkills,
  initialLocalSkills,
  initialFilterPreferences,
  initialLabels,
  me,
  orgs,
  currentOrg,
  initialRoute,
  initialRouteSource,
}: {
  initialSkills: SkillVM[];
  initialLocalSkills: LocalSkillRow[];
  initialFilterPreferences: SkillFilterPreferences;
  initialLabels: LabelsResponse;
  me: MeVM;
  orgs: OrgVM[];
  currentOrg: OrgVM;
  initialRoute: SkillsRoute;
  initialRouteSource: SkillsRouteSource;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const settingsWarmupRef = useRef<{ orgId: string; promise: Promise<SettingsAppData> } | null>(null);
  const [localSettings, setLocalSettings] = useState<LocalSettingsSurface | null>(null);
  const [skills, setSkills] = useState<SkillVM[]>(initialSkills);
  const [labels, setLabels] = useState<LabelVM[]>(initialLabels.flat);
  const [localSkills, setLocalSkills] = useState<LocalSkillRow[]>(initialLocalSkills);
  const [currentView, setCurrentView] = useState<SkillsView>(() => skillsViewForRoute(initialRoute));
  const [archivedSkills, setArchivedSkills] = useState<SkillVM[]>([]);
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [selection, setSelection] = useState<Selection>(() => selectionFromRoute(initialRoute));
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [filters, setFilters] = useState<Filter[]>(() => initialFilterPreferences.active_filters);

  // Synchronous mirrors for optimistic handlers (StrictMode-safe: read current state via the ref,
  // never gate an RPC on a flag set inside a setState updater — the double-invoke would drop it).
  const skillsRef = useRef<SkillVM[]>(initialSkills);
  const labelsRef = useRef<LabelVM[]>(initialLabels.flat);
  skillsRef.current = skills;
  labelsRef.current = labels;

  useEffect(() => setSkills(initialSkills), [initialSkills]);
  useEffect(() => setLabels(initialLabels.flat), [initialLabels]);
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

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [updateSkill, setUpdateSkill] = useState<SkillVM | null>(null);
  const [installSkill, setInstallSkill] = useState<SkillVM | null>(null);
  const [labelNotice, setLabelNotice] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(() =>
    initialRoute.kind === "local" ? null : initialRoute.skill ?? null,
  );
  const [lastId, setLastId] = useState<string | null>(() =>
    initialRoute.kind === "local" ? null : initialRoute.skill ?? null,
  );
  const [preferenceStatus, setPreferenceStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [toast, setToast] = useState<string | null>(null);
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
      if (!query.matches) setMobileSidebarOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Re-derive selection / open skill / view when the server route (or org) changes.
  useEffect(() => {
    setFilters(initialFilterPreferences.active_filters);
    setSelection(selectionFromRoute(initialRoute));
    didInitializePersistenceRef.current = false;
    setPreferenceStatus("idle");
    setOpenId(initialRoute.kind === "local" ? null : initialRoute.skill ?? null);
    setLastId(initialRoute.kind === "local" ? null : initialRoute.skill ?? null);
    setCurrentView(skillsViewForRoute(initialRoute));
    if (typeof window !== "undefined" && window.location.pathname === "/skills") {
      replaceSkillsUrl(initialRoute);
    }
  }, [currentOrg.id, preferenceKey, initialFilterPreferences, initialRoute, initialRouteKey, replaceSkillsUrl]);

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

  const persistPreferences = useCallback((activeFilters: Filter[]) => {
    queuedPreferencesRef.current = {
      active_filters: activeFilters.map((f) => ({ ...f })),
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
    persistTimerRef.current = setTimeout(() => persistPreferences(filters), 350);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [filters, persistPreferences]);

  const openUpload = useCallback(() => {
    uploadReturnRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setUploadOpen(true);
  }, []);
  const closeUpload = useCallback(() => {
    setUploadOpen(false);
    queueMicrotask(() => uploadReturnRef.current?.focus());
  }, []);

  // --- Optimistic mutations: stars / install ---------------------------------
  const toggleStar = useCallback((id: string) => {
    setSkills((arr) =>
      arr.map((s) =>
        s.id === id ? { ...s, starred: !s.starred, stars: s.stars + (s.starred ? -1 : 1) } : s,
      ),
    );
    toggleStarRpc(id).catch(() => {
      setSkills((arr) =>
        arr.map((s) =>
          s.id === id ? { ...s, starred: !s.starred, stars: s.stars + (s.starred ? -1 : 1) } : s,
        ),
      );
    });
  }, []);

  const setInstalled = useCallback(
    (id: string, installed: boolean) => {
      const target = skillsRef.current.find((s) => s.id === id);
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
    [orgActions],
  );

  // --- Optimistic label mutations --------------------------------------------
  // Every handler captures the previous value, reads current state from a SYNCHRONOUS ref, applies
  // the optimistic setState, fires the RPC, and reverts on failure. No router.refresh() on success
  // (it re-derives the route and would close the open detail). Counts re-derive from `skills` in the
  // tree memo, so adding/removing a label assignment automatically adjusts the roll-up.

  // Assign or unassign a label path on a skill (toggle). The detail "Add to folder" calls this.
  const toggleSkillLabel = useCallback((skillId: string, path: string) => {
    const current = skillsRef.current.find((s) => s.id === skillId);
    if (!current) return;
    const had = (current.labels ?? []).includes(path);
    // The server's assignLabel upserts the path AND its ancestors as explicit `labels` rows, so a
    // newly-assigned folder must persist in the tree even after its last skill is unfiled. Mirror that:
    // on assign, register any not-yet-known ancestor as an explicit folder (and revert those on failure).
    const newFolders: string[] = [];
    if (!had) {
      const known = new Set(labelsRef.current.map((l) => l.path));
      const segs = path.split("/");
      for (let i = 1; i <= segs.length; i += 1) {
        const p = segs.slice(0, i).join("/");
        if (!known.has(p)) newFolders.push(p);
      }
    }
    setSkills((arr) =>
      arr.map((s) =>
        s.id === skillId
          ? {
              ...s,
              labels: had ? s.labels.filter((p) => p !== path) : [...s.labels, path],
            }
          : s,
      ),
    );
    if (newFolders.length) {
      setLabels((arr) => [...arr, ...newFolders.map((p) => ({ path: p, displayName: null, color: null, icon: null }))]);
    }
    const rpc = had ? unassignSkillLabel(skillId, path) : assignSkillLabel(skillId, path);
    rpc.catch((err: unknown) => {
      setSkills((arr) =>
        arr.map((s) =>
          s.id === skillId
            ? { ...s, labels: had ? [...s.labels, path] : s.labels.filter((p) => p !== path) }
            : s,
        ),
      );
      if (newFolders.length) {
        const remove = new Set(newFolders);
        setLabels((arr) => arr.filter((l) => !remove.has(l.path)));
      }
      setLabelNotice(err instanceof Error ? err.message : "Could not update the skill's folders.");
    });
  }, []);

  // Create an empty folder (explicit `labels` row) and select it.
  const createLabelPath = useCallback(
    (path: string, displayName?: string) => {
      if (labelsRef.current.some((l) => l.path === path)) {
        setSelection({ kind: "label", label: path });
        replaceSkillsUrl({ kind: "label", label: path });
        return;
      }
      const optimistic: LabelVM = { path, displayName: displayName ?? null, color: null, icon: null };
      setLabels((arr) => [...arr, optimistic]);
      setSelection({ kind: "label", label: path });
      setOpenId(null);
      setExpanded((prev) => {
        const next = new Set(prev);
        const segs = path.split("/");
        for (let i = 1; i < segs.length; i += 1) next.add(segs.slice(0, i).join("/"));
        return next;
      });
      replaceSkillsUrl({ kind: "label", label: path });
      createLabelRpc(path, { displayName }).catch((err: unknown) => {
        setLabels((arr) => arr.filter((l) => l.path !== path));
        setLabelNotice(err instanceof Error ? err.message : "Could not create the folder.");
      });
    },
    [replaceSkillsUrl],
  );

  const setLabelColorPath = useCallback((path: string, color: LabelColor | null) => {
    const prev = labelsRef.current.find((l) => l.path === path);
    const prevColor = prev?.color ?? null;
    setLabels((arr) => {
      const exists = arr.some((l) => l.path === path);
      return exists
        ? arr.map((l) => (l.path === path ? { ...l, color } : l))
        : [...arr, { path, displayName: null, color, icon: null }];
    });
    setLabelColorRpc(path, color).catch((err: unknown) => {
      setLabels((arr) => arr.map((l) => (l.path === path ? { ...l, color: prevColor } : l)));
      setLabelNotice(err instanceof Error ? err.message : "Could not change the folder color.");
    });
  }, []);

  const setLabelIconPath = useCallback((path: string, icon: LabelIcon | null) => {
    const prev = labelsRef.current.find((l) => l.path === path);
    const prevIcon = prev?.icon ?? null;
    setLabels((arr) => {
      const exists = arr.some((l) => l.path === path);
      return exists
        ? arr.map((l) => (l.path === path ? { ...l, icon } : l))
        : [...arr, { path, displayName: null, color: null, icon }];
    });
    setLabelIconRpc(path, icon).catch((err: unknown) => {
      setLabels((arr) => arr.map((l) => (l.path === path ? { ...l, icon: prevIcon } : l)));
      setLabelNotice(err instanceof Error ? err.message : "Could not change the folder icon.");
    });
  }, []);

  const renameLabelPath = useCallback(
    (from: string, to: string, displayName?: string) => {
      if (from === to && displayName === undefined) return;
      const prevLabels = labelsRef.current;
      const prevSkills = skillsRef.current;
      const within = (p: string) => p === from || p.startsWith(from + "/");
      const remap = (p: string) => (within(p) ? to + p.slice(from.length) : p);
      setLabels((arr) =>
        arr.map((l) => ({
          ...l,
          path: remap(l.path),
          displayName: displayName !== undefined && l.path === from ? displayName : l.displayName,
        })),
      );
      setSkills((arr) => arr.map((s) => ({ ...s, labels: s.labels.map(remap) })));
      setSelection((sel) =>
        sel.kind === "label" && sel.label && within(sel.label)
          ? { kind: "label", label: remap(sel.label) }
          : sel,
      );
      // Keep the URL in sync when the active folder (or an ancestor of it) is the one being renamed,
      // preserving any open skill so reload/back re-opens it under the new path. Mirrors deleteLabelPath.
      if (selection.kind === "label" && selection.label && within(selection.label)) {
        replaceSkillsUrl(
          routeFromSelection({ kind: "label", label: remap(selection.label) }, openIdRef.current ?? undefined),
        );
      }
      renameLabelRpc(from, to, { displayName }).catch((err: unknown) => {
        setLabels(prevLabels);
        setSkills(prevSkills);
        setLabelNotice(err instanceof Error ? err.message : "Could not rename the folder.");
      });
    },
    [replaceSkillsUrl, selection],
  );

  const deleteLabelPath = useCallback(
    (path: string) => {
      const prevLabels = labelsRef.current;
      const prevSkills = skillsRef.current;
      const within = (p: string) => p === path || p.startsWith(path + "/");
      setLabels((arr) => arr.filter((l) => !within(l.path)));
      setSkills((arr) => arr.map((s) => ({ ...s, labels: s.labels.filter((p) => !within(p)) })));
      setSelection((sel) =>
        sel.kind === "label" && sel.label && within(sel.label) ? { kind: "all" } : sel,
      );
      if (selection.kind === "label" && selection.label && within(selection.label)) {
        replaceSkillsUrl({ kind: "all" });
      }
      deleteLabelRpc(path).catch((err: unknown) => {
        setLabels(prevLabels);
        setSkills(prevSkills);
        setLabelNotice(err instanceof Error ? err.message : "Could not delete the folder.");
      });
    },
    [replaceSkillsUrl, selection],
  );

  // Auto-dismiss toasts.
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (!labelNotice) return;
    const t = setTimeout(() => setLabelNotice(null), 5000);
    return () => clearTimeout(t);
  }, [labelNotice]);

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

  useEffect(() => {
    setArchivedSkills([]);
    setArchivedLoaded(false);
    void loadArchived();
  }, [currentOrg.id, loadArchived]);

  const archiveSkillById = useCallback(
    (id: string) => {
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
  const treeRows = useMemo(() => deriveTreeRows(skills, labels), [skills, labels]);
  const starredCount = useMemo(() => skills.filter((s) => s.starred).length, [skills]);

  // The active scope + the in-list filter chips both gate the list.
  const filtered = useMemo(
    () => skills.filter((s) => skillInSelection(s, selection) && matchFilters(s, filters)),
    [skills, selection, filters],
  );

  const activeLabel = selection.kind === "label" ? selection.label ?? null : null;
  const breadcrumb = useMemo(() => {
    if (selection.kind === "starred") return ["Starred"];
    if (selection.kind === "nolabel") return ["No folder"];
    if (selection.kind === "label" && selection.label) return selection.label.split("/");
    return ["All skills"];
  }, [selection]);

  const routeForCurrentSurface = useCallback(
    (skillId?: string): SkillsRoute => {
      if (currentView === "archived") {
        return skillId ? { kind: "archived", skill: skillId } : { kind: "archived" };
      }
      return routeFromSelection(selection, skillId);
    },
    [currentView, selection],
  );

  // --- Filter actions (in-list bar: status / deps / starred) -----------------
  const toggleFilter = useCallback((type: Filter["type"], value: string) => {
    setFilters((fs) =>
      fs.some((f) => f.type === type && f.value === value)
        ? fs.filter((f) => !(f.type === type && f.value === value))
        : ([...fs, { type, value }] as Filter[]),
    );
  }, []);
  const removeFilter = useCallback((f: Filter) => {
    setFilters((fs) => fs.filter((x) => !(x.type === f.type && x.value === f.value)));
  }, []);
  const clearFilters = useCallback(() => setFilters([]), []);
  const retryPreferenceSave = useCallback(() => {
    if (!queuedPreferencesRef.current) persistPreferences(filters);
    else void flushPreferenceQueue();
  }, [filters, flushPreferenceQueue, persistPreferences]);

  // --- Selection / navigation ------------------------------------------------
  const applySkillsRoute = useCallback(
    (route: SkillsRoute, history: "push" | "replace" | "none") => {
      setCurrentView(skillsViewForRoute(route));
      setSelection(selectionFromRoute(route));
      const nextOpenId = route.kind === "local" ? null : route.skill ?? null;
      setOpenId(nextOpenId);
      setLastId(nextOpenId);
      if (history === "none" || typeof window === "undefined") return;
      const href = skillsRouteHref(route);
      const currentHref = `${window.location.pathname}${window.location.search}`;
      if (currentHref === href) return;
      if (history === "push") window.history.pushState(window.history.state, "", href);
      else window.history.replaceState(window.history.state, "", href);
    },
    [],
  );
  const selectAll = useCallback(() => applySkillsRoute({ kind: "all" }, "push"), [applySkillsRoute]);
  const selectStarred = useCallback(() => applySkillsRoute({ kind: "starred" }, "push"), [applySkillsRoute]);
  const selectLabel = useCallback(
    (path: string) => applySkillsRoute({ kind: "label", label: path }, "push"),
    [applySkillsRoute],
  );
  const selectLocal = useCallback(() => applySkillsRoute({ kind: "local" }, "push"), [applySkillsRoute]);
  const selectArchived = useCallback(() => {
    loadArchived();
    applySkillsRoute({ kind: "archived" }, "push");
  }, [applySkillsRoute, loadArchived]);

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Selecting a label auto-expands its ancestors so the row is reachable in the tree.
  useEffect(() => {
    if (selection.kind !== "label" || !selection.label) return;
    const segs = selection.label.split("/");
    if (segs.length < 2) return;
    setExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (let i = 1; i < segs.length; i += 1) {
        const p = segs.slice(0, i).join("/");
        if (!next.has(p)) {
          next.add(p);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [selection]);

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
      settingsWarmupRef.current = null;
      setLocalSettings(null);
      if (window.location.pathname === "/skills") {
        const route = parseSkillsRoute(window.location.search);
        const source = skillsRouteSource(window.location.search);
        if (source === "default" && route.kind === "all") {
          setCurrentView("workspace");
          setSelection({ kind: "all" });
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
  const detailPool = currentView === "archived" ? archivedSkills : filtered;
  const index = openId ? detailPool.findIndex((s) => s.id === openId) : -1;
  const skill = index >= 0 ? detailPool[index] : null;
  openIdRef.current = openId;

  const open = useCallback((id: string) => {
    const openingFromWorkspace = currentView === "workspace";
    if (!openingFromWorkspace) setCurrentView("workspace");
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

  const openSkillBySlug = useCallback(
    async (slug: string) => {
      setUploadOpen(false);
      if (skillsRef.current.some((s) => s.id === slug)) {
        setCurrentView("workspace");
        setSelection({ kind: "all" });
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
    [loadArchived, pushSkillsUrl],
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

  // If the open skill drops out of the filtered slice, fall back to the list.
  useEffect(() => {
    if (!openId || index >= 0) return;
    if (currentView === "archived" && !archivedLoaded) return;
    setOpenId(null);
    replaceSkillsUrl(routeForCurrentSurface());
  }, [archivedLoaded, currentView, index, openId, replaceSkillsUrl, routeForCurrentSurface]);

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

  const localActive = currentView === "local";
  const archivedActive = currentView === "archived";

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
        treeRows={treeRows}
        expanded={expanded}
        onToggleExpand={toggleExpand}
        selection={currentView === "workspace" ? selection : { kind: "all" }}
        totalCount={skills.length}
        starredCount={starredCount}
        onOpenPalette={() => setPaletteOpen(true)}
        onSelectAll={selectAll}
        onSelectStarred={selectStarred}
        onSelectLabel={selectLabel}
        onCreateLabel={createLabelPath}
        onSetLabelColor={setLabelColorPath}
        onSetLabelIcon={setLabelIconPath}
        onRenameLabel={renameLabelPath}
        onDeleteLabel={deleteLabelPath}
        onSelectLocal={selectLocal}
        onSelectArchived={selectArchived}
        localActive={localActive}
        localUpdateCount={localUpdateCount}
        archivedActive={archivedActive}
        archivedCount={archivedSkills.length}
        mobileOpen={mobileSidebarOpen}
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
            allLabels={treeRows.map((r) => r.path)}
            onBack={back}
            onPrev={() => go(-1)}
            onNext={() => go(1)}
            onToggleStar={() => toggleStar(skill.id)}
            onToggleInstalled={() => setInstalled(skill.id, skill.installStatus === "none")}
            onToggleLabel={(path) => toggleSkillLabel(skill.id, path)}
            onSelectLabel={selectLabel}
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
            breadcrumb={breadcrumb}
            activeLabel={activeLabel}
            onOpen={open}
            onToggleStar={toggleStar}
            onUpload={openUpload}
            lastId={lastId}
            filters={filters}
            onToggleFilter={toggleFilter}
            onRemoveFilter={removeFilter}
            onClearFilters={clearFilters}
            preferenceStatus={preferenceStatus}
            onRetryPreferences={retryPreferenceSave}
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
          allLabels={treeRows.map((r) => r.path)}
          defaultLabels={activeLabel ? [activeLabel] : []}
          onClose={closeUpload}
          onPublished={() => router.refresh()}
        />
      )}
      {updateSkill && (
        <UploadDialog
          mode="update"
          skill={updateSkill}
          allLabels={treeRows.map((r) => r.path)}
          onClose={() => setUpdateSkill(null)}
          onPublished={() => router.refresh()}
        />
      )}
      {installSkill && (
        <InstallDialog skill={installSkill} onClose={() => setInstallSkill(null)} />
      )}
      {labelNotice && (
        <div className="og-toast" role="alert" onClick={() => setLabelNotice(null)}>
          {labelNotice}
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
