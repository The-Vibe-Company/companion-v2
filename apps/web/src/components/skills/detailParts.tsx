"use client";

import { useEffect, useRef, useState } from "react";
import type { SkillCommentRow, SkillVisibilityInput, SkillVersionRow } from "@companion/contracts";
import { Icon } from "../Icon";
import { relativeTime } from "@/lib/format";
import type { MeVM, SkillVM, TeamVM } from "@/lib/types";
import { Avatar, ValidBadge, visibilityMeta } from "./blocks";

export function VisibilityControl({
  skill,
  teams,
  onChange,
}: {
  skill: SkillVM;
  teams: TeamVM[];
  onChange: (visibility: SkillVisibilityInput) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
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
  return (
    <span className="vis" ref={ref}>
      <button
        className="vis__btn"
        onClick={() => setOpen((o) => !o)}
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
        <div className="menu" role="menu">
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
              <span className="ico">
                <Icon name="users" size={14} />
              </span>
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
}: {
  skill: SkillVM;
  teams: TeamVM[];
  onChangeVisibility: (visibility: SkillVisibilityInput) => void;
}) {
  const meta = visibilityMeta(skill);
  const teamNames = skill.teams.map((team) => team.name).join(", ");
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
          <VisibilityControl skill={skill} teams={teams} onChange={onChangeVisibility} />
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
