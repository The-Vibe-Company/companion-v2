import { createHash } from "node:crypto";
import {
  createOpencodeClient,
  type Event,
  type OpencodeClient,
} from "@opencode-ai/sdk/v2";
import type {
  RunActivityPhase,
  RunChatEvent,
  RunChatHistoryItem,
  RunQuestionProtocol,
} from "@companion/contracts";
import {
  OPENCODE_SERVER_USERNAME,
  PROJECT_FILES_DIR,
  PROJECT_WORKDIR,
  RunRuntimeError,
  modelPartsForProject,
  type ProjectChatEventEnvelope,
  type ProjectChatRuntime,
  type ProjectChatTarget,
  type ProjectPendingQuestion,
} from "@companion/core";
import { toolTitleAndSkill } from "./chatMapping";
import {
  createOpencodeStreamState,
  type OpencodeStreamState,
} from "./opencodeChat";

const RECOVERY_MESSAGE_PREFIX =
  "Companion restored this private Project from a durable checkpoint.";
const PROJECT_OPENCODE_DIRECTORY =
  `${PROJECT_WORKDIR}/${PROJECT_FILES_DIR}`;

/** V2 SDK client used only by Cowork Projects; legacy Skill Runs retain the pinned v1 bridge. */
export function createProjectChatClient(target: ProjectChatTarget): OpencodeClient {
  const auth = Buffer.from(`${OPENCODE_SERVER_USERNAME}:${target.password}`).toString("base64");
  return createOpencodeClient({
    baseUrl: target.domain,
    directory: PROJECT_OPENCODE_DIRECTORY,
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
  const response = await client.session.create(
    { title, directory: PROJECT_OPENCODE_DIRECTORY },
    { signal },
  );
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
  const session = await client.session.get(
    { sessionID: sessionId, directory: PROJECT_OPENCODE_DIRECTORY },
    { signal },
  );
  if (session.error) {
    if ("name" in session.error && session.error.name === "NotFoundError") return "missing" as const;
    throw new RunRuntimeError("OpenCode could not validate the Project session");
  }
  const status = await client.session.status(
    { directory: PROJECT_OPENCODE_DIRECTORY },
    { signal },
  );
  if (status.error) throw new RunRuntimeError("OpenCode could not report Project session status");
  return status.data?.[sessionId]?.type ?? "idle";
}

async function loadProjectSessionMessages(
  client: OpencodeClient,
  sessionId: string,
  signal?: AbortSignal,
) {
  const response = await client.session.messages(
    { sessionID: sessionId, directory: PROJECT_OPENCODE_DIRECTORY },
    { signal },
  );
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

function pushActivity(
  output: RunChatEvent[],
  state: OpencodeStreamState,
  activity: RunActivityPhase,
): void {
  if (state.activity === activity) return;
  state.activity = activity;
  output.push({
    type: "status",
    state: activity === "retrying" ? "retry" : "busy",
    attempt: null,
    message: null,
    activity,
  });
}

function questionProtocol(event: Event): RunQuestionProtocol {
  return event.type.startsWith("question.v2.") ? "question.v2" : "question";
}

type NativeQuestionInfo = {
  header: string;
  question: string;
  options: Array<{ label: string; description: string }>;
  multiple?: boolean;
  custom?: boolean;
};

type NativeQuestionTool = {
  messageID: string;
  callID: string;
};

function normalizedQuestions(
  questions: NativeQuestionInfo[],
): ProjectPendingQuestion["questions"] {
  return questions.map((question) => ({
    header: question.header,
    question: question.question,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
    })),
    multiple: question.multiple ?? false,
    // OpenCode's standard question tool omits this field and its own clients treat only an
    // explicit `false` as disabling "Something else".
    custom: question.custom ?? true,
  }));
}

function normalizedQuestionTool(
  tool: NativeQuestionTool | undefined,
): ProjectPendingQuestion["tool"] {
  return tool
    ? { message_id: tool.messageID, call_id: tool.callID }
    : null;
}

function retryAction(
  action: Extract<
    Extract<Event, { type: "session.status" }>["properties"]["status"],
    { type: "retry" }
  >["action"],
): Extract<RunChatEvent, { type: "status" }>["retry_action"] {
  if (!action) return null;
  const safeLink =
    action.link?.startsWith("https://") || action.link?.startsWith("http://")
      ? action.link
      : undefined;
  return {
    reason: action.reason,
    provider: action.provider,
    title: action.title,
    message: action.message,
    label: action.label,
    ...(safeLink ? { link: safeLink } : {}),
  };
}

function toolProgressText(
  content: Array<{ type: string; text?: string }>,
  structured: unknown,
): string {
  const text = content
    .filter((item): item is { type: string; text: string } =>
      item.type === "text" && typeof item.text === "string"
    )
    .map((item) => item.text)
    .join("\n")
    .trim();
  return text || safeJson(structured);
}

function errorMessage(error: unknown, fallback = "agent error"): string {
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") {
      return error.message || fallback;
    }
    if (
      "data" in error
      && error.data
      && typeof error.data === "object"
      && "message" in error.data
    ) {
      return String((error.data as { message?: unknown }).message ?? fallback);
    }
  }
  return fallback;
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
    case "session.compacted":
    case "question.asked":
    case "question.replied":
    case "question.rejected":
    case "question.v2.asked":
    case "question.v2.replied":
    case "question.v2.rejected":
    case "session.next.step.started":
    case "session.next.step.ended":
    case "session.next.step.failed":
    case "session.next.text.started":
    case "session.next.text.delta":
    case "session.next.text.ended":
    case "session.next.reasoning.started":
    case "session.next.reasoning.delta":
    case "session.next.reasoning.ended":
    case "session.next.tool.input.started":
    case "session.next.tool.input.delta":
    case "session.next.tool.input.ended":
    case "session.next.tool.called":
    case "session.next.tool.progress":
    case "session.next.tool.success":
    case "session.next.tool.failed":
    case "session.next.retried":
    case "session.next.compaction.started":
    case "session.next.compaction.delta":
    case "session.next.compaction.ended":
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
    toolPhases,
    toolProgress,
    projectTools,
    doneTexts,
    textEmitted,
    reasoningEmitted,
    doneReasoning,
    askedQuestions,
    resolvedQuestions,
  } = state;

  switch (event.type) {
    case "message.updated": {
      const info = event.properties.info;
      if (info.role === "assistant" && !assistantMessages.has(info.id)) {
        assistantMessages.add(info.id);
        pushActivity(output, state, "thinking");
      }
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
        const startedAt =
          "time" in part.state && part.state.time && "start" in part.state.time
            ? part.state.time.start
            : null;
        projectTools.set(part.callID, {
          messageId: part.messageID,
          tool: part.tool,
          skill,
          title,
          input: inputJson,
          startedAt,
        });
        if (
          (status === "pending" || status === "running")
          && toolPhases.get(part.callID) !== status
        ) {
          toolPhases.set(part.callID, status);
          startedTools.add(part.callID);
          output.push({
            type: "tool.start",
            call_id: part.callID,
            skill,
            tool: part.tool,
            title,
            input: inputJson,
            phase: status,
            message_id: part.messageID,
          });
          pushActivity(output, state, "using_tool");
        } else if (
          (status === "completed" || status === "error")
          && !startedTools.has(part.callID)
        ) {
          startedTools.add(part.callID);
          toolPhases.set(part.callID, "running");
          output.push({
            type: "tool.start",
            call_id: part.callID,
            skill,
            tool: part.tool,
            title,
            input: inputJson,
            phase: "running",
            message_id: part.messageID,
          });
          pushActivity(output, state, "using_tool");
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
            message_id: part.messageID,
            outcome: "success",
          });
          pushActivity(output, state, "thinking");
        } else if (status === "error" && !doneTools.has(part.callID)) {
          doneTools.add(part.callID);
          output.push({
            type: "tool.done",
            call_id: part.callID,
            title,
            output: ("error" in part.state ? String(part.state.error) : "tool failed") || "tool failed",
            duration_ms: part.state.time
              ? Math.max(0, part.state.time.end - part.state.time.start)
              : null,
            message_id: part.messageID,
            outcome: "error",
          });
          pushActivity(output, state, "thinking");
        }
      } else if (part.type === "text" && assistantMessages.has(part.messageID)) {
        const key = part.id ?? part.messageID;
        const full = part.text ?? "";
        const emitted = textEmitted.get(key) ?? 0;
        if (full.length > emitted) {
          pushActivity(output, state, "responding");
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
          pushActivity(output, state, "thinking");
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
        const activity =
          state.activity === "waiting_for_answer" ? state.activity : "thinking";
        state.activity = activity;
        output.push({
          type: "status",
          state: "busy",
          attempt: null,
          message: null,
          activity,
        });
      } else if (status.type === "idle") {
        state.activity = null;
        output.push({
          type: "status",
          state: "idle",
          attempt: null,
          message: null,
          activity: null,
        });
      } else {
        state.activity = "retrying";
        output.push({
          type: "status",
          state: "retry",
          attempt: status.attempt,
          message: status.message,
          activity: "retrying",
          retry_at: status.next,
          retry_action: retryAction(status.action),
        });
      }
      break;
    }
    case "session.idle":
      state.activity = null;
      output.push({
        type: "status",
        state: "idle",
        attempt: null,
        message: null,
        activity: null,
      });
      output.push({ type: "session.idle", session_id: event.properties.sessionID });
      break;
    case "question.asked":
    case "question.v2.asked": {
      const requestId = event.properties.id;
      if (
        !resolvedQuestions.has(requestId)
        && event.properties.questions.length > 0
        && !askedQuestions.has(requestId)
      ) {
        askedQuestions.add(requestId);
        output.push({
          type: "question.asked",
          request_id: requestId,
          protocol: questionProtocol(event),
          questions: normalizedQuestions(event.properties.questions),
          tool: normalizedQuestionTool(event.properties.tool),
        });
        pushActivity(output, state, "waiting_for_answer");
      }
      break;
    }
    case "question.replied":
    case "question.v2.replied": {
      const requestId = event.properties.requestID;
      if (!resolvedQuestions.has(requestId)) {
        resolvedQuestions.add(requestId);
        output.push({
          type: "question.replied",
          request_id: requestId,
          protocol: questionProtocol(event),
          answers: event.properties.answers,
        });
        pushActivity(output, state, "thinking");
      }
      break;
    }
    case "question.rejected":
    case "question.v2.rejected": {
      const requestId = event.properties.requestID;
      if (!resolvedQuestions.has(requestId)) {
        resolvedQuestions.add(requestId);
        output.push({
          type: "question.rejected",
          request_id: requestId,
          protocol: questionProtocol(event),
        });
        pushActivity(output, state, "thinking");
      }
      break;
    }
    case "session.compacted":
    case "session.next.compaction.started":
    case "session.next.compaction.delta":
      pushActivity(output, state, "compacting");
      break;
    case "session.next.compaction.ended":
      pushActivity(output, state, "thinking");
      break;
    case "session.next.step.started":
    case "session.next.reasoning.started":
    case "session.next.reasoning.delta":
    case "session.next.reasoning.ended":
      pushActivity(output, state, "thinking");
      break;
    case "session.next.text.started":
    case "session.next.text.delta":
    case "session.next.text.ended":
      pushActivity(output, state, "responding");
      break;
    case "session.next.tool.input.started": {
      const inputJson = "{}";
      const { title, skill } = toolTitleAndSkill({
        tool: event.properties.name,
        title: null,
        inputJson,
      });
      projectTools.set(event.properties.callID, {
        messageId: event.properties.assistantMessageID,
        tool: event.properties.name,
        skill,
        title,
        input: inputJson,
        startedAt: event.properties.timestamp,
      });
      if (toolPhases.get(event.properties.callID) !== "pending") {
        toolPhases.set(event.properties.callID, "pending");
        startedTools.add(event.properties.callID);
        output.push({
          type: "tool.start",
          call_id: event.properties.callID,
          skill,
          tool: event.properties.name,
          title,
          input: inputJson,
          phase: "pending",
          message_id: event.properties.assistantMessageID,
        });
      }
      pushActivity(output, state, "using_tool");
      break;
    }
    case "session.next.tool.called": {
      const inputJson = safeJson(event.properties.input);
      const { title, skill } = toolTitleAndSkill({
        tool: event.properties.tool,
        title: null,
        inputJson,
      });
      const prior = projectTools.get(event.properties.callID);
      projectTools.set(event.properties.callID, {
        messageId: event.properties.assistantMessageID,
        tool: event.properties.tool,
        skill,
        title,
        input: inputJson,
        startedAt: prior?.startedAt ?? event.properties.timestamp,
      });
      if (toolPhases.get(event.properties.callID) !== "running") {
        toolPhases.set(event.properties.callID, "running");
        startedTools.add(event.properties.callID);
        output.push({
          type: "tool.start",
          call_id: event.properties.callID,
          skill,
          tool: event.properties.tool,
          title,
          input: inputJson,
          phase: "running",
          message_id: event.properties.assistantMessageID,
        });
      }
      pushActivity(output, state, "using_tool");
      break;
    }
    case "session.next.tool.progress": {
      const tool = projectTools.get(event.properties.callID);
      if (!tool || doneTools.has(event.properties.callID)) break;
      const progress = toolProgressText(
        event.properties.content,
        event.properties.structured,
      );
      if (toolProgress.get(event.properties.callID) === progress) break;
      toolProgress.set(event.properties.callID, progress);
      output.push({
        type: "tool.start",
        call_id: event.properties.callID,
        skill: tool.skill,
        tool: tool.tool,
        title: tool.title,
        input: tool.input,
        phase: "running",
        message_id: tool.messageId,
        progress,
      });
      pushActivity(output, state, "using_tool");
      break;
    }
    case "session.next.tool.success":
    case "session.next.tool.failed": {
      if (doneTools.has(event.properties.callID)) break;
      doneTools.add(event.properties.callID);
      const tool = projectTools.get(event.properties.callID);
      const failed = event.type === "session.next.tool.failed";
      const outputText = failed
        ? errorMessage(event.properties.error, "tool failed")
        : toolProgressText(
            event.properties.content,
            event.properties.result ?? event.properties.structured,
          );
      output.push({
        type: "tool.done",
        call_id: event.properties.callID,
        title: tool?.title ?? null,
        output: outputText,
        duration_ms: tool?.startedAt === null || tool?.startedAt === undefined
          ? null
          : Math.max(0, event.properties.timestamp - tool.startedAt),
        ...(tool ? { message_id: tool.messageId } : {}),
        outcome: failed ? "error" : "success",
      });
      pushActivity(output, state, "thinking");
      break;
    }
    case "session.next.retried":
      state.activity = "retrying";
      output.push({
        type: "status",
        state: "retry",
        attempt: event.properties.attempt,
        message: event.properties.error.message,
        activity: "retrying",
        retry_at: null,
        retry_action: null,
      });
      break;
    case "session.error": {
      output.push({
        type: "run.error",
        code: "opencode_session_error",
        message: errorMessage(event.properties.error),
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
    directory: PROJECT_OPENCODE_DIRECTORY,
    model: modelPartsForProject(input.modelRef),
    parts: [{ type: "text", text: input.text }],
  }, { signal: input.signal });
  if (response.error) throw new RunRuntimeError("OpenCode rejected the Project prompt");
}

/**
 * Reconcile both question generations exposed by the pinned SDK.
 *
 * The legacy endpoint is global to the managed directory, so exact session filtering is mandatory.
 * The V2 endpoint is session-scoped but is filtered again defensively before normalizing. Request ids
 * are opaque routing values and are never transformed here.
 */
export async function listPendingProjectQuestions(input: {
  client: OpencodeClient;
  sessionId: string;
  signal?: AbortSignal;
}): Promise<ProjectPendingQuestion[]> {
  const [legacy, v2] = await Promise.all([
    input.client.question.list(
      { directory: PROJECT_OPENCODE_DIRECTORY },
      { signal: input.signal },
    ),
    input.client.v2.session.question.list(
      { sessionID: input.sessionId },
      { signal: input.signal },
    ),
  ]);
  if (legacy.error || v2.error) {
    throw new RunRuntimeError("OpenCode could not list pending Project questions");
  }

  const byRequestId = new Map<string, ProjectPendingQuestion>();
  const add = (
    request: {
      id: string;
      sessionID: string;
      questions: NativeQuestionInfo[];
      tool?: NativeQuestionTool;
    },
    protocol: RunQuestionProtocol,
  ) => {
    if (request.sessionID !== input.sessionId) return;
    const normalized: ProjectPendingQuestion = {
      type: "question.asked",
      request_id: request.id,
      protocol,
      questions: normalizedQuestions(request.questions),
      tool: normalizedQuestionTool(request.tool),
    };
    const existing = byRequestId.get(request.id);
    if (
      existing
      && existing.protocol === protocol
      && JSON.stringify(existing) !== JSON.stringify(normalized)
    ) {
      throw new RunRuntimeError("OpenCode returned an ambiguous pending Project question");
    }
    // Current servers can surface the same request through the compatibility endpoint and V2.
    // The session-scoped V2 protocol is authoritative; retain legacy only when V2 has no such id.
    if (existing?.protocol === "question.v2" && protocol === "question") return;
    byRequestId.set(request.id, normalized);
  };

  for (const request of legacy.data ?? []) add(request, "question");
  for (const request of v2.data?.data ?? []) add(request, "question.v2");
  return [...byRequestId.values()];
}

/**
 * Reply through the exact OpenCode question protocol that produced the normalized request.
 *
 * This remains exported from the SDK adapter until the Project runtime port and session-only API
 * expose the member response command. Callers must persist/idempotently claim that command before
 * invoking this side effect, just like prompts.
 */
export async function replyProjectQuestion(input: {
  client: OpencodeClient;
  sessionId: string;
  requestId: string;
  protocol: RunQuestionProtocol;
  answers: string[][];
  signal?: AbortSignal;
}): Promise<void> {
  const response = input.protocol === "question.v2"
    ? await input.client.v2.session.question.reply({
        sessionID: input.sessionId,
        requestID: input.requestId,
        questionV2Reply: { answers: input.answers },
      }, { signal: input.signal })
    : await input.client.question.reply({
        requestID: input.requestId,
        directory: PROJECT_OPENCODE_DIRECTORY,
        answers: input.answers,
      }, { signal: input.signal });
  if (response.error) {
    throw new RunRuntimeError("OpenCode could not accept the Project question response");
  }
}

/** Reject one pending OpenCode question without exposing the SDK protocol outside this adapter. */
export async function rejectProjectQuestion(input: {
  client: OpencodeClient;
  sessionId: string;
  requestId: string;
  protocol: RunQuestionProtocol;
  signal?: AbortSignal;
}): Promise<void> {
  const response = input.protocol === "question.v2"
    ? await input.client.v2.session.question.reject({
        sessionID: input.sessionId,
        requestID: input.requestId,
      }, { signal: input.signal })
    : await input.client.question.reject({
        requestID: input.requestId,
        directory: PROJECT_OPENCODE_DIRECTORY,
      }, { signal: input.signal });
  if (response.error) {
    throw new RunRuntimeError("OpenCode could not reject the Project question");
  }
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
    directory: PROJECT_OPENCODE_DIRECTORY,
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
    directory: PROJECT_OPENCODE_DIRECTORY,
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
    { directory: PROJECT_OPENCODE_DIRECTORY },
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
      const response = await clientFor(target).session.list(
        { directory: PROJECT_OPENCODE_DIRECTORY },
        { signal },
      );
      if (response.error) throw new Error("OpenCode could not list Project sessions");
      const session = (response.data ?? []).find((candidate) => candidate.title === title);
      return session ? { id: session.id, title: session.title ?? title } : null;
    },
    createSession(target, title, signal) {
      return createProjectChatSession(clientFor(target), title, signal);
    },
    async abortSession(target, sessionId, signal) {
      const response = await clientFor(target).session.abort(
        { sessionID: sessionId, directory: PROJECT_OPENCODE_DIRECTORY },
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
    listPendingQuestions(target, sessionId, signal) {
      return listPendingProjectQuestions({
        client: clientFor(target),
        sessionId,
        signal,
      });
    },
    replyQuestion(target, sessionId, requestId, protocol, answers, signal) {
      return replyProjectQuestion({
        client: clientFor(target),
        sessionId,
        requestId,
        protocol,
        answers,
        signal,
      });
    },
    rejectQuestion(target, sessionId, requestId, protocol, signal) {
      return rejectProjectQuestion({
        client: clientFor(target),
        sessionId,
        requestId,
        protocol,
        signal,
      });
    },
    loadItems(target, sessionId, signal) {
      return loadProjectSessionItems(clientFor(target), sessionId, signal);
    },
    async getFileChanges(target, sessionId, messageId, signal) {
      const response = await clientFor(target).session.diff(
        {
          sessionID: sessionId,
          messageID: messageId,
          directory: PROJECT_OPENCODE_DIRECTORY,
        },
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
