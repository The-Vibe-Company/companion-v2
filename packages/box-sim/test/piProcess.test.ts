import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendPiEvent,
  appendPiFault,
  createBoxSimCommandMachine,
} from "../src/commandShims";
import { PiProcessController } from "../src/piController";
import type { PiScenarioName } from "../src/scenarios";

const PI_PROCESS_PATH = fileURLToPath(new URL("../src/pi-process.mjs", import.meta.url));
const DELAYED_CLOSE_PROCESS_PATH = fileURLToPath(
  new URL("./fixtures/delayed-close-child.mjs", import.meta.url),
);
const PI_UNTERMINATED_PROCESS_PATH = fileURLToPath(
  new URL("./fixtures/pi-unterminated.mjs", import.meta.url),
);
const liveControllers: PiProcessController[] = [];
const liveChildren: ChildProcessWithoutNullStreams[] = [];

afterEach(async () => {
  await Promise.all(liveControllers.splice(0).map((controller) => controller.dispose()));
  await Promise.all(liveChildren.splice(0).map(async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
  }));
});

describe("the real Pi JSONL subprocess", () => {
  it("uses literal LF framing and keeps Unicode separators inside a JSON string", async () => {
    const harness = spawnRawPi("normal");
    const prompt = JSON.stringify({
      id: "req-unicode",
      type: "prompt",
      message: "first\u2028second\u2029third",
      streamingBehavior: "followUp",
    });

    harness.child.stdin.write(prompt, "utf8");
    await delay(40);
    expect(harness.stdout()).toBe("");

    harness.child.stdin.write("\n", "utf8");
    const records = await waitForRawRecords(harness, (items) => (
      items.some((item) => item.type === "agent_settled")
    ));

    expect(records[0]).toMatchObject({
      id: "req-unicode",
      type: "response",
      command: "prompt",
      success: true,
    });
    expect(harness.stdout()).not.toContain("\r\n");
    expect(harness.stdout().endsWith("\n")).toBe(true);
    for (const line of completeLines(harness.stdout())) {
      expect(line).toBe(JSON.stringify(JSON.parse(line)));
    }
  });

  it("returns a parse failure only after a malformed input record is LF-terminated", async () => {
    const harness = spawnRawPi("normal");
    harness.child.stdin.write('{"type":"get_state"', "utf8");
    await delay(30);
    expect(harness.stdout()).toBe("");
    harness.child.stdin.write("\n", "utf8");

    const records = await waitForRawRecords(harness, (items) => items.length === 1);
    expect(records).toEqual([
      expect.objectContaining({
        type: "response",
        command: "parse",
        success: false,
      }),
    ]);
  });

  it("cancels a prompt queued before an abort in the same stdin chunk", async () => {
    const harness = spawnRawPi("normal");
    harness.child.stdin.write([
      JSON.stringify({ id: "prompt-same-chunk", type: "prompt", message: "do not dispatch" }),
      JSON.stringify({ id: "abort-same-chunk", type: "abort" }),
      "",
    ].join("\n"), "utf8");

    const records = await waitForRawRecords(harness, (items) => (
      items.some((item) => item.type === "agent_settled")
    ));
    expect(records.map((record) => record.type)).toEqual([
      "response",
      "response",
      "message_end",
      "agent_end",
      "agent_settled",
    ]);
    expect(records.slice(0, 2)).toEqual([
      expect.objectContaining({ id: "prompt-same-chunk", command: "prompt", success: true }),
      expect.objectContaining({ id: "abort-same-chunk", command: "abort", success: true }),
    ]);
    expect(records.some((record) => record.type === "agent_start")).toBe(false);
    expect(records.find((record) => record.type === "message_end")).toMatchObject({
      message: { stopReason: "aborted" },
    });
  });
});

describe("PiProcessController", () => {
  it("correlates command responses and forwards general events without the prompt id", async () => {
    const harness = await controllerHarness("normal");
    expect(harness.controller.pid).toEqual(expect.any(Number));

    const state = await harness.controller.handleRpc({ id: "state-1", type: "get_state" });
    expect(state).toMatchObject({
      id: "state-1",
      type: "response",
      command: "get_state",
      success: true,
      data: {
        isStreaming: false,
        pendingMessageCount: 0,
        sessionId: "simulated-session",
      },
    });

    const acknowledgement = await harness.controller.handleRpc({
      id: "prompt-1",
      type: "prompt",
      message: "Hello from the contract test.",
      streamingBehavior: "followUp",
    });
    expect(acknowledgement).toEqual({
      type: "response",
      command: "prompt",
      success: true,
      id: "prompt-1",
    });

    await waitForEvent(harness.events, "agent_settled");
    const records = objectEvents(harness.events);
    expect(records.map((event) => event.type)).toEqual(expect.arrayContaining([
      "agent_start",
      "turn_start",
      "message_start",
      "message_update",
      "message_end",
      "turn_end",
      "agent_end",
      "agent_settled",
    ]));
    for (const event of records) {
      if (event.type === "extension_ui_request" || event.type === "bash_execution_update") continue;
      expect(event).not.toHaveProperty("id");
    }
    for (const event of records.filter((item) => item.type === "message_update")) {
      expect(event).not.toHaveProperty("message");
      expect(event.assistantMessageEvent).not.toHaveProperty("partial");
    }
  });

  it("emits a correlated tool lifecycle and result", async () => {
    const harness = await controllerHarness("tool");
    await acceptedPrompt(harness.controller, "tool-prompt");
    await waitForEvent(harness.events, "agent_settled");

    const records = objectEvents(harness.events);
    const start = findEvent(records, "tool_execution_start");
    const update = findEvent(records, "tool_execution_update");
    const end = findEvent(records, "tool_execution_end");
    expect(start).toMatchObject({ toolName: "read", args: { path: "/workspace/README.md" } });
    expect(update.toolCallId).toBe(start.toolCallId);
    expect(end).toMatchObject({ toolCallId: start.toolCallId, toolName: "read", isError: false });
    expect(records.some((event) => (
      event.type === "message_end" && isRecord(event.message) && event.message.role === "toolResult"
    ))).toBe(true);
  });

  it("blocks ask_user until the matching extension UI response arrives", async () => {
    const harness = await controllerHarness("ask_user");
    await acceptedPrompt(harness.controller, "ask-prompt");
    const request = await waitForEvent(harness.events, "extension_ui_request");
    expect(request).toMatchObject({
      id: "ui-sim-1",
      method: "input",
      title: "companion:question:ask_user",
    });
    expect(harness.events.some((event) => eventType(event) === "agent_settled")).toBe(false);

    await harness.controller.respondExtensionUi({
      type: "extension_ui_response",
      id: "ui-does-not-match",
      value: "ignored",
    });
    await delay(30);
    expect(harness.events.some((event) => eventType(event) === "agent_settled")).toBe(false);

    await harness.controller.respondExtensionUi({
      type: "extension_ui_response",
      id: request.id,
      value: "Continue",
    });
    await waitForEvent(harness.events, "agent_settled");
    expect(findEvent(objectEvents(harness.events), "tool_execution_end")).toMatchObject({
      toolName: "ask_user",
      isError: false,
    });
  });

  it("blocks propose_config until the matching confirm response arrives", async () => {
    const harness = await controllerHarness("propose_config");
    await acceptedPrompt(harness.controller, "config-prompt");
    const request = await waitForEvent(harness.events, "extension_ui_request");
    expect(request).toMatchObject({
      id: "ui-sim-1",
      method: "confirm",
      title: "companion:config:propose_config",
    });
    expect(JSON.parse(String(request.message))).toMatchObject({
      proposal: { kind: "config" },
    });
    expect(harness.events.some((event) => eventType(event) === "agent_settled")).toBe(false);

    await harness.controller.respondExtensionUi({
      type: "extension_ui_response",
      id: request.id,
      confirmed: true,
    });
    await waitForEvent(harness.events, "agent_settled");
    expect(findEvent(objectEvents(harness.events), "tool_execution_end")).toMatchObject({
      toolName: "propose_config",
      isError: false,
    });
  });

  it.each([
    ["retry", ["auto_retry_start", "auto_retry_end", "agent_settled"]],
    ["errors", ["message_end", "agent_end", "agent_settled"]],
  ] satisfies Array<[PiScenarioName, string[]]>) (
    "runs the %s event scenario through settlement",
    async (scenario, expectedTypes) => {
      const harness = await controllerHarness(scenario);
      await acceptedPrompt(harness.controller, `${scenario}-prompt`);
      await waitForEvent(harness.events, "agent_settled");
      const records = objectEvents(harness.events);
      expect(records.map((event) => event.type)).toEqual(expect.arrayContaining(expectedTypes));
      if (scenario === "errors") {
        const messageEnd = findEvent(records, "message_end");
        expect(messageEnd).toMatchObject({
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "Synthetic provider request failed.",
          },
        });
      }
    },
  );

  it("acknowledges and then exits without settlement in the crash scenario", async () => {
    const harness = await controllerHarness("crash");
    const acknowledgement = await acceptedPrompt(harness.controller, "crash-prompt");
    expect(acknowledgement.success).toBe(true);
    const exit = await harness.controller.waitForExit();
    await delay(10);

    expect(exit).toEqual({ code: 86, signal: null });
    expect(harness.controller.running).toBe(false);
    expect(harness.controller.stderr).toContain("synthetic crash");
    expect(harness.events.some((event) => eventType(event) === "agent_settled")).toBe(false);
  });

  it("preserves a malformed record and continues with later valid events", async () => {
    const harness = await controllerHarness("malformed");
    await acceptedPrompt(harness.controller, "malformed-prompt");
    await waitForEvent(harness.events, "agent_settled");

    expect(harness.events).toContain('{"type":"message_update","assistantMessageEvent":');
    expect(objectEvents(harness.events).some((event) => event.type === "message_end")).toBe(true);
  });

  it("preserves an oversized valid record and continues with later valid events", async () => {
    const harness = await controllerHarness("oversized", 65_537);
    await acceptedPrompt(harness.controller, "oversized-prompt");
    await waitForEvent(harness.events, "agent_settled");

    const oversized = objectEvents(harness.events).find((event) => (
      Buffer.byteLength(JSON.stringify(event), "utf8") > 65_536
    ));
    expect(oversized).toMatchObject({ type: "message_update" });
  });

  it("forwards unknown future events without preventing settlement", async () => {
    const harness = await controllerHarness("unknown");
    await acceptedPrompt(harness.controller, "unknown-prompt");
    await waitForEvent(harness.events, "agent_settled");

    expect(findEvent(objectEvents(harness.events), "future_protocol_event")).toEqual({
      type: "future_protocol_event",
      schemaVersion: 999,
      note: "Synthetic unknown event.",
    });
  });

  it("counts an unterminated final fragment without retaining its raw content", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "box-sim-test", scenario: "normal" });
    machine.daemon.invocationId = "00000000000000000000000000000001";
    const controller = new PiProcessController({
      boxId: "box-sim-test",
      appendEvent: (event) => appendPiEvent(machine, event),
      appendFault: (fault) => appendPiFault(machine, fault),
      currentInvocationId: () => machine.daemon.invocationId,
    }, {
      processPath: PI_UNTERMINATED_PROCESS_PATH,
      rpcTimeoutMs: 2_000,
      stopTimeoutMs: 1_000,
    });
    liveControllers.push(controller);

    await controller.start();
    await controller.waitForExit();
    await waitFor(() => machine.daemon.brokerCounters.unterminatedLines > 0 ? true : null);

    expect(machine.daemon.brokerCounters).toMatchObject({
      unterminatedLines: 1,
      malformedLines: 0,
    });
    expect(machine.daemon.brokerJournal).toEqual([]);
    expect(controller.stderr).not.toContain("sensitive-fragment-marker");
    expect(JSON.stringify({
      counters: machine.daemon.brokerCounters,
      journal: machine.daemon.brokerJournal,
      stderr: controller.stderr,
    })).not.toContain("sensitive-fragment-marker");
  });

  it("returns correlated command errors and rejects unsupported scenario names", async () => {
    const harness = await controllerHarness("normal");
    const response = await harness.controller.handleRpc({ id: "future-1", type: "future_command" });
    expect(response).toEqual({
      type: "response",
      command: "future_command",
      success: false,
      error: "Unknown command: future_command",
      id: "future-1",
    });
    await expect(harness.controller.setScenario("not-a-scenario")).rejects.toThrow(
      "unknown Pi simulator scenario",
    );
  });

  it("waits for the previous close before replacing an exited child", async () => {
    const events: Array<Record<string, unknown> | string> = [];
    const controller = new PiProcessController({
      boxId: "box-sim-delayed-close",
      appendEvent: (event) => events.push(event),
      appendFault: () => undefined,
      currentInvocationId: () => "00000000000000000000000000000001",
    }, {
      processPath: DELAYED_CLOSE_PROCESS_PATH,
      rpcTimeoutMs: 1_000,
      stopTimeoutMs: 1_000,
    });
    liveControllers.push(controller);
    await controller.start();
    const firstPid = controller.pid;
    const pendingFailure = controller.handleRpc({ id: "pending-before-close", type: "get_state" })
      .then(() => null, (error: unknown) => error);

    await waitFor(() => controller.running ? null : true);
    let replacementStarted = false;
    const startReplacement = () => controller.start().then(() => {
      replacementStarted = true;
      return controller.pid;
    });
    const replacements = [startReplacement(), startReplacement()];
    await delay(30);
    expect(replacementStarted).toBe(false);

    const failure = await pendingFailure;
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("exited with code 0");
    const replacementPids = await Promise.all(replacements);
    expect(controller.running).toBe(true);
    expect(controller.pid).not.toBe(firstPid);
    expect(new Set(replacementPids).size).toBe(1);
    expect(events).toEqual([]);
  });
});

interface RawHarness {
  child: ChildProcessWithoutNullStreams;
  stdout(): string;
}

interface ControllerHarness {
  controller: PiProcessController;
  events: Array<Record<string, unknown> | string>;
  faults: string[];
}

function spawnRawPi(scenario: PiScenarioName): RawHarness {
  const child = spawn(process.execPath, [PI_PROCESS_PATH, "--scenario", scenario], {
    env: { PI_SIM_SCENARIO: scenario },
    stdio: ["pipe", "pipe", "pipe"],
  });
  liveChildren.push(child);
  let stdout = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  return { child, stdout: () => stdout };
}

async function controllerHarness(
  scenario: PiScenarioName,
  oversizedBytes?: number,
): Promise<ControllerHarness> {
  const events: Array<Record<string, unknown> | string> = [];
  const faults: string[] = [];
  const controller = new PiProcessController({
    boxId: "box-sim-test",
    appendEvent: (event) => events.push(event),
    appendFault: (fault) => faults.push(fault),
    currentInvocationId: () => "00000000000000000000000000000001",
  }, {
    scenario,
    oversizedBytes,
    rpcTimeoutMs: 2_000,
    stopTimeoutMs: 1_000,
  });
  liveControllers.push(controller);
  await controller.start();
  return { controller, events, faults };
}

function acceptedPrompt(controller: PiProcessController, id: string): Promise<Record<string, unknown>> {
  return controller.handleRpc({
    id,
    type: "prompt",
    message: "Run the deterministic scenario.",
    streamingBehavior: "followUp",
  });
}

async function waitForRawRecords(
  harness: RawHarness,
  predicate: (records: Array<Record<string, unknown>>) => boolean,
): Promise<Array<Record<string, unknown>>> {
  return waitFor(() => {
    const records = completeLines(harness.stdout()).map((line) => JSON.parse(line) as Record<string, unknown>);
    return predicate(records) ? records : null;
  });
}

async function waitForEvent(
  events: Array<Record<string, unknown> | string>,
  type: string,
): Promise<Record<string, unknown>> {
  return waitFor(() => objectEvents(events).find((event) => event.type === type) ?? null);
}

async function waitFor<T>(read: () => T | null, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await delay(5);
  }
  throw new Error(`condition was not met within ${timeoutMs}ms`);
}

function completeLines(output: string): string[] {
  const parts = output.split("\n");
  if (!output.endsWith("\n")) parts.pop();
  return parts.filter((line) => line.length > 0);
}

function objectEvents(events: Array<Record<string, unknown> | string>): Array<Record<string, unknown>> {
  return events.filter(isRecord);
}

function eventType(event: Record<string, unknown> | string): unknown {
  return isRecord(event) ? event.type : undefined;
}

function findEvent(events: Array<Record<string, unknown>>, type: string): Record<string, unknown> {
  const event = events.find((item) => item.type === type);
  if (!event) throw new Error(`event ${type} was not emitted`);
  return event;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
