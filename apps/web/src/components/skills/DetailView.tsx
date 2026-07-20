"use client";

import { useEffect, useRef, useState } from "react";
import type {
  SkillCommentRow,
  SkillDependenciesResponse,
  SkillFile,
  SkillRunRow,
  SkillVersionRow,
} from "@companion/contracts";
import { Icon } from "../Icon";
import {
  addComment as addCommentRpc,
  fetchSkillDependencies,
  fetchSkillDetail,
  fetchSkillVersionFiles,
  skillFileContentUrl,
  setCommentDeprecated as setCommentDeprecatedRpc,
} from "@/lib/queries";
import type { MeVM, SkillVM } from "@/lib/types";
import { Avatar } from "./blocks";
import {
  Activity,
  FiledIn,
  ManifestRows,
  Requirements,
  Section,
} from "./detailParts";
import { DependenciesTab } from "./DependenciesTab";
import { RunSessionsTab } from "../runs/RunSessionsTab";
import { RunLauncherDialog } from "../runs/RunLauncherDialog";
import type { RunLauncherDraft } from "../runs/launcherState";
import { fetchRuns } from "@/lib/runQueries";
import { FileExplorer } from "./fileview";
import { MarkdownView } from "./markdown";
import { Discussion } from "./discussion";
import { SkillSecretConfiguration } from "../secrets/SkillSecretConfiguration";
import {
  resolveSkillActions,
  skillActionPermissions,
  type SkillAction,
} from "./skillActions";

export function DetailMoreMenuContent({
  actions,
  onAction,
}: {
  actions: SkillAction[];
  onAction: (action: SkillAction) => void;
}) {
  return (
    <div className="menu dmore__menu" role="menu">
      <div className="menu__head">Actions</div>
      {actions.map((action) => (
        <button
          key={action.id}
          className="menu__item"
          role="menuitem"
          aria-label={action.label}
          title={action.label}
          onClick={() => onAction(action)}
        >
          <span className="ico">
            <Icon name={action.icon} size={14} />
          </span>
          <span className="menu__label">{action.contextualLabel ?? action.label}</span>
        </button>
      ))}
    </div>
  );
}

function DetailMoreMenu({
  actions,
  onAction,
}: {
  actions: SkillAction[];
  onAction: (action: SkillAction) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    ref.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const choose = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <span
      className="dmore"
      ref={ref}
      onKeyDown={(event) => {
        if (!open) return;
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(false);
          ref.current?.querySelector<HTMLButtonElement>(".iconbtn")?.focus();
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const next = event.key === "ArrowDown" ? current + 1 : current - 1;
        items[(next + items.length) % items.length]?.focus();
      }}
    >
      <button
        className="iconbtn"
        title="More actions"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((next) => !next)}
      >
        <Icon name="more-horizontal" size={15} />
      </button>
      {open && (
        <DetailMoreMenuContent
          actions={actions}
          onAction={(action) => choose(() => onAction(action))}
        />
      )}
    </span>
  );
}

/** The detail page's top-level sections, shown as a tab bar under the breadcrumb. */
type DetailTab = "overview" | "files" | "dependencies" | "activity" | "discussion" | "sessions";

// Only the active tabpanel is mounted (the Files explorer + scroll-spy shouldn't run
// hidden). All tabs therefore point `aria-controls` at one stable panel id so no tab
// references a missing element; the panel names its controlling tab via aria-labelledby.
const DETAIL_PANEL_ID = "skill-detail-panel";

export function normalizeSkillNotes(value: string | null | undefined): string {
  if (!value) return "";
  const lines = value.replace(/\r\n/g, "\n").split("\n");
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first < 0) return "";

  const heading = lines[first]?.match(/^\s{0,3}#{1,6}\s+What it (?:does|has)\b\s*:?\s*(.*)$/i);
  if (heading) {
    const remainder = (heading[1] ?? "").trim();
    if (remainder) {
      lines[first] = remainder;
    } else {
      lines.splice(first, 1);
      while (lines[first]?.trim() === "") lines.splice(first, 1);
    }
  }
  return lines.join("\n").trim();
}

function SkillNotes({ value }: { value: string | null | undefined }) {
  const notes = normalizeSkillNotes(value);
  if (!notes) return null;
  return (
    <div className="skillnotes">
      <MarkdownView content={notes} />
    </div>
  );
}

interface TabDef {
  id: DetailTab;
  label: string;
  icon: string;
  count?: number;
}

/** Accessible tablist: roving tabindex, arrow/Home/End navigation, activation follows focus. */
function DetailTabs({
  tabs,
  active,
  onSelect,
}: {
  tabs: TabDef[];
  active: DetailTab;
  onSelect: (id: DetailTab) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div
      className="dtabs"
      role="tablist"
      aria-label="Skill detail sections"
      ref={ref}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const idx = tabs.findIndex((t) => t.id === active);
        const next =
          event.key === "ArrowRight"
            ? (idx + 1) % tabs.length
            : event.key === "ArrowLeft"
              ? (idx - 1 + tabs.length) % tabs.length
              : event.key === "Home"
                ? 0
                : tabs.length - 1;
        const nextTab = tabs[next];
        if (!nextTab) return;
        onSelect(nextTab.id);
        ref.current?.querySelector<HTMLButtonElement>(`#dtab-${nextTab.id}`)?.focus();
      }}
    >
      {tabs.map((t) => (
        <button
          key={t.id}
          id={`dtab-${t.id}`}
          type="button"
          role="tab"
          className="dtab"
          aria-selected={active === t.id}
          aria-controls={DETAIL_PANEL_ID}
          tabIndex={active === t.id ? 0 : -1}
          onClick={() => onSelect(t.id)}
        >
          <Icon name={t.icon} size={14} />
          {t.label}
          {t.count != null && <span className="dtab__count mono">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

export function DetailView({
  skill,
  index,
  total,
  me,
  orgName,
  allLabels,
  onBack,
  onPrev,
  onNext,
  onToggleLabel,
  onSelectLabel,
  onAction,
  onOpenSkill,
  onOpenRun,
  onOpenModelSettings,
  initialTab,
  runDraft,
  onRunDraftChange,
  runAgainRequested,
  onRunAgainConsumed,
  orgId = "",
  historyEnabled = true,
  onUpgrade = () => {},
}: {
  skill: SkillVM;
  index: number;
  total: number;
  me: MeVM;
  orgName: string;
  orgId?: string;
  /** Every folder path in this skill's library (for the "Add to folder" picker). */
  allLabels: string[];
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
  /** Assign / unassign a folder path on this skill (toggle). */
  onToggleLabel: (path: string) => void;
  /** Navigate to a folder's scope (chip click). */
  onSelectLabel: (path: string) => void;
  onAction: (action: SkillAction) => void;
  onOpenSkill: (slug: string) => void;
  /** Open a run transcript/chat (`?skill=…&run=…`). */
  onOpenRun: (runId: string) => void;
  /** Open Settings → Models (the launcher's "Add more models" — the shell owns the surface). */
  onOpenModelSettings?: () => void;
  /** Land on this tab when opening the skill (Back from a run returns to Sessions). */
  initialTab?: "overview" | "sessions";
  /** Full per-skill draft, including the one-shot Run again snapshot. */
  runDraft?: RunLauncherDraft | null;
  onRunDraftChange?: (draft: RunLauncherDraft | null) => void;
  runAgainRequested?: boolean;
  /** Consume the one-shot launcher-open request (run-again). */
  onRunAgainConsumed?: () => void;
  historyEnabled?: boolean;
  onUpgrade?: () => void;
}) {
  const invalid = skill.validation === "invalid";
  const [versions, setVersions] = useState<SkillVersionRow[]>([]);
  const [comments, setComments] = useState<SkillCommentRow[]>([]);
  const [files, setFiles] = useState<SkillFile[]>([]);
  const [deps, setDeps] = useState<SkillDependenciesResponse | null>(null);
  const [runs, setRuns] = useState<SkillRunRow[]>([]);
  const [runsLoading, setRunsLoading] = useState(true);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runsReload, setRunsReload] = useState(0);
  const [launcherOpen, setLauncherOpen] = useState(false);
  const [tab, setTab] = useState<DetailTab>(initialTab ?? "overview");

  // Reset to the initial tab when opening a different skill (not on a version bump).
  useEffect(() => {
    setTab(initialTab ?? "overview");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skill.id, initialTab]);

  // The "Run again" path (from a frozen/errored transcript) opens the launcher prefilled.
  useEffect(() => {
    if (!runAgainRequested) return;
    setLauncherOpen(true);
  }, [runAgainRequested]);

  useEffect(() => {
    let active = true;
    setFiles([]);
    // Clear the previous skill's discussion/versions so they don't flash under the new title.
    setComments([]);
    setVersions([]);
    fetchSkillDetail(skill.id, skill.version)
      .then((d) => {
        if (!active) return;
        setVersions(d.versions);
        setComments(d.comments);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [skill.id, skill.version]);

  // Eagerly load the package file list once per (slug, version); the archive has
  // no random access, so one fetch beats lazily re-streaming per file.
  useEffect(() => {
    if (!skill.version) {
      setFiles([]);
      return;
    }
    let active = true;
    fetchSkillVersionFiles(skill.id, skill.version)
      .then((res) => {
        if (active) setFiles(res.files);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [skill.id, skill.version]);

  // Resolve the dependency graph (Requires + Used by) for the tab and the rail counters.
  useEffect(() => {
    let active = true;
    setDeps(null);
    fetchSkillDependencies(skill.id, skill.version)
      .then((d) => {
        if (active) setDeps(d);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [skill.id, skill.version]);

  useEffect(() => {
    setRuns([]);
    setRunsError(null);
  }, [skill.id]);

  // The caller's runs of this skill (Sessions tab + tab count). A failed first load is distinct
  // from a legitimate empty history; retries preserve any last valid snapshot.
  useEffect(() => {
    let active = true;
    setRunsLoading(true);
    setRunsError(null);
    fetchRuns(skill.id)
      .then((r) => {
        if (!active) return;
        setRuns(r.runs);
        setRunsError(null);
      })
      .catch((cause) => {
        if (active) setRunsError(cause instanceof Error ? cause.message : "Could not load your run history.");
      })
      .finally(() => {
        if (active) setRunsLoading(false);
      });
    return () => {
      active = false;
    };
  }, [skill.id, runsReload]);

  // Flat model: skills carry no owner/visibility axis — every member can do anything to any skill.
  const canModifySkill = true;
  const canDeprecate = (c: SkillCommentRow): boolean =>
    // Hide the control on a still-optimistic row (a PATCH to a tmp id would 404).
    !c.id.startsWith("tmp-") &&
    (c.author_id === me.id || canModifySkill);

  const addComment = (
    body: string,
    opts: { parentId?: string | null; versionId?: string | null; images?: File[] },
  ) => {
    const parentId = opts.parentId ?? null;
    const versionId = opts.versionId ?? null;
    const images = opts.images ?? [];
    // Unique even when two comments (e.g. a thread + a reply) are sent within the same millisecond.
    const tmpId = `tmp-${crypto.randomUUID()}`;
    // Local object-URL previews so the attachments render instantly; revoked once the row is settled.
    const previews = images.map((file, i) => ({
      id: `tmp-img-${i}`,
      content_type: file.type,
      byte_size: file.size,
      position: i,
      url: URL.createObjectURL(file),
    }));
    const revokePreviews = () => previews.forEach((p) => URL.revokeObjectURL(p.url));
    const optimistic: SkillCommentRow = {
      id: tmpId,
      skill_id: skill.uuid,
      author_id: me.id,
      body,
      created_at: new Date().toISOString(),
      author_name: me.name,
      author_initials: me.initials,
      author_avatar_url: me.avatarUrl,
      parent_id: parentId,
      version_id: versionId,
      version: versionId ? (versions.find((v) => v.id === versionId)?.version ?? null) : null,
      deprecated: false,
      images: previews,
    };
    setComments((c) => [...c, optimistic]);
    addCommentRpc(skill.id, body, { parentId, versionId, images })
      .then((row) => {
        revokePreviews();
        setComments((c) =>
          c.map((x) =>
            x.id === tmpId
              ? // Server row carries persistent image urls but no author display fields; keep ours.
                { ...row, author_name: me.name, author_initials: me.initials, author_avatar_url: me.avatarUrl }
              : // Re-point any optimistic reply that targeted this still-pending root.
                x.parent_id === tmpId
                ? { ...x, parent_id: row.id }
                : x,
          ),
        );
      })
      .catch(() => {
        revokePreviews();
        setComments((c) => c.filter((x) => x.id !== tmpId));
      });
  };

  const toggleDeprecated = (id: string, next: boolean) => {
    setComments((c) => c.map((x) => (x.id === id ? { ...x, deprecated: next } : x)));
    setCommentDeprecatedRpc(skill.id, id, next)
      .then((row) =>
        setComments((c) =>
          c.map((x) =>
            x.id === id
              ? { ...row, author_name: x.author_name, author_initials: x.author_initials, author_avatar_url: x.author_avatar_url }
              : x,
          ),
        ),
      )
      .catch(() =>
        setComments((c) => c.map((x) => (x.id === id ? { ...x, deprecated: !next } : x))),
      );
  };

  const reqN = deps?.requires_n ?? skill.requiresCount;
  const usedN = deps?.used_by_n ?? skill.usedByCount;
  const description = skill.display?.summary ?? skill.description;
  const hasNotes = normalizeSkillNotes(skill.notes).length > 0;

  const showDeps = reqN + usedN > 0;
  const tabs: TabDef[] = [
    { id: "overview", label: "Overview", icon: "package" },
    { id: "files", label: "Files", icon: "file-text", count: files.length },
    ...(showDeps
      ? [{ id: "dependencies" as const, label: "Dependencies", icon: "layers", count: reqN + usedN }]
      : []),
    { id: "activity", label: "Activity", icon: "activity", count: versions.length },
    { id: "discussion", label: "Discussion", icon: "message-square", count: comments.length },
    { id: "sessions", label: "Sessions", icon: "play", count: runs.length },
  ];
  // Guard against a stale "dependencies" tab if the count just dropped to zero.
  const activeTab: DetailTab = tab === "dependencies" && !showDeps ? "overview" : tab;

  // Library-aware framing. A personal skill or an installed copy lives in "My Skills"; everything else
  // is an org skill. Only the owner can open a personal skill (server-enforced), so Share is owner-safe.
  const inMyLibrary = skill.scope === "personal" || skill.source === "installed";
  const libLabel = inMyLibrary ? "My Skills" : orgName;
  const isInstalledCopy = skill.source === "installed";
  const actionModel = resolveSkillActions(skill, skillActionPermissions(skill, me.id));
  const eyebrow = skill.scope === "personal" ? "Personal skill" : isInstalledCopy ? "Installed skill" : "Organization skill";
  const eyebrowIcon = skill.scope === "personal" ? "user" : isInstalledCopy ? "download" : "building-2";
  const currentVersion = skill.version;

  return (
    <div className="dpage">
      <div className="dtop">
        <div className="crumb">
          <button className="crumb__btn" onClick={onBack}>
            <Icon name={inMyLibrary ? "user" : "building-2"} size={13} />
            {libLabel}
          </button>
          <span className="crumb__sep">/</span> <b>{skill.id}</b>
        </div>
        <span className="dtop__spacer" />
        <span className="navpair">
          <button title="Previous skill" onClick={onPrev} disabled={index <= 0}>
            <Icon name="chevron-up" size={15} />
          </button>
          <button title="Next skill" onClick={onNext} disabled={index >= total - 1}>
            <Icon name="chevron-down" size={15} />
          </button>
        </span>
        <span className="count tnum">
          {index + 1} / {total}
        </span>
        {!skill.archived && (
          <button
            className="btn-ghost"
            disabled={invalid || !skill.version}
            onClick={() => setLauncherOpen(true)}
            title={
              invalid
                ? "Resolve validation errors first"
                : !skill.version
                  ? "No published version yet"
                  : "Run this skill in a sandboxed session"
            }
          >
            <Icon name="play" size={14} />
            Run skill
          </button>
        )}
        {actionModel.primary && (
          <button
            className="btn-primary"
            onClick={() => onAction(actionModel.primary!)}
            aria-label={actionModel.primary.label}
            title={actionModel.primary.label}
          >
            <Icon name={actionModel.primary.icon} size={14} />
            {actionModel.primary.contextualLabel ?? actionModel.primary.label}
          </button>
        )}
        {actionModel.secondary.length > 0 && (
          <DetailMoreMenu actions={actionModel.secondary} onAction={onAction} />
        )}
      </div>

      <DetailTabs tabs={tabs} active={activeTab} onSelect={setTab} />

      <div
        className={"dpanel " + (activeTab === "files" ? "dpanel--files" : "dpanel--doc")}
        role="tabpanel"
        id={DETAIL_PANEL_ID}
        aria-labelledby={`dtab-${activeTab}`}
        tabIndex={0}
      >
        {activeTab === "overview" && (
          <div className="ddoc">
            <div className="dhead">
              <p className="lin-eyebrow">
                <Icon name={eyebrowIcon} size={13} />
                {eyebrow}
              </p>
              <div className="dtitlebar">
                <h1 className="dtitle dtitle--linear">{skill.display?.name ?? skill.id}</h1>
              </div>
              {skill.display?.name ? <p className="dslug mono">{skill.id}</p> : null}
              <p className="ov__lead ov__lead--linear">{description}</p>
              <p className="dbyline">
                <Avatar initials={skill.authorInitials} avatarUrl={skill.authorAvatarUrl} size={16} />
                <span>
                  Created by <span className="dbyline__name">{skill.authorName}</span>
                </span>
                {skill.updaterId !== skill.authorId && (
                  <>
                    <span aria-hidden="true">·</span>
                    <Avatar initials={skill.updaterInitials} avatarUrl={skill.updaterAvatarUrl} size={16} />
                    <span>
                      Updated by <span className="dbyline__name">{skill.updaterName}</span>
                    </span>
                  </>
                )}
              </p>
              {isInstalledCopy && (
                <div className="ls-confirm dinstalled-note">
                  <Icon name="info" size={15} />
                  <span>
                    Installed from <b>{orgName}</b>. The original lives in the organization library. Personal
                    folders do not apply to installed skills.
                  </span>
                </div>
              )}
              {/* Installed copies are not personally filed — hide the folder picker for them. */}
              {!isInstalledCopy && (
                <FiledIn
                  skill={skill}
                  allLabels={allLabels}
                  onToggleLabel={onToggleLabel}
                  onSelectLabel={onSelectLabel}
                />
              )}
            </div>

            {invalid && skill.error && (
              <div className="lin-alert">
                <p className="seclabel" style={{ color: "var(--color-danger)", marginBottom: 8 }}>
                  Validation error
                </p>
                <div className="errblock">{skill.error}</div>
              </div>
            )}

            <div className="dsections">
              {hasNotes && (
                <Section label="Notes" defaultOpen>
                  <SkillNotes value={skill.notes} />
                </Section>
              )}

              {skill.requirements.length > 0 && (
                <Section label="Setup & secrets" count={skill.requirements.length} defaultOpen>
                  <Requirements requirements={skill.requirements} />
                  <SkillSecretConfiguration slug={skill.id} canSuggest={skill.scope === "org" || skill.authorId === me.id} />
                </Section>
              )}

              <Section label="Manifest">
                <div className="props">
                  <ManifestRows skill={skill} />
                </div>
              </Section>
            </div>
          </div>
        )}

        {activeTab === "files" && (
          <FileExplorer
            files={files}
            requestedPath={null}
            contentUrlForPath={currentVersion ? (path) => skillFileContentUrl(skill.id, currentVersion, path) : undefined}
          />
        )}

        {activeTab === "dependencies" && (
          <div className="ddoc">
            <DependenciesTab
              slug={skill.id}
              version={skill.version}
              deps={deps}
              onOpenSkill={onOpenSkill}
            />
          </div>
        )}

        {activeTab === "activity" && (
          <div className="ddoc">
            {!historyEnabled && (
              <div className="entitlement-bar entitlement-bar--detail" role="status">
                <Icon name="lock" size={14} />
                <span>Free shows the current version only. Upgrade to Pro to browse the full version history.</span>
                <button className="btn-sec" onClick={onUpgrade}>View plans</button>
              </div>
            )}
            <Activity
              versions={versions}
              fallbackAuthor={{
                name: skill.authorName,
                initials: skill.authorInitials,
                avatarUrl: skill.authorAvatarUrl,
              }}
            />
          </div>
        )}

        {activeTab === "discussion" && (
          <div className="ddoc">
            <Discussion
              comments={comments}
              versions={versions}
              me={{ id: me.id, name: me.name, initials: me.initials, avatarUrl: me.avatarUrl }}
              canDeprecate={canDeprecate}
              onAdd={addComment}
              onToggleDeprecated={toggleDeprecated}
            />
          </div>
        )}

        {activeTab === "sessions" && (
          <RunSessionsTab
            runs={runs}
            loading={runsLoading}
            error={runsError}
            onRetry={() => setRunsReload((value) => value + 1)}
            onOpen={onOpenRun}
          />
        )}
      </div>

      {launcherOpen && (
        <RunLauncherDialog
          key={skill.id}
          slug={skill.id}
          orgId={orgId}
          initialDraft={runDraft}
          onOpenModelSettings={onOpenModelSettings}
          onStashDraft={(draft) => onRunDraftChange?.(draft)}
          onLaunched={(run) => {
            setLauncherOpen(false);
            onRunDraftChange?.(null);
            onRunAgainConsumed?.();
            setRuns((prev) => [
              {
                id: run.id,
                skill_slug: run.skill_slug,
                skill_version: run.skill_version,
                model: run.model,
                prompt_excerpt: run.prompt_excerpt,
                status: run.status,
                status_detail: run.status_detail,
                phase: run.phase,
                error_code: run.error_code,
                error_message: run.error_message,
                run_config_id: run.run_config_id,
                run_config_name_snapshot: run.run_config_name_snapshot,
                created_at: run.created_at,
                last_active_at: run.last_active_at,
              },
              ...prev,
            ]);
            onOpenRun(run.id);
          }}
          onClose={() => {
            setLauncherOpen(false);
            onRunAgainConsumed?.();
          }}
        />
      )}
    </div>
  );
}
