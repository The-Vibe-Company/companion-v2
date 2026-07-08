"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { SkillRunDetail } from "@companion/contracts";
import { fetchRun, runAttachmentHref, sendRunPrompt } from "@/lib/runQueries";
import { formatDurationSeconds } from "@/lib/format";
import { Icon } from "../Icon";
import { ChatMarkdown } from "./chatMarkdown";
import { chatReducer, initChatState, openRunStream, type ChatItem } from "./chatStream";
import { toolIcon } from "./derive";
import { ArtifactsStrip } from "./ArtifactsStrip";

/**
 * The run surface: one skill run's live chat (while the sandbox lives) or read-only transcript
 * (frozen). Boot flow: fetch the run → poll every 1.5s while `starting` (status_detail banner) →
 * seed the transcript → consume the normalized SSE event stream via `openRunStream`
 * (AbortController teardown, StrictMode-safe). Frozen runs never open a stream.
 */

const MONO_FAINT_11: CSSProperties = { fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-faint)" };

const FRAME_DESKTOP: CSSProperties = {
  width: "min(880px, 100%)",
  display: "flex",
  flexDirection: "column",
  border: "1px solid var(--color-line)",
  borderRadius: 10,
  overflow: "hidden",
  boxShadow: "var(--shadow-xs)",
  background: "var(--color-surface)",
};

const TOOL_SECTION_LABEL: CSSProperties = {
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: "var(--tracking-wide)",
  color: "var(--color-faint)",
  marginBottom: 5,
};
const TOOL_PRE: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-mono)",
  fontSize: "var(--text-xs)",
  color: "var(--color-muted)",
  whiteSpace: "pre-wrap",
};

const STARTING_POLL_MS = 1500;

/** "Starting your run" banner: spinner + the live launch step + the indeterminate sweep track. */
function StartingBanner({ detail }: { detail: string | null }) {
  return (
    <div
      style={{
        flex: "none",
        padding: "12px 16px",
        borderBottom: "1px solid var(--color-line)",
        background: "var(--color-surface-sunken)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9, fontSize: "var(--text-sm)", color: "var(--color-fg)", flexWrap: "wrap" }}>
        <Icon name="loader" size={14} className="ls-spin" style={{ color: "var(--color-muted)" }} />
        <span style={{ fontWeight: 500 }}>Starting your run</span>
        <span style={{ color: "var(--color-muted)" }}>{detail || "Preparing sandbox"}…</span>
      </div>
      <div className="chat-wake__track">
        <span className="chat-wake__bar" />
      </div>
    </div>
  );
}

/** "This session has ended" banner for frozen transcripts, with the Run again affordance. */
function FrozenBanner({ note, onRunAgain }: { note: string | null; onRunAgain: () => void }) {
  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: 10,
        flexWrap: "wrap",
        padding: "10px 16px",
        borderBottom: "1px solid var(--color-line)",
        background: "var(--color-surface-sunken)",
        fontSize: "var(--text-sm)",
      }}
    >
      <Icon name="lock" size={13} style={{ color: "var(--color-muted)", flex: "none" }} />
      <span style={{ fontWeight: 500, color: "var(--color-fg)" }}>This session has ended</span>
      <span style={{ color: "var(--color-muted)" }}>{note ?? "The transcript below is read-only."}</span>
      <span style={{ flex: 1 }} />
      <button type="button" className="btn-sec" onClick={onRunAgain}>
        <Icon name="play" size={13} />
        Run again
      </button>
    </div>
  );
}

/** One collapsible tool row: chevron + tool-type icon + label/title + skill chip + status. */
function ToolRow({
  item,
  expanded,
  onToggle,
}: {
  item: Extract<ChatItem, { kind: "tool" }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ alignSelf: "stretch", maxWidth: 620 }} className={item.running ? "ca-tool ca-tool--running" : "ca-tool"}>
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          width: "100%",
          textAlign: "left",
          border: "1px solid var(--color-line)",
          borderRadius: "var(--radius-md)",
          background: "var(--color-surface-sunken)",
          padding: "7px 10px",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: "var(--text-xs)",
          color: "var(--color-muted)",
        }}
      >
        <Icon
          name="chevron-right"
          size={12}
          style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 120ms var(--ease-out-quint)", flex: "none" }}
        />
        <Icon name={toolIcon(item.tool)} size={13} style={{ color: "var(--color-muted)", flex: "none" }} />
        <span style={{ color: "var(--color-fg)", fontWeight: 500, whiteSpace: "nowrap" }}>{item.label}</span>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{item.action}</span>
        {item.skill && !item.label.startsWith(`${item.skill}@`) && (
          <span className="chip" style={{ flex: "none" }} title="This run references this skill">
            {item.skill}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {item.running ? (
          <Icon name="loader" size={12} className="ls-spin" style={{ color: "var(--color-muted)", flex: "none" }} />
        ) : (
          <Icon name="check" size={12} style={{ color: "var(--color-ok)", flex: "none" }} />
        )}
        <span style={{ color: "var(--color-faint)", flex: "none" }}>{item.running ? "running" : formatDurationSeconds(item.durationMs)}</span>
      </button>
      {expanded && (
        <div
          style={{
            border: "1px solid var(--color-line)",
            borderTop: "none",
            borderRadius: "0 0 var(--radius-md) var(--radius-md)",
            background: "var(--color-surface-sunken)",
            padding: "10px 12px",
            margin: "0 1px",
          }}
        >
          <div style={TOOL_SECTION_LABEL}>input</div>
          <pre style={{ ...TOOL_PRE, margin: "0 0 10px" }}>{item.input}</pre>
          <div style={TOOL_SECTION_LABEL}>result</div>
          <pre style={TOOL_PRE}>{item.output || "…"}</pre>
        </div>
      )}
    </div>
  );
}

/**
 * The model's live "thinking". While it streams it renders expanded and muted; once the answer
 * starts it auto-collapses to a compact toggle the user can re-open.
 */
function ReasoningRow({
  item,
  expanded,
  onToggle,
}: {
  item: Extract<ChatItem, { kind: "reasoning" }>;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div style={{ alignSelf: "stretch", maxWidth: 620 }} className="ca-reason">
      <button
        type="button"
        onClick={onToggle}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          width: "100%",
          textAlign: "left",
          border: "none",
          background: "none",
          padding: "2px 0",
          cursor: "pointer",
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--color-faint)",
        }}
      >
        <Icon
          name="chevron-right"
          size={11}
          style={{ transform: expanded ? "rotate(90deg)" : "none", transition: "transform 120ms var(--ease-out-quint)", flex: "none" }}
        />
        {item.streaming ? (
          <Icon name="loader" size={11} className="ls-spin" style={{ flex: "none" }} />
        ) : (
          <Icon name="sparkles" size={11} style={{ flex: "none" }} />
        )}
        <span style={{ fontStyle: "italic" }}>{item.streaming ? "Thinking…" : "Thought process"}</span>
      </button>
      {expanded && (
        <div
          style={{
            marginTop: 4,
            paddingLeft: 11,
            borderLeft: "2px solid var(--color-line)",
            fontSize: "var(--text-xs)",
            lineHeight: "var(--leading-normal)",
            color: "var(--color-muted)",
            fontStyle: "italic",
            whiteSpace: "pre-wrap",
          }}
        >
          {item.text}
        </div>
      )}
    </div>
  );
}

/** The "the agent is working" indicator: three animated dots + a live label, shown while it runs. */
function WorkingLine({ label }: { label: string }) {
  return (
    <div
      className="ca-working"
      role="status"
      aria-live="polite"
      style={{
        alignSelf: "flex-start",
        display: "flex",
        alignItems: "center",
        gap: 9,
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--color-muted)",
      }}
    >
      <span className="ca-working__dots" aria-hidden="true">
        <span />
        <span />
        <span />
      </span>
      <span>{label || "Thinking…"}</span>
    </div>
  );
}

export function RunChatView({
  runId,
  onBack,
  onRunAgain,
}: {
  runId: string;
  onBack: () => void;
  /** Open the launcher prefilled with this run's prompt (Run again / Try again). */
  onRunAgain: (prompt: string) => void;
}) {
  const [run, setRun] = useState<SkillRunDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState("");
  // Explicit per-row expand overrides. Absent → the row follows its default (a tool auto-expands
  // while running, a reasoning block while it streams).
  const [rowOverride, setRowOverride] = useState<Map<string, boolean>>(() => new Map());
  const [chat, dispatch] = useReducer(chatReducer, undefined, initChatState);
  const runRef = useRef<SkillRunDetail | null>(null);
  runRef.current = run;
  // Set once `openRunStream` gives up on reconnecting (distinct from a server-driven freeze,
  // which flips `run.status` instead). Gates the composer so a follow-up isn't silently accepted
  // by the API and never displayed, and drives the "Reconnect" affordance below.
  const [streamDead, setStreamDead] = useState(false);
  const [reconnectNonce, setReconnectNonce] = useState(0);

  /** `slug@version` when the tool run maps to the mounted skill; otherwise the raw tool name. */
  const resolveToolLabel = useCallback(
    (tool: string, skill: string | null): { label: string; action: string } => {
      const current = runRef.current;
      if (current && skill && skill === current.skill_slug) {
        return { label: `${current.skill_slug}@${current.skill_version ?? "?"}`, action: tool };
      }
      return { label: tool, action: "run" };
    },
    [],
  );

  // --- Boot + starting poll: fetch the run; while `starting`, poll every 1.5s so the banner tracks
  // status_detail live. One-shot per runId (StrictMode-safe via the abort flag).
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = async () => {
      try {
        const detail = await fetchRun(runId);
        if (!live) return;
        setRun(detail);
        if (detail.status === "starting") timer = setTimeout(() => void load(), STARTING_POLL_MS);
      } catch (error) {
        if (live) setLoadError(error instanceof Error ? error.message : "Could not load the run.");
      }
    };
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  // --- Seed the transcript once the run is past `starting`. Frozen/error runs seed from the DB
  // snapshot; running runs seed from the same fetch, then the live stream appends (see below).
  // When the snapshot carries no user message yet (fresh run, first idle not reached), the original
  // prompt renders as a synthetic first bubble — the live stream never re-emits it.
  const seededRef = useRef<string | null>(null);
  const [showPromptBubble, setShowPromptBubble] = useState(false);
  useEffect(() => {
    if (!run || run.status === "starting") return;
    if (seededRef.current === run.id) return;
    seededRef.current = run.id;
    setShowPromptBubble(!run.transcript.some((item) => item.kind === "user"));
    dispatch({ kind: "history", items: run.transcript, resolveToolLabel });
    setStreamDead(false);
  }, [run, resolveToolLabel]);

  // --- Stream lifecycle: open the live stream only while `running`; aborted on cleanup
  // (StrictMode-safe). A terminal stream error re-fetches the run — it usually means freeze.
  const status = run?.status ?? "starting";
  useEffect(() => {
    if (status !== "running" || streamDead) return;
    const controller = new AbortController();
    void openRunStream(
      runId,
      (event) => {
        if (event.type === "error" && event.message === "This session has ended.") {
          void fetchRun(runId).then((detail) => setRun(detail)).catch(() => {});
          return;
        }
        dispatch({ kind: "event", event, resolveToolLabel });
        if (event.type === "session.idle") {
          // Artifacts publish on idle server-side — refresh the strip (and the persisted status).
          void fetchRun(runId)
            .then((detail) => setRun(detail))
            .catch(() => {});
        } else if (event.type === "error") {
          // The reconnect budget is exhausted — the stream is dead even though the run may
          // still be healthy server-side. Refresh in case it actually froze, and stop the
          // composer from accepting input the user would never see a reply to.
          setStreamDead(true);
          void fetchRun(runId).then((detail) => setRun(detail)).catch(() => {});
        }
      },
      controller.signal,
    );
    return () => controller.abort();
  }, [status, runId, resolveToolLabel, streamDead, reconnectNonce]);

  // --- Auto-scroll the message area to the bottom on new items / streamed deltas.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items]);

  const sendDisabled = status !== "running" || streamDead || chat.busy || !text.trim();
  const streamingAssistant = chat.items.some((item) => item.kind === "asst" && item.streaming);
  const showWorking = chat.working.active && !streamingAssistant && status === "running";

  const send = () => {
    const trimmed = text.trim();
    if (sendDisabled || !trimmed) return;
    dispatch({ kind: "user", text: trimmed });
    dispatch({ kind: "send" });
    setText("");
    sendRunPrompt(runId, trimmed).catch((error) => {
      const message = error instanceof Error ? error.message : "Could not send the message.";
      dispatch({ kind: "event", event: { type: "error", message }, resolveToolLabel });
      // A 409 means the run froze under us — swap to the read-only transcript.
      void fetchRun(runId).then((detail) => setRun(detail)).catch(() => {});
    });
  };

  /** Effective expansion: the user's pin if set, else the row's default (running/streaming). */
  const isRowExpanded = (id: string, defaultOpen: boolean) => rowOverride.get(id) ?? defaultOpen;
  const toggleRow = (id: string, defaultOpen: boolean) => {
    setRowOverride((prev) => {
      const next = new Map(prev);
      next.set(id, !(prev.get(id) ?? defaultOpen));
      return next;
    });
  };

  const statusWord =
    status === "starting" ? "starting" : status === "running" ? "running" : status === "frozen" ? "ended" : "error";
  const dotCls =
    status === "running"
      ? "vdot vdot--ok"
      : status === "starting"
        ? "vdot vdot--warn"
        : status === "error"
          ? "vdot vdot--down"
          : "vdot vdot--unknown";

  if (loadError) {
    return (
      <div data-screen-label="Run" style={{ height: "100%", display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }} role="alert">
            {loadError}
          </p>
          <button type="button" className="btn-sec" onClick={onBack}>
            <Icon name="arrow-left" size={13} />
            Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-screen-label="Run"
      style={{ height: "100%", minHeight: 0, display: "flex", flexDirection: "column", background: "var(--color-canvas)" }}
    >
      <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}>
        <button type="button" className="btn-sec" onClick={onBack}>
          <Icon name="arrow-left" size={13} />
          Back
        </button>
        <span style={{ flex: 1 }} />
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "stretch", justifyContent: "center", padding: "0 16px 16px" }}>
        <div style={FRAME_DESKTOP}>
          <header
            style={{
              flex: "none",
              display: "flex",
              alignItems: "center",
              gap: 10,
              height: 52,
              padding: "0 16px",
              borderBottom: "1px solid var(--color-line)",
              background: "var(--color-surface)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--text-sm)",
                  fontWeight: 600,
                  color: "var(--color-fg)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {run ? `${run.skill_slug}${run.skill_version ? `@${run.skill_version}` : ""}` : "…"}
              </span>
              <span className={dotCls} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-muted)" }}>{statusWord}</span>
              {chat.working.active && status === "running" && (
                <Icon name="loader" size={12} className="ls-spin" style={{ color: "var(--color-muted)", flex: "none" }} aria-label="working" />
              )}
            </div>
            <span style={{ flex: 1 }} />
            {run && (
              <span className="mono" style={{ fontSize: 11, color: "var(--color-faint)", flex: "none" }}>
                {run.model}
              </span>
            )}
          </header>

          {status === "starting" && <StartingBanner detail={run?.status_detail ?? null} />}
          {status === "frozen" && run && (
            <FrozenBanner
              note={run.status_detail}
              onRunAgain={() => onRunAgain(run.prompt)}
            />
          )}
          {status === "error" && run && (
            <div
              style={{
                flex: "none",
                display: "flex",
                alignItems: "center",
                gap: 10,
                flexWrap: "wrap",
                padding: "10px 16px",
                borderBottom: "1px solid var(--color-line)",
                background: "var(--color-danger-tint, var(--color-surface-sunken))",
                fontSize: "var(--text-sm)",
              }}
              role="alert"
            >
              <Icon name="alert-triangle" size={13} style={{ color: "var(--color-danger)", flex: "none" }} />
              <span style={{ fontWeight: 500, color: "var(--color-fg)" }}>This run failed</span>
              <span style={{ color: "var(--color-muted)", whiteSpace: "pre-wrap" }}>{run.status_detail}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn-sec" onClick={() => onRunAgain(run.prompt)}>
                Try again
              </button>
            </div>
          )}

          <div
            ref={listRef}
            style={{
              flex: 1,
              minHeight: 0,
              overflowY: "auto",
              padding: "20px 16px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              background: "var(--color-surface)",
            }}
          >
            {run && showPromptBubble && status !== "starting" && (
              <div
                style={{
                  alignSelf: "flex-end",
                  maxWidth: "78%",
                  background: "var(--color-surface-raised)",
                  border: "1px solid var(--color-line)",
                  borderRadius: 10,
                  padding: "8px 12px",
                  fontSize: "var(--text-sm)",
                  color: "var(--color-fg)",
                  lineHeight: "var(--leading-normal)",
                  whiteSpace: "pre-wrap",
                }}
              >
                {run.prompt}
              </div>
            )}
            {run && run.attachments.length > 0 && (
              <div style={{ alignSelf: "flex-end", display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
                {run.attachments.map((attachment) => (
                  <a
                    key={attachment.id}
                    href={runAttachmentHref(run.id, attachment.id)}
                    className="chip"
                    title={`Download ${attachment.file_name}`}
                    style={{ textDecoration: "none" }}
                  >
                    <Icon name="file" size={11} style={{ marginRight: 4 }} />
                    {attachment.file_name}
                  </a>
                ))}
              </div>
            )}
            {chat.items.map((item) => {
              if (item.kind === "sys") {
                return (
                  <div key={item.id} style={{ textAlign: "center", ...MONO_FAINT_11 }}>
                    {item.text}
                  </div>
                );
              }
              if (item.kind === "user") {
                return (
                  <div
                    key={item.id}
                    style={{
                      alignSelf: "flex-end",
                      maxWidth: "78%",
                      background: "var(--color-surface-raised)",
                      border: "1px solid var(--color-line)",
                      borderRadius: 10,
                      padding: "8px 12px",
                      fontSize: "var(--text-sm)",
                      color: "var(--color-fg)",
                      lineHeight: "var(--leading-normal)",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {item.text}
                  </div>
                );
              }
              if (item.kind === "tool") {
                return (
                  <ToolRow
                    key={item.id}
                    item={item}
                    expanded={isRowExpanded(item.id, item.running)}
                    onToggle={() => toggleRow(item.id, item.running)}
                  />
                );
              }
              if (item.kind === "reasoning") {
                return (
                  <ReasoningRow
                    key={item.id}
                    item={item}
                    expanded={isRowExpanded(item.id, item.streaming)}
                    onToggle={() => toggleRow(item.id, item.streaming)}
                  />
                );
              }
              return (
                <div key={item.id} style={{ maxWidth: "68ch", fontSize: "var(--text-sm)", color: "var(--color-fg)", lineHeight: "var(--leading-relaxed)" }}>
                  <ChatMarkdown text={item.text} streaming={item.streaming} />
                </div>
              );
            })}
            {showWorking && <WorkingLine label={chat.working.label} />}
            {chat.error && chat.error !== "This session has ended." && (
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-danger)" }}
                role="alert"
              >
                {chat.error}
                {streamDead && status === "running" && (
                  <button
                    type="button"
                    className="btn-sec"
                    style={{ fontFamily: "var(--font-ui)" }}
                    onClick={() => {
                      setStreamDead(false);
                      setReconnectNonce((n) => n + 1);
                    }}
                  >
                    Reconnect
                  </button>
                )}
              </div>
            )}
          </div>

          {run && <ArtifactsStrip artifacts={run.artifacts} />}

          <div style={{ flex: "none", padding: "12px 16px 14px", borderTop: "1px solid var(--color-line)", background: "var(--color-surface)" }}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                border: "1px solid var(--color-line)",
                borderRadius: "var(--radius-md)",
                background: "var(--color-surface)",
                padding: "4px 4px 4px 12px",
                opacity: status === "running" ? 1 : 0.6,
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") send();
                }}
                disabled={status !== "running"}
                placeholder={
                  status === "running"
                    ? "Send a follow-up"
                    : status === "starting"
                      ? "Starting…"
                      : status === "frozen"
                        ? "This session has ended — start a new run."
                        : "This run failed"
                }
                style={{
                  flex: 1,
                  minWidth: 0,
                  border: "none",
                  outline: "none",
                  background: "none",
                  fontFamily: "var(--font-ui)",
                  fontSize: "var(--text-sm)",
                  color: "var(--color-fg)",
                  height: 32,
                }}
              />
              <button
                type="button"
                onClick={send}
                disabled={sendDisabled}
                className="btn-primary"
                style={{ width: 32, height: 32, padding: 0, justifyContent: "center" }}
                aria-label="Send"
              >
                <Icon name="arrow-up" size={15} />
              </button>
            </div>
            <div style={{ marginTop: 7, fontSize: 11, color: "var(--color-faint)", textAlign: "center" }}>
              This run executes in an isolated sandbox and freezes after a few minutes of inactivity.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
