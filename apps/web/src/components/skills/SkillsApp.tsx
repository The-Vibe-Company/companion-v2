"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Scope, SkillFilterPreferences } from "@companion/contracts";
import { saveSkillFilterPreferences, setSkillScope, toggleStar as toggleStarRpc } from "@/lib/queries";
import type { MeVM, OrgVM, SkillVM, TeamVM } from "@/lib/types";
import { Sidebar } from "./Sidebar";
import { ListView } from "./ListView";
import { DetailView } from "./DetailView";
import { CommandPalette } from "./CommandPalette";
import { UploadDialog, InstallDialog } from "./UploadDialog";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import type { SettingsIntent } from "../org/model";
import {
  BUILTIN_VIEWS,
  chipParts,
  filtersKey,
  makeFilter,
  matchFilters,
  type Filter,
  type ViewDef,
} from "./filters";

export function SkillsApp({
  initialSkills,
  initialFilterPreferences,
  me,
  teams,
  orgs,
  currentOrg,
}: {
  initialSkills: SkillVM[];
  initialFilterPreferences: SkillFilterPreferences;
  me: MeVM;
  teams: TeamVM[];
  orgs: OrgVM[];
  currentOrg: OrgVM;
}) {
  const router = useRouter();
  const orgActions = useOrgActions();
  const openSettings = useCallback(
    (intent?: SettingsIntent) => {
      const qs = new URLSearchParams();
      if (intent?.tab) qs.set("tab", intent.tab);
      if (intent?.dialog) qs.set("dialog", intent.dialog);
      const s = qs.toString();
      router.push("/settings" + (s ? `?${s}` : ""));
    },
    [router],
  );
  const [skills, setSkills] = useState<SkillVM[]>(initialSkills);
  useEffect(() => setSkills(initialSkills), [initialSkills]);
  useEffect(() => {
    document.cookie = `companion_org=${encodeURIComponent(currentOrg.id)}; path=/; SameSite=Lax`;
  }, [currentOrg.id]);

  const [filters, setFilters] = useState<Filter[]>(() => initialFilterPreferences.active_filters);
  const [customViews, setCustomViews] = useState<ViewDef[]>(() =>
    initialFilterPreferences.custom_views.map((v) => ({ ...v, custom: true })),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [updateSkill, setUpdateSkill] = useState<SkillVM | null>(null);
  const [installSkill, setInstallSkill] = useState<SkillVM | null>(null);
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

  useEffect(() => {
    setFilters(initialFilterPreferences.active_filters);
    setCustomViews(initialFilterPreferences.custom_views.map((v) => ({ ...v, custom: true })));
    didInitializePersistenceRef.current = false;
    setPreferenceStatus("idle");
    setOpenId(null);
  }, [currentOrg.id, preferenceKey, initialFilterPreferences]);

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

  const changeVisibility = useCallback((id: string, newScope: Scope) => {
    let prev: Scope | null = null;
    setSkills((arr) =>
      arr.map((s) => {
        if (s.id === id) {
          prev = s.scope;
          return { ...s, scope: newScope };
        }
        return s;
      }),
    );
    setSkillScope(id, newScope, null, currentOrg.id).catch(() => {
      if (prev) setSkills((arr) => arr.map((s) => (s.id === id ? { ...s, scope: prev as Scope } : s)));
    });
    // Keep the open skill visible if an active scope filter would now hide it.
    if (id === openIdRef.current) {
      setFilters((fs) => {
        const hasScope = fs.some((f) => f.type === "scope");
        if (hasScope && !fs.some((f) => f.type === "scope" && f.value === newScope)) {
          return fs.filter((f) => f.type !== "scope");
        }
        return fs;
      });
    }
  }, [currentOrg.id]);

  // --- Derived ---------------------------------------------------------------
  const owners = useMemo(() => [...new Set(skills.map((s) => s.owner.name))].sort(), [skills]);
  const teamCounts = useMemo(() => {
    const c: Record<string, number> = {};
    skills.forEach((s) => {
      if (s.teamSlug) c[s.teamSlug] = (c[s.teamSlug] || 0) + 1;
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
  const isMine =
    filters.length === 1 && filters[0]?.type === "owner" && filters[0]?.value === me.name;
  const myCount = useMemo(() => skills.filter((s) => s.owner.name === me.name).length, [skills, me.name]);

  // --- View / filter actions -------------------------------------------------
  const selectView = useCallback(
    (id: string) => {
      const v = [...BUILTIN_VIEWS, ...customViews].find((x) => x.id === id);
      if (v) {
        setFilters(v.filters.map((f) => ({ ...f })));
        setOpenId(null);
      }
    },
    [customViews],
  );
  const toggleFilter = useCallback((type: Filter["type"], value: string) => {
    setFilters((fs) =>
      fs.some((f) => f.type === type && f.value === value)
        ? fs.filter((f) => !(f.type === type && f.value === value))
        : (() => {
            const next = makeFilter(type, value);
            return next ? [...fs, next] : fs;
          })(),
    );
  }, []);
  const removeFilter = useCallback(
    (f: Filter) => setFilters((fs) => fs.filter((x) => !(x.type === f.type && x.value === f.value))),
    [],
  );
  const clearFilters = useCallback(() => setFilters([]), []);
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
  const retryPreferenceSave = useCallback(() => {
    if (!queuedPreferencesRef.current) persistPreferences(filters, customViews);
    else void flushPreferenceQueue();
  }, [customViews, filters, flushPreferenceQueue, persistPreferences]);
  const selectTeam = useCallback((teamId: string) => {
    setFilters([{ type: "team", value: teamId }]);
    setOpenId(null);
  }, []);
  const selectAll = useCallback(() => {
    setFilters([]);
    setOpenId(null);
  }, []);
  const selectMine = useCallback(() => {
    setFilters([{ type: "owner", value: me.name }]);
    setOpenId(null);
  }, [me.name]);

  // --- Open / navigate -------------------------------------------------------
  const index = openId ? filtered.findIndex((s) => s.id === openId) : -1;
  const skill = index >= 0 ? filtered[index] : null;
  openIdRef.current = openId;

  const open = useCallback((id: string) => {
    setUploadOpen(false);
    setOpenId(id);
    setLastId(id);
  }, []);
  const back = useCallback(() => setOpenId(null), []);
  const go = useCallback(
    (delta: number) => {
      setOpenId((cur) => {
        const i = filtered.findIndex((s) => s.id === cur);
        const n = filtered[i + delta];
        if (n) {
          setLastId(n.id);
          return n.id;
        }
        return cur;
      });
    },
    [filtered],
  );

  // If the open skill drops out of the filter, fall back to the list.
  useEffect(() => {
    if (openId && index < 0) setOpenId(null);
  }, [openId, index]);

  // Keyboard: ⌘K toggles palette; Esc back to list; ↑/↓ move between skills.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Modal dialogs own the keyboard while open (their own Esc closes them).
      if (uploadOpen || updateSkill || installSkill) return;
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
  }, [openId, paletteOpen, uploadOpen, updateSkill, installSkill, back, go]);

  return (
    <div className="app">
      <Sidebar
        orgs={orgs}
        currentOrg={currentOrg}
        onSwitchOrg={orgActions.switchOrg}
        onOnboard={(m) => orgActions.setOnboarding(m)}
        onOpenSettings={openSettings}
        teams={teams}
        totalCount={skills.length}
        myCount={myCount}
        teamCounts={teamCounts}
        activeTeam={activeTeam}
        isMine={isMine}
        workspaceActive={isAll}
        onOpenPalette={() => setPaletteOpen(true)}
        onSelectMine={selectMine}
        onSelectAll={selectAll}
        onSelectTeam={selectTeam}
      />
      <div className="main">
        {skill ? (
          <DetailView
            skill={skill}
            index={index}
            total={filtered.length}
            me={me}
            onBack={back}
            onPrev={() => go(-1)}
            onNext={() => go(1)}
            onToggleStar={() => toggleStar(skill.id)}
            onChangeVisibility={(sc) => changeVisibility(skill.id, sc)}
            onInstall={() => setInstallSkill(skill)}
            onUpdate={() => setUpdateSkill(skill)}
          />
        ) : (
          <ListView
            skills={filtered}
            onOpen={open}
            onUpload={openUpload}
            lastId={lastId}
            views={views}
            activeViewId={activeViewId}
            onSelectView={selectView}
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
    </div>
  );
}
