import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

import { SpawnProcessRunner, type ProcessRunner } from "./process";

const BOX_LAB_PROCESS_TITLE_PREFIX = "@companion/box-lab:";
const BOX_LAB_PROCESS_NONCE = /^[a-f0-9]{32}$/;
const BEACON_ARGS = ["-e", "process.stdin.resume()"] as const;
const PS_EXECUTABLE = "/bin/ps";
const PS_TIMEOUT_MS = 2_000;
const PS_OUTPUT_LIMIT_BYTES = 1_024;

type ProcessExistence = "live" | "dead" | "unknown";

export type BoxLabProcessObservation =
  | { state: "dead" }
  | { state: "live"; nonce: string | null }
  | { state: "unknown" };

export interface BoxLabPreparedProcessIdentity {
  readonly ownerPid: number;
  readonly beaconPid: number;
  readonly nonce: string;
}

export interface BoxLabProcessBeacon {
  readonly pid: number;
  close(): void;
  healthy(): boolean;
}

export interface BoxLabProcessIdentity {
  readonly ownerPid: number;
  readonly nonce: string;
  prepare(): Promise<BoxLabPreparedProcessIdentity>;
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
  ownerPid: number;
  nonce: string;
  runner: ProcessRunner;
  startBeacon(title: string): Promise<BoxLabProcessBeacon>;
  processExistence(pid: number): ProcessExistence;
}

interface UnrefableBeaconInput {
  unref(): void;
}

function identityError(): BoxLabProcessIdentityError {
  return new BoxLabProcessIdentityError();
}

function expectedBeaconCommand(title: string): string {
  return `${title} ${BEACON_ARGS.join(" ")}`;
}

export async function startBoxLabProcessBeacon(title: string): Promise<BoxLabProcessBeacon> {
  let child;
  try {
    child = spawn(process.execPath, [...BEACON_ARGS], {
      argv0: title,
      detached: true,
      env: {},
      shell: false,
      stdio: ["pipe", "ignore", "ignore"],
    });
  } catch {
    throw identityError();
  }

  const stdin = child.stdin;
  let state: "starting" | "live" | "closing" | "failed" = "starting";
  let settled = false;

  const stopChild = (): void => {
    stdin?.destroy();
    try {
      child.kill("SIGTERM");
    } catch {
      // A process that already exited needs no further cleanup.
    }
  };

  return await new Promise<BoxLabProcessBeacon>((resolvePromise, rejectPromise) => {
    const fail = (): void => {
      if (state === "closing" || state === "failed") return;
      state = "failed";
      stopChild();
      if (!settled) {
        settled = true;
        rejectPromise(identityError());
      }
    };

    // These handlers must exist before the child or its pipe is otherwise used. They remain
    // installed after startup so an unexpected beacon failure invalidates future lease attempts.
    child.on("error", fail);
    child.once("exit", fail);
    stdin?.on("error", fail);
    child.once("spawn", () => {
      if (state !== "starting") return;
      const pid = child.pid;
      if (stdin === null || pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
        fail();
        return;
      }
      try {
        child.unref();
        // SAFETY: Node creates child stdin as a libuv Pipe when stdio[0] is exactly "pipe".
        const beaconInput = stdin as typeof stdin & UnrefableBeaconInput;
        beaconInput.unref();
      } catch {
        fail();
        return;
      }

      state = "live";
      settled = true;
      resolvePromise({
        pid,
        close(): void {
          if (state === "closing") return;
          state = "closing";
          stopChild();
        },
        healthy(): boolean {
          return state === "live";
        },
      });
    });
  });
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
  const titleEnd = command.indexOf(" ");
  if (titleEnd < 0) return undefined;
  const nonce = command.slice(prefix.length, titleEnd);
  const title = command.slice(0, titleEnd);
  if (!BOX_LAB_PROCESS_NONCE.test(nonce)) return undefined;
  return command === expectedBeaconCommand(title) ? nonce : undefined;
}

export function createBoxLabProcessIdentity(
  options: BoxLabProcessIdentityOptions,
): BoxLabProcessIdentity {
  if (!Number.isSafeInteger(options.ownerPid) || options.ownerPid <= 0) {
    throw new Error("Box Lab process identity requires a positive integer owner pid");
  }
  if (!BOX_LAB_PROCESS_NONCE.test(options.nonce)) {
    throw new Error("Box Lab process identity requires a 128-bit lowercase hex nonce");
  }

  const title = `${BOX_LAB_PROCESS_TITLE_PREFIX}${options.nonce}`;
  let beacon: BoxLabProcessBeacon | undefined;
  let preparation: Promise<BoxLabPreparedProcessIdentity> | undefined;

  const identity: BoxLabProcessIdentity = {
    ownerPid: options.ownerPid,
    nonce: options.nonce,
    async prepare(): Promise<BoxLabPreparedProcessIdentity> {
      preparation ??= (async () => {
        try {
          beacon = await options.startBeacon(title);
          const observation = await identity.observe(beacon.pid);
          if (!beacon.healthy() || observation.state !== "live"
            || observation.nonce !== options.nonce) {
            throw identityError();
          }
          return {
            ownerPid: options.ownerPid,
            beaconPid: beacon.pid,
            nonce: options.nonce,
          };
        } catch {
          beacon?.close();
          throw identityError();
        }
      })();
      const prepared = await preparation;
      if (!beacon?.healthy()) {
        beacon?.close();
        throw identityError();
      }
      return prepared;
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
// in the beacon argv and private workspace lease names.
const processSessionNonce = randomBytes(16).toString("hex");

export const hostBoxLabProcessIdentity = createBoxLabProcessIdentity({
  ownerPid: process.pid,
  nonce: processSessionNonce,
  runner: new SpawnProcessRunner(),
  startBeacon: startBoxLabProcessBeacon,
  processExistence: hostProcessExistence,
});
