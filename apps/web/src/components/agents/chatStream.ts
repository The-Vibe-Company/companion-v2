import type { AgentChatEvent } from "@companion/contracts";

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
      running: boolean;
      input: string;
      output: string;
      durationMs: number | null;
    }
  | { kind: "asst"; id: string; messageId: string | null; text: string; streaming: boolean };

export interface ChatState {
  items: ChatItem[];
  /** True from send until the assistant reply completes (disables the composer). */
  busy: boolean;
  sessionId: string | null;
  error: string | null;
}

export function initChatState(): ChatState {
  return { items: [], busy: false, sessionId: null, error: null };
}

export type ChatAction =
  | { kind: "sys"; text: string }
  | { kind: "user"; text: string }
  | { kind: "event"; event: AgentChatEvent; resolveToolLabel: (tool: string, skill: string | null) => { label: string; action: string } }
  | { kind: "send" }
  | { kind: "reset-busy" };

let localId = 0;
function nextId(prefix: string): string {
  localId += 1;
  return `${prefix}-${localId}`;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.kind) {
    case "sys":
      return { ...state, items: [...state.items, { kind: "sys", id: nextId("sys"), text: action.text }] };
    case "user":
      return { ...state, items: [...state.items, { kind: "user", id: nextId("user"), text: action.text }] };
    case "send":
      return { ...state, busy: true, error: null };
    case "reset-busy":
      return { ...state, busy: false };
    case "event":
      return applyEvent(state, action.event, action.resolveToolLabel);
  }
}

function applyEvent(
  state: ChatState,
  event: AgentChatEvent,
  resolveToolLabel: (tool: string, skill: string | null) => { label: string; action: string },
): ChatState {
  switch (event.type) {
    case "ready":
      return { ...state, sessionId: event.session_id };
    case "tool.start": {
      const { label, action } = resolveToolLabel(event.tool, event.skill);
      return {
        ...state,
        items: [
          ...state.items,
          {
            kind: "tool",
            id: nextId("tool"),
            callId: event.call_id,
            label,
            action,
            running: true,
            input: event.input,
            output: "",
            durationMs: null,
          },
        ],
      };
    }
    case "tool.done": {
      return {
        ...state,
        items: state.items.map((item) =>
          item.kind === "tool" && item.callId === event.call_id
            ? { ...item, running: false, output: event.output, durationMs: event.duration_ms }
            : item,
        ),
      };
    }
    case "text.delta": {
      const existing = state.items.find(
        (item): item is Extract<ChatItem, { kind: "asst" }> =>
          item.kind === "asst" && item.messageId === event.message_id,
      );
      if (existing) {
        return {
          ...state,
          items: state.items.map((item) =>
            item.kind === "asst" && item.messageId === event.message_id
              ? { ...item, text: item.text + event.delta }
              : item,
          ),
        };
      }
      return {
        ...state,
        items: [
          ...state.items,
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
      return { ...state, busy: false };
    case "error":
      return { ...state, busy: false, error: event.message };
  }
}
