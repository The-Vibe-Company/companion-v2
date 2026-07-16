import { deleteExpiredRunArtifact, listExpiredRunArtifacts } from "@companion/core/services";
import { deleteSkillArchive, headSkillArchive } from "@companion/storage";

const DEFAULT_INCOMPLETE_GRACE_MS = 60 * 60 * 1_000;
const DEFAULT_DELETE_TIMEOUT_MS = 30_000;

export interface RunArtifactSweepResult {
  deleted: number;
  retained: number;
  failed: number;
}

async function withStorageDeadline<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("artifact storage operation timed out");
      abort.abort(error);
      reject(error);
    }, Math.max(1, timeoutMs));
  });
  try {
    return await Promise.race([operation(abort.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Idempotently remove expired ready objects and abandoned reservation uploads. */
export async function sweepRunArtifacts(input: {
  now?: Date;
  incompleteGraceMs?: number;
  limit?: number;
  deleteTimeoutMs?: number;
  list?: typeof listExpiredRunArtifacts;
  deleteExpired?: typeof deleteExpiredRunArtifact;
  headObject?: (key: string, signal: AbortSignal) => Promise<{ etag: string } | null>;
  deleteObject?: (key: string, ifMatch: string, signal: AbortSignal) => Promise<void>;
} = {}): Promise<RunArtifactSweepResult> {
  const now = input.now ?? new Date();
  const staleBefore = new Date(now.getTime() - (input.incompleteGraceMs ?? DEFAULT_INCOMPLETE_GRACE_MS));
  const list = input.list ?? listExpiredRunArtifacts;
  const deleteExpired = input.deleteExpired ?? deleteExpiredRunArtifact;
  const headObject = input.headObject ?? ((key, signal) => headSkillArchive({ key, signal }));
  const deleteObject = input.deleteObject
    ?? ((key, ifMatch, signal) => deleteSkillArchive({ key, ifMatch, signal }));
  const deleteTimeoutMs = input.deleteTimeoutMs ?? DEFAULT_DELETE_TIMEOUT_MS;
  const candidates = await list({ staleBefore, limit: input.limit ?? 250 });
  const result: RunArtifactSweepResult = { deleted: 0, retained: 0, failed: 0 };
  for (const artifact of candidates) {
    try {
      // Observe the current object version before taking the database row lock. A conditional
      // DELETE that finishes after timeout can delete only these old bytes, never a replacement.
      const object = await withStorageDeadline(deleteTimeoutMs, (signal) =>
        headObject(artifact.storageKey, signal));
      const deleted = await deleteExpired({
        artifact,
        staleBefore,
        deleteObject: async () => {
          if (!object) return;
          await withStorageDeadline(deleteTimeoutMs, (signal) =>
            deleteObject(artifact.storageKey, object.etag, signal));
        },
      });
      if (deleted) result.deleted += 1;
      else result.retained += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
