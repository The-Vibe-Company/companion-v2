import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  COMPANION_PI_BROKER_MAX_LINE_BYTES,
  CompanionPiBroker,
  SegmentedCompanionPiJournal,
  StrictLfJsonlDecoder,
  startCompanionPiBrokerSocket,
  type CompanionPiRpcTransport,
  type PiJsonObject,
} from "./companionPiBrokerCore";

const root = requiredAbsolutePath("COMPANION_PI_ROOT");
const piBin = requiredAbsolutePath("COMPANION_PI_BIN");
const invocationId = requiredOpaqueId(
  process.env.COMPANION_PI_INVOCATION_ID ?? process.env.INVOCATION_ID,
  "COMPANION_PI_INVOCATION_ID",
);
const socketPath = optionalAbsolutePath("COMPANION_PI_SOCKET_PATH")
  ?? join(root, "state", "pi-broker.sock");
const journalPath = optionalAbsolutePath("COMPANION_PI_JOURNAL_PATH")
  ?? join(root, "events");
const maxLineBytes = optionalPositiveInteger("COMPANION_PI_MAX_LINE_BYTES")
  ?? COMPANION_PI_BROKER_MAX_LINE_BYTES;
const segmentBytes = optionalPositiveInteger("COMPANION_PI_SEGMENT_BYTES");
const rpcTimeoutMs = optionalPositiveInteger("COMPANION_PI_RPC_TIMEOUT_MS") ?? 8_000;

class SpawnedPiTransport implements CompanionPiRpcTransport {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pending = new Map<string, {
    command: string;
    timeout: NodeJS.Timeout;
    resolve: (record: PiJsonObject) => void;
    reject: (error: Error) => void;
  }>();
  #onEvent: (record: PiJsonObject) => void = () => undefined;
  #onExit: (exit: { code: number | null; signal: string | null }) => void = () => undefined;
  #onFault: (fault: "malformed" | "oversized" | "unterminated") => void = () => undefined;
  #lastExit: { code: number | null; signal: string | null } | null = null;
  readonly ready: Promise<void>;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;

  constructor() {
    const decoder = new StrictLfJsonlDecoder({
      maxLineBytes,
      onRecord: (record) => this.#acceptRecord(record),
      onFault: (fault) => this.#onFault(fault),
    });
    this.#child = spawn(piBin, piArguments(root), {
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Drain but never retain/log raw Pi stderr: it may contain provider diagnostics or secrets.
    this.#child.stderr.resume();
    this.#child.stdout.on("data", (chunk: Buffer) => decoder.push(chunk));
    this.#child.stdout.on("end", () => decoder.finish());
    this.#child.stdin.on("error", () => this.#rejectPending());
    this.#child.on("error", () => this.#rejectPending());
    this.exited = new Promise((resolveExit) => {
      this.#child.once("close", (code, signal) => {
        const exit = { code, signal };
        this.#lastExit = exit;
        this.#rejectPending();
        this.#onExit(exit);
        resolveExit(exit);
      });
    });
    this.ready = new Promise<void>((resolveReady, rejectReady) => {
      const onSpawn = (): void => {
        this.#child.off("error", onError);
        resolveReady();
      };
      const onError = (): void => {
        this.#child.off("spawn", onSpawn);
        rejectReady(new Error("Pi process could not start"));
      };
      this.#child.once("spawn", onSpawn);
      this.#child.once("error", onError);
    });
  }

  bind(input: {
    onEvent(record: PiJsonObject): void;
    onExit(exit: { code: number | null; signal: string | null }): void;
    onFault(fault: "malformed" | "oversized" | "unterminated"): void;
  }): void {
    this.#onEvent = input.onEvent;
    this.#onExit = input.onExit;
    this.#onFault = input.onFault;
    if (this.#lastExit) this.#onExit(this.#lastExit);
  }

  request(command: PiJsonObject): Promise<PiJsonObject> {
    const id = typeof command.id === "string" ? command.id : "";
    const commandName = typeof command.type === "string" ? command.type : "invalid";
    if (!id || this.#pending.has(id)) return Promise.reject(new Error("Pi command id is invalid"));
    return new Promise((resolveResponse, rejectResponse) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectResponse(new Error("Pi response deadline elapsed"));
      }, rpcTimeoutMs);
      this.#pending.set(id, {
        command: commandName,
        timeout,
        resolve: resolveResponse,
        reject: rejectResponse,
      });
      this.#write(command).catch(() => {
        const pending = this.#pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(id);
        pending.reject(new Error("Pi command write failed"));
      });
    });
  }

  send(command: PiJsonObject): Promise<void> {
    return this.#write(command);
  }

  stop(): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) this.#child.kill("SIGTERM");
  }

  async terminate(): Promise<void> {
    this.stop();
    let timeout: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.exited.then(() => true),
      new Promise<boolean>((resolveTimeout) => {
        timeout = setTimeout(() => resolveTimeout(false), 2_000);
      }),
    ]);
    if (timeout) clearTimeout(timeout);
    if (!exited && this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      await this.exited;
    }
  }

  #write(command: PiJsonObject): Promise<void> {
    return new Promise((resolveWrite, rejectWrite) => {
      this.#child.stdin.write(`${JSON.stringify(command)}\n`, "utf8", (error) => {
        if (error) rejectWrite(new Error("Pi command write failed"));
        else resolveWrite();
      });
    });
  }

  #acceptRecord(record: PiJsonObject): void {
    if (record.type !== "response" || typeof record.id !== "string") {
      this.#onEvent(record);
      return;
    }
    const pending = this.#pending.get(record.id);
    if (!pending || record.command !== pending.command) {
      this.#onEvent(record);
      return;
    }
    clearTimeout(pending.timeout);
    this.#pending.delete(record.id);
    pending.resolve(record);
  }

  #rejectPending(): void {
    for (const [id, pending] of this.#pending) {
      clearTimeout(pending.timeout);
      this.#pending.delete(id);
      pending.reject(new Error("Pi process is unavailable"));
    }
  }
}

async function main(): Promise<void> {
  const journal = new SegmentedCompanionPiJournal({
    directory: journalPath,
    ...(segmentBytes === undefined ? {} : { segmentBytes }),
  });
  const transport = new SpawnedPiTransport();
  const broker = new CompanionPiBroker({
    invocationId,
    transport,
    journal,
  });
  transport.bind({
    onEvent(record) {
      if (record.type === "response") {
        journal.recordFault("orphanResponses");
        return;
      }
      broker.acceptPiRecord(record);
    },
    onExit: (exit) => broker.acceptPiProcessExit(exit),
    onFault(fault) {
      journal.recordFault(
        fault === "malformed"
          ? "malformedLines"
          : fault === "oversized"
            ? "oversizedLines"
            : "unterminatedLines",
      );
    },
  });
  let server;
  try {
    await transport.ready;
    server = await startCompanionPiBrokerSocket({ broker, socketPath });
  } catch (error) {
    // A spawned Pi and its pipes would otherwise keep this failed systemd invocation alive forever.
    await transport.terminate();
    throw error;
  }
  let stopping = false;
  const removeSocket = (): void => {
    try {
      rmSync(socketPath, { force: true });
    } catch {
      // systemd will replace an owned stale socket on the next invocation.
    }
  };
  const stop = (): void => {
    stopping = true;
    server.close();
    void transport.terminate();
    removeSocket();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  void transport.exited.then(() => {
    removeSocket();
    if (stopping) return;
    server.close();
    // A broker without its Pi child must fail so systemd restarts the whole control boundary.
    process.exitCode = 1;
  });
}

function piArguments(runtimeRoot: string): string[] {
  // Without --continue, Pi's own CLI always starts a brand-new session (SessionManager.create),
  // even when one already exists in --session-dir. Every broker start -- including a routine
  // Pi-only restart that never recreates the Box -- must resume the Companion's single ongoing
  // conversation instead of silently discarding it. --continue safely falls back to a fresh
  // session when the directory has none yet, so this is correct on a Companion's very first start
  // too.
  const args = [
    "--mode", "rpc", "--session-dir", join(runtimeRoot, "sessions"), "--continue",
  ];
  const model = readOptionalText(join(runtimeRoot, "state", "model.txt"));
  if (model) args.push("--model", model);
  args.push("--no-skills");
  const skills = join(runtimeRoot, "skills");
  if (containsSkillFile(skills)) args.push("--skill", skills);
  const instructions = readOptionalText(join(runtimeRoot, "state", "instructions.txt"));
  if (instructions) args.push("--append-system-prompt", instructions);
  return args;
}

function containsSkillFile(directory: string): boolean {
  if (!existsSync(directory)) return false;
  const pending = [directory];
  while (pending.length > 0) {
    const current = pending.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isFile() && entry.name === "SKILL.md") return true;
      if (entry.isDirectory()) pending.push(join(current, entry.name));
    }
  }
  return false;
}

function readOptionalText(path: string): string | null {
  if (!existsSync(path)) return null;
  const value = readFileSync(path, "utf8").trim();
  return value || null;
}

function requiredAbsolutePath(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  const absolute = resolve(value);
  if (absolute !== value) throw new Error(`${name} must be absolute`);
  return absolute;
}

function optionalAbsolutePath(name: string): string | null {
  const value = process.env[name]?.trim();
  if (!value) return null;
  const absolute = resolve(value);
  if (absolute !== value) throw new Error(`${name} must be absolute`);
  return absolute;
}

function requiredOpaqueId(value: string | undefined, name: string): string {
  if (!value || value.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function optionalPositiveInteger(name: string): number | undefined {
  const text = process.env[name]?.trim();
  if (!text) return undefined;
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} is invalid`);
  return value;
}

void main().catch(() => {
  // Startup diagnostics are intentionally stable and value-free. No provider/Pi payload is logged.
  process.stderr.write("companion-pi-broker: startup failed\n");
  process.exitCode = 1;
});
