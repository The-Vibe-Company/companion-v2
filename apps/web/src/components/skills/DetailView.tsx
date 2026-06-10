"use client";

import { useEffect, useState } from "react";
import type {
  OrgRole,
  SkillVisibilityInput,
  SkillCommentRow,
  SkillFile,
  SkillVersionRow,
} from "@companion/contracts";
import { Icon } from "../Icon";
import {
  addComment as addCommentRpc,
  fetchSkillDetail,
  fetchSkillDownloadUrl,
  fetchSkillVersionFiles,
  setCommentDeprecated as setCommentDeprecatedRpc,
} from "@/lib/queries";
import type { MeVM, SkillVM, TeamVM } from "@/lib/types";
import { StarButton, ValidBadge, VisibilityChip } from "./blocks";
import { Activity, PropList } from "./detailParts";
import { FileExplorer } from "./fileview";
import { Discussion } from "./discussion";
import { fmtBytes, iconForFile } from "./fileFormat";

type Tab = "overview" | "files" | "activity";

export function DetailView({
  skill,
  index,
  total,
  me,
  myRole,
  onBack,
  onPrev,
  onNext,
  onToggleStar,
  onChangeVisibility,
  onInstall,
  onUpdate,
  teams,
}: {
  skill: SkillVM;
  index: number;
  total: number;
  me: MeVM;
  myRole: OrgRole;
  onBack: () => void;
  onPrev: () => void;
  onNext: () => void;
  onToggleStar: () => void;
  onChangeVisibility: (visibility: SkillVisibilityInput) => void;
  onInstall: () => void;
  onUpdate: () => void;
  teams: TeamVM[];
}) {
  const invalid = skill.validation === "invalid";
  const [tab, setTab] = useState<Tab>("overview");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [versions, setVersions] = useState<SkillVersionRow[]>([]);
  const [comments, setComments] = useState<SkillCommentRow[]>([]);
  const [files, setFiles] = useState<SkillFile[]>([]);

  useEffect(() => {
    let active = true;
    setTab("overview");
    setSelectedPath(null);
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

  const download = async () => {
    const url = await fetchSkillDownloadUrl(skill.id, skill.version);
    window.location.href = url;
  };

  const openFile = (path: string) => {
    setSelectedPath(path);
    setTab("files");
  };

  const ownerTeam = skill.owner.teamId
    ? teams.find((team) => team.dbId === skill.owner.teamId || team.id === skill.owner.handle)
    : null;
  const canModifySkill =
    myRole === "admin" ||
    myRole === "owner" ||
    (skill.owner.kind === "user" && skill.owner.userId === me.id) ||
    (skill.owner.kind === "team" && (ownerTeam?.role === "admin" || ownerTeam?.role === "editor"));
  const canDeprecate = (c: SkillCommentRow): boolean =>
    // Hide the control on a still-optimistic row (a PATCH to a tmp id would 404).
    !c.id.startsWith("tmp-") &&
    (c.author_id === me.id || canModifySkill);

  const addComment = (
    body: string,
    opts: { parentId?: string | null; versionId?: string | null },
  ) => {
    const parentId = opts.parentId ?? null;
    const versionId = opts.versionId ?? null;
    const tmpId = `tmp-${Date.now()}`;
    const optimistic: SkillCommentRow = {
      id: tmpId,
      skill_id: skill.uuid,
      author_id: me.id,
      body,
      created_at: new Date().toISOString(),
      author_name: me.name,
      author_initials: me.initials,
      parent_id: parentId,
      version_id: versionId,
      version: versionId ? (versions.find((v) => v.id === versionId)?.version ?? null) : null,
      deprecated: false,
    };
    setComments((c) => [...c, optimistic]);
    addCommentRpc(skill.id, body, { parentId, versionId })
      .then((row) =>
        setComments((c) =>
          c.map((x) =>
            x.id === tmpId
              ? { ...row, author_name: me.name, author_initials: me.initials }
              : // Re-point any optimistic reply that targeted this still-pending root.
                x.parent_id === tmpId
                ? { ...x, parent_id: row.id }
                : x,
          ),
        ),
      )
      .catch(() => setComments((c) => c.filter((x) => x.id !== tmpId)));
  };

  const toggleDeprecated = (id: string, next: boolean) => {
    setComments((c) => c.map((x) => (x.id === id ? { ...x, deprecated: next } : x)));
    setCommentDeprecatedRpc(skill.id, id, next)
      .then((row) =>
        setComments((c) =>
          c.map((x) =>
            x.id === id
              ? { ...row, author_name: x.author_name, author_initials: x.author_initials }
              : x,
          ),
        ),
      )
      .catch(() =>
        setComments((c) => c.map((x) => (x.id === id ? { ...x, deprecated: !next } : x))),
      );
  };

  const TABS: { id: Tab; label: string; icon: string; n?: number }[] = [
    { id: "overview", label: "Overview", icon: "file-text" },
    { id: "files", label: "Files", icon: "package-open", n: files.length },
    { id: "activity", label: "Activity", icon: "activity", n: versions.length },
  ];

  return (
    <div className="dpage">
      <div className="dtop">
        <div className="crumb">
          <button className="crumb__btn" onClick={onBack}>
            <Icon name="package" size={13} />
            Skills
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
        <button
          className="dsecbtn"
          onClick={onUpdate}
          disabled={!canModifySkill}
          title={canModifySkill ? "Publish a new version" : "Only the owner can publish a new version"}
        >
          <Icon name="git-commit" size={14} />
          Update
        </button>
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
        <button className="iconbtn" title="Download package" onClick={download}>
          <Icon name="package-2" size={15} />
        </button>
        <button className="iconbtn" title="More">
          <Icon name="more-horizontal" size={15} />
        </button>
      </div>

      <div className="viewbar dtabs" role="tablist" aria-label="Skill detail sections">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            id={`skilltab-${t.id}`}
            aria-selected={tab === t.id}
            aria-controls="skilltab-panel"
            className={"vtab" + (tab === t.id ? " is-active" : "")}
            onClick={() => setTab(t.id)}
          >
            <Icon name={t.icon} size={14} />
            {t.label}
            {t.n != null && <span className="vtab__count">{t.n}</span>}
          </button>
        ))}
      </div>

      {tab === "files" ? (
        <div
          className="dbody dbody--full"
          role="tabpanel"
          id="skilltab-panel"
          aria-labelledby={`skilltab-${tab}`}
        >
          <div className="dcontent dcontent--flush">
            <FileExplorer files={files} requestedPath={selectedPath} />
          </div>
        </div>
      ) : (
        <div
          className="dbody"
          role="tabpanel"
          id="skilltab-panel"
          aria-labelledby={`skilltab-${tab}`}
        >
          {tab === "overview" ? (
            <div className="dcontent">
              <div className="dcontent__inner">
                <h1 className="dtitle">{skill.id}</h1>
                <div className="dchips">
                  <VisibilityChip skill={skill} />
                  <ValidBadge v={skill.validation} />
                  <span
                    className="mono"
                    style={{ fontSize: "var(--text-xs)", color: "var(--color-muted)" }}
                  >
                    {skill.version ?? "—"}
                  </span>
                </div>
                <div className="ov">
                  {invalid && skill.error && (
                    <div>
                      <p className="seclabel" style={{ color: "var(--color-danger)" }}>
                        Validation error
                      </p>
                      <div className="errblock">{skill.error}</div>
                    </div>
                  )}
                  <p className="ov__lead">{skill.description}</p>

                  {files.length > 0 && (
                    <div className="contents">
                      <div className="contents__head">
                        <Icon name="package-open" size={14} />
                        <span className="contents__title">Package contents</span>
                        <span className="contents__n">{files.length} files</span>
                      </div>
                      <div className="contents__grid">
                        {files.map((f) => (
                          <button
                            className="contents__item"
                            key={f.path}
                            onClick={() => openFile(f.path)}
                            title={"Open " + f.path}
                          >
                            <Icon name={iconForFile(f.path)} size={15} />
                            <span className="contents__fname">{f.path}</span>
                            <span className="contents__fsize">{fmtBytes(f.size)}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  <Discussion
                    comments={comments}
                    versions={versions}
                    me={{ id: me.id, name: me.name, initials: me.initials }}
                    canDeprecate={canDeprecate}
                    onAdd={addComment}
                    onToggleDeprecated={toggleDeprecated}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="dcontent">
              <div className="dcontent__inner">
                <div className="dblocks">
                  <div>
                    <p className="seclabel">
                      Versions <span className="seclabel__n">{versions.length}</span>
                    </p>
                    <Activity versions={versions} ownerName={skill.owner.name} />
                  </div>
                </div>
              </div>
            </div>
          )}
          <aside className="dsidebar">
            <p className="railhead">Properties</p>
            <PropList
              skill={skill}
              teams={teams}
              onChangeVisibility={onChangeVisibility}
              canChangeVisibility={canModifySkill}
            />
          </aside>
        </div>
      )}
    </div>
  );
}
