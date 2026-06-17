"use client";

import { useEffect, useRef, useState } from "react";
import type { SkillCommentRow, SkillVisibilityInput, SkillVersionRow } from "@companion/contracts";
import { Icon } from "../Icon";
import { TeamAvatar } from "../org/TeamAvatar";
import { relativeTime } from "@/lib/format";
import type { MeVM, SkillVM, TeamVM } from "@/lib/types";
import { Avatar, ValidBadge, visibilityMeta } from "./blocks";

export type DetailPanel = "dependencies" | "requirements" | "files" | "activity" | "manifest" | "checksum";
export type DetailPanelItem = {
  id: DetailPanel;
  label: string;
  icon: string;
  count: string | number;
};

function metadataKeyLabel(key: string): string {
  return key.startsWith("companion_") ? key.slice("companion_".length).replaceAll("_", " ") : key;
}

export function VisibilityControl({
  skill,
  teams,
  onChange,
  canChange,
}: {
  skill: SkillVM;
  teams: TeamVM[];
  onChange: (visibility: SkillVisibilityInput) => void;
  canChange: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const meta = visibilityMeta(skill);
  const selected = new Set(skill.teamSlugs);
  const commit = (everyone: boolean, nextTeams: string[]) => onChange({ everyone, teams: nextTeams });
  const toggleTeam = (slug: string) => {
    const next = new Set(selected);
    if (next.has(slug)) next.delete(slug);
    else next.add(slug);
    commit(skill.visibility.everyone, [...next]);
  };
  useEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = menuPos.x - r.width;
    let top = menuPos.y;
    if (left < pad) left = pad;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [open, menuPos]);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, []);

  const toggleMenu = () => {
    setOpen((wasOpen) => {
      if (!wasOpen) {
        const r = btnRef.current?.getBoundingClientRect();
        if (r) setMenuPos({ x: r.right, y: r.bottom + 6 });
      }
      return !wasOpen;
    });
  };
  if (!canChange) {
    return (
      <span className="vis__btn vis__btn--readonly" title="Only the owner can change visibility" aria-label={`Visibility: ${meta.label}`}>
        <span className="lead">
          <Icon name={meta.icon} size={11} />
        </span>
        <span className="vis__label">{meta.label}</span>
        <span className="caret">
          <Icon name="lock" size={11} />
        </span>
      </span>
    );
  }
  return (
    <span className="vis" ref={ref}>
      <button
        ref={btnRef}
        className="vis__btn"
        onClick={toggleMenu}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <span className="lead">
          <Icon name={meta.icon} size={11} />
        </span>
        <span className="vis__label">{meta.label}</span>
        <span className="caret">
          <Icon name="chevron-down" size={12} />
        </span>
      </button>
      {open && (
        <div className="menu menu--fixed" role="menu" ref={menuRef}>
          <div className="menu__head">Visibility</div>
          <button
            role="menuitemcheckbox"
            aria-checked={skill.visibility.everyone}
            className={"menu__item" + (skill.visibility.everyone ? " is-sel" : "")}
            onClick={() => commit(!skill.visibility.everyone, skill.teamSlugs)}
          >
            <span className="ico">
              <Icon name="building-2" size={14} />
            </span>
            <span className="menu__label">Everyone</span>
            <span className="menu__desc">whole workspace</span>
            {skill.visibility.everyone && (
              <span className="menu__check">
                <Icon name="check" size={13} />
              </span>
            )}
          </button>
          {teams.length > 0 && <div className="menu__head">Teams</div>}
          {teams.map((team) => (
            <button
              key={team.id}
              role="menuitemcheckbox"
              aria-checked={selected.has(team.id)}
              className={"menu__item" + (selected.has(team.id) ? " is-sel" : "")}
              onClick={() => toggleTeam(team.id)}
            >
              <TeamAvatar team={team} className="ico menu__teamav" />
              <span className="menu__label">{team.name}</span>
              <span className="menu__desc">team</span>
              {selected.has(team.id) && (
                <span className="menu__check">
                  <Icon name="check" size={13} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function PropList({
  skill,
  teams,
  onChangeVisibility,
  canChangeVisibility,
  requiresN,
  usedByN,
  depFlag,
  onOpenDeps,
}: {
  skill: SkillVM;
  teams: TeamVM[];
  onChangeVisibility: (visibility: SkillVisibilityInput) => void;
  canChangeVisibility: boolean;
  /** Dependency counts for the rail (fall back to the list-row counts before the graph loads). */
  requiresN?: number;
  usedByN?: number;
  /** Set when at least one dependency is unsatisfied; `blocked` means a missing/cycle edge. */
  depFlag?: { n: number; blocked: boolean } | null;
  onOpenDeps?: () => void;
}) {
  const meta = visibilityMeta(skill);
  const teamNames = skill.teams.map((team) => team.name).join(", ");
  const reqN = requiresN ?? skill.requiresCount;
  const usedN = usedByN ?? skill.usedByCount;
  const flag = depFlag ?? (skill.depWarn ? { n: 0, blocked: false } : null);
  const metadataEntries = Object.entries(skill.metadata).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="props">
      <div className="prop">
        <span className="prop__label">
          <Icon name="activity" size={14} />
          Status
        </span>
        <span className="prop__value">
          <ValidBadge v={skill.validation} />
        </span>
      </div>
      <div className="prop">
        <span className="prop__label">
          <Icon name={meta.icon} size={14} />
          Visibility
        </span>
        <span className="prop__value">
          <VisibilityControl skill={skill} teams={teams} onChange={onChangeVisibility} canChange={canChangeVisibility} />
        </span>
      </div>
      <div className="prop">
        <span className="prop__label">
          <Icon name="tag" size={14} />
          Version
        </span>
        <span className="prop__value">
          <span className="mono" style={{ color: "var(--color-fg)" }}>
            {skill.version ?? "—"}
          </span>
        </span>
      </div>
      <div className="prop">
        <span className="prop__label">
          <Icon name="user" size={14} />
          Owner
        </span>
        <span className="prop__value">
          <Avatar initials={skill.owner.initials} />
          {skill.owner.name}
        </span>
      </div>
      <div className="prop">
        <span className="prop__label">
          <Icon name="users" size={14} />
          Teams
        </span>
        <span className="prop__value">
          <span className="mono" title={teamNames || undefined}>{teamNames || "—"}</span>
        </span>
      </div>
      <div className="divider" />
      <p className="railhead railhead--sub">Dependencies</p>
      <div className="depmeter">
        <button className="depmeter__cell" onClick={onOpenDeps} type="button">
          <span className="depmeter__top">
            <span className="depmeter__lbl">
              <Icon name="package" size={13} />
              Requires
            </span>
            {flag && (
              <span className={"depmeter__flag depmeter__flag--" + (flag.blocked ? "down" : "warn")}>
                <Icon name="alert-triangle" size={10} />
                {flag.n > 0 ? flag.n : null}
              </span>
            )}
          </span>
          <span className="depmeter__val">{reqN}</span>
        </button>
        <button className="depmeter__cell" onClick={onOpenDeps} type="button">
          <span className="depmeter__top">
            <span className="depmeter__lbl">
              <Icon name="corner-down-right" size={13} />
              Used by
            </span>
          </span>
          <span className="depmeter__val">{usedN}</span>
        </button>
      </div>
      <div className="divider" />
      <div className="prop">
        <span className="prop__label">
          <Icon name="calendar" size={14} />
          Created
        </span>
        <span className="prop__value">
          <span className="mono">{skill.created}</span>
        </span>
      </div>
      <div className="prop">
        <span className="prop__label">
          <Icon name="clock" size={14} />
          Updated
        </span>
        <span className="prop__value" style={{ color: "var(--color-muted)" }}>
          {skill.updated}
        </span>
      </div>
      <div className="prop">
        <span className="prop__label">
          <Icon name="hash" size={14} />
          Checksum
        </span>
        <span className="prop__value">
          <span className="mono" style={{ color: "var(--color-muted)" }}>
            {skill.checksum ?? "—"}
          </span>
          {skill.checksum && (
            <button
              className="iconbtn"
              style={{ width: 22, height: 22 }}
              title="Copy checksum"
              onClick={() => navigator.clipboard?.writeText(skill.checksum ?? "").catch(() => {})}
            >
              <Icon name="copy" size={12} style={{ color: "var(--color-faint)" }} />
            </button>
          )}
        </span>
      </div>
      <div className="divider" />
      <p className="railhead railhead--sub">Manifest</p>
      <div className="prop prop--stack">
        <span className="prop__label">
          <Icon name="layers" size={14} />
          Compatibility
        </span>
        <span className="prop__value">
          <span className="mono prop__wrap">{skill.compatibility ?? "—"}</span>
        </span>
      </div>
      <div className="prop prop--stack prop--metadata">
        <span className="prop__label">
          <Icon name="shield" size={14} />
          Allowed tools
          <span className="prop__count">{skill.tools.length}</span>
        </span>
        <span className="prop__value">
          {skill.tools.length ? (
            <span className="chips">
              {skill.tools.map((t) => (
                <span className="chip" key={t}>
                  {t}
                </span>
              ))}
            </span>
          ) : (
            <span style={{ color: "var(--color-muted)" }}>None declared</span>
          )}
        </span>
      </div>
      <div className="prop">
        <span className="prop__label">
          <Icon name="file-text" size={14} />
          License
        </span>
        <span className="prop__value">
          <span className="mono">{skill.license ?? "—"}</span>
        </span>
      </div>
      <div className="prop prop--stack">
        <span className="prop__label">
          <Icon name="braces" size={14} />
          Metadata
          <span className="prop__count">{metadataEntries.length}</span>
        </span>
        <span className="prop__value">
          {metadataEntries.length ? (
            <span className="kvlist">
              {metadataEntries.map(([key, value]) => (
                <span className="kv" key={key}>
                  <span className="kv__k" title={key} aria-label={key}>
                    {metadataKeyLabel(key)}
                  </span>
                  <span className="kv__v">{value}</span>
                </span>
              ))}
            </span>
          ) : (
            <span style={{ color: "var(--color-muted)" }}>None declared</span>
          )}
        </span>
      </div>
    </div>
  );
}

export function DetailRail({
  skill,
  teams,
  onChangeVisibility,
  canChangeVisibility,
  requiresN,
  usedByN,
  depFlag,
  panelItems,
  onOpenPanel,
}: {
  skill: SkillVM;
  teams: TeamVM[];
  onChangeVisibility: (visibility: SkillVisibilityInput) => void;
  canChangeVisibility: boolean;
  requiresN?: number;
  usedByN?: number;
  depFlag?: { n: number; blocked: boolean } | null;
  panelItems: DetailPanelItem[];
  onOpenPanel: (panel: DetailPanel) => void;
}) {
  const meta = visibilityMeta(skill);
  const reqN = requiresN ?? skill.requiresCount;
  const usedN = usedByN ?? skill.usedByCount;
  const flag = depFlag ?? (skill.depWarn ? { n: 0, blocked: false } : null);
  const depLabel = flag ? (flag.blocked ? "Blocked" : "Attention") : "Clean";
  const depTone = flag ? (flag.blocked ? "danger" : "warn") : "ok";
  return (
    <div className="linrail">
      <p className="railhead">Essential</p>
      <div className="linprop">
        <span className="linprop__label">
          <Icon name="activity" size={13} />
          Status
        </span>
        <span className="linprop__value">
          <ValidBadge v={skill.validation} />
        </span>
      </div>
      <div className="linprop">
        <span className="linprop__label">
          <Icon name={meta.icon} size={13} />
          Visibility
        </span>
        <span className="linprop__value">
          <VisibilityControl skill={skill} teams={teams} onChange={onChangeVisibility} canChange={canChangeVisibility} />
        </span>
      </div>
      <div className="linprop">
        <span className="linprop__label">
          <Icon name="tag" size={13} />
          Version
        </span>
        <span className="linprop__value">
          <span className="mono">{skill.version ?? "—"}</span>
        </span>
      </div>
      <div className="linprop">
        <span className="linprop__label">
          <Icon name="user" size={13} />
          Owner
        </span>
        <span className="linprop__value">
          <Avatar initials={skill.owner.initials} />
          <span className="linprop__truncate">{skill.owner.name}</span>
        </span>
      </div>
      <button className="linprop linprop--button" onClick={() => onOpenPanel("dependencies")} type="button">
        <span className="linprop__label">
          <Icon name="git-branch" size={13} />
          Dependencies
        </span>
        <span className={"linprop__value linprop__value--" + depTone}>
          <span className="linstatus">{depLabel}</span>
          <span className="mono">{reqN}/{usedN}</span>
        </span>
      </button>
      <div className="linprop">
        <span className="linprop__label">
          <Icon name="clock" size={13} />
          Updated
        </span>
        <span className="linprop__value">
          <span className="mono">{skill.updated}</span>
        </span>
      </div>

      <div className="divider" />
      <p className="railhead railhead--sub">More</p>
      <div className="linlinks">
        {panelItems.map((item) => (
          <button className="linlink" onClick={() => onOpenPanel(item.id)} type="button" key={item.id}>
            <span><Icon name={item.icon} size={13} /> {item.label}</span>
            <b>{item.count}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

export function ManifestDetails({ skill }: { skill: SkillVM }) {
  const metadataEntries = Object.entries(skill.metadata).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div className="dblocks dblocks--panel">
      <div>
        <p className="seclabel">
          <Icon name="braces" size={14} />
          Manifest
        </p>
        <p className="ov__lead" style={{ marginBottom: 18 }}>
          Runtime declarations from the published skill package. These values are inspectable, not
          marketing copy.
        </p>
        <div className="manifeststack">
          <div className="manifestrow">
            <span className="manifestrow__label">
              <Icon name="layers" size={13} />
              Compatibility
            </span>
            <span className="manifestrow__value mono">{skill.compatibility ?? "—"}</span>
          </div>
          <div className="manifestrow manifestrow--stack">
            <span className="manifestrow__label">
              <Icon name="shield" size={13} />
              Allowed tools
              <b>{skill.tools.length}</b>
            </span>
            <span className="manifestrow__value">
              {skill.tools.length ? (
                <span className="chips">
                  {skill.tools.map((tool) => (
                    <span className="chip" key={tool}>{tool}</span>
                  ))}
                </span>
              ) : (
                <span className="muted">None declared</span>
              )}
            </span>
          </div>
          <div className="manifestrow">
            <span className="manifestrow__label">
              <Icon name="file-text" size={13} />
              License
            </span>
            <span className="manifestrow__value mono">{skill.license ?? "—"}</span>
          </div>
          <div className="manifestrow manifestrow--stack">
            <span className="manifestrow__label">
              <Icon name="braces" size={13} />
              Metadata
              <b>{metadataEntries.length}</b>
            </span>
            <span className="manifestrow__value">
              {metadataEntries.length ? (
                <span className="kvlist">
                  {metadataEntries.map(([key, value]) => (
                    <span className="kv" key={key}>
                      <span className="kv__k" title={key} aria-label={key}>
                        {metadataKeyLabel(key)}
                      </span>
                      <span className="kv__v">{value}</span>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="muted">None declared</span>
              )}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ChecksumDetails({ checksum }: { checksum: string | null }) {
  return (
    <div className="dblocks dblocks--panel">
      <div>
        <p className="seclabel">
          <Icon name="hash" size={14} />
          Checksum
        </p>
        <p className="ov__lead" style={{ marginBottom: 18 }}>
          Digest for the current published package. Use it to verify the package downloaded from
          the registry.
        </p>
        <div className="checksumcard">
          <code>{checksum ?? "No checksum recorded"}</code>
          {checksum && (
            <button
              className="iconbtn"
              title="Copy checksum"
              aria-label="Copy checksum"
              onClick={() => navigator.clipboard?.writeText(checksum).catch(() => {})}
            >
              <Icon name="copy" size={13} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function Requirements({ requirements }: { requirements: SkillVM["requirements"] }) {
  return (
    <div className="dblocks">
      <div>
        <p className="seclabel">
          <Icon name="key-round" size={14} />
          Setup &amp; secrets <span className="seclabel__n">{requirements.length}</span>
        </p>
        <p className="ov__lead" style={{ marginBottom: 18 }}>
          Secrets and environment variables this skill needs to run. Set these before using it. The
          values themselves are never stored here.
        </p>
        {requirements.length ? (
          <div className="reqlist reqlist--full">
            {requirements.map((req) => (
              <div className="req" key={req.key}>
                <div className="req__head">
                  <span className="req__key mono">{req.key}</span>
                  <span className={`req__tag req__tag--${req.type}`}>{req.type}</span>
                  {req.required ? null : <span className="req__tag req__tag--optional">optional</span>}
                </div>
                {req.note ? <p className="req__note">{req.note}</p> : null}
              </div>
            ))}
          </div>
        ) : (
          <p style={{ color: "var(--color-muted)" }}>
            This skill declares no required secrets or environment variables.
          </p>
        )}
      </div>
    </div>
  );
}

export function Activity({
  versions,
  ownerName,
}: {
  versions: SkillVersionRow[];
  ownerName: string;
}) {
  return (
    <div className="feed">
      {versions.map((v, i) => (
        <div className="act" key={v.id}>
          <div className="act__rail">
            <span className={"act__node" + (i === 0 ? " act__node--cur" : "")}>
              <Icon name={i === 0 ? "upload" : "git-commit"} size={12} />
            </span>
            {i < versions.length - 1 && <span className="act__line" />}
          </div>
          <div className="act__body">
            <div className="act__top">
              <span className="act__who">{ownerName}</span>
              <span className="act__verb">published</span>
              <span className="act__ver">v{v.version}</span>
              {i === 0 && <span className="curtag">current</span>}
              <span className="act__time">{v.created_at.slice(0, 10)}</span>
            </div>
            <p className="act__note">{v.note}</p>
          </div>
        </div>
      ))}
      {versions.length === 0 && <div className="alist--empty">No versions yet.</div>}
    </div>
  );
}

export function Comments({
  list,
  me,
  onAdd,
}: {
  list: SkillCommentRow[];
  me: MeVM;
  onAdd: (text: string) => void;
}) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText("");
  };
  return (
    <div>
      <p className="seclabel">
        Comments <span className="seclabel__n">{list.length}</span>
      </p>
      <div className="comments">
        {list.map((c) => (
          <div className="comment" key={c.id}>
            <span className="avatar comment__avatar">{c.author_initials ?? "?"}</span>
            <div className="comment__body">
              <div className="comment__head">
                <span className="comment__who">{c.author_name ?? "Someone"}</span>
                <span className="comment__time">{relativeTime(c.created_at)}</span>
              </div>
              <p className="comment__text">{c.body}</p>
            </div>
          </div>
        ))}
        {!list.length && <div className="comments__empty">No comments yet. Start the thread.</div>}
      </div>
      <div className="composer">
        <span className="avatar comment__avatar">{me.initials}</span>
        <div className="composer__box">
          <textarea
            className="composer__input"
            rows={2}
            placeholder="Leave a comment…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
          <div className="composer__foot">
            <span className="composer__hint">⌘↵ to send</span>
            <button className="btn-primary" disabled={!text.trim()} onClick={submit}>
              Comment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
