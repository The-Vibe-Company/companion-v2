import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { RunChatEvent, RunChatHistoryItem } from "@companion/contracts";
import {
  OPENCODE_SERVER_USERNAME,
  RunRuntimeError,
  type RunChatMessageState,
  type RunChatRuntime,
  type RunChatSessionState,
  type RunChatTarget,
} from "@companion/core";
import { toolTitleAndSkill } from "./chatMapping";

/**
 * The chat bridge to one run's OpenCode server. Everything version-sensitive about the pinned
 * `@opencode-ai/sdk` (event shapes, prompt payloads) stays HERE, translated into the stable
 * `RunChatEvent` vocabulary from @companion/contracts before it reaches the API proxy — OpenCode's
 * near-daily churn is absorbed in one file. The sandbox's basic-auth password is injected into an
 * SDK-level fetch wrapper and never leaves the server.
 */

export interface ChatTarget {
  domain: string;
  password: string;
}

export function createChatClient(target: ChatTarget): OpencodeClient {
  const auth = Buffer.from(`${OPENCODE_SERVER_USERNAME}:${target.password}`).toString("base64");
  return createOpencodeClient({
    baseUrl: target.domain,
    // BOTH auth channels are load-bearing: regular requests go through the custom fetch, but the
    // SDK's SSE path (`event.subscribe`) calls global fetch directly and only merges the
    // client-level `headers` config — without it the /event stream 401s and retries silently
    // forever, which reads as "the agent never answers".
    headers: { authorization: `Basic ${auth}` },
    fetch: (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("authorization", `Basic ${auth}`);
      return fetch(new Request(request, { headers }));
    },
  });
}

export async function createChatSession(
  client: OpencodeClient,
  title?: string,
  signal?: AbortSignal,
): Promise<{ id: string; title: string }> {
  const res = await client.session.create({ body: title ? { title } : {}, signal });
  if (!res.data) throw new Error("opencode did not return a session");
  return { id: res.data.id, title: res.data.title ?? title ?? "New session" };
}

/**
 * Load a session's prior messages as normalized history items (for reopening a chat). Same
 * parts→item translation as {@link streamChatEvents}, kept next to the pinned SDK.
 */
export async function loadSessionItems(
  client: OpencodeClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<RunChatHistoryItem[]> {
  const res = await client.session.messages({ path: { id: sessionId }, signal });
  if (res.error) throw new Error("opencode could not load the session transcript");
  const messages = res.data ?? [];
  const items: RunChatHistoryItem[] = [];
  for (const entry of messages) {
    const role = entry.info.role;
    // Tool runs render inline before the assistant text they belong to.
    for (const part of entry.parts) {
      if (part.type === "tool" && (part.state.status === "completed" || part.state.status === "error")) {
        const inputJson = safeJson("input" in part.state ? part.state.input : {});
        const rawTitle = "title" in part.state ? (part.state.title ?? null) : null;
        const { title, skill } = toolTitleAndSkill({ tool: part.tool, title: rawTitle, inputJson });
        // Same completed/error handling as the live path in streamChatEvents: a failed tool call
        // still gets a history item so it survives into the persisted transcript.
        const output =
          part.state.status === "completed"
            ? (part.state.output ?? "")
            : ("error" in part.state ? String(part.state.error) : "tool failed") || "tool failed";
        items.push({
          kind: "tool",
          call_id: part.callID,
          tool: part.tool,
          skill,
          title,
          input: inputJson,
          // Keep the complete SDK payload here. The worker redacts every injected literal before
          // applying persistence bounds; truncating in the SDK adapter first could retain a secret
          // prefix while cutting off the bytes needed by the redactor to recognize it.
          output,
          duration_ms: part.state.status === "completed" && part.state.time ? Math.max(0, part.state.time.end - part.state.time.start) : null,
        });
      }
    }
    const text = entry.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
    // Use trim only as the empty-message predicate. The worker must see the exact bytes so a
    // credential containing leading/trailing whitespace is redacted before any normalization.
    if (text.trim()) {
      items.push(
        role === "user"
          ? { kind: "user", text, message_id: entry.info.id }
          : { kind: "assistant", text },
      );
    }
  }
  return items;
}

/** Validate the persisted session and reconcile its current state after a worker interruption. */
export async function getSessionState(
  client: OpencodeClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<RunChatSessionState> {
  const session = await client.session.get({ path: { id: sessionId }, signal });
  if (session.error) {
    if (session.error.name === "NotFoundError") return "missing";
    throw new Error("opencode could not validate the persisted session");
  }
  if (!session.data) throw new Error("opencode returned an invalid session response");
  const response = await client.session.status({ signal });
  if (response.error) throw new Error("opencode could not report the session status");
  return response.data?.[sessionId]?.type ?? "idle";
}

/** Reconcile the deterministic user message with its exact assistant child. */
export async function getSessionMessageState(
  client: OpencodeClient,
  sessionId: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<RunChatMessageState> {
  const response = await client.session.messages({ path: { id: sessionId }, signal });
  if (response.error) throw new Error("opencode could not inspect the session messages");
  const messages = response.data ?? [];
  if (!messages.some((entry) => entry.info.role === "user" && entry.info.id === messageId)) return "missing";
  const replies = messages.filter(
    (entry) => entry.info.role === "assistant" && entry.info.parentID === messageId,
  );
  if (replies.some((entry) => entry.info.role === "assistant" && entry.info.error)) return "error";
  if (replies.some((entry) => entry.info.role === "assistant" && entry.info.time.completed !== undefined)) {
    return "completed";
  }
  return "pending";
}

/**
 * Cursor shared by successive subscriptions for one recorder. OpenCode sends cumulative part
 * updates, so reconnecting with a fresh cursor would replay every byte already persisted.
 */
export interface OpencodeStreamState {
  assistantMessages: Set<string>;
  startedTools: Set<string>;
  doneTools: Set<string>;
  doneTexts: Set<string>;
  textEmitted: Map<string, number>;
  reasoningEmitted: Map<string, number>;
  doneReasoning: Set<string>;
}

export function createOpencodeStreamState(): OpencodeStreamState {
  return {
    assistantMessages: new Set(),
    startedTools: new Set(),
    doneTools: new Set(),
    doneTexts: new Set(),
    textEmitted: new Map(),
    reasoningEmitted: new Map(),
    doneReasoning: new Set(),
  };
}

/** Fire a prompt without waiting for the reply — deltas arrive on the event stream. */
export async function sendPromptAsync(
  client: OpencodeClient,
  sessionId: string,
  text: string,
  options: { messageId?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const res = await client.session.promptAsync({
    path: { id: sessionId },
    body: { messageID: options.messageId, parts: [{ type: "text", text }] },
    signal: options.signal,
  });
  // Keep the SDK response body out of logs and persisted run errors: it may echo prompt/tool
  // content. The bounded runtime error still gives the durable worker a useful, non-generic code.
  if (res.error) throw new RunRuntimeError("OpenCode rejected the prompt");
}

/**
 * Subscribe to the server's event stream and translate into normalized chat events for one session.
 * Ends when the upstream stream closes or `signal` aborts.
 */
export async function* streamChatEvents(input: {
  client: OpencodeClient;
  sessionId: string;
  signal?: AbortSignal;
  /** Reused across recorder reconnects to derive deltas from cumulative OpenCode parts. */
  state?: OpencodeStreamState;
  /** Handshake used by the worker to prove the subscription exists before dispatching a prompt. */
  onConnected?: () => void;
}): AsyncGenerator<RunChatEvent> {
  const { client, sessionId, signal, onConnected } = input;
  const state = input.state ?? createOpencodeStreamState();
  const { assistantMessages, startedTools, doneTools, doneTexts } = state;
  // Length already emitted per text part id. `message.part.updated` carries the CUMULATIVE text of
  // an assistant text part (the server also emits a separate `message.part.delta` event that the
  // pinned SDK types don't model), so we diff against what we've emitted to derive the increment —
  // version-independent, no reliance on an optional `delta` field.
  const { textEmitted } = state;
  // Same cumulative-diff bookkeeping for the model's reasoning ("thinking") parts.
  const { reasoningEmitted, doneReasoning } = state;

  // The signal must reach the SDK's underlying fetch: the SDK's SSE client checks `signal.aborted`
  // in its read loop and the fetch carries the signal, so aborting a stalled stream (no bytes
  // flowing) rejects the in-flight read and ends this loop — it can never hang the caller.
  const subscription = await client.event.subscribe(signal ? { signal } : {});
  onConnected?.();
  for await (const event of subscription.stream) {
    if (signal?.aborted) return;
    switch (event.type) {
      case "message.updated": {
        const info = event.properties.info;
        if (info.sessionID === sessionId && info.role === "assistant") assistantMessages.add(info.id);
        break;
      }
      case "message.part.updated": {
        const { part, delta } = event.properties;
        if (part.sessionID !== sessionId) break;
        if (part.type === "tool") {
          const status = part.state.status;
          const inputJson = "input" in part.state ? safeJson(part.state.input ?? {}) : "";
          const title = "title" in part.state ? (part.state.title ?? null) : null;
          const { title: humanTitle, skill } = toolTitleAndSkill({ tool: part.tool, title, inputJson });
          if ((status === "running" || status === "completed" || status === "error") && !startedTools.has(part.callID)) {
            startedTools.add(part.callID);
            yield {
              type: "tool.start",
              call_id: part.callID,
              skill,
              tool: part.tool,
              title: humanTitle,
              input: inputJson,
            };
          }
          if (status === "completed" && !doneTools.has(part.callID)) {
            doneTools.add(part.callID);
            yield {
              type: "tool.done",
              call_id: part.callID,
              title: humanTitle,
              output: part.state.output ?? "",
              duration_ms: part.state.time ? Math.max(0, part.state.time.end - part.state.time.start) : null,
            };
          } else if (status === "error" && !doneTools.has(part.callID)) {
            doneTools.add(part.callID);
            yield {
              type: "tool.done",
              call_id: part.callID,
              title: humanTitle,
              output: ("error" in part.state ? String(part.state.error) : "tool failed") || "tool failed",
              duration_ms: null,
            };
          }
        } else if (part.type === "text" && assistantMessages.has(part.messageID)) {
          // Emit the increment between the cumulative text and what we've already streamed. Falls
          // back to the SDK's optional `delta` only when a part id isn't available.
          const key = part.id ?? part.messageID;
          const full = part.text ?? "";
          const already = textEmitted.get(key) ?? 0;
          if (full.length > already) {
            textEmitted.set(key, full.length);
            yield { type: "text.delta", message_id: part.messageID, delta: full.slice(already) };
          } else if (delta && already === 0) {
            // Some OpenCode builds emit delta-first and only later send cumulative text. Account
            // for the fallback bytes now so the next cumulative update does not replay them.
            textEmitted.set(key, delta.length);
            yield { type: "text.delta", message_id: part.messageID, delta };
          }
          if (part.time?.end && !doneTexts.has(part.messageID)) {
            doneTexts.add(part.messageID);
            yield { type: "text.done", message_id: part.messageID };
          }
        } else if (part.type === "reasoning") {
          // The model's "thinking" streams like text (cumulative on updates); diff per part id.
          const full = part.text ?? "";
          const already = reasoningEmitted.get(part.id) ?? 0;
          if (full.length > already) {
            reasoningEmitted.set(part.id, full.length);
            yield { type: "reasoning.delta", part_id: part.id, delta: full.slice(already) };
          }
          if (part.time?.end && !doneReasoning.has(part.id)) {
            doneReasoning.add(part.id);
            yield { type: "reasoning.done", part_id: part.id };
          }
        }
        break;
      }
      case "session.status": {
        if (event.properties.sessionID === sessionId) {
          const st = event.properties.status;
          if (st.type === "busy") yield { type: "status", state: "busy", attempt: null, message: null };
          else if (st.type === "idle") yield { type: "status", state: "idle", attempt: null, message: null };
          else if (st.type === "retry") yield { type: "status", state: "retry", attempt: st.attempt, message: st.message };
        }
        break;
      }
      case "session.idle": {
        if (event.properties.sessionID === sessionId) {
          yield { type: "status", state: "idle", attempt: null, message: null };
          yield { type: "session.idle", session_id: sessionId };
        }
        break;
      }
      case "session.error": {
        if (!event.properties.sessionID || event.properties.sessionID === sessionId) {
          const err = event.properties.error;
          const message =
            err && typeof err === "object" && "data" in err && err.data && typeof err.data === "object" && "message" in err.data
              ? String((err.data as { message?: unknown }).message ?? "agent error")
              : "agent error";
          yield { type: "run.error", code: "opencode_session_error", message, phase: null };
        }
        break;
      }
      default:
        break;
    }
  }
}

/** SDK-backed chat adapter composed by the durable worker, never by a browser-facing route. */
export function createOpencodeRunChatRuntime(
  clientFor: (target: RunChatTarget) => OpencodeClient = createChatClient,
): RunChatRuntime {
  // The worker supplies one recorder-local key across transient connection AbortSignals. This
  // preserves cumulative cursors without sharing state between runs and remains garbage-collectable.
  const streamStates = new WeakMap<object, OpencodeStreamState>();
  return {
    async findSessionByTitle(target, title, signal) {
      const response = await clientFor(target).session.list({ signal });
      if (response.error) throw new Error("opencode could not list sessions");
      const session = (response.data ?? []).find((candidate) => candidate.title === title);
      return session ? { id: session.id, title: session.title ?? title } : null;
    },
    createSession(target, title, signal) {
      return createChatSession(clientFor(target), title, signal);
    },
    async abortSession(target, sessionId, signal) {
      const response = await clientFor(target).session.abort({ path: { id: sessionId }, signal });
      if (response.error) throw new RunRuntimeError("OpenCode could not abort the active prompt");
    },
    getSessionState(target, sessionId, signal) {
      return getSessionState(clientFor(target), sessionId, signal);
    },
    getMessageState(target, sessionId, messageId, signal) {
      return getSessionMessageState(clientFor(target), sessionId, messageId, signal);
    },
    sendPrompt(target, sessionId, text, messageId, signal) {
      return sendPromptAsync(clientFor(target), sessionId, text, { messageId, signal });
    },
    loadItems(target, sessionId, signal) {
      return loadSessionItems(clientFor(target), sessionId, signal);
    },
    streamEvents(target, sessionId, signal, onConnected, cursorKey) {
      const key = cursorKey ?? signal;
      let state = streamStates.get(key);
      if (!state) {
        state = createOpencodeStreamState();
        streamStates.set(key, state);
      }
      return streamChatEvents({ client: clientFor(target), sessionId, signal, state, onConnected });
    },
  };
}

function safeJson(value: unknown): string {
  try {
    // Redaction intentionally happens in the worker before any persistence bound is applied.
    return JSON.stringify(value, null, 2) ?? "{}";
  } catch {
    return "{}";
  }
}
