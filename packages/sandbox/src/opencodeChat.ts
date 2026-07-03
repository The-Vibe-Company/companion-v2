import { createOpencodeClient, type OpencodeClient } from "@opencode-ai/sdk";
import type { AgentChatEvent, AgentChatHistoryItem } from "@companion/contracts";
import { OPENCODE_SERVER_USERNAME } from "@companion/core";

/**
 * The chat bridge to one agent's OpenCode server. Everything version-sensitive about the pinned
 * `@opencode-ai/sdk` (event shapes, prompt payloads) stays HERE, translated into the stable
 * `AgentChatEvent` vocabulary from @companion/contracts before it reaches the API proxy — OpenCode's
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

export async function createChatSession(client: OpencodeClient, title?: string): Promise<{ id: string; title: string }> {
  const res = await client.session.create({ body: title ? { title } : {} });
  if (!res.data) throw new Error("opencode did not return a session");
  return { id: res.data.id, title: res.data.title ?? title ?? "New session" };
}

/**
 * Load a session's prior messages as normalized history items (for reopening a chat). Same
 * parts→item translation as {@link streamChatEvents}, kept next to the pinned SDK.
 */
export async function loadSessionItems(client: OpencodeClient, sessionId: string): Promise<AgentChatHistoryItem[]> {
  const res = await client.session.messages({ path: { id: sessionId } });
  const messages = res.data ?? [];
  const items: AgentChatHistoryItem[] = [];
  for (const entry of messages) {
    const role = entry.info.role;
    // Tool runs render inline before the assistant text they belong to.
    for (const part of entry.parts) {
      if (part.type === "tool" && part.state.status === "completed") {
        items.push({
          kind: "tool",
          call_id: part.callID,
          tool: part.tool,
          skill: null,
          input: safeJson("input" in part.state ? part.state.input : {}),
          output: truncate(part.state.output ?? "", 4000),
          duration_ms: part.state.time ? Math.max(0, part.state.time.end - part.state.time.start) : null,
        });
      }
    }
    const text = entry.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    if (text) items.push({ kind: role === "user" ? "user" : "assistant", text });
  }
  return items;
}

/** Fire a prompt without waiting for the reply — deltas arrive on the event stream. */
export async function sendPromptAsync(client: OpencodeClient, sessionId: string, text: string): Promise<void> {
  const res = await client.session.promptAsync({
    path: { id: sessionId },
    body: { parts: [{ type: "text", text }] },
  });
  if (res.error) throw new Error("opencode rejected the prompt");
}

/**
 * Subscribe to the server's event stream and translate into normalized chat events for one session.
 * Ends when the upstream stream closes or `signal` aborts.
 */
export async function* streamChatEvents(input: {
  client: OpencodeClient;
  sessionId: string;
  signal?: AbortSignal;
}): AsyncGenerator<AgentChatEvent> {
  const { client, sessionId, signal } = input;
  const assistantMessages = new Set<string>();
  const startedTools = new Set<string>();
  const doneTools = new Set<string>();
  const doneTexts = new Set<string>();

  // The signal must reach the SDK's underlying fetch: the SDK's SSE client checks `signal.aborted`
  // in its read loop and the fetch carries the signal, so aborting a stalled stream (no bytes
  // flowing) rejects the in-flight read and ends this loop — it can never hang the caller.
  const subscription = await client.event.subscribe(signal ? { signal } : {});
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
          if ((status === "running" || status === "completed" || status === "error") && !startedTools.has(part.callID)) {
            startedTools.add(part.callID);
            const inputPayload = "input" in part.state ? (part.state.input ?? {}) : {};
            yield {
              type: "tool.start",
              call_id: part.callID,
              skill: null,
              tool: part.tool,
              input: safeJson(inputPayload),
            };
          }
          if (status === "completed" && !doneTools.has(part.callID)) {
            doneTools.add(part.callID);
            yield {
              type: "tool.done",
              call_id: part.callID,
              output: truncate(part.state.output ?? "", 4000),
              duration_ms: part.state.time ? Math.max(0, part.state.time.end - part.state.time.start) : null,
            };
          } else if (status === "error" && !doneTools.has(part.callID)) {
            doneTools.add(part.callID);
            yield {
              type: "tool.done",
              call_id: part.callID,
              output: truncate(("error" in part.state ? String(part.state.error) : "tool failed") || "tool failed", 4000),
              duration_ms: null,
            };
          }
        } else if (part.type === "text" && assistantMessages.has(part.messageID)) {
          if (delta) {
            yield { type: "text.delta", message_id: part.messageID, delta };
          }
          if (part.time?.end && !doneTexts.has(part.messageID)) {
            doneTexts.add(part.messageID);
            yield { type: "text.done", message_id: part.messageID };
          }
        }
        break;
      }
      case "session.idle": {
        if (event.properties.sessionID === sessionId) {
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
          yield { type: "error", message };
        }
        break;
      }
      default:
        break;
    }
  }
}

function safeJson(value: unknown): string {
  try {
    return truncate(JSON.stringify(value, null, 2) ?? "{}", 2000);
  } catch {
    return "{}";
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
