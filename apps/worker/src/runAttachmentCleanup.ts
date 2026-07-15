import { deleteRunAttachmentOrphanIfReserved } from "@companion/core/services";
import { deleteSkillArchive, listStoredRunAttachmentObjects } from "@companion/storage";

const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;
let sweepCursor: string | undefined;

export interface RunAttachmentSweepResult {
  deleted: number;
  retained: number;
  failed: number;
}

/**
 * Delete only old objects that remain unreferenced in a second durable read immediately before
 * deletion. Fresh/ambiguous uploads stay available for idempotent retries.
 */
export async function sweepRunAttachmentOrphans(input: {
  now?: Date;
  graceMs?: number;
  limit?: number;
  listObjects?: typeof listStoredRunAttachmentObjects;
  deleteIfReserved?: typeof deleteRunAttachmentOrphanIfReserved;
  deleteObject?: (key: string) => Promise<void>;
} = {}): Promise<RunAttachmentSweepResult> {
  const now = input.now ?? new Date();
  const graceMs = input.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const limit = input.limit ?? 250;
  const listObjects = input.listObjects ?? listStoredRunAttachmentObjects;
  const deleteIfReserved = input.deleteIfReserved ?? deleteRunAttachmentOrphanIfReserved;
  const deleteObject = input.deleteObject ?? ((key) => deleteSkillArchive({ key }));
  const page = await listObjects({ limit: Math.max(limit * 4, limit), cursor: sweepCursor });
  sweepCursor = page.nextCursor ?? undefined;
  const candidates = page.objects
    .filter((object) => object.lastModified.getTime() <= now.getTime() - graceMs)
    .slice(0, limit);
  const result: RunAttachmentSweepResult = { deleted: 0, retained: 0, failed: 0 };
  for (const candidate of candidates) {
    try {
      const deleted = await deleteIfReserved({
        storageKey: candidate.key,
        before: new Date(now.getTime() - graceMs),
        deleteObject: () => deleteObject(candidate.key),
      });
      if (deleted) result.deleted += 1;
      else result.retained += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
