#!/usr/bin/env node

/**
 * Deterministic stand-in for `pi --mode rpc`.
 *
 * Protocol shapes are adapted from Pi's public RPC documentation. Fault-only records are called
 * out inline and in fixtures/pi/provenance.json; they are not representations of healthy Pi output.
 * This process intentionally has no network access and contains no credentials or host paths.
 */

import { StringDecoder } from "node:string_decoder";

const SCENARIOS = new Set([
  "normal",
  "tool",
  "ask_user",
  "propose_config",
  "propose_routine",
  "propose_trigger",
  "retry",
  "errors",
  "crash",
  "malformed",
  "oversized",
  "unknown",
]);

const FIXED_TIMESTAMP = 1_700_000_000_000;
const DEFAULT_OVERSIZED_BYTES = 70 * 1024;
const MAX_OVERSIZED_BYTES = 2 * 1024 * 1024;
const DEFAULT_SCENARIO = "normal";
const CRASH_EXIT_CODE = 86;

function scenarioArgument(argv) {
  const index = argv.indexOf("--scenario");
  if (index === -1) return process.env.PI_SIM_SCENARIO || DEFAULT_SCENARIO;
  return argv[index + 1] || "";
}

const scenario = scenarioArgument(process.argv.slice(2));
if (!SCENARIOS.has(scenario)) {
  process.stderr.write(`pi-sim: unknown scenario ${JSON.stringify(scenario)}\n`);
  process.exitCode = 64;
} else {
  run();
}

function run() {
  const decoder = new StringDecoder("utf8");
  let inputBuffer = "";
  let isStreaming = false;
  let messageCount = 0;
  let promptSequence = 0;
  let pendingPromptSequence = null;
  let pendingUiRequest = null;
  let stopped = false;

  const usage = () => ({
    input: 8,
    output: 4,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 12,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });

  const textMessage = (text, stopReason = "stop") => ({
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "simulated-provider",
    model: "simulated-model",
    usage: usage(),
    stopReason,
    timestamp: FIXED_TIMESTAMP,
  });

  const toolCallMessage = (callId) => ({
    role: "assistant",
    content: [{
      type: "toolCall",
      id: callId,
      name: "read",
      arguments: { path: "/workspace/README.md" },
    }],
    api: "openai-responses",
    provider: "simulated-provider",
    model: "simulated-model",
    usage: usage(),
    stopReason: "toolUse",
    timestamp: FIXED_TIMESTAMP,
  });

  const toolResultMessage = (callId) => ({
    role: "toolResult",
    toolCallId: callId,
    toolName: "read",
    content: [{ type: "text", text: "# Example project" }],
    isError: false,
    timestamp: FIXED_TIMESTAMP,
  });

  function writeJson(value, callback) {
    process.stdout.write(`${JSON.stringify(value)}\n`, "utf8", callback);
  }

  function writeRawLine(value, callback) {
    process.stdout.write(`${value}\n`, "utf8", callback);
  }

  function correlatedResponse(command, response) {
    const record = { type: "response", command: command.type, ...response };
    if (Object.hasOwn(command, "id")) record.id = command.id;
    writeJson(record);
  }

  function beginRun() {
    isStreaming = true;
    writeJson({ type: "agent_start" });
    writeJson({ type: "turn_start" });
  }

  function emitTextTurn(text, options = {}) {
    const message = textMessage(text, options.stopReason || "stop");
    writeJson({
      type: "message_start",
      message: { ...message, content: [] },
    });
    writeJson({
      type: "message_update",
      usage: usage(),
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    writeJson({
      type: "message_update",
      usage: usage(),
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
    });
    writeJson({
      type: "message_update",
      usage: usage(),
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text },
    });
    writeJson({ type: "message_end", message });
    writeJson({ type: "turn_end", message, toolResults: options.toolResults || [] });
    messageCount += 1;
    return message;
  }

  function finishRun(messages) {
    writeJson({ type: "agent_end", messages, willRetry: false });
    writeJson({ type: "agent_settled" });
    isStreaming = false;
  }

  function runNormal(prefixRecords = []) {
    beginRun();
    for (const record of prefixRecords) writeJson(record);
    const message = emitTextTurn("Simulated reply.");
    finishRun([message]);
  }

  function runTool() {
    const callId = `call-sim-${promptSequence}`;
    const call = toolCallMessage(callId);
    const result = toolResultMessage(callId);

    beginRun();
    writeJson({ type: "message_start", message: { ...call, content: [] } });
    writeJson({
      type: "message_update",
      usage: usage(),
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
    });
    writeJson({
      type: "message_update",
      usage: usage(),
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: call.content[0],
      },
    });
    writeJson({ type: "message_end", message: call });
    writeJson({
      type: "tool_execution_start",
      toolCallId: callId,
      toolName: "read",
      args: { path: "/workspace/README.md" },
    });
    writeJson({
      type: "tool_execution_update",
      toolCallId: callId,
      toolName: "read",
      args: { path: "/workspace/README.md" },
      partialResult: {
        content: [{ type: "text", text: "# Example" }],
        details: { truncation: null, fullOutputPath: null },
      },
    });
    writeJson({
      type: "tool_execution_end",
      toolCallId: callId,
      toolName: "read",
      result: {
        content: [{ type: "text", text: "# Example project" }],
        details: { truncation: null, fullOutputPath: null },
      },
      isError: false,
    });
    writeJson({ type: "message_start", message: result });
    writeJson({ type: "message_end", message: result });
    writeJson({ type: "turn_end", message: call, toolResults: [result] });
    writeJson({ type: "turn_start" });
    const reply = emitTextTurn("The simulated file was read successfully.", { toolResults: [] });
    messageCount += 2;
    finishRun([call, result, reply]);
  }

  function runAskUser() {
    const toolCallId = `call-ask-${promptSequence}`;
    const requestId = `ui-sim-${promptSequence}`;
    beginRun();
    writeJson({
      type: "tool_execution_start",
      toolCallId,
      toolName: "ask_user",
      args: { question: "Continue the simulated task?" },
    });
    writeJson({
      type: "extension_ui_request",
      id: requestId,
      method: "input",
      title: "companion:question:ask_user",
      placeholder: "Continue the simulated task?",
      timeout: 300_000,
    });
    pendingUiRequest = { requestId, toolCallId, toolName: "ask_user" };
  }

  function runProposeConfig() {
    const toolCallId = `call-config-${promptSequence}`;
    const requestId = `ui-sim-${promptSequence}`;
    const proposal = {
      kind: "config",
      add_skill_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    };
    beginRun();
    writeJson({
      type: "tool_execution_start",
      toolCallId,
      toolName: "propose_config",
      args: { add_skills: proposal.add_skill_ids },
    });
    writeJson({
      type: "extension_ui_request",
      id: requestId,
      method: "confirm",
      title: "companion:config:propose_config",
      message: JSON.stringify({
        summary: "Add the search skill",
        proposal,
      }),
      timeout: 300_000,
    });
    pendingUiRequest = { requestId, toolCallId, toolName: "propose_config" };
  }

  function runProposeRoutine() {
    const toolCallId = `call-routine-${promptSequence}`;
    const requestId = `ui-sim-${promptSequence}`;
    const proposal = {
      kind: "routine",
      name: "Standup",
      prompt: "Write the standup.",
      cron: "0 9 * * 1-5",
      timezone: "UTC",
    };
    beginRun();
    writeJson({
      type: "tool_execution_start",
      toolCallId,
      toolName: "propose_routine",
      args: proposal,
    });
    writeJson({
      type: "extension_ui_request",
      id: requestId,
      method: "confirm",
      title: "companion:routine:Standup",
      message: JSON.stringify({
        summary: "Schedule Standup each weekday at 9am",
        proposal,
      }),
      timeout: 300_000,
    });
    pendingUiRequest = { requestId, toolCallId, toolName: "propose_routine" };
  }

  function runProposeTrigger() {
    const toolCallId = `call-trigger-${promptSequence}`;
    const requestId = `ui-sim-${promptSequence}`;
    const proposal = {
      kind: "trigger",
      name: "ci-failed",
      prompt: "Summarize the failed workflow run and post the likely cause.",
      provider: "github",
      target: { repo: "acme/ci", events: ["push"] },
    };
    beginRun();
    writeJson({
      type: "tool_execution_start",
      toolCallId,
      toolName: "propose_trigger",
      args: proposal,
    });
    writeJson({
      type: "extension_ui_request",
      id: requestId,
      method: "confirm",
      title: "companion:trigger:ci-failed",
      message: JSON.stringify({
        summary: "Summarize failed CI runs when GitHub calls the webhook",
        proposal,
      }),
      timeout: 300_000,
    });
    pendingUiRequest = { requestId, toolCallId, toolName: "propose_trigger" };
  }

  function continueAskUser(command) {
    if (!pendingUiRequest || command.id !== pendingUiRequest.requestId) return;
    const { toolCallId, toolName } = pendingUiRequest;
    pendingUiRequest = null;
    const cancelled = command.cancelled === true || command.confirmed === false;
    const approved = command.confirmed === true;
    const config = toolName === "propose_config";
    const routine = toolName === "propose_routine";
    const trigger = toolName === "propose_trigger";
    writeJson({
      type: "tool_execution_end",
      toolCallId,
      toolName,
      result: {
        content: [{
          type: "text",
          text: config
            ? (approved
              ? "Approved. Changes apply after this turn ends."
              : "User denied or timed out. No settings changed.")
            : routine
              ? (approved
                ? "Approved. The routine is created after this turn ends."
                : "User denied or timed out. No routine was created.")
              : trigger
                ? (approved
                  ? "Approved. The trigger is created after this turn ends; the person pastes its webhook URL into the external service."
                  : "User denied or timed out. No trigger was created.")
                : (cancelled ? "Question cancelled." : "Answer received."),
        }],
        details: {},
      },
      isError: false,
    });
    const reply = emitTextTurn(config
      ? (approved
        ? "The simulated config proposal was approved."
        : "The simulated config proposal was denied.")
      : routine
        ? (approved
          ? "The simulated routine proposal was approved."
          : "The simulated routine proposal was denied.")
        : trigger
          ? (approved
            ? "The simulated trigger proposal was approved."
            : "The simulated trigger proposal was denied.")
          : (cancelled
            ? "The simulated question was cancelled."
            : "The simulated answer was received."));
    finishRun([reply]);
  }

  function runRetry() {
    beginRun();
    writeJson({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 1,
      errorMessage: "Synthetic transient provider overload.",
    });
    writeJson({ type: "agent_end", messages: [], willRetry: true });
    writeJson({ type: "auto_retry_end", success: true, attempt: 2 });
    writeJson({ type: "agent_start" });
    writeJson({ type: "turn_start" });
    const reply = emitTextTurn("Simulated retry recovered.");
    finishRun([reply]);
  }

  function runErrors() {
    const message = {
      ...textMessage("", "error"),
      content: [],
      errorMessage: "Synthetic provider request failed.",
    };
    beginRun();
    writeJson({ type: "message_start", message });
    writeJson({ type: "message_end", message });
    writeJson({ type: "turn_end", message, toolResults: [] });
    writeJson({ type: "agent_end", messages: [message], willRetry: false });
    writeJson({ type: "agent_settled" });
    messageCount += 1;
    isStreaming = false;
  }

  function oversizedTargetBytes() {
    const configured = Number(process.env.PI_SIM_OVERSIZED_BYTES);
    if (!Number.isFinite(configured)) return DEFAULT_OVERSIZED_BYTES;
    return Math.min(Math.max(Math.trunc(configured), 65_537), MAX_OVERSIZED_BYTES);
  }

  function dispatchScenario() {
    switch (scenario) {
      case "normal":
        runNormal();
        return;
      case "tool":
        runTool();
        return;
      case "ask_user":
        runAskUser();
        return;
      case "propose_config":
        runProposeConfig();
        return;
      case "propose_routine":
        runProposeRoutine();
        return;
      case "propose_trigger":
        runProposeTrigger();
        return;
      case "retry":
        runRetry();
        return;
      case "errors":
        runErrors();
        return;
      case "crash":
        isStreaming = true;
        writeJson({ type: "agent_start" }, () => {
          process.stderr.write("pi-sim: synthetic crash after prompt acknowledgement\n", () => {
            process.exit(CRASH_EXIT_CODE);
          });
        });
        return;
      case "malformed":
        beginRun();
        // Synthetic fault: an incomplete JSON object framed as one complete LF record.
        writeRawLine('{"type":"message_update","assistantMessageEvent":', () => {
          const reply = emitTextTurn("Simulated recovery after a malformed record.");
          finishRun([reply]);
        });
        return;
      case "oversized": {
        beginRun();
        // Synthetic fault: valid JSON whose encoded line is intentionally above the broker cap.
        const target = oversizedTargetBytes();
        writeJson({
          type: "message_update",
          usage: usage(),
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: "x".repeat(target),
          },
        }, () => {
          const reply = emitTextTurn("Simulated recovery after an oversized record.");
          finishRun([reply]);
        });
        return;
      }
      case "unknown":
        runNormal([{
          type: "future_protocol_event",
          schemaVersion: 999,
          note: "Synthetic unknown event.",
        }]);
        return;
    }
  }

  function handleCommand(command) {
    if (!command || typeof command !== "object" || Array.isArray(command)) {
      writeJson({ type: "response", command: "parse", success: false, error: "Command must be an object" });
      return;
    }

    if (command.type === "extension_ui_response") {
      continueAskUser(command);
      return;
    }

    if (command.type === "get_state") {
      correlatedResponse(command, {
        success: true,
        data: {
          model: {
            id: "simulated-model",
            name: "Simulated model",
            api: "openai-responses",
            provider: "simulated-provider",
            baseUrl: "https://example.invalid/v1",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 32_000,
            maxTokens: 4_096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          thinkingLevel: "off",
          isStreaming,
          isCompacting: false,
          steeringMode: "one-at-a-time",
          followUpMode: "one-at-a-time",
          sessionFile: "/workspace/.pi/sessions/simulated.jsonl",
          sessionId: "simulated-session",
          sessionName: "Box simulator",
          autoCompactionEnabled: true,
          messageCount,
          pendingMessageCount: 0,
        },
      });
      return;
    }

    if (command.type === "abort") {
      correlatedResponse(command, { success: true });
      if (isStreaming) {
        pendingPromptSequence = null;
        const message = { ...textMessage("", "aborted"), content: [] };
        writeJson({ type: "message_end", message });
        writeJson({ type: "agent_end", messages: [message], willRetry: false });
        writeJson({ type: "agent_settled" });
        pendingUiRequest = null;
        isStreaming = false;
      }
      return;
    }

    if (command.type !== "prompt") {
      correlatedResponse(command, { success: false, error: `Unknown command: ${String(command.type)}` });
      return;
    }

    if (typeof command.message !== "string" || command.message.length === 0) {
      correlatedResponse(command, { success: false, error: "Prompt message is required" });
      return;
    }

    if (isStreaming && command.streamingBehavior !== "steer" && command.streamingBehavior !== "followUp") {
      correlatedResponse(command, { success: false, error: "Agent is streaming" });
      return;
    }

    if (isStreaming) {
      correlatedResponse(command, { success: true });
      writeJson({
        type: "queue_update",
        steering: command.streamingBehavior === "steer" ? [command.message] : [],
        followUp: command.streamingBehavior === "followUp" ? [command.message] : [],
      });
      return;
    }

    promptSequence += 1;
    const dispatchSequence = promptSequence;
    pendingPromptSequence = dispatchSequence;
    // Reserve the one active run before yielding. stdin may contain a following abort in the same
    // chunk, and that command must be able to invalidate this not-yet-dispatched prompt.
    isStreaming = true;
    correlatedResponse(command, { success: true });
    queueMicrotask(() => {
      if (pendingPromptSequence !== dispatchSequence) return;
      pendingPromptSequence = null;
      dispatchScenario();
    });
  }

  function handleLine(rawLine) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.length === 0) return;
    let command;
    try {
      command = JSON.parse(line);
    } catch (error) {
      writeJson({
        type: "response",
        command: "parse",
        success: false,
        error: `Failed to parse command: ${error instanceof Error ? error.message : "invalid JSON"}`,
      });
      return;
    }
    handleCommand(command);
  }

  process.stdin.on("data", (chunk) => {
    inputBuffer += decoder.write(chunk);
    while (true) {
      const newline = inputBuffer.indexOf("\n");
      if (newline < 0) break;
      const line = inputBuffer.slice(0, newline);
      inputBuffer = inputBuffer.slice(newline + 1);
      handleLine(line);
    }
  });

  process.stdin.on("end", () => {
    decoder.end();
    // Strict JSONL: an unterminated trailing fragment is not a command.
  });

  process.on("SIGTERM", () => {
    if (stopped) return;
    stopped = true;
    process.exit(0);
  });
}
