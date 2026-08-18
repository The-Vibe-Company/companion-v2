import { describe, expect, it, vi } from "vitest";

import {
  appendPiEvent,
  classifyBoxCommand,
  createBoxSimCommandMachine,
  decodeShellQuoted,
  executeBoxCommand,
  extractFifoJson,
  putBoxFile,
} from "../src/commandShims";
import type { BoxSimPiController } from "../src/protocol";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function rpcShell(command: Record<string, unknown>): string {
  return `set -euo pipefail
fifo="$HOME/.companion/runtime/state/pi.rpc.in"
rpc_start_size=0
printf '%s\\n' ${shellQuote(JSON.stringify(command))} > "$fifo"
printf '%s\\n' 'Pi RPC did not acknowledge prompt' >&2`;
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
      ["companion-pi-rpc-ready companion-pi-rpc-unready", "daemon-state"],
      [rpcShell({ id: "one", type: "prompt" }), "rpc-command"],
      ['test -p "$fifo"\nprintf \'%s\\n\' \'{}\' > "$fifo"', "extension-ui-response"],
      ["reset-failed companion-pi-daemon.service; systemctl --user start companion-pi-daemon.service", "heal-daemon"],
      ["companion-pi-journal companion-pi-restarts", "daemon-diagnostics"],
      ['rm -f "$HOME/.companion/runtime/state/providers.env"', "remove-provider-files"],
      ["Pi daemon is still active after stop", "stop-daemon"],
      ["log=pi.rpc.ndjson; offset=0; head -c 262144", "read-events"],
      ["mktemp -t companion-frame; printf 'data:%s;base64'", "capture-desktop-frame"],
    ];
    for (const [command, kind] of commands) expect(classifyBoxCommand(command)).toBe(kind);
    expect(classifyBoxCommand("uname -a")).toBe("unsupported");
  });

  it("round-trips the adapter's POSIX quoting, including apostrophes", () => {
    const payload = { id: "req-1", type: "prompt", message: "don't execute this" };
    expect(decodeShellQuoted(shellQuote("don't"))).toBe("don't");
    expect(extractFifoJson(rpcShell(payload))).toEqual(payload);
  });

  it("models credential movement, daemon lifecycle, correlated RPC, and warm probes", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    const handleRpc = vi.fn(async (command: Record<string, unknown>) => ({
      type: "response",
      command: command.type,
      id: command.id,
      success: true,
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
    expect(await executeBoxCommand(machine, "printf companion-pi-warm-ready"))
      .toMatchObject({ success: true, stdout: "companion-pi-warm-ready\n" });

    const rpc = await executeBoxCommand(machine, rpcShell({
      id: "turn-with-apostrophe",
      type: "prompt",
      message: "don't repeat",
    }));
    expect(rpc.success).toBe(true);
    expect(JSON.parse(rpc.stdout)).toMatchObject({
      type: "response",
      command: "prompt",
      id: "turn-with-apostrophe",
      success: true,
    });
    expect(handleRpc).toHaveBeenCalledWith(expect.objectContaining({ message: "don't repeat" }));
    expect(machine.daemon.rpcLog).toContain('"id":"turn-with-apostrophe"');

    expect(await executeBoxCommand(machine, "Pi daemon is still active after stop"))
      .toMatchObject({ success: true });
    expect(machine.daemon).toMatchObject({ status: "inactive", rpcReady: false, invocationId: null });
    expect(machine.volatileFiles.size).toBe(0);
  });

  it("joins virtual file parts and reads byte-offset event chunks without a shell", async () => {
    const machine = createBoxSimCommandMachine({ boxId: "bx_23456789", scenario: "normal" });
    putBoxFile(machine, "archive.part0", Buffer.from("abc"));
    putBoxFile(machine, "archive.part1", Buffer.from("def"));
    expect(await executeBoxCommand(
      machine,
      "set -e; cat 'archive.part0' 'archive.part1' > 'archive'; rm -f 'archive.part0' 'archive.part1'",
    )).toMatchObject({ success: true });
    expect(machine.persistentFiles.get("archive")?.toString()).toBe("abcdef");
    expect(machine.persistentFiles.has("archive.part0")).toBe(false);

    appendPiEvent(machine, { type: "one" });
    appendPiEvent(machine, { type: "two" });
    const command = "log=pi.rpc.ndjson; offset=4; tail -c x | head -c 262144";
    const read = await executeBoxCommand(machine, command);
    expect(read.stdout.startsWith("4\n")).toBe(true);
    expect(Buffer.byteLength(read.stdout.slice(2))).toBe(
      Buffer.byteLength(machine.daemon.rpcLog) - 4,
    );
    const rewound = await executeBoxCommand(
      machine,
      "log=pi.rpc.ndjson; offset=99999; tail -c x | head -c 262144",
    );
    expect(rewound.stdout).toBe(`0\n${machine.daemon.rpcLog}`);
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
