"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Scope } from "@companion/contracts";
import { setSkillScope, toggleStar as toggleStarRpc } from "@/lib/queries";
import type { MeVM, OrgVM, SkillVM, TeamVM } from "@/lib/types";
import { Sidebar } from "./Sidebar";
import { ListView } from "./ListView";
import { DetailView } from "./DetailView";
import { CommandPalette } from "./CommandPalette";
import { UploadDrawer } from "./UploadDrawer";
import { Onboarding } from "../org/Onboarding";
import { useOrgActions } from "../org/useOrgActions";
import type { SettingsIntent } from "../org/model";
import {
  BUILTIN_VIEWS,
  chipParts,
  filtersKey,
  matchFilters,
  type Filter,
  type ViewDef,
} from "./filters";

export function SkillsApp({
  initialSkills,
  me,
  teams,
  orgs,
  currentOrg,
}: {
  initialSkills: SkillVM[];
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

  const [filters, setFilters] = useState<Filter[]>([]);
  const [customViews, setCustomViews] = useState<ViewDef[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [lastId, setLastId] = useState<string | null>(null);
  const viewSeq = useRef(0);
  const openIdRef = useRef<string | null>(null);
  const uploadReturnRef = useRef<HTMLElement | null>(null);

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
        : [...fs, { type, value }],
    );
  }, []);
  const removeFilter = useCallback(
    (f: Filter) => setFilters((fs) => fs.filter((x) => !(x.type === f.type && x.value === f.value))),
    [],
  );
  const clearFilters = useCallback(() => setFilters([]), []);
  const saveView = useCallback(() => {
    setFilters((fs) => {
      const name =
        fs
          .map((f) => chipParts(f).val)
          .map((v) => v[0]?.toUpperCase() + v.slice(1))
          .join(" · ") || "View";
      viewSeq.current += 1;
      const id = "view-" + viewSeq.current;
      setCustomViews((cv) => [
        ...cv,
        { id, name, icon: "bookmark", custom: true, filters: fs.map((f) => ({ ...f })) },
      ]);
      return fs;
    });
  }, []);
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
  }, [openId, paletteOpen, back, go]);

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
        <UploadDrawer
          teams={teams}
          onClose={closeUpload}
          onUploaded={() => {
            closeUpload();
            router.refresh();
          }}
        />
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
