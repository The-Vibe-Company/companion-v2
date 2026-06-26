"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { SkillCommentImage, SkillCommentRow, SkillVersionRow } from "@companion/contracts";
import {
  COMMENT_IMAGE_FILE_ACCEPT,
  MAX_COMMENT_IMAGES,
  MAX_COMMENT_IMAGE_BYTES,
  isAllowedCommentImageFile,
} from "@companion/contracts";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";
import { relativeTime } from "@/lib/format";

/** Add type for `onAdd` callbacks: text + optional image files for a new comment or reply. */
type AddCommentFn = (body: string, opts: { parentId?: string | null; versionId?: string | null; images?: File[] }) => void;

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
  me: { id: string; name: string; initials: string; avatarUrl: string | null };
  canDeprecate: (c: SkillCommentRow) => boolean;
  onAdd: AddCommentFn;
  onToggleDeprecated: (id: string, next: boolean) => void;
}

/**
 * A single comment thumbnail. Clicking enlarges it in a lightbox (flat scrim, Esc / click-outside to
 * close, focus returns to the thumbnail). Degrades to a placeholder icon if the image fails to load.
 */
function CommentThumb({ img }: { img: SkillCommentImage }) {
  const [broken, setBroken] = useState(false);
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  // Close and restore focus to the thumbnail that opened the lightbox. Used by every close path:
  // the close button, the backdrop, the image, and Escape.
  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("keydown", onKey);
    closeRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
    // `close` only touches stable refs/setters; rebinding solely on `open` is intentional.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={"comment__thumb" + (broken ? " is-broken" : "")}
        aria-label={broken ? "Image attachment unavailable" : "Enlarge image attachment"}
        title={broken ? "Image unavailable" : undefined}
        disabled={broken}
        onClick={() => setOpen(true)}
      >
        {broken ? (
          <Icon name="image" size={18} />
        ) : (
          <img src={img.url} alt="" loading="lazy" onError={() => setBroken(true)} />
        )}
      </button>
      {open &&
        createPortal(
          <div
            className="lightbox"
            role="dialog"
            aria-modal="true"
            aria-label="Image attachment"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) close();
            }}
          >
            <button ref={closeRef} type="button" className="lightbox__close" aria-label="Close" onClick={close}>
              <Icon name="x" size={18} />
            </button>
            <img className="lightbox__img" src={img.url} alt="" onClick={close} />
          </div>,
          document.body,
        )}
    </>
  );
}

/** Image attachments rendered under a comment: a strip of thumbnails, each opening full-size. */
function CommentMedia({ images }: { images?: SkillCommentImage[] }) {
  if (!images || images.length === 0) return null;
  return (
    <div className="comment__media">
      {images.map((img) => (
        <CommentThumb key={img.id} img={img} />
      ))}
    </div>
  );
}

/** A pending image attachment in the composer, kept with its preview object URL. */
interface PendingImage {
  file: File;
  url: string;
}

/**
 * Shared comment / reply composer: a textarea plus image attachments via click, clipboard paste, or
 * drag-and-drop, a pending-thumbnail strip, and a submit button. `footerLeft` lets the root composer
 * slot in its "Link to" scope picker. Calls `onSubmit(body, files)` and then resets itself.
 */
function CommentComposer({
  placeholder,
  submitLabel,
  onSubmit,
  autoFocus,
  footerLeft,
  footClassName,
}: {
  placeholder: string;
  submitLabel: string;
  onSubmit: (body: string, files: File[]) => void;
  autoFocus?: boolean;
  footerLeft?: ReactNode;
  footClassName?: string;
}) {
  const [text, setText] = useState("");
  const [pending, setPending] = useState<PendingImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Revoke any still-pending preview URLs when the composer unmounts (e.g. a reply form closes).
  const pendingRef = useRef<PendingImage[]>([]);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current.forEach((p) => URL.revokeObjectURL(p.url)), []);

  const addFiles = (incoming: File[]) => {
    const images = incoming.filter((f) => f.type.startsWith("image/") || isAllowedCommentImageFile(f));
    if (images.length === 0) return;
    setError(null);
    setPending((cur) => {
      const next = [...cur];
      for (const f of images) {
        if (!isAllowedCommentImageFile(f)) {
          setError("Only PNG, JPEG, WebP, or GIF images are allowed.");
          continue;
        }
        if (next.length >= MAX_COMMENT_IMAGES) {
          setError(`Up to ${MAX_COMMENT_IMAGES} images per comment.`);
          break;
        }
        if (f.size > MAX_COMMENT_IMAGE_BYTES) {
          setError("Each image must be 10 MB or smaller.");
          continue;
        }
        next.push({ file: f, url: URL.createObjectURL(f) });
      }
      return next;
    });
  };

  const removeAt = (i: number) =>
    setPending((cur) => {
      const target = cur[i];
      if (target) URL.revokeObjectURL(target.url);
      return cur.filter((_, idx) => idx !== i);
    });

  const canSend = text.trim().length > 0 || pending.length > 0;
  const send = () => {
    if (!canSend) return;
    onSubmit(
      text.trim(),
      pending.map((p) => p.file),
    );
    pending.forEach((p) => URL.revokeObjectURL(p.url));
    setText("");
    setPending([]);
    setError(null);
  };

  return (
    <div
      className={"composer__box" + (dragOver ? " is-dragover" : "")}
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes("Files")) {
          e.preventDefault();
          setDragOver(true);
        }
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        const dropped = Array.from(e.dataTransfer.files);
        if (dropped.length) {
          e.preventDefault();
          setDragOver(false);
          addFiles(dropped);
        }
      }}
    >
      <textarea
        className="composer__input"
        rows={2}
        placeholder={placeholder}
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          const pasted = Array.from(e.clipboardData.files);
          if (pasted.length) {
            e.preventDefault();
            addFiles(pasted);
          }
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            send();
          }
        }}
      />
      {pending.length > 0 && (
        <div className="composer__pending">
          {pending.map((p, i) => (
            <span className="composer__pending-item" key={p.url}>
              <img src={p.url} alt="" />
              <button
                type="button"
                className="composer__pending-remove"
                aria-label="Remove image"
                onClick={() => removeAt(i)}
              >
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
        </div>
      )}
      {error && <p className="composer__error">{error}</p>}
      <div className={"composer__foot" + (footClassName ? " " + footClassName : "")}>
        {footerLeft}
        <button
          type="button"
          className="composer__attach"
          title="Add images"
          aria-label="Add images"
          onClick={() => inputRef.current?.click()}
        >
          <Icon name="image" size={14} />
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={COMMENT_IMAGE_FILE_ACCEPT}
          multiple
          hidden
          onChange={(e) => {
            const fs = Array.from(e.target.files ?? []);
            if (fs.length) addFiles(fs);
            if (inputRef.current) inputRef.current.value = "";
          }}
        />
        <span className="fv-spacer" />
        <span className="composer__hint">⌘↵ to send</span>
        <button className="btn-primary" disabled={!canSend} onClick={send}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
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
  onAdd: AddCommentFn;
  onToggleDeprecated: (id: string, next: boolean) => void;
  onFilter: (versionId: string | null) => void;
}) {
  const { root, replies } = thread;
  const [open, setOpen] = useState(false);
  const label = root.version_id === null ? "Global" : "v" + (root.version ?? "?");
  return (
    <div className={"thread" + (root.deprecated ? " is-deprecated" : "")}>
      <div className="thread__main">
        <UserAvatar
          className="avatar comment__avatar"
          avatarUrl={root.author_avatar_url ?? null}
          initials={root.author_initials ?? "?"}
        />
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
          {root.body && <p className="comment__text">{root.body}</p>}
          <CommentMedia images={root.images} />
          {replies.length > 0 && (
            <div className="thread__replies">
              {replies.map((r) => (
                <div className="reply" key={r.id}>
                  <UserAvatar
                    className="avatar comment__avatar reply__avatar"
                    avatarUrl={r.author_avatar_url ?? null}
                    initials={r.author_initials ?? "?"}
                  />
                  <div className="comment__body">
                    <div className="comment__head">
                      <span className="comment__who">{r.author_name ?? "Someone"}</span>
                      <span className="comment__time">{relativeTime(r.created_at)}</span>
                    </div>
                    {r.body && <p className="comment__text">{r.body}</p>}
                    <CommentMedia images={r.images} />
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
              <CommentComposer
                placeholder="Reply to this thread…"
                submitLabel="Reply"
                autoFocus
                onSubmit={(body, images) => {
                  onAdd(body, { parentId: root.id, images });
                  setOpen(false);
                }}
              />
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

  const addThread = (body: string, images: File[]) => {
    onAdd(body, { versionId: newScope === "global" ? null : newScope, images });
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
        <UserAvatar className="avatar comment__avatar" avatarUrl={me.avatarUrl} initials={me.initials} />
        <CommentComposer
          placeholder="Start a thread…"
          submitLabel="Comment"
          onSubmit={addThread}
          footClassName="composer__foot--disc"
          footerLeft={
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
          }
        />
      </div>
    </div>
  );
}
