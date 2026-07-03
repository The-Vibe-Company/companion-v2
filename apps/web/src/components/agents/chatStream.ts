import type { AgentChatEvent, AgentChatHistoryItem } from "@companion/contracts";

/**
 * Pure pieces of the chat surface: an incremental SSE frame parser (the stream is consumed via
 * `fetch` + ReadableStream, not EventSource — deterministic AbortController teardown for StrictMode)
 * and the reducer that folds normalized `AgentChatEvent`s into the visible message list.
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
      buffer += chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
export function decodeChatEvent(frame: SseFrame): AgentChatEvent | null {
  if (!frame.data) return null;
  try {
    const parsed: unknown = JSON.parse(frame.data);
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
      return parsed as AgentChatEvent;
    }
    return null;
  } catch {
    return null;
  }
}

/* ---- Stream lifecycle ------------------------------------------------------------- */

const STREAM_MAX_RECONNECTS = 3;

/**
 * Open the agent's SSE event stream and pump decoded events into `onEvent` until `signal` aborts.
 * Consumed with fetch + ReadableStream (deterministic teardown); reconnects with exponential
 * backoff (max {@link STREAM_MAX_RECONNECTS} tries), resuming from `parser.lastId()` via a
 * `last_event_id` query param (harmless if the backend ignores it). Auth/shape failures
 * (401/404/422) surface as a terminal `error` event instead of retrying.
 */
export async function openChatStream(
  slug: string,
  sessionId: string,
  onEvent: (event: AgentChatEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  const parser = createSseParser();
  let attempts = 0;
  for (;;) {
    if (signal.aborted) return;
    try {
      const params = new URLSearchParams({ session: sessionId });
      const lastId = parser.lastId();
      if (lastId) params.set("last_event_id", lastId);
      const res = await fetch(`/v1/agents/${encodeURIComponent(slug)}/events?${params.toString()}`, {
        signal,
        headers: { accept: "text/event-stream" },
      });
      if (res.status === 401 || res.status === 404 || res.status === 422) {
        onEvent({ type: "error", message: `Chat stream unavailable (${res.status}).` });
        return;
      }
      if (!res.ok || !res.body) throw new Error(`stream failed: ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const frame of parser.push(decoder.decode(value, { stream: true }))) {
          const event = decodeChatEvent(frame);
          if (event) onEvent(event);
        }
      }
      // The server closed the stream — reconnect (the parser keeps its lastId).
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

/* ---- Chat state ----------------------------------------------------------------- */

export type ChatItem =
  | { kind: "sys"; id: string; text: string }
  | { kind: "user"; id: string; text: string }
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
}

export interface ChatState {
  items: ChatItem[];
  /** True from send until the assistant reply completes (disables the composer). */
  busy: boolean;
  /** The visible working indicator (session.status-driven). */
  working: WorkingState;
  sessionId: string | null;
  error: string | null;
}

export function initChatState(): ChatState {
  return { items: [], busy: false, working: { active: false, label: "" }, sessionId: null, error: null };
}

export type ResolveToolLabel = (tool: string, skill: string | null) => { label: string; action: string };

export type ChatAction =
  | { kind: "sys"; text: string }
  | { kind: "user"; text: string }
  | { kind: "event"; event: AgentChatEvent; resolveToolLabel: ResolveToolLabel }
  | {
      /** Seed prior-session messages ABOVE any sys lines, before the live stream opens. */
      kind: "history";
      items: AgentChatHistoryItem[];
      resolveToolLabel: ResolveToolLabel;
    }
  | { kind: "send" }
  | { kind: "reset-busy" }
  /** Clear the transcript back to an empty session (New session). */
  | { kind: "reset" };

let localId = 0;
function nextId(prefix: string): string {
  localId += 1;
  return `${prefix}-${localId}`;
}

/** Map one persisted history item to a completed `ChatItem` (tool rows resolve their label + finish). */
function mapHistoryItem(item: AgentChatHistoryItem, resolveToolLabel: ResolveToolLabel): ChatItem {
  switch (item.kind) {
    case "user":
      return { kind: "user", id: nextId("user"), text: item.text };
    case "assistant":
      return { kind: "asst", id: nextId("asst"), messageId: null, text: item.text, streaming: false };
    case "tool": {
      const { label, action } = resolveToolLabel(item.tool, item.skill);
      return {
        kind: "tool",
        id: nextId("tool"),
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
    case "user":
      return { ...state, items: [...state.items, { kind: "user", id: nextId("user"), text: action.text }] };
    case "history": {
      // Preserve any existing sys lines (boot annotations like "resumed from snapshot") ABOVE the
      // reloaded transcript, so history shows above new live events appended afterwards.
      const sysLines = state.items.filter((item) => item.kind === "sys");
      const history = action.items.map((item) => mapHistoryItem(item, action.resolveToolLabel));
      return { ...state, items: [...sysLines, ...history] };
    }
    case "send":
      return { ...state, busy: true, error: null };
    case "reset-busy":
      return { ...state, busy: false };
    case "reset":
      return initChatState();
    case "event":
      return applyEvent(state, action.event, action.resolveToolLabel);
  }
}

function applyEvent(state: ChatState, event: AgentChatEvent, resolveToolLabel: ResolveToolLabel): ChatState {
  switch (event.type) {
    case "ready":
      return { ...state, sessionId: event.session_id };
    case "status": {
      // The reliable "is it running?" signal from OpenCode's session.status — never inferred.
      if (event.state === "idle") {
        return { ...state, busy: false, working: { active: false, label: "" } };
      }
      if (event.state === "retry") {
        const label = event.attempt ? `Retrying (attempt ${event.attempt})…` : "Retrying…";
        return { ...state, busy: true, working: { active: true, label } };
      }
      // busy — keep a more specific "Running <tool>…" label if a tool is mid-flight.
      const toolRunning = state.items.some((item) => item.kind === "tool" && item.running);
      const label = toolRunning && state.working.label ? state.working.label : "Thinking…";
      return { ...state, busy: true, working: { active: true, label } };
    }
    case "tool.start": {
      const { label, action } = resolveToolLabel(event.tool, event.skill);
      const runningLabel = event.title?.trim() ? event.title.trim() : label;
      return {
        ...state,
        working: { active: true, label: `Running ${runningLabel}…` },
        items: [
          ...state.items,
          {
            kind: "tool",
            id: nextId("tool"),
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
              ? { ...item, text: item.text + event.delta }
              : item,
          ),
        };
      }
      return {
        ...state,
        working,
        items: [
          ...state.items,
          { kind: "reasoning", id: nextId("reasoning"), partId: event.part_id, text: event.delta, streaming: true },
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
          items: items.map((item) =>
            item.kind === "asst" && item.messageId === event.message_id
              ? { ...item, text: item.text + event.delta }
              : item,
          ),
        };
      }
      return {
        ...state,
        items: [
          ...items,
          { kind: "asst", id: nextId("asst"), messageId: event.message_id, text: event.delta, streaming: true },
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
    case "session.idle":
      return { ...state, busy: false, working: { active: false, label: "" } };
    case "error":
      return { ...state, busy: false, working: { active: false, label: "" }, error: event.message };
  }
}
