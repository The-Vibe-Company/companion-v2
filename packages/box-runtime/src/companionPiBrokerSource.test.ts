import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { sendCompanionPiBrokerCommand } from "./companionPiBrokerCore";
import {
  COMPANION_PI_BROKER_SOCKET_PATH,
  COMPANION_PI_BROKER_SOURCE,
} from "./companionPiBroker";

const processes: ChildProcessWithoutNullStreams[] = [];
const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(processes.splice(0).map(stopBrokerProcess));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("COMPANION_PI_BROKER_SOURCE", () => {
  it("is the byte-exact deterministic bundle and retains only Node built-in imports", async () => {
    const generator = fileURLToPath(new URL("../scripts/generate-companion-pi-broker.mjs", import.meta.url));
    await expect(execFileAsync(process.execPath, [generator, "--check"])).resolves.toMatchObject({
      stderr: "",
    });
    const imports = [
      ...[...COMPANION_PI_BROKER_SOURCE.matchAll(/\bfrom\s*["']([^"']+)["']/g)]
        .flatMap((match) => match[1] ? [match[1]] : []),
      ...[...COMPANION_PI_BROKER_SOURCE.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)]
        .flatMap((match) => match[1] ? [match[1]] : []),
      ...[...COMPANION_PI_BROKER_SOURCE.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g)]
        .flatMap((match) => match[1] ? [match[1]] : []),
    ];
    expect(imports.length).toBeGreaterThan(0);
    expect(imports.every((specifier) => specifier.startsWith("node:"))).toBe(true);
  });

  it("runs the staged ESM against a real strict-LF Pi subprocess", async () => {
    const home = temporaryDirectory("pi-broker-source-");
    const runtimeRoot = join(home, ".companion", "runtime");
    const brokerPath = join(home, "companion-pi-broker.mjs");
    const piPath = join(home, "fake-pi.mjs");
    const capturePath = join(home, "pi-commands.ndjson");
    const piPidPath = join(home, "pi.pid");
    const piArgvPath = join(home, "pi.argv.json");
    // macOS has a short Unix-socket path limit; the production relative layout is covered by the
    // adapter tests, while this subprocess test only needs a private socket in its temp directory.
    const socketPath = join(home, "broker.sock");
    mkdirSync(join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "sessions"), { recursive: true, mode: 0o700 });
    writeFileSync(brokerPath, COMPANION_PI_BROKER_SOURCE, { mode: 0o700 });
    writeFileSync(piPath, fakePiSource(), { mode: 0o700 });
    chmodSync(piPath, 0o700);

    const broker = spawn(process.execPath, [brokerPath], {
      env: {
        ...process.env,
        COMPANION_PI_ROOT: runtimeRoot,
        COMPANION_PI_BIN: piPath,
        COMPANION_PI_INVOCATION_ID: "invocation-source-1",
        COMPANION_PI_SOCKET_PATH: socketPath,
        COMPANION_PI_MAX_LINE_BYTES: "256",
        COMPANION_PI_SEGMENT_BYTES: "400",
        FAKE_PI_CAPTURE_PATH: capturePath,
        FAKE_PI_PID_PATH: piPidPath,
        FAKE_PI_ARGV_PATH: piArgvPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    processes.push(broker);
    let startupStderr = "";
    broker.stderr.on("data", (chunk: Buffer) => {
      startupStderr += chunk.toString("utf8");
    });
    // A Unix socket path appears at bind(), but connections are only accepted once the broker
    // reaches listen(). Waiting for the path alone left a window where the first command raced the
    // broker and came back ECONNREFUSED, so readiness is proven by a real round trip instead.
    await waitFor(async () => {
      if (!existsSync(socketPath)) return false;
      try {
        await sendCompanionPiBrokerCommand({
          socketPath,
          command: { id: "control-source-ready", type: "broker_state" },
        });
        return true;
      } catch {
        return false;
      }
    }).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : "startup failed"}: ${startupStderr}`);
    });

    // Without --continue, Pi's own CLI always starts a brand-new session even when a Companion
    // already has one on disk in --session-dir, silently discarding its conversation on every
    // broker (re)start. Assert the exact argv the broker spawns Pi with so a future regeneration of
    // the bundled broker source cannot lose this flag unnoticed.
    expect(await waitForJsonFile<string[]>(piArgvPath)).toEqual([
      "--mode", "rpc", "--session-dir", join(runtimeRoot, "sessions"), "--continue", "--no-skills",
    ]);

    const prompt = await sendCompanionPiBrokerCommand({
      socketPath,
      command: {
        id: "control-source-prompt",
        type: "prompt",
        attemptId: "attempt-source-1",
        message: "Run through the standalone broker",
        requiredInput: ["text"],
        clearOutbox: true,
      },
    });
    expect(prompt).toMatchObject({
      id: "control-source-prompt",
      success: true,
      data: { attemptId: "attempt-source-1", piAcknowledged: true },
    });

    let brokerState: Record<string, unknown> = {};
    await waitFor(async () => {
      const response = await sendCompanionPiBrokerCommand({
        socketPath,
        command: { id: "control-source-state", type: "broker_state" },
      });
      brokerState = response.data as Record<string, unknown>;
      return brokerState.activeAttemptId === null
        && Number(brokerState.tailCursor) >= 3;
    });
    expect(brokerState).toMatchObject({
      invocationId: "invocation-source-1",
      activeAttemptId: null,
      counters: {
        malformedLines: 1,
        oversizedLines: 1,
        unknownEvents: 1,
      },
    });

    const read = await sendCompanionPiBrokerCommand({
      socketPath,
      command: { id: "control-source-read", type: "read_events", after: 0, limit: 20 },
    });
    expect(read).toMatchObject({
      success: true,
      data: {
        events: [
          { sequence: 1, attemptId: "attempt-source-1", event: { type: "agent_start" } },
          { sequence: 2, attemptId: "attempt-source-1", event: { type: "message_end" } },
          { sequence: 3, attemptId: "attempt-source-1", event: { type: "agent_settled" } },
        ],
      },
    });
    const ack = await sendCompanionPiBrokerCommand({
      socketPath,
      command: { id: "control-source-ack", type: "ack_events", through: 3 },
    });
    expect(ack).toMatchObject({ success: true, data: { acknowledgedCursor: 3 } });

    const commands = readFileSync(capturePath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(commands.map((command) => command.type)).toEqual(["get_state", "get_state", "prompt"]);
    expect(commands[2]).not.toHaveProperty("streamingBehavior");
    const piPid = Number(readFileSync(piPidPath, "utf8"));
    expect(Number.isSafeInteger(piPid)).toBe(true);
    process.kill(piPid, "SIGKILL");
    const brokerExit = await waitForExit(broker);
    expect(brokerExit).toMatchObject({ code: 1, signal: null });
    expect(existsSync(socketPath)).toBe(false);
    const journalRecords = readJournalRecords(join(runtimeRoot, "events"));
    expect(journalRecords.some((record) => record.kind === "pi_process_exit")).toBe(false);
    expect(JSON.parse(readFileSync(join(runtimeRoot, "events", "counters.json"), "utf8")))
      .toMatchObject({ unboundEvents: 1 });
  }, 10_000);

  it("terminates a spawned Pi when the command socket cannot start", async () => {
    const home = temporaryDirectory("pi-broker-start-failure-");
    const runtimeRoot = join(home, ".companion", "runtime");
    const brokerPath = join(home, "companion-pi-broker.mjs");
    const piPath = join(home, "idle-pi.mjs");
    const invalidSocketPath = join(runtimeRoot, "state", "not-a-socket");
    mkdirSync(join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    writeFileSync(invalidSocketPath, "regular file", { mode: 0o600 });
    writeFileSync(brokerPath, COMPANION_PI_BROKER_SOURCE, { mode: 0o700 });
    writeFileSync(piPath, fakePiSource(), { mode: 0o700 });

    const broker = spawn(process.execPath, [brokerPath], {
      env: {
        ...process.env,
        COMPANION_PI_ROOT: runtimeRoot,
        COMPANION_PI_BIN: piPath,
        COMPANION_PI_INVOCATION_ID: "invocation-start-failure",
        COMPANION_PI_SOCKET_PATH: invalidSocketPath,
        FAKE_PI_CAPTURE_PATH: join(home, "pi-commands.ndjson"),
        FAKE_PI_PID_PATH: join(home, "pi.pid"),
        FAKE_PI_ARGV_PATH: join(home, "pi.argv.json"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    processes.push(broker);
    let stderr = "";
    broker.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await expect(waitForExitWithin(broker, 5_000)).resolves.toEqual({ code: 1, signal: null });
    expect(stderr).toBe("companion-pi-broker: startup failed (Error)\n");
  });

  it("fails immediately when Pi exits before its initial state is ready", async () => {
    const home = temporaryDirectory("pi-broker-early-exit-");
    const runtimeRoot = join(home, ".companion", "runtime");
    const brokerPath = join(home, "companion-pi-broker.mjs");
    const piPath = join(home, "exiting-pi.mjs");
    const socketPath = join(home, "broker.sock");
    mkdirSync(join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    writeFileSync(brokerPath, COMPANION_PI_BROKER_SOURCE, { mode: 0o700 });
    writeFileSync(piPath, "#!/usr/bin/env node\nprocess.exit(23);\n", { mode: 0o700 });

    const broker = spawn(process.execPath, [brokerPath], {
      env: {
        ...process.env,
        COMPANION_PI_ROOT: runtimeRoot,
        COMPANION_PI_BIN: piPath,
        COMPANION_PI_INVOCATION_ID: "invocation-early-exit",
        COMPANION_PI_SOCKET_PATH: socketPath,
        COMPANION_PI_RPC_TIMEOUT_MS: "10000",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    processes.push(broker);
    let stderr = "";
    broker.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    await expect(waitForExitWithin(broker, 2_000)).resolves.toEqual({ code: 1, signal: null });
    expect(stderr).toBe(
      "companion-pi-broker: startup failed (PiProcessExitedBeforeReadyError)\n",
    );
    expect(existsSync(socketPath)).toBe(false);
  });
});

describe("Pi broker --append-system-prompt", () => {
  async function spawnedPiArgv(instructions: string | null): Promise<string[]> {
    const home = temporaryDirectory("pi-broker-argv-");
    const runtimeRoot = join(home, ".companion", "runtime");
    const brokerPath = join(home, "companion-pi-broker.mjs");
    const piPath = join(home, "fake-pi.mjs");
    const piArgvPath = join(home, "pi.argv.json");
    const socketPath = join(home, COMPANION_PI_BROKER_SOCKET_PATH);
    mkdirSync(join(runtimeRoot, "state"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "logs"), { recursive: true, mode: 0o700 });
    mkdirSync(join(runtimeRoot, "sessions"), { recursive: true, mode: 0o700 });
    if (instructions !== null) {
      writeFileSync(join(runtimeRoot, "state", "instructions.txt"), instructions, { mode: 0o600 });
    }
    writeFileSync(brokerPath, COMPANION_PI_BROKER_SOURCE, { mode: 0o700 });
    writeFileSync(piPath, fakePiSource(), { mode: 0o700 });
    chmodSync(piPath, 0o700);
    const broker = spawn(process.execPath, [brokerPath], {
      env: {
        ...process.env,
        COMPANION_PI_ROOT: runtimeRoot,
        COMPANION_PI_BIN: piPath,
        COMPANION_PI_INVOCATION_ID: "invocation-argv",
        COMPANION_PI_SOCKET_PATH: socketPath,
        FAKE_PI_CAPTURE_PATH: join(home, "unused.ndjson"),
        FAKE_PI_PID_PATH: join(home, "pi.pid"),
        FAKE_PI_ARGV_PATH: piArgvPath,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    processes.push(broker);
    return waitForJsonFile<string[]>(piArgvPath);
  }

  it("passes a present instructions file as --append-system-prompt", async () => {
    const argv = await spawnedPiArgv("Be terse.\n");
    const flag = argv.indexOf("--append-system-prompt");
    expect(flag).toBeGreaterThan(-1);
    expect(argv[flag + 1]).toBe("Be terse.");
  });

  it("omits --append-system-prompt when instructions.txt is absent", async () => {
    expect(await spawnedPiArgv(null)).not.toContain("--append-system-prompt");
  });

  it("omits --append-system-prompt when instructions.txt is whitespace-only", async () => {
    expect(await spawnedPiArgv("   \n")).not.toContain("--append-system-prompt");
  });
});

function fakePiSource(): string {
  return `#!/usr/bin/env node
import { appendFileSync, renameSync, writeFileSync } from "node:fs";
import { StringDecoder } from "node:string_decoder";
const capture = process.env.FAKE_PI_CAPTURE_PATH;
process.stdout.on("error", () => process.exit(1));
writeFileSync(process.env.FAKE_PI_PID_PATH, String(process.pid), { mode: 0o600 });
if (process.env.FAKE_PI_ARGV_PATH) {
  const argvPath = process.env.FAKE_PI_ARGV_PATH;
  const temporary = argvPath + ".tmp";
  writeFileSync(temporary, JSON.stringify(process.argv.slice(2)), { mode: 0o600 });
  renameSync(temporary, argvPath);
}
const decoder = new StringDecoder("utf8");
let buffered = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function handle(line) {
  const command = JSON.parse(line);
  appendFileSync(capture, JSON.stringify(command) + "\\n", { mode: 0o600 });
  if (command.type === "get_state") {
    send({
      id: command.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        isStreaming: false,
        isCompacting: false,
        pendingMessageCount: 0,
        model: { id: "vision-model", input: ["text", "image"] },
      },
    });
    return;
  }
  send({ id: command.id, type: "response", command: "prompt", success: true });
  send({ type: "agent_start" });
  process.stdout.write('{"type":"message_update","provider":"provider-secret"\\n');
  send({ type: "message_update", value: "x".repeat(512) });
  send({ type: "future_event", value: "provider-secret" });
  send({ type: "message_end", message: { role: "assistant", content: [] } });
  send({ type: "agent_settled" });
}
process.stdin.on("data", (chunk) => {
  buffered += decoder.write(chunk);
  for (;;) {
    const newline = buffered.indexOf("\\n");
    if (newline < 0) break;
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line) handle(line);
  }
});
`;
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition did not become true before timeout");
}

async function waitForJsonFile<T>(path: string, timeoutMs = 5_000): Promise<T> {
  let parsed: T | undefined;
  await waitFor(() => {
    if (!existsSync(path)) return false;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as T;
      return true;
    } catch {
      // writeFileSync creates the path before the bytes land; wait until JSON is complete.
      return false;
    }
  }, timeoutMs);
  return parsed as T;
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

async function stopBrokerProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // Let the broker's SIGTERM handler terminate and await its Pi child before removing the shared
  // temp directory. SIGKILL bypasses that handler and lets Pi race rmSync with late file writes.
  child.kill("SIGTERM");
  try {
    await waitForExitWithin(child, 3_000);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await waitForExit(child);
  }
}

async function waitForExitWithin(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      waitForExit(child),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("broker did not exit after startup failure")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function readJournalRecords(directory: string): Array<Record<string, unknown>> {
  return readdirSync(directory)
    .filter((name) => name.endsWith(".ndjson"))
    .sort()
    .flatMap((name) => readFileSync(join(directory, name), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>));
}
