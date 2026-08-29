import type { BoxLabWorkspaceLease } from "./workspaceLock";

export interface BoxLabLeasedActivity<Result> {
  lease: BoxLabWorkspaceLease;
  run(): Promise<Result>;
  drain(): Promise<void>;
}

export async function runBoxLabLeasedActivity<Result>(
  activity: BoxLabLeasedActivity<Result>,
): Promise<Result> {
  try {
    return await activity.run();
  } finally {
    // Intentionally sequential and fail-closed: a drain failure skips release, so a concurrent
    // reset still sees this process as the live owner until the failed CLI process exits.
    await activity.drain();
    await activity.lease.release();
  }
}
