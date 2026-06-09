"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SkillCommentRow, SkillVersionRow } from "@companion/contracts";
import { Icon } from "../Icon";
import { relativeTime } from "@/lib/format";

/** A root comment plus its (single-level) replies, derived from the flat list. */
interface Thread {
  root: SkillCommentRow;
  replies: SkillCommentRow[];
}

/** "all" / "global" / a `skill_versions.id` — the active filter and the per-thread scope key. */
type FilterKey = "all" | "global";
/** "global" / a `skill_versions.id` — the new-thread "Link to" selection. */
type ScopeKey = "global";

interface DiscussionProps {
  comments: SkillCommentRow[];
  versions: SkillVersionRow[];
  me: { id: string; name: string; initials: string };
  canDeprecate: (c: SkillCommentRow) => boolean;
  onAdd: (body: string, opts: { parentId?: string | null; versionId?: string | null }) => void;
  onToggleDeprecated: (id: string, next: boolean) => void;
}

/** The version chip on a thread; clicking filters the discussion to that scope. */
function ScopeTag({
  versionId,
  label,
  onClick,
}: {
  versionId: string | null;
  label: string;
  onClick: () => void;
}) {
  const ver = versionId !== null;
  return (
    <button
      className={"scopetag" + (ver ? " scopetag--ver" : "")}
      onClick={onClick}
      title={ver ? "Filter to " + label : "Filter to global"}
    >
      <Icon name={ver ? "tag" : "globe"} size={11} />
      {label}
    </button>
  );
}

function ThreadCard({
  thread,
  canDeprecate,
  onAdd,
  onToggleDeprecated,
  onFilter,
}: {
  thread: Thread;
  canDeprecate: (c: SkillCommentRow) => boolean;
  onAdd: (body: string, opts: { parentId?: string | null; versionId?: string | null }) => void;
  onToggleDeprecated: (id: string, next: boolean) => void;
  onFilter: (versionId: string | null) => void;
}) {
  const { root, replies } = thread;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const label = root.version_id === null ? "Global" : "v" + (root.version ?? "?");
  const send = () => {
    const v = text.trim();
    if (!v) return;
    onAdd(v, { parentId: root.id });
    setText("");
    setOpen(false);
  };
  return (
    <div className={"thread" + (root.deprecated ? " is-deprecated" : "")}>
      <div className="thread__main">
        <span className="avatar comment__avatar">{root.author_initials ?? "?"}</span>
        <div className="comment__body">
          <div className="thread__head">
            <span className="comment__who">{root.author_name ?? "Someone"}</span>
            <ScopeTag
              versionId={root.version_id}
              label={label}
              onClick={() => onFilter(root.version_id)}
            />
            {root.deprecated && (
              <span className="depbadge">
                <Icon name="archive" size={11} />
                Deprecated
              </span>
            )}
            <span className="comment__time">{relativeTime(root.created_at)}</span>
          </div>
          <p className="comment__text">{root.body}</p>
          {replies.length > 0 && (
            <div className="thread__replies">
              {replies.map((r) => (
                <div className="reply" key={r.id}>
                  <span className="avatar comment__avatar reply__avatar">
                    {r.author_initials ?? "?"}
                  </span>
                  <div className="comment__body">
                    <div className="comment__head">
                      <span className="comment__who">{r.author_name ?? "Someone"}</span>
                      <span className="comment__time">{relativeTime(r.created_at)}</span>
                    </div>
                    <p className="comment__text">{r.body}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="thread__actions">
            <button className="thread__act" onClick={() => setOpen((o) => !o)}>
              <Icon name="reply" size={13} />
              Reply
            </button>
            {canDeprecate(root) && (
              <button
                className={"thread__act" + (root.deprecated ? "" : " thread__act--danger")}
                onClick={() => onToggleDeprecated(root.id, !root.deprecated)}
              >
                <Icon name={root.deprecated ? "rotate-ccw" : "archive"} size={13} />
                {root.deprecated ? "Restore" : "Mark deprecated"}
              </button>
            )}
          </div>
          {open && (
            <div className="thread__reply">
              <div className="composer__box">
                <textarea
                  className="composer__input"
                  rows={2}
                  placeholder="Reply to this thread…"
                  value={text}
                  autoFocus
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      send();
                    }
                  }}
                />
                <div className="composer__foot">
                  <span className="composer__hint">⌘↵ to send</span>
                  <button className="btn-primary" disabled={!text.trim()} onClick={send}>
                    Reply
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function Discussion({
  comments,
  versions,
  me,
  canDeprecate,
  onAdd,
  onToggleDeprecated,
}: DiscussionProps) {
  // "all" | "global" | a version id.
  const [filter, setFilter] = useState<FilterKey | string>("all");
  const [text, setText] = useState("");
  // "global" | a version id.
  const [newScope, setNewScope] = useState<ScopeKey | string>("global");
  const [scopeOpen, setScopeOpen] = useState(false);
  const scopeRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (scopeRef.current && !scopeRef.current.contains(e.target as Node)) setScopeOpen(false);
    };
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") setScopeOpen(false);
    };
    document.addEventListener("mousedown", h);
    document.addEventListener("keydown", k);
    return () => {
      document.removeEventListener("mousedown", h);
      document.removeEventListener("keydown", k);
    };
  }, []);

  // Derive threads: roots (parent_id === null) each carrying their single level of replies.
  const threads = useMemo<Thread[]>(() => {
    const roots = comments.filter((c) => c.parent_id === null);
    const repliesByParent = new Map<string, SkillCommentRow[]>();
    for (const c of comments) {
      if (c.parent_id === null) continue;
      const list = repliesByParent.get(c.parent_id);
      if (list) list.push(c);
      else repliesByParent.set(c.parent_id, [c]);
    }
    return roots.map((root) => ({ root, replies: repliesByParent.get(root.id) ?? [] }));
  }, [comments]);

  // Count for a filter key: All = all roots; Global = roots with no version; a version id = roots
  // linked to THAT version only (globals are not folded into per-version counts).
  const countFor = (key: FilterKey | string): number => {
    if (key === "all") return threads.length;
    if (key === "global") return threads.filter((t) => t.root.version_id === null).length;
    return threads.filter((t) => t.root.version_id === key).length;
  };

  // Filter bar: All · Global · one pill per version that has at least one root thread.
  const FILTERS = useMemo(() => {
    const base: { key: FilterKey | string; label: string }[] = [
      { key: "all", label: "All" },
      { key: "global", label: "Global" },
    ];
    for (const v of versions) {
      if (countFor(v.id) > 0) base.push({ key: v.id, label: "v" + v.version });
    }
    return base;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [versions, threads]);

  // "Link to" picker: Global + every version (the current one marked, others by date).
  const SCOPE_OPTS = useMemo(() => {
    const opts: { key: ScopeKey | string; label: string; desc: string }[] = [
      { key: "global", label: "Global", desc: "applies to the skill" },
    ];
    versions.forEach((v, i) => {
      opts.push({ key: v.id, label: "v" + v.version, desc: i === 0 ? "current" : v.created_at.slice(0, 10) });
    });
    return opts;
  }, [versions]);

  const isVer = filter !== "all" && filter !== "global";
  // A version view also surfaces Global threads — they apply to every version.
  const shown = threads.filter(
    (t) =>
      filter === "all" ||
      (filter === "global" && t.root.version_id === null) ||
      (isVer && (t.root.version_id === filter || t.root.version_id === null)),
  );

  const filterVersionLabel = isVer
    ? "v" + (versions.find((v) => v.id === filter)?.version ?? "?")
    : "";

  const addThread = () => {
    const v = text.trim();
    if (!v) return;
    onAdd(v, { versionId: newScope === "global" ? null : newScope });
    setText("");
  };

  const newScopeLabel =
    newScope === "global"
      ? "Global"
      : "v" + (versions.find((vv) => vv.id === newScope)?.version ?? "?");

  return (
    <div className="disc">
      <div className="disc__head">
        <p className="seclabel" style={{ margin: 0 }}>
          Discussion <span className="seclabel__n">{threads.length}</span>
        </p>
        <div className="disc__filter">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={"pill" + (filter === f.key ? " is-on" : "")}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
              <span className="ct">{countFor(f.key)}</span>
            </button>
          ))}
        </div>
      </div>
      {isVer && (
        <p className="disc__note">
          <Icon name="globe" size={12} />
          Showing threads linked to <b>{filterVersionLabel}</b> plus Global threads, which apply to
          every version.
        </p>
      )}
      <div className="threads">
        {shown.map((t) => (
          <ThreadCard
            key={t.root.id}
            thread={t}
            canDeprecate={canDeprecate}
            onAdd={onAdd}
            onToggleDeprecated={onToggleDeprecated}
            onFilter={(versionId) => setFilter(versionId === null ? "global" : versionId)}
          />
        ))}
        {shown.length === 0 && (
          <div className="comments__empty">No threads linked here yet.</div>
        )}
      </div>
      <div className="composer">
        <span className="avatar comment__avatar">{me.initials}</span>
        <div className="composer__box">
          <textarea
            className="composer__input"
            rows={2}
            placeholder="Start a thread…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                addThread();
              }
            }}
          />
          <div className="composer__foot composer__foot--disc">
            <span className="newscope" ref={scopeRef}>
              <button
                className="newscope__btn"
                onClick={() => setScopeOpen((o) => !o)}
                aria-haspopup="menu"
                aria-expanded={scopeOpen}
              >
                <span className="lead">
                  <Icon name="link-2" size={12} />
                </span>
                Link to <b>{newScopeLabel}</b>
                <span className="caret">
                  <Icon name="chevron-down" size={12} />
                </span>
              </button>
              {scopeOpen && (
                <div className="newmenu" role="menu">
                  <div className="menu__head">Link thread to</div>
                  {SCOPE_OPTS.map((o) => (
                    <button
                      key={o.key}
                      role="menuitemradio"
                      aria-checked={o.key === newScope}
                      className={"menu__item" + (o.key === newScope ? " is-sel" : "")}
                      onClick={() => {
                        setNewScope(o.key);
                        setScopeOpen(false);
                      }}
                    >
                      <span className="ico">
                        <Icon name={o.key === "global" ? "globe" : "tag"} size={14} />
                      </span>
                      <span className="menu__label">{o.label}</span>
                      <span className="menu__desc">{o.desc}</span>
                      {o.key === newScope && (
                        <span className="menu__check">
                          <Icon name="check" size={13} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </span>
            <span className="fv-spacer" />
            <span className="composer__hint">⌘↵ to send</span>
            <button className="btn-primary" disabled={!text.trim()} onClick={addThread}>
              Comment
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
