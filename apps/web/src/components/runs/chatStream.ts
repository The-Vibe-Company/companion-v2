import {
  runChatEventSchema,
  type RunChatEvent,
  type RunChatHistoryItem,
  type RunRetryAction,
  type SkillRunAttachmentRow,
} from "@companion/contracts";

/**
 * Pure pieces of the chat surface: an incremental SSE frame parser (the stream is consumed via
 * `fetch` + ReadableStream, not EventSource — deterministic AbortController teardown for StrictMode)
 * and the reducer that folds normalized `RunChatEvent`s into the visible message list.
 */

/* ---- SSE parsing ------------------------------------------------------------------ */

export interface SseFrame {
  event: string | null;
  id: string | null;
  data: string;
}

export interface SseParser {
  /** Feed a decoded chunk; returns the frames completed by it. */
  push(chunk: string): SseFrame[];
  /** The last seen frame id (for reconnect with Last-Event-ID). */
  lastId(): string | null;
}

export function createSseParser(): SseParser {
  let buffer = "";
  let lastId: string | null = null;
  let pendingCr = false;

  function parseFrame(raw: string): SseFrame | null {
    let event: string | null = null;
    let id: string | null = null;
    const data: string[] = [];
    for (const line of raw.split("\n")) {
      if (line.startsWith(":")) continue; // comment / heartbeat
      const sep = line.indexOf(":");
      if (sep === -1) continue;
      const field = line.slice(0, sep);
      const value = line.startsWith(`${field}: `) ? line.slice(sep + 2) : line.slice(sep + 1);
      if (field === "event") event = value;
      else if (field === "id") id = value;
      else if (field === "data") data.push(value);
    }
    if (event === null && id === null && data.length === 0) return null;
    if (id !== null) lastId = id;
    return { event, id, data: data.join("\n") };
  }

  return {
    push(chunk: string): SseFrame[] {
      let source = pendingCr ? `\r${chunk}` : chunk;
      pendingCr = false;
      if (source.endsWith("\r")) {
        pendingCr = true;
        source = source.slice(0, -1);
      }
      // Preserve a CRLF boundary split between decoded chunks. Normalizing each chunk in
      // isolation turns `\r` + `\n` into two line breaks and can terminate a frame early.
      buffer += source.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      const frames: SseFrame[] = [];
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const frame = parseFrame(raw);
        if (frame) frames.push(frame);
        boundary = buffer.indexOf("\n\n");
      }
      return frames;
    },
    lastId: () => lastId,
  };
}

/** Decode one SSE frame's data into a normalized chat event; null for pings/unknown payloads. */
export function decodeChatEvent(frame: SseFrame): RunChatEvent | null {
  if (!frame.data) return null;
  try {
    // Validate against the contract union rather than trusting the wire shape: a malformed frame
    // (partial/renamed fields from an OpenCode churn) is dropped, not fed to the reducer. Defaults
    // (`title`/`attempt`/`message` → null) are applied here, so downstream reads are total.
    const parsed = JSON.parse(frame.data) as unknown;
    const payload = parsed && typeof parsed === "object" && "event" in parsed
      ? (parsed as { event: unknown }).event
      : parsed;
    const result = runChatEventSchema.safeParse(payload);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

/* ---- Stream lifecycle ------------------------------------------------------------- */

const STREAM_MAX_RECONNECTS = 3;

export interface ChatStreamCursor {
  lastEventId?: string | null;
  onEventId?: (id: string) => void;
  /** The HTTP stream is open. This is deliberately independent from replay payloads. */
  onConnected?: () => void;
  /** Reconcile durable state when the server intentionally closes a terminal stream. */
  onStreamEnd?: () => Promise<boolean>;
}

/**
 * Open one normalized OpenCode SSE stream and pump decoded events until `signal` aborts.
 * Consumed with fetch + ReadableStream (deterministic teardown); reconnects with exponential
 * backoff (max {@link STREAM_MAX_RECONNECTS} tries), resuming from `parser.lastId()` via a
 * `last_event_id` query param. Auth/shape/state failures surface as a terminal event.
 */
async function openChatStream(
  eventsPath: string,
  onEvent: (event: RunChatEvent) => void,
  signal: AbortSignal,
  cursor?: ChatStreamCursor,
): Promise<void> {
  let attempts = 0;
  let lastDeliveredId: string | null = cursor?.lastEventId ?? null;
  for (;;) {
    if (signal.aborted) return;
    try {
      const params = new URLSearchParams();
      const lastId = lastDeliveredId;
      if (lastId) params.set("last_event_id", lastId);
      const query = params.toString();
      const res = await fetch(`${eventsPath}${query ? `?${query}` : ""}`, {
        signal,
        headers: {
          accept: "text/event-stream",
          ...(lastId ? { "Last-Event-ID": lastId } : {}),
        },
      });
      if (res.status === 409) {
        // The run froze between the fetch and the stream open — terminal, not retryable.
        onEvent({ type: "error", message: "This session has ended." });
        return;
      }
      if (res.status === 401 || res.status === 404 || res.status === 422) {
        onEvent({ type: "error", message: `Chat stream unavailable (${res.status}).` });
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
      cursor?.onConnected?.();
      // A transport cut may leave an incomplete frame buffered. Never carry that buffer into a
      // replay response: the server will resend the whole event after `lastDeliveredId`.
      const parser = createSseParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const connectedAt = Date.now();
      let deliveredValidEvent = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const event = decodeChatEvent(frame);
          if (!event) continue;
          if (frame.id && frame.id === lastDeliveredId) continue;
          if (frame.id) {
            lastDeliveredId = frame.id;
            cursor?.onEventId?.(frame.id);
          }
          deliveredValidEvent = true;
          attempts = 0;
          onEvent(event);
        }
      }
      // A terminal run closes its SSE response after draining the durable backlog. Reconcile the
      // run before treating EOF as a transport failure so freeze/cancel does not burn the reconnect
      // budget or leave the UI looking live forever.
      if (cursor?.onStreamEnd && (await cursor.onStreamEnd())) return;
      // A quiet connection only earns a fresh budget when it stayed up long enough to be a
      // durable connection. An immediately-closing 200 must not create an infinite retry loop.
      if (!deliveredValidEvent && Date.now() - connectedAt >= 10_000) attempts = 0;
      // The server closed the stream — reconnect from the last fully decoded event id.
      throw new Error("stream ended");
    } catch (error) {
      if (signal.aborted) return;
      attempts += 1;
      if (attempts > STREAM_MAX_RECONNECTS) {
        onEvent({
          type: "error",
          message: error instanceof Error && error.message !== "stream ended" ? error.message : "Lost connection to the agent stream.",
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 400 * 2 ** (attempts - 1)));
    }
  }
}

export function openRunStream(
  runId: string,
  onEvent: (event: RunChatEvent) => void,
  signal: AbortSignal,
  cursor?: ChatStreamCursor,
): Promise<void> {
  return openChatStream(
    `/v1/runs/${encodeURIComponent(runId)}/events`,
    onEvent,
    signal,
    cursor,
  );
}

export function openProjectStream(
  projectId: string,
  sessionId: string,
  onEvent: (event: RunChatEvent) => void,
  signal: AbortSignal,
  cursor?: ChatStreamCursor,
): Promise<void> {
  return openChatStream(
    `/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}/events`,
    onEvent,
    signal,
    cursor,
  );
}

/* ---- Chat state ----------------------------------------------------------------- */

export type ChatItem =
  | { kind: "sys"; id: string; text: string }
  | {
      kind: "user";
      id: string;
      text: string;
      messageId: string | null;
      attachments: SkillRunAttachmentRow[];
    }
  | {
      kind: "tool";
      id: string;
      callId: string;
      /** "skill@version" when resolvable, else the raw tool name. */
      label: string;
      action: string;
      /** Raw OpenCode tool name (bash/read/webfetch/…) — drives the per-tool icon. */
      tool: string;
      /** Resolved skill slug when the run maps to an installed skill, else null. */
      skill: string | null;
      running: boolean;
      input: string;
      output: string;
      durationMs: number | null;
    }
  | { kind: "reasoning"; id: string; partId: string; text: string; streaming: boolean }
  | { kind: "asst"; id: string; messageId: string | null; text: string; streaming: boolean };

/** Live "is it running?" state, driven by OpenCode session.status — never inferred from content. */
export interface WorkingState {
  active: boolean;
  label: string;
  retryAt?: number | null;
  retryAction?: RunRetryAction | null;
}

export interface ChatState {
  items: ChatItem[];
  /** True from send until the assistant reply completes (disables the composer). */
  busy: boolean;
  /** The visible working indicator (session.status-driven). */
  working: WorkingState;
  sessionId: string | null;
  error: string | null;
  warnings: { code: string; message: string }[];
  /** Prompt currently owning live OpenCode output; queued siblings must not settle its visuals. */
  activePromptId?: string | null;
}

export function initChatState(): ChatState {
  return {
    items: [],
    busy: false,
    working: { active: false, label: "" },
    sessionId: null,
    error: null,
    warnings: [],
    activePromptId: null,
  };
}

export type ResolveToolLabel = (tool: string, skill: string | null) => { label: string; action: string };

export type ChatAction =
  | { kind: "sys"; text: string }
  | { kind: "user"; text: string; messageId?: string | null; attachments?: SkillRunAttachmentRow[] }
  | { kind: "event"; event: RunChatEvent; resolveToolLabel: ResolveToolLabel }
  | {
      /** Seed prior-session messages ABOVE any sys lines, before the live stream opens. */
      kind: "history";
      items: RunChatHistoryItem[];
      attachments?: SkillRunAttachmentRow[];
      resolveToolLabel: ResolveToolLabel;
    }
  | { kind: "send" }
  | { kind: "connected" }
  | { kind: "reset-busy" }
  /** Clear the transcript back to an empty session (New session). */
  | { kind: "reset" };

let localId = 0;
function nextId(prefix: string): string {
  localId += 1;
  return `${prefix}-${localId}`;
}

/** Map one persisted history item to a completed `ChatItem` (tool rows resolve their label + finish). */
function mapHistoryItem(
  item: RunChatHistoryItem,
  resolveToolLabel: ResolveToolLabel,
  attachments: SkillRunAttachmentRow[] = [],
  promptOrdinal?: number,
  historyIndex = 0,
): ChatItem {
  switch (item.kind) {
    case "user":
      return {
        kind: "user",
        id: item.message_id ? `user:${item.message_id}` : `history:user:${promptOrdinal ?? historyIndex}`,
        text: item.text,
        messageId: item.message_id ?? null,
        attachments: item.message_id
          ? attachments.filter((attachment) => attachment.message_id === item.message_id)
          : attachments.filter((attachment) => attachment.prompt_ordinal === promptOrdinal),
      };
    case "assistant": {
      const messageId = "message_id" in item && typeof item.message_id === "string" ? item.message_id : null;
      return {
        kind: "asst",
        id: messageId ? `assistant:${messageId}` : `history:assistant:${historyIndex}`,
        messageId,
        text: item.text,
        streaming: false,
      };
    }
    case "tool": {
      const { label, action } = resolveToolLabel(item.tool, item.skill);
      return {
        kind: "tool",
        id: `tool:${item.call_id}`,
        callId: item.call_id,
        label,
        action: item.title ?? action,
        tool: item.tool,
        skill: item.skill,
        running: false,
        input: item.input,
        output: item.output,
        durationMs: item.duration_ms,
      };
    }
  }
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "sys":
      return { ...state, items: [...state.items, { kind: "sys", id: nextId("sys"), text: action.text }] };
    case "user": {
      if (action.messageId) {
        const existing = state.items.find((item) => item.kind === "user" && item.messageId === action.messageId);
        if (existing) {
          return {
            ...state,
            items: state.items.map((item) => item.kind === "user" && item.messageId === action.messageId
              ? {
                  ...item,
                  text: item.text || action.text,
                  attachments: item.attachments.length > 0 ? item.attachments : action.attachments ?? [],
                }
              : item),
          };
        }
      }
      return {
        ...state,
        items: [...state.items, {
          kind: "user",
          id: action.messageId ? `user:${action.messageId}` : nextId("user"),
          text: action.text,
          messageId: action.messageId ?? null,
          attachments: action.attachments ?? [],
        }],
      };
    }
    case "history": {
      // Preserve any existing sys lines (boot annotations like "resumed from snapshot") ABOVE the
      // reloaded transcript, so history shows above new live events appended afterwards.
      const sysLines = state.items.filter((item) => item.kind === "sys");
      let promptOrdinal = 0;
      const history = action.items.map((item, historyIndex) => {
        const itemPromptOrdinal = item.kind === "user" ? promptOrdinal++ : undefined;
        return mapHistoryItem(item, action.resolveToolLabel, action.attachments, itemPromptOrdinal, historyIndex);
      });
      return {
        ...state,
        items: [...sysLines, ...history],
        busy: false,
        working: { active: false, label: "" },
      };
    }
    case "send":
      return { ...state, busy: true, error: null };
    case "connected":
      return { ...state, error: null };
    case "reset-busy":
      return { ...state, busy: false };
    case "reset":
      return initChatState();
    case "event":
      return applyEvent(state, action.event, action.resolveToolLabel);
  }
}

function applyEvent(state: ChatState, event: RunChatEvent, resolveToolLabel: ResolveToolLabel): ChatState {
  switch (event.type) {
    case "ready":
      // The server re-sends "ready" at the start of every connection, including a manual
      // reconnect — clear any stale terminal-error banner from a prior dead stream.
      return { ...state, sessionId: event.session_id, error: null };
    case "status": {
      // The reliable "is it running?" signal from OpenCode's session.status — never inferred.
      if (event.state === "idle") {
        return { ...state, busy: false, working: { active: false, label: "" } };
      }
      if (event.state === "retry") {
        const label = event.attempt
          ? `Retrying · attempt ${event.attempt}`
          : "Retrying";
        return {
          ...state,
          busy: true,
          working: {
            active: true,
            label,
            retryAt: event.retry_at ?? null,
            retryAction: event.retry_action ?? null,
          },
        };
      }
      const activityLabel =
        event.activity === "responding"
          ? "Responding…"
          : event.activity === "waiting_for_answer"
            ? "Waiting for your answer"
            : event.activity === "compacting"
              ? "Organizing context…"
              : event.activity === "retrying"
                ? "Retrying"
                : event.activity === "thinking"
                  ? "Thinking…"
                  : null;
      // busy — keep a more specific "Running <tool>…" label if a tool is mid-flight.
      const toolRunning = state.items.some((item) => item.kind === "tool" && item.running);
      const label =
        activityLabel ??
        (toolRunning && state.working.label
          ? state.working.label
          : "Thinking…");
      return { ...state, busy: true, working: { active: true, label } };
    }
    case "tool.start": {
      const { label, action } = resolveToolLabel(event.tool, event.skill);
      const semanticLabel = /^(Using|Updating|Reviewing|Researching|Working)\b/.test(
        label,
      );
      const runningLabel = semanticLabel
        ? label
        : `Running ${event.title?.trim() ? event.title.trim() : label}`;
      const workingLabel = `${runningLabel}…`;
      const existing = state.items.find((item) => item.kind === "tool" && item.callId === event.call_id);
      if (existing) {
        return {
          ...state,
          working: { active: true, label: workingLabel },
          items: state.items.map((item) => item.kind === "tool" && item.callId === event.call_id
            ? { ...item, running: true, action: event.title ?? action, input: event.input }
            : item),
        };
      }
      return {
        ...state,
        working: { active: true, label: workingLabel },
        items: [
          ...state.items,
          {
            kind: "tool",
            id: `tool:${event.call_id}`,
            callId: event.call_id,
            label,
            action: event.title ?? action,
            tool: event.tool,
            skill: event.skill,
            running: true,
            input: event.input,
            output: "",
            durationMs: null,
          },
        ],
      };
    }
    case "tool.done": {
      const items = state.items.map((item) =>
        item.kind === "tool" && item.callId === event.call_id
          ? { ...item, running: false, action: event.title ?? item.action, output: event.output, durationMs: event.duration_ms }
          : item,
      );
      // If nothing else is running but the session is still busy, fall back to a generic label.
      const stillRunning = items.some((item) => item.kind === "tool" && item.running);
      const working = stillRunning || !state.working.active ? state.working : { active: true, label: "Thinking…" };
      return { ...state, items, working };
    }
    case "reasoning.delta": {
      const existing = state.items.find(
        (item): item is Extract<ChatItem, { kind: "reasoning" }> =>
          item.kind === "reasoning" && item.partId === event.part_id,
      );
      const working = { active: true, label: state.working.label || "Thinking…" };
      if (existing) {
        return {
          ...state,
          working,
          items: state.items.map((item) =>
            item.kind === "reasoning" && item.partId === event.part_id
              ? { ...item, text: item.text + event.delta, streaming: true }
              : item,
          ),
        };
      }
      return {
        ...state,
        working,
        items: [
          ...state.items,
          { kind: "reasoning", id: `reasoning:${event.part_id}`, partId: event.part_id, text: event.delta, streaming: true },
        ],
      };
    }
    case "reasoning.done":
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "reasoning" && item.partId === event.part_id ? { ...item, streaming: false } : item,
        ),
      };
    case "text.delta": {
      // The answer is arriving — collapse any live reasoning block so it tucks itself away.
      const items = state.items.map((item) =>
        item.kind === "reasoning" && item.streaming ? { ...item, streaming: false } : item,
      );
      const existing = items.find(
        (item): item is Extract<ChatItem, { kind: "asst" }> =>
          item.kind === "asst" && item.messageId === event.message_id,
      );
      if (existing) {
        return {
          ...state,
          working: { active: true, label: "Responding…" },
          items: items.map((item) =>
            item.kind === "asst" && item.messageId === event.message_id
              ? { ...item, text: item.text + event.delta, streaming: true }
              : item,
          ),
        };
      }
      return {
        ...state,
        working: { active: true, label: "Responding…" },
        items: [
          ...items,
          { kind: "asst", id: `assistant:${event.message_id}`, messageId: event.message_id, text: event.delta, streaming: true },
        ],
      };
    }
    case "text.done": {
      return {
        ...state,
        busy: false,
        items: state.items.map((item) =>
          item.kind === "asst" && item.messageId === event.message_id ? { ...item, streaming: false } : item,
        ),
      };
    }
    case "question.asked":
      return {
        ...state,
        busy: true,
        working: { active: true, label: "Waiting for your answer" },
      };
    case "question.replied":
    case "question.rejected":
      return {
        ...state,
        busy: true,
        working: { active: true, label: "Thinking…" },
      };
    case "session.idle":
      return {
        ...state,
        busy: false,
        activePromptId: null,
        working: { active: false, label: "" },
        items: state.items.map((item) => {
          if (item.kind === "tool" && item.running) return { ...item, running: false };
          if ((item.kind === "asst" || item.kind === "reasoning") && item.streaming) {
            return { ...item, streaming: false };
          }
          return item;
        }),
      };
    case "artifacts.collecting":
    case "artifacts.updated":
      return state;
    case "prompt.status":
      if (event.status === "processing") {
        return { ...state, busy: true, error: null, activePromptId: event.prompt_id };
      }
      if (event.status === "queued" || event.status === "completed" || event.status === "canceled" || event.status === "error") {
        // Queue and cancellation events can belong to a follow-up waiting behind the live turn.
        // Only the prompt that entered processing is allowed to settle global OpenCode visuals.
        if (state.activePromptId !== event.prompt_id) return state;
        return {
          ...state,
          busy: false,
          activePromptId: null,
          working: { active: false, label: "" },
          // A stopped turn can legitimately have no text.done/reasoning.done. Preserve its partial
          // bytes but close every visual streaming state so the transcript is explicitly settled.
          items: state.items.map((item) => {
            if (item.kind === "tool" && item.running) return { ...item, running: false };
            if ((item.kind === "asst" || item.kind === "reasoning") && item.streaming) {
              return { ...item, streaming: false };
            }
            return item;
          }),
        };
      }
      return state;
    case "run.warning":
      return state.warnings.some((warning) => warning.code === event.code && warning.message === event.message)
        ? state
        : { ...state, warnings: [...state.warnings, { code: event.code, message: event.message }] };
    case "run.error":
      return { ...state, busy: false, working: { active: false, label: "" }, error: event.message };
    case "error":
      return { ...state, busy: false, working: { active: false, label: "" }, error: event.message };
  }
}
