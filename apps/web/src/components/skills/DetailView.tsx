"use client";

import { useEffect, useRef, useState } from "react";
import type {
  OrgRole,
  SkillCommentRow,
  SkillDependenciesResponse,
  SkillFile,
  SkillVersionRow,
} from "@companion/contracts";
import { Icon } from "../Icon";
import {
  addComment as addCommentRpc,
  fetchSkillDependencies,
  fetchSkillDetail,
  fetchSkillDownloadUrl,
  fetchSkillVersionFiles,
  skillFileContentUrl,
  setCommentDeprecated as setCommentDeprecatedRpc,
} from "@/lib/queries";
import type { MeVM, SkillVM } from "@/lib/types";
import { Avatar, StarButton } from "./blocks";
import {
  Activity,
  FiledIn,
  ManifestRows,
  Requirements,
  Section,
  StatusCard,
} from "./detailParts";
import { DependenciesTab } from "./DependenciesTab";
import { FileExplorer } from "./fileview";
import { MarkdownView } from "./markdown";
import { Discussion } from "./discussion";

export function DetailMoreMenuContent({
  canModifySkill,
  canDownload,
  canArchive,
  installed,
  onToggleInstalled,
  onUpdate,
  onDownload,
  onArchive,
}: {
  canModifySkill: boolean;
  canDownload: boolean;
  canArchive: boolean;
  installed: boolean;
  onToggleInstalled: () => void;
  onUpdate: () => void;
  onDownload: () => void;
  onArchive: () => void;
}) {
  return (
    <div className="menu dmore__menu" role="menu">
      <div className="menu__head">Actions</div>
      <button className="menu__item" role="menuitem" onClick={onToggleInstalled}>
        <span className="ico">
          <Icon name={installed ? "circle-x" : "circle-check"} size={14} />
        </span>
        <span className="menu__label">{installed ? "Mark as not installed" : "Mark as installed"}</span>
      </button>
      {canModifySkill && (
        <button className="menu__item" role="menuitem" onClick={onUpdate}>
          <span className="ico">
            <Icon name="git-commit" size={14} />
          </span>
          <span className="menu__label">Publish new version</span>
        </button>
      )}
      <button
        className="menu__item"
        role="menuitem"
        onClick={onDownload}
        disabled={!canDownload}
      >
        <span className="ico">
          <Icon name="package-2" size={14} />
        </span>
        <span className="menu__label">Download package</span>
      </button>
      {canArchive && (
        <button className="menu__item" role="menuitem" onClick={onArchive}>
          <span className="ico">
            <Icon name="archive" size={14} />
          </span>
          <span className="menu__label">Archive skill</span>
        </button>
      )}
    </div>
  );
}

function DetailMoreMenu({
  canModifySkill,
  canDownload,
  canArchive,
  installed,
  onToggleInstalled,
  onUpdate,
  onDownload,
  onArchive,
}: {
  canModifySkill: boolean;
  canDownload: boolean;
  canArchive: boolean;
  installed: boolean;
  onToggleInstalled: () => void;
  onUpdate: () => void;
  onDownload: () => void;
  onArchive: () => void;
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
          canModifySkill={canModifySkill}
          canDownload={canDownload}
          canArchive={canArchive}
          installed={installed}
          onToggleInstalled={() => choose(onToggleInstalled)}
          onUpdate={() => choose(onUpdate)}
          onDownload={() => choose(onDownload)}
          onArchive={() => choose(onArchive)}
        />
      )}
    </span>
  );
}

/** The detail page's top-level sections, shown as a tab bar under the breadcrumb. */
type DetailTab = "overview" | "files" | "dependencies" | "activity" | "discussion";

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
  myRole,
  orgName,
  allLabels,
  onBack,
  onPrev,
  onNext,
  onToggleStar,
  onToggleInstalled,
  onToggleLabel,
  onSelectLabel,
  onShare,
  onInstall,
  onUpdate,
  onOpenSkill,
  onRestore,
  onArchive,
}: {
  skill: SkillVM;
  index: number;
  total: number;
  me: MeVM;
  myRole: OrgRole;
  orgName: string;
  /** Every folder path in this skill's library (for the "Add to folder" picker). */
  allLabels: string[];
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleStar: () => void;
  onToggleInstalled: () => void;
  /** Assign / unassign a folder path on this skill (toggle). */
  onToggleLabel: (path: string) => void;
  /** Navigate to a folder's scope (chip click). */
  onSelectLabel: (path: string) => void;
  /** Share this personal skill into the org library (owner + authored only). */
  onShare: () => void;
  /** Open the install flow (hands the Companion agent the prompt; the agent reports back on install). */
  onInstall: () => void;
  onUpdate: () => void;
  onOpenSkill: (slug: string) => void;
  onRestore: () => void;
  onArchive: () => void;
}) {
  const invalid = skill.validation === "invalid";
  const [versions, setVersions] = useState<SkillVersionRow[]>([]);
  const [comments, setComments] = useState<SkillCommentRow[]>([]);
  const [files, setFiles] = useState<SkillFile[]>([]);
  const [deps, setDeps] = useState<SkillDependenciesResponse | null>(null);
  const [tab, setTab] = useState<DetailTab>("overview");

  // Reset to Overview when opening a different skill (not on a version bump).
  useEffect(() => {
    setTab("overview");
  }, [skill.id]);

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

  const download = async () => {
    const url = await fetchSkillDownloadUrl(skill.id, skill.version);
    window.location.href = url;
  };

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
  ];
  // Guard against a stale "dependencies" tab if the count just dropped to zero.
  const activeTab: DetailTab = tab === "dependencies" && !showDeps ? "overview" : tab;

  // Library-aware framing. A personal skill or an installed copy lives in "My Skills"; everything else
  // is an org skill. Only the owner can open a personal skill (server-enforced), so Share is owner-safe.
  const inMyLibrary = skill.scope === "personal" || skill.source === "installed";
  const libLabel = inMyLibrary ? "My Skills" : orgName;
  const isInstalledCopy = skill.source === "installed";
  const canShare = skill.scope === "personal" && !skill.archived;
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
        <StarButton starred={skill.starred} count={skill.stars} onToggle={onToggleStar} />
        {skill.archived ? (
          <button className="btn-ghost" onClick={onRestore} title="Restore this skill">
            <Icon name="rotate-ccw" size={14} />
            Restore
          </button>
        ) : canShare ? (
          <button className="btn-primary" onClick={onShare} title="Share this skill to the organization">
            <Icon name="send" size={14} />
            Share to organization
          </button>
        ) : (
          <button
            className="btn-primary"
            disabled={invalid || !skill.version}
            onClick={onInstall}
            title={
              invalid
                ? "Resolve validation errors first"
                : !skill.version
                  ? "No published version yet"
                  : "Install skill"
            }
          >
            <Icon name="download" size={14} />
            Install skill
          </button>
        )}
        <DetailMoreMenu
          canModifySkill={canModifySkill}
          canDownload={!!skill.version && (!skill.archived || (skill.referenced ?? skill.usedByCount > 0))}
          canArchive={canModifySkill && !skill.archived}
          installed={skill.installStatus !== "none"}
          onToggleInstalled={onToggleInstalled}
          onUpdate={onUpdate}
          onDownload={download}
          onArchive={onArchive}
        />
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
              <div className="dhead__main">
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
              <div className="dhead__aside">
                <StatusCard skill={skill} libLabel={isInstalledCopy ? "My Skills · installed" : libLabel} />
              </div>
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
      </div>
    </div>
  );
}
