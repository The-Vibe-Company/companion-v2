import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { StringDecoder } from "node:string_decoder";

import type {
  BoxSimPiController,
  BoxSimPiControllerContext,
  BoxSimPiControllerFactory,
} from "./protocol";
import { parsePiScenarioName, type PiScenarioName } from "./scenarios";

const DEFAULT_RPC_TIMEOUT_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 2_000;
const MAX_CAPTURED_STDERR_BYTES = 16 * 1024;
const DEFAULT_PROCESS_PATH = fileURLToPath(new URL("./pi-process.mjs", import.meta.url));

interface PendingRpc {
  readonly command: string;
  readonly correlationKey: string | null;
  readonly resolve: (response: Record<string, unknown>) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
}

interface JsonlReaderState {
  readonly decoder: StringDecoder;
  buffer: string;
}

export interface PiProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface PiProcessControllerOptions {
  scenario?: PiScenarioName;
  processPath?: string;
  rpcTimeoutMs?: number;
  stopTimeoutMs?: number;
  /** Test-only override used by the bounded oversized-record scenario. */
  oversizedBytes?: number;
  onStderr?: (chunk: string) => void;
}

/**
 * Controls a real child process that speaks Pi's LF-delimited RPC protocol.
 *
 * Responses are returned to the command shim so it can append the exact acknowledgement once.
 * Every other stdout record is forwarded through `appendEvent`, including unknown records and raw
 * malformed lines. This mirrors the production split between correlated FIFO acknowledgements and
 * the append-only Pi event log without teaching the simulator to silently discard new event types.
 */
export class PiProcessController implements BoxSimPiController {
  readonly #context: BoxSimPiControllerContext;
  readonly #processPath: string;
  readonly #rpcTimeoutMs: number;
  readonly #stopTimeoutMs: number;
  readonly #oversizedBytes: number | undefined;
  readonly #onStderr: ((chunk: string) => void) | undefined;

  #scenario: PiScenarioName;
  #child: ChildProcessWithoutNullStreams | null = null;
  #startPromise: Promise<void> | null = null;
  #exitPromise: Promise<PiProcessExit> | null = null;
  #lastExit: PiProcessExit | null = null;
  #generation = 0;
  #disposed = false;
  #stderr = "";
  readonly #pendingById = new Map<string, PendingRpc>();
  readonly #pendingWithoutId: PendingRpc[] = [];

  constructor(context: BoxSimPiControllerContext, options: PiProcessControllerOptions = {}) {
    this.#context = context;
    this.#scenario = parsePiScenarioName(options.scenario);
    this.#processPath = options.processPath ?? DEFAULT_PROCESS_PATH;
    this.#rpcTimeoutMs = positiveDuration(options.rpcTimeoutMs, DEFAULT_RPC_TIMEOUT_MS, "rpcTimeoutMs");
    this.#stopTimeoutMs = positiveDuration(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, "stopTimeoutMs");
    if (options.oversizedBytes !== undefined && (!Number.isFinite(options.oversizedBytes) || options.oversizedBytes <= 0)) {
      throw new Error("oversizedBytes must be a positive number");
    }
    this.#oversizedBytes = options.oversizedBytes === undefined
      ? undefined
      : Math.trunc(options.oversizedBytes);
    this.#onStderr = options.onStderr;
  }

  get scenario(): PiScenarioName {
    return this.#scenario;
  }

  get running(): boolean {
    return this.#child !== null && this.#child.exitCode === null && this.#child.signalCode === null;
  }

  get pid(): number | undefined {
    return this.#child?.pid;
  }

  /** Bounded diagnostics from the deterministic child; never populated from a host shell. */
  get stderr(): string {
    return this.#stderr;
  }

  get lastExit(): PiProcessExit | null {
    return this.#lastExit;
  }

  async start(): Promise<void> {
    this.#assertUsable();
    if (this.running) return;
    if (this.#startPromise) return this.#startPromise;

    const startPromise = this.#startAfterPreviousExit();
    this.#startPromise = startPromise;
    try {
      await startPromise;
    } finally {
      if (this.#startPromise === startPromise) this.#startPromise = null;
    }
  }

  async #startAfterPreviousExit(): Promise<void> {
    // `exitCode` is observable before Node emits `close`. Do not replace #child during that window:
    // the old close handler still owns rejection of its in-flight RPCs and cleanup of its pipes.
    const previousExit = this.#exitPromise;
    if (previousExit) await previousExit;
    this.#assertUsable();
    if (this.running) return;
    await this.#spawn();
  }

  async restart(): Promise<void> {
    this.#assertUsable();
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    const child = this.#child;
    const exitPromise = this.#exitPromise;
    if (!child || !exitPromise) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      await exitPromise;
      return;
    }

    child.kill("SIGTERM");
    const stopped = await waitWithTimeout(exitPromise, this.#stopTimeoutMs);
    if (stopped) return;

    child.kill("SIGKILL");
    await exitPromise;
  }

  handleRpc(command: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#assertUsable();
    const child = this.#requireRunningChild();
    const commandName = typeof command.type === "string" ? command.type : "unknown";
    const hasId = Object.hasOwn(command, "id");
    const correlationKey = hasId ? correlationKeyFor(command.id) : null;
    if (hasId && correlationKey === null) {
      throw new Error("Pi RPC command id must be a string or finite number");
    }
    if (correlationKey !== null && this.#pendingById.has(correlationKey)) {
      throw new Error(`Pi RPC command id is already pending: ${String(command.id)}`);
    }

    const line = serializeRecord(command, "Pi RPC command");
    let pending!: PendingRpc;
    const response = new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#removePending(pending);
        reject(new Error(`Pi RPC ${commandName} response timed out after ${this.#rpcTimeoutMs}ms`));
      }, this.#rpcTimeoutMs);
      pending = { command: commandName, correlationKey, resolve, reject, timeout };
    });

    this.#addPending(pending);
    child.stdin.write(`${line}\n`, "utf8", (error) => {
      if (!error) return;
      this.#rejectPending(pending, new Error(`Could not write Pi RPC ${commandName}: ${error.message}`));
    });
    return response;
  }

  async respondExtensionUi(response: Record<string, unknown>): Promise<void> {
    this.#assertUsable();
    const child = this.#requireRunningChild();
    if (response.type !== "extension_ui_response") {
      throw new Error("Pi extension UI response must have type extension_ui_response");
    }
    const line = serializeRecord(response, "Pi extension UI response");
    await writeLine(child, line);
  }

  async crash(): Promise<void> {
    const child = this.#child;
    const exitPromise = this.#exitPromise;
    if (!child || !exitPromise) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exitPromise;
  }

  async setScenario(name: string): Promise<void> {
    this.#assertUsable();
    const next = parsePiScenarioName(name);
    if (next === this.#scenario) return;
    const shouldRestart = this.running;
    this.#scenario = next;
    if (shouldRestart) await this.restart();
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    await this.stop();
    this.#disposed = true;
    this.#rejectAllPending(new Error("Pi simulator controller was disposed"));
  }

  waitForExit(): Promise<PiProcessExit> {
    if (this.#exitPromise) return this.#exitPromise;
    if (this.#lastExit) return Promise.resolve(this.#lastExit);
    return Promise.reject(new Error("Pi simulator process has not been started"));
  }

  async #spawn(): Promise<void> {
    const generation = ++this.#generation;
    const invocationId = this.#context.currentInvocationId();
    const reader: JsonlReaderState = { decoder: new StringDecoder("utf8"), buffer: "" };
    const environment: NodeJS.ProcessEnv = { PI_SIM_SCENARIO: this.#scenario };
    if (this.#oversizedBytes !== undefined) {
      environment.PI_SIM_OVERSIZED_BYTES = String(this.#oversizedBytes);
    }

    const child = spawn(process.execPath, [this.#processPath, "--scenario", this.#scenario], {
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child = child;
    this.#lastExit = null;

    child.stdout.on("data", (chunk: Buffer) => {
      this.#consumeStdout(reader, chunk, generation, invocationId);
    });
    child.stdout.on("end", () => {
      reader.buffer += reader.decoder.end();
      if (reader.buffer.length > 0) {
        this.#forwardFault("unterminated", generation, invocationId);
      }
      reader.buffer = "";
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      this.#stderr = `${this.#stderr}${text}`.slice(-MAX_CAPTURED_STDERR_BYTES);
      this.#onStderr?.(text);
    });
    child.stdin.on("error", (error: Error) => {
      this.#rejectAllPending(new Error(`Pi simulator stdin failed: ${error.message}`));
    });
    child.on("error", (error: Error) => {
      this.#rejectAllPending(new Error(`Pi simulator process failed: ${error.message}`));
    });

    const exitPromise = new Promise<PiProcessExit>((resolve) => {
      child.once("close", (code, signal) => {
        const exit = { code, signal };
        this.#lastExit = exit;
        if (this.#child === child) {
          this.#child = null;
          this.#exitPromise = null;
          this.#rejectAllPending(new Error(exitDescription(exit)));
        }
        resolve(exit);
      });
    });
    this.#exitPromise = exitPromise;

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve();
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        if (this.#child === child) this.#child = null;
        reject(new Error(`Could not start Pi simulator process: ${error.message}`));
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }

  #consumeStdout(
    reader: JsonlReaderState,
    chunk: Buffer,
    generation: number,
    invocationId: string | null,
  ): void {
    reader.buffer += reader.decoder.write(chunk);
    while (true) {
      const newline = reader.buffer.indexOf("\n");
      if (newline < 0) return;
      let line = reader.buffer.slice(0, newline);
      reader.buffer = reader.buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line.length === 0) continue;
      this.#handleStdoutLine(line, generation, invocationId);
    }
  }

  #handleStdoutLine(line: string, generation: number, invocationId: string | null): void {
    let record: unknown;
    try {
      record = JSON.parse(line) as unknown;
    } catch {
      this.#forwardEvent(line, generation, invocationId);
      return;
    }

    if (!isRecord(record)) {
      this.#forwardEvent(line, generation, invocationId);
      return;
    }
    if (record.type !== "response") {
      this.#forwardEvent(record, generation, invocationId);
      return;
    }

    const pending = this.#matchingPending(record);
    if (!pending) {
      this.#forwardEvent(record, generation, invocationId);
      return;
    }
    this.#removePending(pending);
    pending.resolve(record);
  }

  #forwardEvent(
    event: Record<string, unknown> | string,
    generation: number,
    invocationId: string | null,
  ): void {
    // Command acknowledgements are appended by the command shim immediately after handleRpc
    // resolves. Deferring asynchronous events preserves the real stdout order: ACK, then events.
    setImmediate(() => {
      if (generation !== this.#generation) return;
      if (invocationId !== null && this.#context.currentInvocationId() !== invocationId) return;
      this.#context.appendEvent(event);
    });
  }

  #forwardFault(
    fault: "malformed" | "oversized" | "unterminated",
    generation: number,
    invocationId: string | null,
  ): void {
    // The fault is value-free, but still belongs only to the invocation that emitted it.
    setImmediate(() => {
      if (generation !== this.#generation) return;
      if (invocationId !== null && this.#context.currentInvocationId() !== invocationId) return;
      this.#context.appendFault(fault);
    });
  }

  #matchingPending(response: Record<string, unknown>): PendingRpc | null {
    if (Object.hasOwn(response, "id")) {
      const key = correlationKeyFor(response.id);
      return key === null ? null : this.#pendingById.get(key) ?? null;
    }

    const command = typeof response.command === "string" ? response.command : "unknown";
    return this.#pendingWithoutId.find((pending) => pending.command === command) ?? null;
  }

  #addPending(pending: PendingRpc): void {
    if (pending.correlationKey === null) this.#pendingWithoutId.push(pending);
    else this.#pendingById.set(pending.correlationKey, pending);
  }

  #removePending(pending: PendingRpc): void {
    clearTimeout(pending.timeout);
    if (pending.correlationKey !== null) {
      if (this.#pendingById.get(pending.correlationKey) === pending) {
        this.#pendingById.delete(pending.correlationKey);
      }
      return;
    }
    const index = this.#pendingWithoutId.indexOf(pending);
    if (index >= 0) this.#pendingWithoutId.splice(index, 1);
  }

  #rejectPending(pending: PendingRpc, error: Error): void {
    const isCurrent = pending.correlationKey === null
      ? this.#pendingWithoutId.includes(pending)
      : this.#pendingById.get(pending.correlationKey) === pending;
    if (!isCurrent) return;
    this.#removePending(pending);
    pending.reject(error);
  }

  #rejectAllPending(error: Error): void {
    for (const pending of [...this.#pendingById.values(), ...this.#pendingWithoutId]) {
      this.#removePending(pending);
      pending.reject(error);
    }
  }

  #requireRunningChild(): ChildProcessWithoutNullStreams {
    if (!this.running || !this.#child) throw new Error("Pi simulator process is not running");
    return this.#child;
  }

  #assertUsable(): void {
    if (this.#disposed) throw new Error("Pi simulator controller is disposed");
  }
}

export const createBoxSimPiController: BoxSimPiControllerFactory = (context) => (
  new PiProcessController(context)
);

function positiveDuration(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return Math.trunc(value);
}

function correlationKeyFor(id: unknown): string | null {
  if (typeof id === "string") return `string:${id}`;
  if (typeof id === "number" && Number.isFinite(id)) return `number:${id}`;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function serializeRecord(record: Record<string, unknown>, description: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(record);
  } catch (error) {
    throw new Error(`${description} is not JSON serializable: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (serialized === undefined) throw new Error(`${description} is not JSON serializable`);
  return serialized;
}

function writeLine(child: ChildProcessWithoutNullStreams, line: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child.stdin.write(`${line}\n`, "utf8", (error) => {
      if (error) reject(new Error(`Could not write to Pi simulator process: ${error.message}`));
      else resolve();
    });
  });
}

function exitDescription(exit: PiProcessExit): string {
  if (exit.signal) return `Pi simulator process exited from ${exit.signal}`;
  return `Pi simulator process exited with code ${exit.code ?? "unknown"}`;
}

async function waitWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    promise.then(() => true),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timeout) clearTimeout(timeout);
  return result;
}
