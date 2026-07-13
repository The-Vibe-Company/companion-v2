"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillCommentRow, SkillVersionRow } from "@companion/contracts";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";
import { relativeTime } from "@/lib/format";
import type { MeVM, SkillVM } from "@/lib/types";

function metadataKeyLabel(key: string): string {
  return key.startsWith("companion_") ? key.slice("companion_".length).replaceAll("_", " ") : key;
}

/* ----------------------------------------------------------- folder filing */

/**
 * "Add to folder" picker: a `position: fixed` popover (clamped at the cursor, reusing the
 * `.menu--fixed` pattern so the scroll container never clips it) that searches existing label paths,
 * toggles assignment with a checkbox, and lets the actor create + assign a brand-new path. Labels are
 * org-wide shared, so every member sees and edits the same tree — there is no owner/visibility gate.
 */
function AddToFolder({
  filed,
  allLabels,
  onToggle,
  onCreate,
}: {
  filed: string[];
  allLabels: string[];
  onToggle: (path: string) => void;
  onCreate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [query, setQuery] = useState("");
  const wrapRef = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filedSet = useMemo(() => new Set(filed), [filed]);
  const q = query.trim().toLowerCase();
  const matches = useMemo(
    () => allLabels.filter((p) => !q || p.toLowerCase().includes(q)).sort((a, b) => a.localeCompare(b)),
    [allLabels, q],
  );
  // Offer to create the typed path only when it is a non-empty, not-yet-existing label.
  const typed = query.trim();
  const canCreate = typed.length > 0 && !allLabels.includes(typed) && !filedSet.has(typed);

  // Clamp the fixed popover into the viewport once it has measured its own size.
  useEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    let left = pos.x;
    let top = pos.y;
    if (left + r.width > window.innerWidth - pad) left = Math.max(pad, window.innerWidth - r.width - pad);
    if (top + r.height > window.innerHeight - pad) top = Math.max(pad, window.innerHeight - r.height - pad);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [open, pos]);

  useEffect(() => {
    if (!open) return;
    queueMicrotask(() => inputRef.current?.focus());
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const toggleMenu = () => {
    setOpen((wasOpen) => {
      if (!wasOpen) {
        const r = btnRef.current?.getBoundingClientRect();
        if (r) setPos({ x: r.left, y: r.bottom + 6 });
        setQuery("");
      }
      return !wasOpen;
    });
  };

  const create = () => {
    if (!canCreate) return;
    onCreate(typed);
    setQuery("");
  };

  return (
    <span className="addfolder" ref={wrapRef}>
      <button
        ref={btnRef}
        type="button"
        className="filedin__add"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggleMenu}
      >
        <Icon name="folder-plus" size={12} />
        Add to folder
      </button>
      {open && (
        <div className="menu menu--fixed addfolder__menu" role="menu" ref={menuRef}>
          <div className="addfolder__search">
            <Icon name="search" size={13} />
            <input
              ref={inputRef}
              className="addfolder__input"
              placeholder="Search or create marketing/seo…"
              value={query}
              aria-label="Search or create a folder"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canCreate) {
                  e.preventDefault();
                  create();
                }
              }}
            />
          </div>
          <div className="addfolder__list">
            {matches.map((path) => {
              const on = filedSet.has(path);
              return (
                <button
                  key={path}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={on}
                  className={"addfolder__item" + (on ? " is-on" : "")}
                  onClick={() => onToggle(path)}
                >
                  <span className={"addfolder__check" + (on ? " is-on" : "")}>
                    {on && <Icon name="check" size={11} />}
                  </span>
                  <Icon name="folder" size={13} />
                  <span className="addfolder__path">{path}</span>
                </button>
              );
            })}
            {matches.length === 0 && !canCreate && (
              <div className="addfolder__empty">No matching folders.</div>
            )}
          </div>
          {canCreate && (
            <button type="button" className="addfolder__create" role="menuitem" onClick={create}>
              <Icon name="plus" size={13} />
              <span>
                Create <span className="mono">{typed}</span>
              </span>
            </button>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * The "Filed in" row: the org-wide shared folders a skill is filed under. Each chip navigates to that
 * label's scope; the trailing control opens the "Add to folder" picker. Any member can file / unfile a
 * skill — labels carry no access semantics.
 */
export function FiledIn({
  skill,
  allLabels,
  onToggleLabel,
  onSelectLabel,
}: {
  skill: SkillVM;
  allLabels: string[];
  onToggleLabel: (path: string) => void;
  onSelectLabel: (path: string) => void;
}) {
  const filed = useMemo(() => [...skill.labels].sort((a, b) => a.localeCompare(b)), [skill.labels]);
  return (
    <div className="filedin">
      <span className="filedin__lead">
        <Icon name="folder" size={13} />
        Filed in
      </span>
      <span className="filedin__chips">
        {filed.map((path) => (
          <span className="filedin__chip" key={path}>
            <button
              type="button"
              className="filedin__chipgo"
              onClick={() => onSelectLabel(path)}
              title={`View ${path}`}
            >
              {path}
            </button>
            <button
              type="button"
              className="filedin__chipx"
              onClick={() => onToggleLabel(path)}
              aria-label={`Remove from ${path}`}
              title={`Remove from ${path}`}
            >
              <Icon name="x" size={11} />
            </button>
          </span>
        ))}
        {filed.length === 0 && <span className="filedin__none">No folders yet</span>}
        <AddToFolder
          filed={skill.labels}
          allLabels={allLabels}
          onToggle={onToggleLabel}
          onCreate={onToggleLabel}
        />
      </span>
    </div>
  );
}

/* ----------------------------------------------------------------- section */

/**
 * A stacked, collapsible detail section: an uppercase faint label with a chevron that rotates when
 * open, and its content below. Owns its own open/close state, seeded by `defaultOpen`.
 */
export function Section({
  label,
  count,
  defaultOpen = false,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={"dsection" + (open ? " is-open" : "")}>
      <button
        type="button"
        className="dsection__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dsection__chev" aria-hidden="true">
          <Icon name="chevron-right" size={14} />
        </span>
        <span className="dsection__label">{label}</span>
        {count != null && <span className="dsection__count mono">{count}</span>}
      </button>
      {open && <div className="dsection__body">{children}</div>}
    </section>
  );
}

/* ----------------------------------------------------------------- manifest */

/**
 * The manifest facts — compatibility, allowed tools, license, checksum, metadata. Shared by the
 * detail's Manifest section and the standalone `PropList`.
 */
export function ManifestRows({ skill }: { skill: SkillVM }) {
  const metadataEntries = Object.entries(skill.metadata).sort(([a], [b]) => a.localeCompare(b));
  return (
    <>
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
          <Icon name="hash" size={14} />
          Checksum
        </span>
        <span className="prop__value">
          <span className="mono prop__wrap" style={{ color: "var(--color-muted)" }}>
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
      <div className="prop prop--stack prop--metadata">
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
    </>
  );
}

export function PropList({ skill }: { skill: SkillVM }) {
  return (
    <div className="props">
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
      <div className="divider" />
      <p className="railhead railhead--sub">Manifest</p>
      <ManifestRows skill={skill} />
    </div>
  );
}

export function Requirements({ requirements }: { requirements: SkillVM["requirements"] }) {
  return (
    <div className="dblocks">
      <div>
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
  fallbackAuthor,
}: {
  versions: SkillVersionRow[];
  /** Shown when a version row has no joined publisher (e.g. the skill creator, as a fallback). */
  fallbackAuthor: { name: string; initials: string; avatarUrl: string | null };
}) {
  return (
    <div className="feed">
      {versions.map((v, i) => {
        const changes = v.changelog?.changes ?? [];
        // Per-version attribution: the member who published this version, falling back to the creator.
        const whoName = v.created_by_name ?? fallbackAuthor.name;
        const whoInitials = v.created_by_initials ?? fallbackAuthor.initials;
        const whoAvatar = v.created_by_avatar_url ?? fallbackAuthor.avatarUrl;
        return (
          <div className="act" key={v.id}>
            <div className="act__rail">
              <span className={"act__node" + (i === 0 ? " act__node--cur" : "")}>
                <Icon name={i === 0 ? "upload" : "git-commit"} size={12} />
              </span>
              {i < versions.length - 1 && <span className="act__line" />}
            </div>
            <div className="act__body">
              <div className="act__top">
                <UserAvatar
                  className="avatar"
                  avatarUrl={whoAvatar}
                  initials={whoInitials}
                  size={16}
                  style={{ alignSelf: "center", fontSize: 8 }}
                />
                <span className="act__who">{whoName}</span>
                <span className="act__verb">published</span>
                <span className="act__ver">v{v.version}</span>
                {i === 0 && <span className="curtag">current</span>}
                <span className="act__time">{v.created_at.slice(0, 10)}</span>
              </div>
              {changes.length ? (
                <ul className="act__changes">
                  {changes.map((change, changeIndex) => (
                    <li className="act__change" key={`${v.id}-${changeIndex}`}>
                      {change}
                    </li>
                  ))}
                </ul>
              ) : v.note ? (
                <p className="act__note">{v.note}</p>
              ) : null}
            </div>
          </div>
        );
      })}
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
            <UserAvatar
              className="avatar comment__avatar"
              avatarUrl={c.author_avatar_url ?? null}
              initials={c.author_initials ?? "?"}
            />
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
        <UserAvatar className="avatar comment__avatar" avatarUrl={me.avatarUrl} initials={me.initials} />
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
