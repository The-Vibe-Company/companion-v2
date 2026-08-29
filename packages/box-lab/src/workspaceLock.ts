import { randomBytes } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  hostBoxLabProcessIdentity,
  type BoxLabProcessIdentity,
} from "./processIdentity";

type BoxLabWorkspaceLeaseKind = "activity" | "reset";

interface LiveLease {
  kind: BoxLabWorkspaceLeaseKind;
  path: string;
}

export interface BoxLabWorkspaceLease {
  release(): Promise<void>;
}

export class BoxLabWorkspaceLockError extends Error {
  readonly code: "box_lab_workspace_active" | "box_lab_workspace_resetting";

  constructor(code: BoxLabWorkspaceLockError["code"], message: string) {
    super(message);
    this.name = "BoxLabWorkspaceLockError";
    this.code = code;
  }
}

const CURRENT_LEASE_NAME =
  /^(activity|reset)-v2-([1-9][0-9]*)-([a-f0-9]{32})-([a-f0-9]{32})\.lease$/;
const LEGACY_LEASE_NAME = /^(activity|reset)-([1-9][0-9]*)-([a-f0-9]{32})\.lease$/;

interface ParsedLease {
  kind: BoxLabWorkspaceLeaseKind;
  nonce: string | null;
  pid: number;
}

export function boxLabWorkspaceLockDirectory(stateDirectory: string): string {
  // Keep the lock beside the state directory: reset deletes stateDirectory while its own lease
  // must remain visible until provider cleanup and filesystem cleanup have both completed.
  return `${resolve(stateDirectory)}.lock`;
}

function parsedLease(name: string): ParsedLease | undefined {
  const current = CURRENT_LEASE_NAME.exec(name);
  if (current) {
    const kind = current[1];
    const pid = current[2];
    const nonce = current[3];
    if ((kind === "activity" || kind === "reset") && pid !== undefined && nonce !== undefined) {
      return { kind, nonce, pid: Number(pid) };
    }
  }
  const legacy = LEGACY_LEASE_NAME.exec(name);
  if (!legacy) return undefined;
  const kind = legacy[1];
  const pid = legacy[2];
  if ((kind !== "activity" && kind !== "reset") || pid === undefined) return undefined;
  return { kind, nonce: null, pid: Number(pid) };
}

async function removeLease(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function liveLeases(
  lockDirectory: string,
  processIdentity: BoxLabProcessIdentity,
): Promise<LiveLease[]> {
  let names: string[];
  try {
    names = await readdir(lockDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const live: LiveLease[] = [];
  for (const name of names) {
    const lease = parsedLease(name);
    if (!lease) continue;
    const path = resolve(lockDirectory, name);
    const observation = await processIdentity.observe(lease.pid);
    const staleCurrentLease = lease.nonce !== null
      && observation.state === "live"
      && observation.nonce !== lease.nonce;
    if (observation.state === "dead" || staleCurrentLease) {
      // Lease names are unique and never reused, so removing one dead owner's exact path cannot
      // unlink a successor's lease even when several cleanup attempts run concurrently.
      await removeLease(path);
      continue;
    }
    // Legacy leases have no process-session identity. A live or unknown PID must therefore block.
    // Unknown observations for current leases also block so reset fails closed on host errors.
    live.push({ kind: lease.kind, path });
  }
  return live;
}

async function createLease(
  stateDirectory: string,
  kind: BoxLabWorkspaceLeaseKind,
  processIdentity: BoxLabProcessIdentity,
): Promise<BoxLabWorkspaceLease & { path: string }> {
  await processIdentity.prepare();
  const lockDirectory = boxLabWorkspaceLockDirectory(stateDirectory);
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString("hex");
  const path = resolve(
    lockDirectory,
    `${kind}-v2-${processIdentity.pid}-${processIdentity.nonce}-${token}.lease`,
  );
  await writeFile(path, `${processIdentity.pid} ${processIdentity.nonce}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  let released = false;
  return {
    path,
    async release(): Promise<void> {
      if (released) return;
      released = true;
      await removeLease(path);
    },
  };
}

export async function acquireBoxLabActivityLease(
  stateDirectory: string,
  processIdentity: BoxLabProcessIdentity = hostBoxLabProcessIdentity,
): Promise<BoxLabWorkspaceLease> {
  await processIdentity.prepare();
  const lockDirectory = boxLabWorkspaceLockDirectory(stateDirectory);
  const resettingBeforeRegistration = (await liveLeases(lockDirectory, processIdentity))
    .some((lease) => lease.kind === "reset");
  if (resettingBeforeRegistration) {
    throw new BoxLabWorkspaceLockError(
      "box_lab_workspace_resetting",
      "Box Lab workspace reset is active; retry this command after reset completes",
    );
  }

  const lease = await createLease(stateDirectory, "activity", processIdentity);
  let resettingAfterRegistration: boolean;
  try {
    resettingAfterRegistration = (await liveLeases(lockDirectory, processIdentity))
      .some((candidate) => candidate.kind === "reset");
  } catch (error) {
    await lease.release();
    throw error;
  }
  if (resettingAfterRegistration) {
    await lease.release();
    throw new BoxLabWorkspaceLockError(
      "box_lab_workspace_resetting",
      "Box Lab workspace reset is active; retry this command after reset completes",
    );
  }
  return lease;
}

export async function acquireBoxLabResetLease(
  stateDirectory: string,
  processIdentity: BoxLabProcessIdentity = hostBoxLabProcessIdentity,
): Promise<BoxLabWorkspaceLease> {
  await processIdentity.prepare();
  const lockDirectory = boxLabWorkspaceLockDirectory(stateDirectory);
  const lease = await createLease(stateDirectory, "reset", processIdentity);
  let leases: LiveLease[];
  try {
    leases = await liveLeases(lockDirectory, processIdentity);
  } catch (error) {
    await lease.release();
    throw error;
  }
  const conflictingActivity = leases.some((candidate) => candidate.kind === "activity");
  const conflictingReset = leases.some(
    (candidate) => candidate.kind === "reset" && candidate.path !== lease.path,
  );
  if (conflictingActivity || conflictingReset) {
    await lease.release();
    throw new BoxLabWorkspaceLockError(
      "box_lab_workspace_active",
      "Box Lab workspace is active; stop its dev, smoke, or shell command before reset",
    );
  }
  return lease;
}
