import { randomBytes } from "node:crypto";

import { SpawnProcessRunner, type ProcessRunner } from "./process";

const BOX_LAB_PROCESS_TITLE_PREFIX = "@companion/box-lab:";
const BOX_LAB_PROCESS_NONCE = /^[a-f0-9]{32}$/;
const PS_EXECUTABLE = "/bin/ps";
const PS_TIMEOUT_MS = 2_000;
const PS_OUTPUT_LIMIT_BYTES = 1_024;

type ProcessExistence = "live" | "dead" | "unknown";

export type BoxLabProcessObservation =
  | { state: "dead" }
  | { state: "live"; nonce: string | null }
  | { state: "unknown" };

export interface BoxLabProcessIdentity {
  readonly pid: number;
  readonly nonce: string;
  prepare(): Promise<void>;
  observe(pid: number): Promise<BoxLabProcessObservation>;
}

export class BoxLabProcessIdentityError extends Error {
  readonly code = "box_lab_process_identity_unavailable";

  constructor() {
    super("Box Lab could not verify its host process identity; no workspace lease was created");
    this.name = "BoxLabProcessIdentityError";
  }
}

export interface BoxLabProcessIdentityOptions {
  pid: number;
  nonce: string;
  runner: ProcessRunner;
  setProcessTitle(title: string): void;
  processExistence(pid: number): ProcessExistence;
}

function parsedCommand(stdout: string): string | undefined {
  if (!stdout.endsWith("\n")) return undefined;
  const command = stdout.slice(0, -1);
  if (command.length === 0 || command.includes("\n") || command.includes("\0")) return undefined;
  return command;
}

function nonceFromCommand(command: string): string | null | undefined {
  const prefix = BOX_LAB_PROCESS_TITLE_PREFIX;
  if (!command.startsWith(prefix)) return null;
  const nonce = command.slice(prefix.length);
  return BOX_LAB_PROCESS_NONCE.test(nonce) ? nonce : undefined;
}

export function createBoxLabProcessIdentity(
  options: BoxLabProcessIdentityOptions,
): BoxLabProcessIdentity {
  if (!Number.isSafeInteger(options.pid) || options.pid <= 0) {
    throw new Error("Box Lab process identity requires a positive integer pid");
  }
  if (!BOX_LAB_PROCESS_NONCE.test(options.nonce)) {
    throw new Error("Box Lab process identity requires a 128-bit lowercase hex nonce");
  }

  const title = `${BOX_LAB_PROCESS_TITLE_PREFIX}${options.nonce}`;
  let preparation: Promise<void> | undefined;

  const identity: BoxLabProcessIdentity = {
    pid: options.pid,
    nonce: options.nonce,
    async prepare(): Promise<void> {
      preparation ??= (async () => {
        options.setProcessTitle(title);
        const observation = await identity.observe(options.pid);
        if (observation.state !== "live" || observation.nonce !== options.nonce) {
          throw new BoxLabProcessIdentityError();
        }
      })();
      await preparation;
    },
    async observe(pid: number): Promise<BoxLabProcessObservation> {
      if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
      const existence = options.processExistence(pid);
      if (existence === "dead") return { state: "dead" };
      if (existence === "unknown") return { state: "unknown" };

      let result;
      try {
        result = await options.runner.run({
          executable: PS_EXECUTABLE,
          args: ["-ww", "-o", "command=", "-p", String(pid)],
          timeoutMs: PS_TIMEOUT_MS,
          outputLimitBytes: PS_OUTPUT_LIMIT_BYTES,
          env: {
            ...process.env,
            LANG: "C",
            LC_ALL: "C",
          },
        });
      } catch {
        return { state: "unknown" };
      }

      if (result.timedOut) return { state: "unknown" };
      if (result.exitCode !== 0 || result.signal !== null || result.stderr.length > 0) {
        return options.processExistence(pid) === "dead"
          ? { state: "dead" }
          : { state: "unknown" };
      }
      const command = parsedCommand(result.stdout);
      if (command === undefined) return { state: "unknown" };
      const nonce = nonceFromCommand(command);
      return nonce === undefined ? { state: "unknown" } : { state: "live", nonce };
    },
  };
  return identity;
}

function hostProcessExistence(pid: number): ProcessExistence {
  try {
    process.kill(pid, 0);
    return "live";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return "dead";
    // EPERM proves neither ownership nor identity. Unknown host errors fail closed.
    return "unknown";
  }
}

// This nonce identifies one Node process lifetime. It is intentionally non-secret and appears only
// in the short process title and private workspace lease names.
const processSessionNonce = randomBytes(16).toString("hex");

export const hostBoxLabProcessIdentity = createBoxLabProcessIdentity({
  pid: process.pid,
  nonce: processSessionNonce,
  runner: new SpawnProcessRunner(),
  setProcessTitle(title) {
    process.title = title;
  },
  processExistence: hostProcessExistence,
});
