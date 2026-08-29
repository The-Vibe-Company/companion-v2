import { spawn, type SpawnOptions } from "node:child_process";

import { GuestCommandControlCapture } from "./guestCommand";

const DEFAULT_OUTPUT_LIMIT_BYTES = 2 * 1024 * 1024;

export interface ProcessInvocation {
  executable: string;
  args: readonly string[];
  input?: Uint8Array | string;
  timeoutMs?: number;
  outputLimitBytes?: number;
  captureGuestCommandControl?: boolean;
  stdio?: "pipe" | "inherit";
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Authentication result only; raw control frames and their challenge never leave the runner. */
  guestCommandControl?: GuestCommandControlResult;
  timedOut: boolean;
}

export interface GuestCommandControlResult {
  started: boolean;
  completedExitCode: number | null;
}

export interface ProcessRunner {
  run(invocation: ProcessInvocation): Promise<ProcessResult>;
}

export class ProcessExecutionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "ProcessExecutionError";
    this.code = code;
  }
}

function appendBounded(chunks: Buffer[], chunk: Buffer, state: { bytes: number }, limit: number): void {
  if (state.bytes >= limit) return;
  const accepted = chunk.subarray(0, Math.max(0, limit - state.bytes));
  chunks.push(accepted);
  state.bytes += accepted.byteLength;
}

function isBrokenPipe(error: Error): boolean {
  return "code" in error && error.code === "EPIPE";
}

/**
 * Host processes are always invoked directly. In particular, this runner never enables a shell:
 * Box commands remain one argument passed to the contained guest's `bash -lc` by its driver.
 */
export class SpawnProcessRunner implements ProcessRunner {
  async run(invocation: ProcessInvocation): Promise<ProcessResult> {
    if (!invocation.executable || invocation.executable.includes("\0")) {
      throw new ProcessExecutionError("invalid_executable", "Process executable is invalid");
    }
    if (invocation.args.some((argument) => argument.includes("\0"))) {
      throw new ProcessExecutionError("invalid_argument", "Process argument contains NUL");
    }
    const stdio = invocation.stdio ?? "pipe";
    if (invocation.captureGuestCommandControl === true && stdio !== "pipe") {
      throw new ProcessExecutionError(
        "invalid_control_capture",
        "Guest command control capture requires piped stderr",
      );
    }
    const spawnOptions: SpawnOptions = {
      shell: false,
      stdio: stdio === "inherit" ? "inherit" : ["pipe", "pipe", "pipe"],
    };
    if (invocation.env !== undefined) spawnOptions.env = invocation.env;
    if (invocation.cwd !== undefined) spawnOptions.cwd = invocation.cwd;
    return await new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
      let child;
      try {
        child = spawn(invocation.executable, [...invocation.args], spawnOptions);
      } catch (error) {
        rejectPromise(error);
        return;
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const controlCapture = invocation.captureGuestCommandControl === true
        ? new GuestCommandControlCapture()
        : undefined;
      const stdoutState = { bytes: 0 };
      const stderrState = { bytes: 0 };
      const limit = invocation.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES;
      let timedOut = false;
      let inputFailed = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const timeout = invocation.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
          killTimer.unref();
        }, invocation.timeoutMs);
      timeout?.unref();
      if (stdio === "pipe") {
        child.stdout?.on("data", (chunk: Buffer) => appendBounded(stdout, chunk, stdoutState, limit));
        child.stderr?.on("data", (chunk: Buffer) => {
          const visibleChunks = controlCapture?.consume(chunk) ?? [chunk];
          for (const visible of visibleChunks) appendBounded(stderr, visible, stderrState, limit);
        });
        child.stdin?.once("error", (error: Error) => {
          // The child exit remains authoritative when it deliberately closes stdin before consuming
          // a buffered payload. Without this listener, Node promotes EPIPE to an uncaught exception.
          if (isBrokenPipe(error)) return;
          inputFailed = true;
          child.kill("SIGTERM");
        });
      }
      child.once("error", (error) => {
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        rejectPromise(error);
      });
      child.once("close", (exitCode, signal) => {
        if (timeout) clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (inputFailed) {
          rejectPromise(new ProcessExecutionError(
            "process_input_failed",
            "Process input could not be written",
          ));
          return;
        }
        for (const visible of controlCapture?.finish() ?? []) {
          appendBounded(stderr, visible, stderrState, limit);
        }
        const result: ProcessResult = {
          exitCode,
          signal,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
          timedOut,
        };
        if (controlCapture !== undefined) result.guestCommandControl = controlCapture.result();
        resolvePromise(result);
      });
      if (stdio === "pipe") {
        if (invocation.input !== undefined) child.stdin?.end(invocation.input);
        else child.stdin?.end();
      }
    });
  }
}

export function successful(result: ProcessResult): boolean {
  return !result.timedOut && result.exitCode === 0;
}

export function safeProcessFailure(operation: string, result: ProcessResult): ProcessExecutionError {
  if (result.timedOut) {
    return new ProcessExecutionError("process_timeout", `${operation} timed out`);
  }
  const output = `${result.stderr}\n${result.stdout}`;
  const exit = result.exitCode === null ? "" : ` (exit ${result.exitCode})`;
  if (/(?:manifest unknown|not found|no such (?:image|file|container|instance))/i.test(output)) {
    return new ProcessExecutionError(
      "process_resource_not_found",
      `${operation} could not find a required resource${exit}`,
    );
  }
  if (/(?:permission denied|operation not permitted|access denied)/i.test(output)) {
    return new ProcessExecutionError(
      "process_permission_denied",
      `${operation} was denied by the host isolation boundary${exit}`,
    );
  }
  if (/(?:cannot connect to the docker daemon|connection refused|daemon is not running)/i.test(output)) {
    return new ProcessExecutionError(
      "process_unavailable",
      `${operation} could not reach the local virtualization service${exit}`,
    );
  }
  return new ProcessExecutionError("process_failed", `${operation} exited unsuccessfully${exit}`);
}
