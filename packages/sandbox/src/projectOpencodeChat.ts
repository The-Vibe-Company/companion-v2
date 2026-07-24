import { createHash } from "node:crypto";
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type { RunChatEvent, RunChatHistoryItem } from "@companion/contracts";
import {
  OPENCODE_SERVER_USERNAME,
  RunRuntimeError,
  modelPartsForProject,
  type ProjectChatEventEnvelope,
  type ProjectChatRuntime,
  type ProjectChatTarget,
} from "@companion/core";
import { toolTitleAndSkill } from "./chatMapping";
import {
  createOpencodeStreamState,
  type OpencodeStreamState,
} from "./opencodeChat";

const RECOVERY_MESSAGE_PREFIX =
  "Companion restored this private Project from a durable checkpoint.";

/** V2 SDK client used only by Cowork Projects; legacy Skill Runs retain the pinned v1 bridge. */
export function createProjectChatClient(target: ProjectChatTarget): OpencodeClient {
  const auth = Buffer.from(`${OPENCODE_SERVER_USERNAME}:${target.password}`).toString("base64");
  return createOpencodeClient({
    baseUrl: target.domain,
    headers: { authorization: `Basic ${auth}` },
    fetch: (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const headers = new Headers(request.headers);
      headers.set("authorization", `Basic ${auth}`);
      return fetch(new Request(request, { headers }));
    },
  });
}

async function createProjectChatSession(
  client: OpencodeClient,
  title: string,
  signal?: AbortSignal,
): Promise<{ id: string; title: string }> {
  const response = await client.session.create({ title }, { signal });
  if (response.error || !response.data) {
    throw new RunRuntimeError("OpenCode did not create the Project session");
  }
  return { id: response.data.id, title: response.data.title ?? title };
}

async function getProjectSessionState(
  client: OpencodeClient,
  sessionId: string,
  signal?: AbortSignal,
) {
  const session = await client.session.get({ sessionID: sessionId }, { signal });
  if (session.error) {
    if ("name" in session.error && session.error.name === "NotFoundError") return "missing" as const;
    throw new RunRuntimeError("OpenCode could not validate the Project session");
  }
  const status = await client.session.status({}, { signal });
  if (status.error) throw new RunRuntimeError("OpenCode could not report Project session status");
  return status.data?.[sessionId]?.type ?? "idle";
}

async function loadProjectSessionMessages(
  client: OpencodeClient,
  sessionId: string,
  signal?: AbortSignal,
) {
  const response = await client.session.messages({ sessionID: sessionId }, { signal });
  if (response.error) throw new RunRuntimeError("OpenCode could not load the Project transcript");
  return response.data ?? [];
}

async function getProjectMessageState(
  client: OpencodeClient,
  sessionId: string,
  messageId: string,
  signal?: AbortSignal,
) {
  const messages = await loadProjectSessionMessages(client, sessionId, signal);
  if (!messages.some((entry) => entry.info.role === "user" && entry.info.id === messageId)) {
    return "missing" as const;
  }
  const replies = messages.filter(
    (entry) => entry.info.role === "assistant" && entry.info.parentID === messageId,
  );
  if (replies.some((entry) => entry.info.role === "assistant" && entry.info.error)) {
    return "error" as const;
  }
  if (
    replies.some(
      (entry) => entry.info.role === "assistant" && entry.info.time.completed !== undefined,
    )
  ) {
    return "completed" as const;
  }
  if (
    replies.length > 0
    && await getProjectSessionState(client, sessionId, signal) === "idle"
  ) {
    // Some OpenCode providers finish the native turn and emit `session.idle` without filling
    // `assistant.time.completed`. An assistant reply plus the authoritative idle session state is
    // still terminal; requiring the optional timestamp would misclassify a delivered response as
    // an interrupted command. The reply guard preserves the no-replay safety rule for an idle
    // session that never produced an assistant message.
    return "completed" as const;
  }
  return "pending" as const;
}

async function loadProjectSessionItems(
  client: OpencodeClient,
  sessionId: string,
  signal?: AbortSignal,
): Promise<RunChatHistoryItem[]> {
  const messages = await loadProjectSessionMessages(client, sessionId, signal);
  const items: RunChatHistoryItem[] = [];
  for (const entry of messages) {
    const recoveryText = entry.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (
      entry.info.role === "user"
      && /^msg_000000000000[0-9a-f]{14}$/.test(entry.info.id)
      && recoveryText.startsWith(RECOVERY_MESSAGE_PREFIX)
    ) {
      // Recovery context is native-session plumbing, not a user-authored transcript item. Keeping
      // it out of durable history prevents recursive transcript growth across repeated restores.
      continue;
    }
    for (const part of entry.parts) {
      if (
        part.type !== "tool"
        || (part.state.status !== "completed" && part.state.status !== "error")
      ) {
        continue;
      }
      const inputJson = safeJson("input" in part.state ? part.state.input : {});
      const rawTitle = "title" in part.state ? (part.state.title ?? null) : null;
      const { title, skill } = toolTitleAndSkill({
        tool: part.tool,
        title: rawTitle,
        inputJson,
      });
      items.push({
        kind: "tool",
        call_id: part.callID,
        tool: part.tool,
        skill,
        title,
        input: inputJson,
        output:
          part.state.status === "completed"
            ? (part.state.output ?? "")
            : ("error" in part.state ? String(part.state.error) : "tool failed") || "tool failed",
        duration_ms:
          part.state.status === "completed" && part.state.time
            ? Math.max(0, part.state.time.end - part.state.time.start)
            : null,
      });
    }
    const text = entry.parts
      .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .join("");
    if (!text.trim()) continue;
    items.push(
      entry.info.role === "user"
        ? { kind: "user", text, message_id: entry.info.id }
        : { kind: "assistant", text, message_id: entry.info.id },
    );
  }
  return items;
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? "{}";
  } catch {
    return "{}";
  }
}

function sessionIdForEvent(event: Event): string | null {
  switch (event.type) {
    case "message.updated":
      return event.properties.info.sessionID;
    case "message.part.updated":
      return event.properties.part.sessionID;
    case "message.part.delta":
      return event.properties.sessionID;
    case "session.status":
    case "session.idle":
      return event.properties.sessionID;
    case "session.error":
      return event.properties.sessionID ?? null;
    default:
      return null;
  }
}

/**
 * Translate one cumulative OpenCode event while retaining independent cursor state per native
 * session. This is the same stable event vocabulary used by legacy runs; the Project envelope
 * supplies the demultiplexing key.
 */
function translateProjectEvent(
  event: Event,
  state: OpencodeStreamState,
): RunChatEvent[] {
  const output: RunChatEvent[] = [];
  const {
    assistantMessages,
    startedTools,
    doneTools,
    doneTexts,
    textEmitted,
    reasoningEmitted,
    doneReasoning,
  } = state;

  switch (event.type) {
    case "message.updated": {
      const info = event.properties.info;
      if (info.role === "assistant") assistantMessages.add(info.id);
      break;
    }
    case "message.part.updated": {
      const { part } = event.properties;
      if (part.type === "tool") {
        const status = part.state.status;
        const inputJson = "input" in part.state ? safeJson(part.state.input ?? {}) : "";
        const rawTitle = "title" in part.state ? (part.state.title ?? null) : null;
        const { title, skill } = toolTitleAndSkill({
          tool: part.tool,
          title: rawTitle,
          inputJson,
        });
        if (
          (status === "running" || status === "completed" || status === "error")
          && !startedTools.has(part.callID)
        ) {
          startedTools.add(part.callID);
          output.push({
            type: "tool.start",
            call_id: part.callID,
            skill,
            tool: part.tool,
            title,
            input: inputJson,
          });
        }
        if (status === "completed" && !doneTools.has(part.callID)) {
          doneTools.add(part.callID);
          output.push({
            type: "tool.done",
            call_id: part.callID,
            title,
            output: part.state.output ?? "",
            duration_ms: part.state.time
              ? Math.max(0, part.state.time.end - part.state.time.start)
              : null,
          });
        } else if (status === "error" && !doneTools.has(part.callID)) {
          doneTools.add(part.callID);
          output.push({
            type: "tool.done",
            call_id: part.callID,
            title,
            output: ("error" in part.state ? String(part.state.error) : "tool failed") || "tool failed",
            duration_ms: null,
          });
        }
      } else if (part.type === "text" && assistantMessages.has(part.messageID)) {
        const key = part.id ?? part.messageID;
        const full = part.text ?? "";
        const emitted = textEmitted.get(key) ?? 0;
        if (full.length > emitted) {
          textEmitted.set(key, full.length);
          output.push({
            type: "text.delta",
            message_id: part.messageID,
            delta: full.slice(emitted),
          });
        }
        if (part.time?.end && !doneTexts.has(part.messageID)) {
          doneTexts.add(part.messageID);
          output.push({ type: "text.done", message_id: part.messageID });
        }
      } else if (part.type === "reasoning") {
        const full = part.text ?? "";
        const emitted = reasoningEmitted.get(part.id) ?? 0;
        if (full.length > emitted) {
          reasoningEmitted.set(part.id, full.length);
          output.push({
            type: "reasoning.delta",
            part_id: part.id,
            delta: full.slice(emitted),
          });
        }
        if (part.time?.end && !doneReasoning.has(part.id)) {
          doneReasoning.add(part.id);
          output.push({ type: "reasoning.done", part_id: part.id });
        }
      }
      break;
    }
    case "session.status": {
      const status = event.properties.status;
      if (status.type === "busy") {
        output.push({ type: "status", state: "busy", attempt: null, message: null });
      } else if (status.type === "idle") {
        output.push({ type: "status", state: "idle", attempt: null, message: null });
      } else {
        output.push({
          type: "status",
          state: "retry",
          attempt: status.attempt,
          message: status.message,
        });
      }
      break;
    }
    case "session.idle":
      output.push({ type: "status", state: "idle", attempt: null, message: null });
      output.push({ type: "session.idle", session_id: event.properties.sessionID });
      break;
    case "session.error": {
      const error = event.properties.error;
      const message =
        error
        && typeof error === "object"
        && "data" in error
        && error.data
        && typeof error.data === "object"
        && "message" in error.data
          ? String((error.data as { message?: unknown }).message ?? "agent error")
          : "agent error";
      output.push({
        type: "run.error",
        code: "opencode_session_error",
        message,
        phase: null,
      });
      break;
    }
    default:
      break;
  }
  return output;
}

export async function sendProjectPromptAsync(input: {
  client: OpencodeClient;
  sessionId: string;
  text: string;
  messageId: string;
  modelRef: string;
  signal?: AbortSignal;
}): Promise<void> {
  const response = await input.client.session.promptAsync({
    sessionID: input.sessionId,
    messageID: input.messageId,
    model: modelPartsForProject(input.modelRef),
    parts: [{ type: "text", text: input.text }],
  }, { signal: input.signal });
  if (response.error) throw new RunRuntimeError("OpenCode rejected the Project prompt");
}

export async function rehydrateProjectSession(input: {
  client: OpencodeClient;
  sessionId: string;
  transcript: RunChatHistoryItem[];
  signal?: AbortSignal;
}): Promise<void> {
  if (input.transcript.length === 0) return;
  const serialized = JSON.stringify(input.transcript);
  const suffix = createHash("sha256")
    .update("companion-project-recovery:v1\0")
    .update(input.sessionId)
    .update("\0")
    .update(serialized)
    .digest("hex")
    .slice(0, 14);
  const messageId = `msg_000000000000${suffix}`;
  const existing = await loadProjectSessionMessages(
    input.client,
    input.sessionId,
    input.signal,
  );
  if (existing.some((entry) => entry.info.role === "user" && entry.info.id === messageId)) {
    return;
  }
  const response = await input.client.session.promptAsync({
    sessionID: input.sessionId,
    messageID: messageId,
    noReply: true,
    parts: [{
      type: "text",
      text: [
        RECOVERY_MESSAGE_PREFIX,
        "The JSON below is the prior redacted conversation transcript. Use it only as conversation context for the user's next message.",
        serialized,
      ].join("\n\n"),
    }],
  }, { signal: input.signal });
  if (response.error) {
    throw new RunRuntimeError("OpenCode could not restore the Project session context");
  }
}

async function approvePermission(
  client: OpencodeClient,
  permission: Extract<Event, { type: "permission.asked" }>["properties"],
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.permission.reply({
    requestID: permission.id,
    reply: "always",
  }, { signal });
  if (response.error) {
    throw new RunRuntimeError("OpenCode could not auto-approve a Project tool permission");
  }
}

async function approvePermissionV2(
  client: OpencodeClient,
  permission: Extract<Event, { type: "permission.v2.asked" }>["properties"],
  signal?: AbortSignal,
): Promise<void> {
  const response = await client.v2.session.permission.reply({
    sessionID: permission.sessionID,
    requestID: permission.id,
    reply: "always",
  }, { signal });
  if (response.error) {
    throw new RunRuntimeError("OpenCode could not auto-approve a Project tool permission");
  }
}

/** One upstream subscription for the Project, yielding envelopes tagged by native session id. */
export async function* streamProjectChatEvents(input: {
  client: OpencodeClient;
  signal?: AbortSignal;
  states?: Map<string, OpencodeStreamState>;
  onConnected?: () => void;
}): AsyncGenerator<ProjectChatEventEnvelope> {
  const states = input.states ?? new Map<string, OpencodeStreamState>();
  const subscription = await input.client.event.subscribe(
    {},
    input.signal ? { signal: input.signal } : {},
  );
  input.onConnected?.();
  for await (const event of subscription.stream) {
    if (input.signal?.aborted) return;
    if (event.type === "permission.asked") {
      // The product's Project permission posture is non-interactive. Keep this API response even
      // though opencode.json is configured to allow known tools: plugins may introduce a new
      // permission class and otherwise deadlock the turn.
      await approvePermission(input.client, event.properties, input.signal);
      continue;
    }
    if (event.type === "permission.v2.asked") {
      await approvePermissionV2(input.client, event.properties, input.signal);
      continue;
    }
    const sessionId = sessionIdForEvent(event);
    if (!sessionId) continue;
    let state = states.get(sessionId);
    if (!state) {
      state = createOpencodeStreamState();
      states.set(sessionId, state);
    }
    for (const translated of translateProjectEvent(event, state)) {
      yield { sessionId, event: translated };
    }
  }
}

/** SDK-backed bridge for the one-server/many-sessions Cowork Project topology. */
export function createOpencodeProjectChatRuntime(
  clientFor: (target: ProjectChatTarget) => OpencodeClient = createProjectChatClient,
): ProjectChatRuntime {
  const streamStates = new WeakMap<object, Map<string, OpencodeStreamState>>();
  return {
    async findSessionByTitle(target, title, signal) {
      const response = await clientFor(target).session.list({}, { signal });
      if (response.error) throw new Error("OpenCode could not list Project sessions");
      const session = (response.data ?? []).find((candidate) => candidate.title === title);
      return session ? { id: session.id, title: session.title ?? title } : null;
    },
    createSession(target, title, signal) {
      return createProjectChatSession(clientFor(target), title, signal);
    },
    async abortSession(target, sessionId, signal) {
      const response = await clientFor(target).session.abort(
        { sessionID: sessionId },
        { signal },
      );
      if (response.error) throw new RunRuntimeError("OpenCode could not stop the Project session");
    },
    getSessionState(target, sessionId, signal) {
      return getProjectSessionState(clientFor(target), sessionId, signal);
    },
    getMessageState(target, sessionId, messageId, signal) {
      return getProjectMessageState(clientFor(target), sessionId, messageId, signal);
    },
    rehydrateSession(target, sessionId, transcript, signal) {
      return rehydrateProjectSession({
        client: clientFor(target),
        sessionId,
        transcript,
        signal,
      });
    },
    sendPrompt(target, sessionId, text, messageId, modelRef, signal) {
      return sendProjectPromptAsync({
        client: clientFor(target),
        sessionId,
        text,
        messageId,
        modelRef,
        signal,
      });
    },
    loadItems(target, sessionId, signal) {
      return loadProjectSessionItems(clientFor(target), sessionId, signal);
    },
    async getFileChanges(target, sessionId, messageId, signal) {
      const response = await clientFor(target).session.diff(
        { sessionID: sessionId, messageID: messageId },
        { signal },
      );
      if (response.error) {
        throw new RunRuntimeError("OpenCode could not report Project file changes");
      }
      const changes = new Map<string, {
        path: string;
        status: "added" | "modified" | "deleted";
        patch: string;
      }>();
      for (const file of response.data ?? []) {
        const path = file.file?.trim();
        if (!path) continue;
        changes.set(path, {
          path,
          status: file.status ?? "modified",
          patch: file.patch ?? "",
        });
      }
      return [...changes.values()].sort((left, right) => left.path.localeCompare(right.path));
    },
    streamEvents(target, signal, onConnected, cursorKey) {
      const key = cursorKey ?? signal;
      let states = streamStates.get(key);
      if (!states) {
        states = new Map();
        streamStates.set(key, states);
      }
      return streamProjectChatEvents({
        client: clientFor(target),
        signal,
        states,
        onConnected,
      });
    },
  };
}
