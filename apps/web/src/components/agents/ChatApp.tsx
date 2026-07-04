"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useRouter } from "next/navigation";
import type { AgentStatus } from "@companion/contracts";
import { createChatSession, fetchSessionMessages, sendChatPrompt, wakeAgent } from "@/lib/agentQueries";
import { formatDurationSeconds } from "@/lib/format";
import type { AgentVM } from "@/lib/types";
import { Icon } from "../Icon";
import { ChatMarkdown } from "./chatMarkdown";
import { chatReducer, initChatState, openChatStream, type ChatItem } from "./chatStream";
import { statusDot, toolIcon } from "./derive";
import { agentsRouteHref } from "./route";

/**
 * The full-viewport end-user chat surface for one agent (`/w/<workspace>/agents/<slug>/chat`) — NO console
 * sidebar. Boot flow: wake a sleeping sandbox (banner + sys line), create a session, then consume
 * the normalized SSE event stream via `openChatStream` (AbortController teardown, StrictMode-safe).
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

/** Top bar for the end-user chat surface: a back affordance + New session. */
function ChatTopBar({ onBack, onNewSession }: { onBack: () => void; onNewSession: () => void }) {
  const btn: CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    height: 28,
    padding: "0 10px",
    border: "1px solid var(--color-line)",
    borderRadius: "var(--radius-md)",
    background: "var(--color-surface)",
    color: "var(--color-muted)",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--text-xs)",
    cursor: "pointer",
  };
  return (
    <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 10, padding: "10px 16px" }}>
      <button type="button" onClick={onBack} style={btn}>
        <Icon name="arrow-left" size={13} />
        Back
      </button>
      <span style={{ flex: 1 }} />
      <button type="button" onClick={onNewSession} style={btn}>
        <Icon name="plus" size={13} />
        New session
      </button>
    </div>
  );
}

/** "Waking your agent" banner: spinner + copy + the indeterminate sweep track. */
function WakeBanner() {
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
        <span style={{ fontWeight: 500 }}>Waking your agent</span>
        <span style={{ color: "var(--color-muted)" }}>Resuming sandbox from snapshot. Usually a few seconds.</span>
      </div>
      <div className="chat-wake__track">
        <span className="chat-wake__bar" />
      </div>
    </div>
  );
}

/** One collapsible skill-run row: chevron + tool-type icon + label/title + skill chip + status. */
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
 * The model's live "thinking". While it streams it renders expanded and muted; once the answer starts
 * (`streaming` flips false via the reducer) it auto-collapses to a compact "Thought…" toggle the user
 * can re-open. Expansion follows `streaming` unless the user has explicitly overridden it.
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

export function ChatApp({
  agent,
  orgId,
  orgName,
  initialSessionId,
}: {
  agent: AgentVM;
  /** Workspace org id — synced to the companion_org cookie on mount for API calls. */
  orgId: string;
  orgName: string;
  /** Resume a specific past session (from `?session=`); overrides the cached most-recent session. */
  initialSessionId?: string;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<AgentStatus>(agent.status);
  const [waking, setWaking] = useState(agent.status === "sleeping");
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** True while an on-demand session is being created (first send / new session), disables the composer. */
  const [creatingSession, setCreatingSession] = useState(false);
  // True while boot is resuming an existing session (fetching history) — keeps the composer disabled
  // so a send can't race the resume and orphan it with a fresh session. Starts true only when there
  // is a session to resume; a no-session boot leaves the composer usable immediately.
  const [resuming, setResuming] = useState(
    () => (initialSessionId ?? agent.sessions[0]?.id ?? null) !== null,
  );
  const [text, setText] = useState("");
  // Explicit per-row expand overrides. Absent → the row follows its default (a tool auto-expands
  // while running, a reasoning block while it streams), so the in-progress step is open and prior
  // ones tuck away — until the user clicks, which pins the row open or closed.
  const [rowOverride, setRowOverride] = useState<Map<string, boolean>>(() => new Map());
  const [chat, dispatch] = useReducer(chatReducer, undefined, initChatState);

  /** `slug@pinnedVersion` when the tool run maps to a pin; otherwise the raw tool name. */
  const resolveToolLabel = useCallback(
    (tool: string, skill: string | null): { label: string; action: string } => {
      const pin = agent.skills.find((s) => s.id === skill) ?? agent.skills.find((s) => s.id === tool);
      if (pin) return { label: `${pin.id}@${pin.version}`, action: tool };
      return { label: tool, action: "run" };
    },
    [agent.skills],
  );

  // --- Boot: wake (if sleeping) → resume an existing session with its history, OR wait to create a
  // session lazily on the first send. One-shot, guarded by a synchronous ref so StrictMode's
  // double-mount never wakes or reloads twice. The session to resume is `?session=` (initialSessionId)
  // if given, else the most-recent cached session, else none (created lazily in `send`).
  const bootRef = useRef(false);
  useEffect(() => {
    if (bootRef.current) return;
    bootRef.current = true;
    document.cookie = `companion_org=${encodeURIComponent(orgId)}; path=/; SameSite=Lax`;
    const resumeId = initialSessionId ?? agent.sessions[0]?.id ?? null;
    void (async () => {
      if (agent.status === "error") {
        dispatch({ kind: "sys", text: "agent unavailable · provisioning failed" });
        setResuming(false);
        return;
      }
      try {
        if (agent.status === "sleeping") {
          const result = await wakeAgent(agent.id);
          setStatus(result.status);
          setWaking(false);
          dispatch({
            kind: "sys",
            text: ["resumed from snapshot", agent.region, formatDurationSeconds(result.resume_ms)].filter(Boolean).join(" · "),
          });
        }
        if (!resumeId) {
          // No session yet — the composer is usable; the first send creates one (see `send`).
          dispatch({ kind: "sys", text: `ready · ${agent.region}` });
          return;
        }
        // Resume an existing session: seed its history BEFORE opening the live stream so prior
        // messages render above any new events. A history-load failure keeps the composer usable.
        try {
          const history = await fetchSessionMessages(agent.id, resumeId);
          dispatch({ kind: "history", items: history.items, resolveToolLabel });
        } catch (historyError) {
          dispatch({
            kind: "event",
            event: {
              type: "error",
              message: historyError instanceof Error ? historyError.message : "Could not load the session history.",
            },
            resolveToolLabel,
          });
        }
        setSessionId(resumeId);
      } catch (error) {
        setWaking(false);
        dispatch({
          kind: "event",
          event: { type: "error", message: error instanceof Error ? error.message : "Could not start the chat session." },
          resolveToolLabel,
        });
      } finally {
        setResuming(false);
      }
    })();
    // Boot is intentionally one-shot for the server-provided agent snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Stream lifecycle: one effect keyed by sessionId, aborted on cleanup (StrictMode-safe).
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void openChatStream(
      agent.id,
      sessionId,
      (event) => dispatch({ kind: "event", event, resolveToolLabel }),
      controller.signal,
    );
    return () => controller.abort();
  }, [sessionId, agent.id, resolveToolLabel]);

  // --- Auto-scroll the message area to the bottom on new items / streamed deltas.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items]);

  const statusWord = waking ? "waking" : status;
  const dotCls = waking ? "vdot vdot--warn" : statusDot(status);
  const sendDisabled = waking || resuming || creatingSession || chat.busy || status === "error" || !text.trim();
  // The working line shows the live "it's running" state EXCEPT while assistant text is streaming
  // (the streaming answer itself already reads as activity — no need to double it).
  const streamingAssistant = chat.items.some((item) => item.kind === "asst" && item.streaming);
  const showWorking = chat.working.active && !streamingAssistant;

  // Synchronous one-shot guard so a double-send (StrictMode / fast Enter) can't create two sessions
  // before `creatingSession` state has flushed.
  const createGuardRef = useRef(false);

  const send = () => {
    const trimmed = text.trim();
    if (sendDisabled || !trimmed) return;
    // Gate the whole send (not just the createChatSession call) on the synchronous guard so a
    // double-fire in the same tick can't emit a duplicate user bubble or create a second session
    // before `creatingSession` state has flushed.
    if (!sessionId && createGuardRef.current) return;

    dispatch({ kind: "user", text: trimmed });
    dispatch({ kind: "send" });
    setText("");

    if (sessionId) {
      sendChatPrompt(agent.id, sessionId, trimmed).catch((error) => {
        dispatch({
          kind: "event",
          event: { type: "error", message: error instanceof Error ? error.message : "Could not send the message." },
          resolveToolLabel,
        });
      });
      return;
    }

    // No session yet: create one, open the stream (via the sessionId effect), then send.
    createGuardRef.current = true;
    setCreatingSession(true);
    void (async () => {
      try {
        const session = await createChatSession(agent.id);
        setSessionId(session.session_id);
        await sendChatPrompt(agent.id, session.session_id, trimmed);
      } catch (error) {
        dispatch({
          kind: "event",
          event: { type: "error", message: error instanceof Error ? error.message : "Could not start the chat session." },
          resolveToolLabel,
        });
      } finally {
        setCreatingSession(false);
        createGuardRef.current = false;
      }
    })();
  };

  /** Reset to a fresh session: clear the transcript + drop the session id so the next send creates one. */
  const newSession = () => {
    setSessionId(null);
    setCreatingSession(false);
    setResuming(false);
    createGuardRef.current = false;
    setRowOverride(new Map());
    setText("");
    dispatch({ kind: "reset" });
    dispatch({ kind: "sys", text: `new session · ${agent.region}` });
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

  const backToConsole = () =>
    router.push(agentsRouteHref({ lib: agent.scope === "org" ? "org" : "mine", kind: "detail", agent: agent.id }));

  return (
    <div
      data-screen-label="Agent chat"
      style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--color-canvas)" }}
    >
      <ChatTopBar onBack={backToConsole} onNewSession={newSession} />

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
            <span
              title={orgName}
              style={{
                display: "grid",
                placeItems: "center",
                width: 26,
                height: 26,
                borderRadius: "var(--radius-md)",
                background: "var(--color-accent)",
                color: "var(--color-accent-fg)",
                fontWeight: 600,
                fontSize: 13,
                flex: "none",
              }}
            >
              {orgName.trim().charAt(0).toUpperCase() || "•"}
            </span>
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
                {agent.id}
              </span>
              <span className={dotCls} />
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-muted)" }}>{statusWord}</span>
              {chat.working.active && (
                <Icon name="loader" size={12} className="ls-spin" style={{ color: "var(--color-muted)", flex: "none" }} aria-label="working" />
              )}
            </div>
            <span style={{ flex: 1 }} />
            <div style={{ display: "flex", gap: 5, flex: "none" }}>
              {agent.skills.map((skill) => (
                <span key={skill.id} className="chip" title="This agent runs this skill">
                  {skill.id}@{skill.version}
                </span>
              ))}
            </div>
          </header>

          {waking && <WakeBanner />}

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
            {chat.error && (
              <div style={{ textAlign: "center", fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-danger)" }} role="alert">
                {chat.error}
              </div>
            )}
          </div>

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
              }}
            >
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") send();
                }}
                placeholder={status === "error" ? "Agent unavailable" : `Message ${agent.id}`}
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
              {agent.id} runs curated skills in an isolated sandbox. Skill runs are shown inline.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
