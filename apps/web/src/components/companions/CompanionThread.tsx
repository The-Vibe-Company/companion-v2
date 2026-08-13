"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Companion, CompanionThread as Thread } from "@companion/contracts";
import { Icon } from "../Icon";
import { companionStatus } from "./status";

/** Server markup keeps the stable ISO minute; the local clock takes over on the client. */
function SentAt({ iso }: { iso: string }) {
  const [text, setText] = useState(() => iso.slice(11, 16));
  useEffect(() => setText(new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })), [iso]);
  return <time dateTime={iso}>{text}</time>;
}

/**
 * Who wrote this entry. A thread shared with Editors has several writers, so only the reader's own
 * messages say "You"; a teammate's message keeps their name.
 */
function author(
  entry: Thread["entries"][number],
  viewerId: string,
  companionName: string,
): string {
  if (entry.role === "assistant") return companionName;
  if (entry.role === "system") return "Companion";
  if (entry.author_id === viewerId) return "You";
  return entry.author_name ?? "Member";
}

/**
 * One Companion, one thread. The transcript is the control-plane read model, so a Viewer sees the
 * conversation without any Box contact and gets no composer. Pi's tools and skills stay out of this
 * surface by design: only the conversation belongs here.
 */
export function CompanionThread({
  companion,
  thread,
  error,
  busy,
  waking,
  onBack,
  onSend,
  onWake,
}: {
  companion: Companion;
  thread: Thread | null;
  error: string | null;
  busy: boolean;
  waking: boolean;
  onBack: () => void;
  onSend: (content: string) => void;
  onWake: () => void;
}) {
  const [draft, setDraft] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const status = companionStatus(companion.runtime.state);
  const canSend = thread ? thread.can_send : companion.access !== "viewer";
  const awake = companion.runtime.state === "running";
  const entries = useMemo(() => thread?.entries ?? [], [thread]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [entries.length]);

  const submit = () => {
    const content = draft.trim();
    if (!content || busy) return;
    setDraft("");
    onSend(content);
  };

  return (
    <section className="chat" aria-label={`Chat with ${companion.name}`}>
      <header className="chat-head">
        <button type="button" className="iconbtn chat-back" aria-label="Back to Companions" onClick={onBack}>
          <Icon name="arrow-left" size={16} />
        </button>
        <span className="companions-avatar" aria-hidden="true">
          {companion.name.trim().slice(0, 1).toLocaleUpperCase("en-US") || "C"}
        </span>
        <div className="chat-identity">
          <h1>{companion.name}</h1>
          {companion.persona && <p>{companion.persona}</p>}
        </div>
        <span className={`companions-state companions-state--${status.tone}`}>
          <i aria-hidden="true" />
          {status.label}
        </span>
        {canSend && !awake && (
          <button
            type="button"
            className="cds-btn cds-btn--secondary cds-btn--sm"
            disabled={waking}
            onClick={onWake}
          >
            {waking ? "Waking..." : "Wake"}
          </button>
        )}
      </header>

      {error && <div className="companions-error" role="alert">{error}</div>}

      <div className="chat-log" ref={logRef} role="log" aria-live="polite" aria-busy={!thread}>
        {!thread ? (
          <p className="chat-empty">Loading conversation...</p>
        ) : entries.length ? (
          entries.map((entry) => (
            <article className={`chat-msg chat-msg--${entry.role}`} key={entry.event_id}>
              <span className="chat-msg__who">{author(entry, thread.viewer_id, companion.name)}</span>
              <p>{entry.content}</p>
              <SentAt iso={entry.created_at} />
            </article>
          ))
        ) : (
          <div className="chat-empty">
            <strong>{canSend ? `Say hello to ${companion.name}` : "No messages yet"}</strong>
            <p>
              {canSend
                ? "Messages are saved here. Wake this Companion when you want a reply."
                : "This transcript is read from the control plane, so opening it left the Box asleep."}
            </p>
          </div>
        )}
      </div>

      {canSend ? (
        <form
          className="chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <textarea
            value={draft}
            rows={1}
            placeholder={`Message ${companion.name}`}
            aria-label={`Message ${companion.name}`}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.shiftKey) return;
              event.preventDefault();
              submit();
            }}
          />
          <button
            type="submit"
            className="cds-btn cds-btn--primary cds-btn--md"
            disabled={busy || !draft.trim()}
            aria-label="Send message"
          >
            <Icon name="send" size={15} />
          </button>
          <p className="chat-hint">
            {thread && thread.pending_count > 0
              ? awake
                ? `${thread.pending_count} message${thread.pending_count === 1 ? "" : "s"} waiting for a reply.`
                : `${thread.pending_count} message${thread.pending_count === 1 ? "" : "s"} saved. Wake ${companion.name} to deliver.`
              : "Enter sends. Shift + Enter starts a new line."}
          </p>
        </form>
      ) : (
        <footer className="chat-readonly">
          Viewer access is read-only. Sending, run, and desktop stay with the Owner and Editors.
        </footer>
      )}
    </section>
  );
}
