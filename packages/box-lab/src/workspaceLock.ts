import { randomBytes } from "node:crypto";
import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

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

const LEASE_NAME = /^(activity|reset)-([1-9][0-9]*)-([a-f0-9]{32})\.lease$/;

export function boxLabWorkspaceLockDirectory(stateDirectory: string): string {
  // Keep the lock beside the state directory: reset deletes stateDirectory while its own lease
  // must remain visible until provider cleanup and filesystem cleanup have both completed.
  return `${resolve(stateDirectory)}.lock`;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    // EPERM means the process exists but is owned by another user. Any unfamiliar failure is also
    // treated as live so reset fails closed instead of deleting a potentially active workspace.
    return true;
  }
}

async function removeLease(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function liveLeases(lockDirectory: string): Promise<LiveLease[]> {
  let names: string[];
  try {
    names = await readdir(lockDirectory);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }

  const live: LiveLease[] = [];
  for (const name of names) {
    const match = LEASE_NAME.exec(name);
    if (!match) continue;
    const kind = match[1];
    if (kind !== "activity" && kind !== "reset") continue;
    const path = resolve(lockDirectory, name);
    const pid = Number(match[2]);
    if (!processIsAlive(pid)) {
      // Lease names are unique and never reused, so removing one dead owner's exact path cannot
      // unlink a successor's lease even when several cleanup attempts run concurrently.
      await removeLease(path);
      continue;
    }
    live.push({ kind, path });
  }
  return live;
}

async function createLease(
  stateDirectory: string,
  kind: BoxLabWorkspaceLeaseKind,
): Promise<BoxLabWorkspaceLease & { path: string }> {
  const lockDirectory = boxLabWorkspaceLockDirectory(stateDirectory);
  await mkdir(lockDirectory, { recursive: true, mode: 0o700 });
  const token = randomBytes(16).toString("hex");
  const path = resolve(lockDirectory, `${kind}-${process.pid}-${token}.lease`);
  await writeFile(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
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
): Promise<BoxLabWorkspaceLease> {
  const lockDirectory = boxLabWorkspaceLockDirectory(stateDirectory);
  const resettingBeforeRegistration = (await liveLeases(lockDirectory))
    .some((lease) => lease.kind === "reset");
  if (resettingBeforeRegistration) {
    throw new BoxLabWorkspaceLockError(
      "box_lab_workspace_resetting",
      "Box Lab workspace reset is active; retry this command after reset completes",
    );
  }

  const lease = await createLease(stateDirectory, "activity");
  let resettingAfterRegistration: boolean;
  try {
    resettingAfterRegistration = (await liveLeases(lockDirectory))
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
): Promise<BoxLabWorkspaceLease> {
  const lockDirectory = boxLabWorkspaceLockDirectory(stateDirectory);
  const lease = await createLease(stateDirectory, "reset");
  let leases: LiveLease[];
  try {
    leases = await liveLeases(lockDirectory);
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
