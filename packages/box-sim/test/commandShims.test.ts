import { describe, expect, it, vi } from "vitest";

import {
  appendPiEvent,
  classifyBoxCommand,
  createBoxSimCommandMachine,
  decodeShellQuoted,
  executeBoxCommand,
  extractBrokerJson,
  putBoxFile,
} from "../src/commandShims";
import type { BoxSimPiController } from "../src/protocol";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function brokerShell(command: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(command), "utf8").toString("base64");
  return `broker_socket="$HOME/.companion/runtime/state/pi-broker.sock"
test -S "$broker_socket"
COMPANION_PI_BROKER_COMMAND=${shellQuote(encoded)} node <<'COMPANION_PI_BROKER_CLIENT'`;
}

describe("semantic Box command shims", () => {
  it("classifies every adapter command family by stable semantic markers", () => {
    const commands: Array<[string, ReturnType<typeof classifyBoxCommand>]> = [
      ["printf '%s\\n' 'companion-box-runnable'", "box-runnable"],
      ["systemctl --user is-active x; printf companion-pi-warm-ready", "warm-daemon-ready"],
      ['mkdir -p "$HOME/.companion/bin"', "mkdir-pi-bin"],
      ['bash "$HOME/.companion/bin/ensure-pi-layout.sh"', "install-layout"],
      ['mkdir -p "$HOME/.companion/pi/extensions"', "mkdir-extensions"],
      ["state/skill-archives companion-provider-auth-present", "clear-skill-archives"],
      ["companion-archive-bytes wc -c", "measure-skill-archives"],
      ["cat '.part0' > '.target'; rm -f '.part0'", "join-file-parts"],
      ["skills.next base64 --decode tar --extract", "prepare-skills"],
      ["staged_credential_file=x; systemctl --user daemon-reload", "start-or-restart-daemon"],
      ["companion-pi-broker-ready companion-pi-broker-unready", "daemon-state"],
      [brokerShell({ id: "one", type: "prompt", attemptId: "attempt-1" }), "rpc-command"],
      [brokerShell({
        id: "decision-1",
        type: "extension_ui_response",
        response: { id: "question-1", type: "extension_ui_response", value: "yes" },
      }), "extension-ui-response"],
      ["companion-pi-journal companion-pi-restarts", "daemon-diagnostics"],
      ['rm -f "$HOME/.companion/runtime/state/providers.env"', "remove-provider-files"],
      ["Pi daemon is still active after stop", "stop-daemon"],
    ];
    for (const [command, kind] of commands) expect(classifyBoxCommand(command)).toBe(kind);
    expect(classifyBoxCommand("uname -a")).toBe("unsupported");
  });

  it("round-trips the adapter's POSIX quoting, including apostrophes", () => {
    const payload = { id: "req-1", type: "prompt", message: "don't execute this" };
    expect(decodeShellQuoted(shellQuote("don't"))).toBe("don't");
    expect(extractBrokerJson(brokerShell(payload))).toEqual(payload);
  });

  it("models credential movement, daemon lifecycle, correlated RPC, and warm probes", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const handleRpc = vi.fn(async (command: Record<string, unknown>) => ({
      type: "response",
      command: command.type,
      id: command.id,
      success: true,
      ...(command.type === "get_state"
        ? { data: { model: { input: ["text", "image"] } } }
        : {}),
    }));
    const controller: BoxSimPiController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc,
      respondExtensionUi: vi.fn(),
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };
    machine.piController = controller;
    putBoxFile(machine, ".companion/pi/auth.json", Buffer.from("secret auth"));
    putBoxFile(machine, ".companion/runtime/state/providers.env", Buffer.from("TOKEN=secret"));

    const started = await executeBoxCommand(
      machine,
      "staged_credential_file=x; systemctl --user daemon-reload; systemctl --user start companion-pi-daemon.service",
    );
    expect(started.success).toBe(true);
    expect(controller.start).toHaveBeenCalledOnce();
    expect(machine.persistentFiles.has(".companion/runtime/state/providers.env")).toBe(false);
    expect(machine.volatileFiles.get("run/user/1000/companion/providers.env")?.toString())
      .toBe("TOKEN=secret");
    expect(machine.daemon).toMatchObject({
      status: "active",
      rpcReady: true,
      invocationId: "00000000000000000000000000000001",
    });
    putBoxFile(machine, ".companion/runtime/state/providers.env", Buffer.from("TOKEN=refreshed"));
    const startedAgain = await executeBoxCommand(
      machine,
      "staged_credential_file=x; systemctl --user daemon-reload; systemctl --user start companion-pi-daemon.service",
    );
    expect(startedAgain.success).toBe(true);
    expect(machine.daemon).toMatchObject({
      invocationId: "00000000000000000000000000000001",
      restartCount: 0,
    });
    expect(controller.start).toHaveBeenCalledOnce();
    expect(await executeBoxCommand(machine, "printf companion-pi-warm-ready"))
      .toMatchObject({ success: true, stdout: "companion-pi-warm-ready\n" });

    const runtimeState = await executeBoxCommand(machine, brokerShell({
      id: "runtime-state-1",
      type: "runtime_state",
    }));
    expect(runtimeState.success).toBe(true);
    expect(JSON.parse(runtimeState.stdout)).toMatchObject({
      type: "response",
      command: "runtime_state",
      id: "runtime-state-1",
      success: true,
      data: {
        invocationId: "00000000000000000000000000000001",
        activeAttemptId: null,
        modelInput: ["text", "image"],
      },
    });
    expect(handleRpc).toHaveBeenCalledWith({ id: "runtime-state-1", type: "get_state" });

    const rpc = await executeBoxCommand(machine, brokerShell({
      id: "turn-with-apostrophe",
      type: "prompt",
      attemptId: "turn-with-apostrophe",
      message: "don't repeat",
    }));
    expect(rpc.success).toBe(true);
    expect(JSON.parse(rpc.stdout)).toMatchObject({
      type: "response",
      command: "prompt",
      id: "turn-with-apostrophe",
      success: true,
      data: {
        attemptId: "turn-with-apostrophe",
        invocationId: "00000000000000000000000000000001",
        piAcknowledged: true,
      },
    });
    expect(handleRpc).toHaveBeenCalledWith(expect.objectContaining({ message: "don't repeat" }));

    const decision = await executeBoxCommand(machine, brokerShell({
      id: "decision-1",
      type: "extension_ui_response",
      response: { id: "question-1", type: "extension_ui_response", value: "yes" },
    }));
    expect(decision.success).toBe(true);
    expect(JSON.parse(decision.stdout)).toMatchObject({
      type: "response",
      command: "extension_ui_response",
      id: "decision-1",
      success: true,
      data: {
        attemptId: "turn-with-apostrophe",
        invocationId: "00000000000000000000000000000001",
        delivered: true,
      },
    });
    expect(controller.respondExtensionUi).toHaveBeenCalledWith({
      id: "question-1",
      type: "extension_ui_response",
      value: "yes",
    });

    expect(await executeBoxCommand(machine, "Pi daemon is still active after stop"))
      .toMatchObject({ success: true });
    expect(machine.daemon).toMatchObject({
      status: "inactive",
      rpcReady: false,
      activeAttemptId: null,
      invocationId: null,
    });
    expect(machine.volatileFiles.size).toBe(0);
  });

  it("restarts Pi with the existing volatile credential when no replacement was staged", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const controller: BoxSimPiController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc: vi.fn(),
      respondExtensionUi: vi.fn(),
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };
    machine.piController = controller;
    putBoxFile(machine, ".companion/pi/auth.json", Buffer.from("secret auth"));
    putBoxFile(machine, ".companion/runtime/state/providers.env", Buffer.from("TOKEN=secret"));
    const command = (action: "start" | "restart") =>
      `staged_credential_file=x; systemctl --user daemon-reload; systemctl --user ${action} companion-pi-daemon.service`;

    await expect(executeBoxCommand(machine, command("start"))).resolves.toMatchObject({ success: true });
    expect(machine.persistentFiles.has(".companion/runtime/state/providers.env")).toBe(false);
    await expect(executeBoxCommand(machine, command("restart"))).resolves.toMatchObject({ success: true });

    expect(controller.restart).toHaveBeenCalledOnce();
    expect(machine.volatileFiles.get("run/user/1000/companion/providers.env")?.toString())
      .toBe("TOKEN=secret");
    expect(machine.daemon).toMatchObject({
      status: "active",
      invocationId: "00000000000000000000000000000002",
      restartCount: 1,
    });
  });

  it("preserves malformed Pi model capabilities so the production adapter rejects them", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    machine.daemon.status = "active";
    machine.daemon.rpcReady = true;
    machine.daemon.invocationId = "00000000000000000000000000000001";
    machine.piController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc: vi.fn(async (command: Record<string, unknown>) => ({
        type: "response",
        command: command.type,
        id: command.id,
        success: true,
        data: { model: { input: ["text", 7, null] } },
      })),
      respondExtensionUi: vi.fn(),
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };

    const result = await executeBoxCommand(machine, brokerShell({
      id: "runtime-state-malformed",
      type: "runtime_state",
    }));

    expect(JSON.parse(result.stdout)).toMatchObject({
      success: true,
      data: { modelInput: ["text", 7, null] },
    });
  });

  it("correlates a Pi event emitted before the prompt acknowledgement", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "ask_user" });
    machine.daemon.status = "active";
    machine.daemon.rpcReady = true;
    machine.daemon.invocationId = "00000000000000000000000000000001";
    machine.piController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc: vi.fn(async (command: Record<string, unknown>) => {
        appendPiEvent(machine, {
          type: "extension_ui_request",
          id: "question-before-ack",
          method: "input",
          title: "companion:question:ask_user",
        });
        return {
          type: "response",
          command: command.type,
          id: command.id,
          success: true,
        };
      }),
      respondExtensionUi: vi.fn(),
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };

    const result = await executeBoxCommand(machine, brokerShell({
      id: "prompt-before-ack",
      type: "prompt",
      attemptId: "attempt-before-ack",
      message: "Ask first.",
    }));

    expect(result.success).toBe(true);
    expect(machine.daemon.activeAttemptId).toBe("attempt-before-ack");
    expect(machine.daemon.brokerCounters.unboundEvents).toBe(0);
    expect(machine.daemon.brokerJournal).toEqual([
      expect.objectContaining({
        invocationId: "00000000000000000000000000000001",
        attemptId: "attempt-before-ack",
        kind: "pi_event",
        event: expect.objectContaining({ type: "extension_ui_request" }),
      }),
    ]);
  });

  it.each([
    ["missing id", { type: "extension_ui_response", value: "yes" }],
    ["empty id", { type: "extension_ui_response", id: "", value: "yes" }],
    [
      "oversized id",
      { type: "extension_ui_response", id: "x".repeat(257), value: "yes" },
    ],
    ["non-finite id", { type: "extension_ui_response", id: Number.POSITIVE_INFINITY, value: "yes" }],
    ["wrong type", { type: "extension_ui_request", id: "question-1", value: "yes" }],
  ] as const)("does not deliver a decision with %s", async (_name, response) => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "ask_user" });
    const respondExtensionUi = vi.fn();
    machine.daemon.status = "active";
    machine.daemon.rpcReady = true;
    machine.daemon.invocationId = "00000000000000000000000000000001";
    machine.daemon.activeAttemptId = "attempt-question";
    machine.piController = {
      start: vi.fn(),
      restart: vi.fn(),
      stop: vi.fn(),
      handleRpc: vi.fn(),
      respondExtensionUi,
      crash: vi.fn(),
      setScenario: vi.fn(),
      dispose: vi.fn(),
    };

    const result = await executeBoxCommand(machine, brokerShell({
      id: "decision-invalid",
      type: "extension_ui_response",
      response,
    }));

    expect(result.success).toBe(true);
    expect(JSON.parse(result.stdout)).toMatchObject({
      id: "decision-invalid",
      success: false,
      error: { code: "invalid_command", ambiguous: false },
    });
    expect(respondExtensionUi).not.toHaveBeenCalled();
  });

  it("bounds read_events pages by encoded bytes without loss or duplication", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    machine.daemon.status = "active";
    machine.daemon.rpcReady = true;
    machine.daemon.invocationId = "00000000000000000000000000000001";
    machine.daemon.activeAttemptId = "attempt-large-events";
    for (let index = 0; index < 4; index += 1) {
      appendPiEvent(machine, {
        type: "message_update",
        index,
        delta: "x".repeat(60 * 1024),
      });
    }

    const first = await executeBoxCommand(machine, brokerShell({
      id: "read-large-page-1",
      type: "read_events",
      after: 0,
      limit: 256,
    }));
    const firstResponse = JSON.parse(first.stdout) as {
      data: { events: Array<{ sequence: number }>; nextCursor: number; hasMore: boolean };
    };
    expect(Buffer.byteLength(first.stdout, "utf8")).toBeLessThan(256 * 1024);
    expect(firstResponse.data.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(firstResponse.data).toMatchObject({ nextCursor: 3, hasMore: true });

    const second = await executeBoxCommand(machine, brokerShell({
      id: "read-large-page-2",
      type: "read_events",
      after: firstResponse.data.nextCursor,
      limit: 256,
    }));
    const secondResponse = JSON.parse(second.stdout) as {
      data: { events: Array<{ sequence: number }>; nextCursor: number; hasMore: boolean };
    };
    expect(secondResponse.data.events.map((event) => event.sequence)).toEqual([4]);
    expect(secondResponse.data).toMatchObject({ nextCursor: 4, hasMore: false });
    expect([
      ...firstResponse.data.events,
      ...secondResponse.data.events,
    ].map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
  });

  it("joins virtual file parts without invoking a host shell", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    putBoxFile(machine, "archive.part0", Buffer.from("abc"));
    putBoxFile(machine, "archive.part1", Buffer.from("def"));
    expect(await executeBoxCommand(
      machine,
      "set -e; cat 'archive.part0' 'archive.part1' > 'archive'; rm -f 'archive.part0' 'archive.part1'",
    )).toMatchObject({ success: true });
    expect(machine.persistentFiles.get("archive")?.toString()).toBe("abcdef");
    expect(machine.persistentFiles.has("archive.part0")).toBe(false);

  });

  it("fails closed on unknown commands and records only their digest", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const syntheticSecret = ["simulated", "credential", "771"].join("-");
    const secretCommand =
      `curl https://example.invalid -H 'Authorization: ${syntheticSecret}'`;
    const result = await executeBoxCommand(machine, secretCommand);
    expect(result).toMatchObject({ success: false, exitCode: 127 });
    expect(result.stderr).not.toContain(syntheticSecret);
    expect(machine.unknownCommandDigests).toHaveLength(1);
    expect(machine.unknownCommandDigests[0]).toMatch(/^[a-f0-9]{64}$/);
    expect(machine.persistentFiles.size).toBe(0);
  });
});
