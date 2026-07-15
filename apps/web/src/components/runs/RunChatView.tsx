"use client";

import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  RUN_ATTACHMENT_MAX_BYTES,
  RUN_ATTACHMENT_MAX_FILES,
  RUN_ATTACHMENT_MAX_TOTAL_BYTES,
  type RunPhase,
  type SkillRunAttachmentRow,
  type SkillRunDetail,
} from "@companion/contracts";
import { cancelRun, fetchRun, runAttachmentHref, sendRunPrompt } from "@/lib/runQueries";
import { formatDurationSeconds } from "@/lib/format";
import { Icon } from "../Icon";
import { ChatMarkdown } from "./chatMarkdown";
import { chatReducer, initChatState, openRunStream, type ChatItem } from "./chatStream";
import { toolIcon } from "./derive";
import { runInputsFromSnapshot, type RunLauncherDraft } from "./launcherState";
import {
  canReactivateRun,
  canUseRunComposer,
  isStaleRunDetail,
  shouldRestartPollingAfterPromptFailure,
} from "./reactivation";

/**
 * The run surface: one skill run's live chat (while the sandbox lives) or read-only transcript
 * (frozen). Boot flow: fetch the run → poll every 1.5s while `starting` (status_detail banner) →
 * seed the transcript → consume the normalized SSE event stream via `openRunStream`
 * (AbortController teardown, StrictMode-safe). Terminal runs open no stream until a message
 * atomically reactivates them and the worker returns them to `running`.
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
  overflowWrap: "anywhere",
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function AttachmentChips({ runId, attachments }: { runId: string; attachments: SkillRunAttachmentRow[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="run-chat__attachment-list">
      {attachments.map((attachment) => (
        <a
          key={attachment.id}
          href={runAttachmentHref(runId, attachment.id)}
          className="chip"
          title={`Download ${attachment.file_name}`}
        >
          <Icon name="file" size={11} />
          {attachment.file_name}
        </a>
      ))}
    </div>
  );
}

const STARTING_POLL_MS = 1500;

/** "Starting your run" banner: spinner + the live launch step + the indeterminate sweep track. */
function phaseLabel(phase: RunPhase | null | undefined): string {
  return phase ?? "pending";
}

function StartingBanner({ status, phase }: { status: "queued" | "starting"; phase: RunPhase | null | undefined }) {
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
        <span style={{ fontWeight: 500 }}>{status === "queued" ? "Run queued" : "Starting your run"}</span>
        <span className="mono" style={{ color: "var(--color-muted)" }}>{phaseLabel(phase)}</span>
      </div>
      <div className="chat-wake__track">
        <span className="chat-wake__bar" />
      </div>
    </div>
  );
}

/** Terminal transcript banner with both continuation guidance and the fresh-run escape hatch. */
function FrozenBanner({
  note,
  onRunAgain,
  canReactivate,
}: {
  note: string | null;
  onRunAgain: () => void;
  canReactivate: boolean;
}) {
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
      <Icon name={canReactivate ? "refresh-cw" : "lock"} size={13} style={{ color: "var(--color-muted)", flex: "none" }} />
      <span style={{ fontWeight: 500, color: "var(--color-fg)" }}>This session has ended</span>
      <span style={{ color: "var(--color-muted)" }}>
        {note ?? (canReactivate ? "Send a message below to reactivate it." : "The transcript below is read-only.")}
      </span>
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
        aria-expanded={expanded}
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
        aria-expanded={expanded}
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
  expectedSkillSlug,
  onBack,
  onRunAgain,
}: {
  runId: string;
  /** The route's skill slug. A mismatched deep link must never contaminate another skill's draft. */
  expectedSkillSlug: string;
  onBack: () => void;
  /** Open the launcher with accessible input references from this immutable snapshot. */
  onRunAgain: (draft: RunLauncherDraft) => void;
}) {
  const [run, setRun] = useState<SkillRunDetail | null>(null);
  const currentRunIdRef = useRef(runId);
  currentRunIdRef.current = runId;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadRetryNonce, setLoadRetryNonce] = useState(0);
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
  const lastEventIdRef = useRef<string | null>(null);
  const [promptPending, setPromptPending] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const promptSendingRef = useRef(false);
  const promptAttemptRef = useRef<{
    text: string;
    fileSignature: string;
    files: File[];
    idempotencyKey: string;
  } | null>(null);
  const [promptError, setPromptError] = useState<string | null>(null);
  const composerRef = useRef<HTMLInputElement | null>(null);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelRequestedLocal, setCancelRequestedLocal] = useState(false);
  const [reactivationClock, setReactivationClock] = useState(() => Date.now());
  const requestGenerationRef = useRef(0);
  const appliedGenerationRef = useRef(0);
  const appliedTranscriptSequenceRef = useRef(-1);

  const applyRunDetail = useCallback((detail: SkillRunDetail, generation: number): SkillRunDetail => {
    if (detail.id !== currentRunIdRef.current) {
      throw new Error("Ignored a stale response for a different run.");
    }
    if (detail.skill_slug !== expectedSkillSlug) {
      throw new Error("This run does not belong to the skill in the current route.");
    }
    const current = runRef.current;
    if (generation < appliedGenerationRef.current) return current ?? detail;
    if (current?.id === detail.id) {
      if (isStaleRunDetail(current, detail)) return current;
    }
    appliedGenerationRef.current = generation;
    runRef.current = detail;
    setRun(detail);
    setLoadError(null);
    return detail;
  }, [expectedSkillSlug]);

  const refreshRun = useCallback(async (): Promise<SkillRunDetail> => {
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    const detail = await fetchRun(runId);
    return applyRunDetail(detail, generation);
  }, [applyRunDetail, runId]);

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
        const detail = await refreshRun();
        if (!live) return;
        setRun(detail);
        if (detail.status === "queued" || detail.status === "starting") timer = setTimeout(() => void load(), STARTING_POLL_MS);
      } catch (error) {
        if (!live) return;
        setLoadError(error instanceof Error ? error.message : "Could not load the run.");
        // A failed status poll must not discard a previously loaded run or strand a queued job.
        // Keep polling the last known non-terminal snapshot while exposing an explicit retry.
        const lastKnown = runRef.current;
        if (lastKnown && (lastKnown.status === "queued" || lastKnown.status === "starting")) {
          timer = setTimeout(() => void load(), STARTING_POLL_MS);
        }
      }
    };
    void load();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [refreshRun, loadRetryNonce]);

  // --- Seed the transcript once the run is past `starting`. Frozen/error runs seed from the DB
  // snapshot; running runs seed from the same fetch, then the live stream appends (see below).
  // When the snapshot carries no user message yet (fresh run, first idle not reached), the original
  // prompt renders as a synthetic first bubble — the live stream never re-emits it.
  const [showPromptBubble, setShowPromptBubble] = useState(false);
  useEffect(() => {
    requestGenerationRef.current = 0;
    appliedGenerationRef.current = 0;
    appliedTranscriptSequenceRef.current = -1;
    lastEventIdRef.current = null;
    dispatch({ kind: "reset" });
    setRun(null);
    setLoadError(null);
    setText("");
    setFiles([]);
    setPromptPending(false);
    setPromptError(null);
    setStreamReady(false);
    promptAttemptRef.current = null;
    setCancelRequestedLocal(false);
    setCancelBusy(false);
    setStreamDead(false);
    setRowOverride(new Map());
  }, [runId]);
  useEffect(() => {
    if (!run || run.status === "queued" || run.status === "starting") return;
    const liveCursor = Number(lastEventIdRef.current ?? 0);
    // Metadata may refresh while the durable transcript still trails already-rendered SSE events.
    // Never replace the chat with such an intermediate snapshot; a later idle snapshot will fold it.
    if (run.transcript_event_sequence < liveCursor) return;
    if (run.transcript_event_sequence <= appliedTranscriptSequenceRef.current) return;
    appliedTranscriptSequenceRef.current = run.transcript_event_sequence;
    if (run.transcript_event_sequence > liveCursor) {
      lastEventIdRef.current = String(run.transcript_event_sequence);
    }
    setShowPromptBubble(!run.transcript.some((item) => item.kind === "user"));
    dispatch({ kind: "history", items: run.transcript, attachments: run.attachments, resolveToolLabel });
    setStreamDead(false);
  }, [run, resolveToolLabel]);

  useEffect(() => {
    if (!run) return;
    for (const warning of run.warnings) {
      dispatch({
        kind: "event",
        event: { type: "run.warning", code: warning.code, message: warning.message, phase: warning.phase },
        resolveToolLabel,
      });
    }
  }, [run, resolveToolLabel]);

  useEffect(() => {
    if (run && ["frozen", "error", "canceled"].includes(run.status)) setCancelRequestedLocal(false);
  }, [run]);

  useEffect(() => {
    const until = run?.reactivatable_until ? Date.parse(run.reactivatable_until) : Number.NaN;
    if (!Number.isFinite(until)) return;
    setReactivationClock(Date.now());
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => setReactivationClock(Date.now()), Math.min(remaining + 25, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [run?.reactivatable_until]);

  // --- Stream lifecycle: open the live stream only while `running`; aborted on cleanup
  // (StrictMode-safe). A terminal stream error re-fetches the run — it usually means freeze.
  const status = run?.status ?? "starting";
  useEffect(() => {
    if (status !== "running" || streamDead) return;
    const controller = new AbortController();
    setStreamReady(false);
    void openRunStream(
      runId,
      (event) => {
        setStreamReady(true);
        if (event.type === "error" && event.message === "This session has ended.") {
          // Gate the composer before reconciling terminal state. If that fetch fails, the
          // transport is already closed and must never continue looking writable.
          setStreamReady(false);
          setStreamDead(true);
          void refreshRun()
            .then((detail) => {
              if (detail.status === "running") {
                dispatch({
                  kind: "event",
                  event: { type: "error", message: "The live connection ended before terminal state could be confirmed." },
                  resolveToolLabel,
                });
              }
            })
            .catch((cause) => {
              setLoadError(cause instanceof Error ? cause.message : "Could not refresh the completed run.");
            });
          return;
        }
        dispatch({ kind: "event", event, resolveToolLabel });
        setStreamDead(false);
        if (event.type === "status" && event.state !== "idle") setPromptPending(false);
        if (event.type === "session.idle") {
          // Reconcile the durable transcript snapshot and persisted run state after each turn.
          void refreshRun().catch(() => {});
        } else if (event.type === "run.error") {
          void refreshRun().catch(() => {});
        } else if (event.type === "error") {
          // The reconnect budget is exhausted — the stream is dead even though the run may
          // still be healthy server-side. Refresh in case it actually froze, and stop the
          // composer from accepting input the user would never see a reply to.
          setStreamDead(true);
          setStreamReady(false);
          void refreshRun().catch(() => {});
        }
      },
      controller.signal,
      {
        lastEventId: lastEventIdRef.current,
        onEventId: (id) => {
          lastEventIdRef.current = id;
        },
        onConnected: () => {
          setStreamReady(true);
          setStreamDead(false);
          dispatch({ kind: "connected" });
        },
        onStreamEnd: async () => {
          try {
            const detail = await refreshRun();
            return ["frozen", "error", "canceled"].includes(detail.status);
          } catch {
            return false;
          }
        },
      },
    );
    return () => controller.abort();
  }, [status, runId, resolveToolLabel, streamDead, reconnectNonce, refreshRun]);

  // --- Auto-scroll the message area to the bottom on new items / streamed deltas.
  const listRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.items]);

  useEffect(() => {
    if (promptError) composerRef.current?.focus();
  }, [promptError]);

  const cancelRequested = cancelRequestedLocal || run?.phase === "cancel";
  const fileSignature = files.map((file) => [file.name, file.size, file.type, file.lastModified].join(":")).join("|");
  const hasMessage = text.trim().length > 0 || files.length > 0;
  const terminalCanReactivate = canReactivateRun(run, reactivationClock);
  const liveSendReady = status === "running" && !cancelRequested && streamReady && !streamDead && !chat.busy;
  const composerDisabled = !canUseRunComposer(status, liveSendReady, terminalCanReactivate) || promptPending;
  const sendDisabled = composerDisabled || !hasMessage;
  const streamingAssistant = chat.items.some((item) => item.kind === "asst" && item.streaming);
  const showWorking = chat.working.active && !streamingAssistant && status === "running";

  const send = () => {
    const trimmed = text.trim();
    if (promptSendingRef.current || sendDisabled || (!trimmed && files.length === 0)) return;
    const terminalDelivery = status === "frozen" || status === "canceled";
    const previous = promptAttemptRef.current;
    const retrying = previous?.text === trimmed && previous.fileSignature === fileSignature;
    const attempt = retrying
      ? previous
      : { text: trimmed, fileSignature, files: [...files], idempotencyKey: crypto.randomUUID() };
    if (!attempt) return;
    promptSendingRef.current = true;
    promptAttemptRef.current = attempt;
    setPromptPending(true);
    setPromptError(null);
    sendRunPrompt(runId, trimmed, attempt.files, attempt.idempotencyKey)
      .then((response) => {
        const currentRun = runRef.current;
        if (currentRun && response.attachments.length > 0) {
          const known = new Set(currentRun.attachments.map((attachment) => attachment.id));
          const merged = {
            ...currentRun,
            attachments: [
              ...currentRun.attachments,
              ...response.attachments.filter((attachment) => !known.has(attachment.id)),
            ],
          };
          runRef.current = merged;
          setRun(merged);
        }
        const lastVisibleUser = [...chat.items].reverse().find((item) => item.kind === "user");
        if (lastVisibleUser?.kind !== "user" || lastVisibleUser.messageId !== response.message_id) {
          dispatch({
            kind: "user",
            text: trimmed,
            messageId: response.message_id,
            attachments: response.attachments,
          });
        }
        dispatch({ kind: "send" });
        setText("");
        setFiles([]);
        if (fileInputRef.current) fileInputRef.current.value = "";
        promptAttemptRef.current = null;
        setPromptError(null);
        if (response.reactivated) {
          setStreamReady(false);
          setStreamDead(false);
          const current = runRef.current;
          if (current) {
            const next = {
              ...current,
              status: "queued" as const,
              phase: "queued" as const,
              error_code: null,
              error_message: null,
              status_detail: null,
              activation_revision: current.activation_revision + 1,
              reactivatable_until: null,
              can_reactivate: false,
            };
            runRef.current = next;
            setRun(next);
          }
        }
        // An idempotent retry may observe the already-created prompt and therefore return
        // `reactivated: false`. The run is still restarting, so always resume polling when the
        // message was submitted from a terminal composer.
        if (terminalDelivery) {
          setLoadRetryNonce((value) => value + 1);
          if (!response.reactivated) void refreshRun().catch(() => {});
        } else if (retrying) {
          void refreshRun().catch(() => {});
        }
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : "Could not send the message.";
        setPromptError(`Delivery status is unknown. Retry safely: ${message}`);
        if (shouldRestartPollingAfterPromptFailure(status)) {
          setLoadRetryNonce((value) => value + 1);
        }
        void refreshRun().catch(() => {});
      })
      .finally(() => {
        promptSendingRef.current = false;
        setPromptPending(false);
      });
  };

  const addFiles = (incoming: FileList | null) => {
    if (!incoming) return;
    setPromptError(null);
    promptAttemptRef.current = null;
    const next = [...files];
    const persistedBytes = run?.attachments.reduce((sum, attachment) => sum + attachment.byte_size, 0) ?? 0;
    for (const file of Array.from(incoming)) {
      if (next.length >= RUN_ATTACHMENT_MAX_FILES) {
        setPromptError(`You can attach at most ${RUN_ATTACHMENT_MAX_FILES} files per message.`);
        break;
      }
      if (file.size === 0) {
        setPromptError(`${file.name} is empty.`);
        continue;
      }
      if (file.size > RUN_ATTACHMENT_MAX_BYTES) {
        setPromptError(`${file.name} is larger than 10 MB.`);
        continue;
      }
      const draftBytes = next.reduce((sum, candidate) => sum + candidate.size, 0);
      if (persistedBytes + draftBytes + file.size > RUN_ATTACHMENT_MAX_TOTAL_BYTES) {
        setPromptError("This run can store at most 100 MB of attachments.");
        continue;
      }
      next.push(file);
    }
    setFiles(next);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const rerun = () => {
    if (!run) return;
    onRunAgain({
      prompt: run.prompt,
      files: [],
      model: run.model,
      inputs: runInputsFromSnapshot(run.input_snapshot),
      configurationId: run.run_config_id ?? null,
    });
  };

  const requestCancel = () => {
    if (!run || cancelBusy || !["queued", "starting", "running"].includes(run.status)) return;
    setCancelRequestedLocal(true);
    setCancelBusy(true);
    cancelRun(run.id)
      .then((detail) => {
        const generation = requestGenerationRef.current + 1;
        requestGenerationRef.current = generation;
        applyRunDetail(detail, generation);
      })
      .catch((cause) => {
        setCancelRequestedLocal(false);
        dispatch({
          kind: "event",
          event: { type: "run.warning", code: "cancel_failed", message: cause instanceof Error ? cause.message : "Could not cancel the run.", phase: run.phase ?? null },
          resolveToolLabel,
        });
      })
      .finally(() => setCancelBusy(false));
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

  const statusWord = cancelRequested ? "canceling" : status === "frozen" ? "ended" : status;
  const dotCls =
    status === "running"
      ? "vdot vdot--ok"
      : status === "queued" || status === "starting"
        ? "vdot vdot--warn"
        : status === "error"
          ? "vdot vdot--down"
          : "vdot vdot--unknown";

  const retryLoad = () => {
    setLoadError(null);
    setStreamDead(false);
    setReconnectNonce((value) => value + 1);
    setLoadRetryNonce((value) => value + 1);
  };

  if (loadError && !run) {
    return (
      <div data-screen-label="Run" style={{ height: "100%", display: "grid", placeItems: "center", padding: 24 }}>
        <div style={{ textAlign: "center" }}>
          <p style={{ color: "var(--color-danger)", fontSize: "var(--text-sm)" }} role="alert">
            {loadError}
          </p>
          <div style={{ display: "flex", justifyContent: "center", gap: 8 }}>
            <button type="button" className="btn-primary" onClick={retryLoad}>
              <Icon name="refresh-cw" size={13} />
              Retry
            </button>
            <button type="button" className="btn-sec" onClick={onBack}>
              <Icon name="arrow-left" size={13} />
              Back
            </button>
          </div>
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
          {loadError && (
            <div className="run-chat__load-warning" role="alert">
              <Icon name="alert-triangle" size={13} />
              <span>Could not refresh this run. Showing the latest available snapshot.</span>
              <button type="button" className="btn-sec" onClick={retryLoad}>Retry</button>
            </div>
          )}
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
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--color-muted)" }}>
                {statusWord}{run?.phase ? ` · ${phaseLabel(run.phase)}` : ""}
              </span>
              {chat.working.active && status === "running" && (
                <Icon name="loader" size={12} className="ls-spin" style={{ color: "var(--color-muted)", flex: "none" }} aria-label="working" />
              )}
            </div>
            <span style={{ flex: 1 }} />
            {run && (
              <div className="run-chat__meta">
                {run.run_config_name_snapshot && <span className="run-chat__config">{run.run_config_name_snapshot}</span>}
                <span className="mono">{run.model}</span>
                {["queued", "starting", "running"].includes(run.status) && (
                  <button type="button" className="btn-sec" disabled={cancelBusy || cancelRequested} onClick={requestCancel}>
                    {cancelBusy || cancelRequested ? "Canceling…" : "Cancel"}
                  </button>
                )}
              </div>
            )}
          </header>

          {(status === "queued" || status === "starting") && <StartingBanner status={status} phase={run?.phase} />}
          {status === "frozen" && run && (
            <FrozenBanner
              note={terminalCanReactivate ? "Send a message below to reactivate this session." : "The reactivation window has expired."}
              onRunAgain={rerun}
              canReactivate={terminalCanReactivate}
            />
          )}
          {status === "canceled" && run && (
            <FrozenBanner
              note={terminalCanReactivate ? "Send a message below to reactivate from the last durable snapshot." : "The reactivation window has expired."}
              onRunAgain={rerun}
              canReactivate={terminalCanReactivate}
            />
          )}
          {status === "error" && run && (
            <div
              className="run-chat__error-banner"
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
              <span style={{ minWidth: 0, color: "var(--color-muted)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{run.error_message ?? run.status_detail ?? "The runtime stopped unexpectedly."}</span>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn-sec" onClick={rerun}>
                Try again
              </button>
            </div>
          )}

          <div
            ref={listRef}
            role="log"
            aria-label="Run transcript"
            aria-live="polite"
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
            {run && showPromptBubble && status !== "queued" && status !== "starting" && (
              <div className="run-chat__user-message">
                {run.prompt && <div className="run-chat__user-text">{run.prompt}</div>}
                <AttachmentChips
                  runId={run.id}
                  attachments={run.attachments.filter((attachment) => attachment.prompt_ordinal === 0)}
                />
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
                  <div key={item.id} className="run-chat__user-message">
                    {item.text && <div className="run-chat__user-text">{item.text}</div>}
                    <AttachmentChips runId={runId} attachments={item.attachments} />
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
            {chat.warnings.map((warning) => (
              <div className="run-chat__warning" role="status" key={`${warning.code}:${warning.message}`}>
                <Icon name="alert-triangle" size={13} />
                <span><b>Warning</b> {warning.message}</span>
              </div>
            ))}
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

          <div style={{ flex: "none", padding: "12px 16px 14px", borderTop: "1px solid var(--color-line)", background: "var(--color-surface)" }}>
            {files.length > 0 && (
              <div className="launch-files run-chat__draft-files">
                {files.map((file, index) => (
                  <span className="launch-file" key={`${file.name}-${file.size}-${index}`}>
                    <Icon name="file" size={12} />
                    <span className="launch-file__name">{file.name}</span>
                    <span className="launch-file__size">{formatBytes(file.size)}</span>
                    <button
                      type="button"
                      className="launch-file__x"
                      disabled={promptPending}
                      aria-label={`Remove ${file.name}`}
                      onClick={() => {
                        promptAttemptRef.current = null;
                        setPromptError(null);
                        setFiles(files.filter((_, itemIndex) => itemIndex !== index));
                      }}
                    >
                      <Icon name="x" size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div
              className="run-chat__composer-box"
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                border: "1px solid var(--color-line)",
                borderRadius: "var(--radius-md)",
                background: "var(--color-surface)",
                padding: "4px 4px 4px 12px",
                opacity: status === "running" || terminalCanReactivate ? 1 : 0.6,
              }}
            >
              <button
                type="button"
                className="composer__attach"
                title="Attach files"
                aria-label="Attach files"
                disabled={composerDisabled || files.length >= RUN_ATTACHMENT_MAX_FILES}
                onClick={() => fileInputRef.current?.click()}
              >
                <Icon name="paperclip" size={14} />
              </button>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                aria-label="Attach files"
                disabled={composerDisabled}
                onChange={(event) => addFiles(event.target.files)}
              />
              <label className="sr-only" htmlFor="run-follow-up">Send a follow-up message</label>
              <input
                id="run-follow-up"
                ref={composerRef}
                value={text}
                onChange={(e) => {
                  if (promptAttemptRef.current?.text !== e.target.value.trim()) promptAttemptRef.current = null;
                  setPromptError(null);
                  setText(e.target.value);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") send();
                }}
                disabled={composerDisabled}
                aria-describedby={promptError ? "run-follow-up-error" : undefined}
                placeholder={
                  status === "running"
                    ? cancelRequested ? "Canceling…" : "Send a follow-up or attach files"
                    : status === "queued"
                      ? "Queued…"
                      : status === "starting"
                        ? "Starting…"
                      : status === "frozen"
                        ? terminalCanReactivate ? "Send a message to reactivate" : "This session has ended. Start a new run."
                        : status === "canceled"
                          ? terminalCanReactivate ? "Send a message to reactivate" : "This run was canceled."
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
                style={{ width: 36, height: 36, padding: 0, justifyContent: "center" }}
                aria-label="Send"
              >
                <Icon name="arrow-up" size={15} />
              </button>
            </div>
            {promptError && <p className="run-chat__prompt-error" id="run-follow-up-error" role="alert">{promptError}</p>}
            <div style={{ marginTop: 7, fontSize: 11, color: "var(--color-faint)", textAlign: "center" }}>
              {terminalCanReactivate
                ? "Attach up to 5 files (10 MB each) and send a message to resume this session."
                : "Up to 5 files per message, 10 MB each and 100 MB per run. This sandbox freezes after a few minutes of inactivity."}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
