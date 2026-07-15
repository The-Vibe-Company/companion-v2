import { deleteRunAttachmentOrphanIfReserved, listRunAttachmentOrphanReservations } from "@companion/core/services";
import { deleteSkillArchive } from "@companion/storage";

const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1_000;

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
  listReservations?: typeof listRunAttachmentOrphanReservations;
  deleteIfReserved?: typeof deleteRunAttachmentOrphanIfReserved;
  deleteObject?: (key: string) => Promise<void>;
} = {}): Promise<RunAttachmentSweepResult> {
  const now = input.now ?? new Date();
  const graceMs = input.graceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const limit = input.limit ?? 250;
  const listReservations = input.listReservations ?? listRunAttachmentOrphanReservations;
  const deleteIfReserved = input.deleteIfReserved ?? deleteRunAttachmentOrphanIfReserved;
  const deleteObject = input.deleteObject ?? ((key) => deleteSkillArchive({ key }));
  const before = new Date(now.getTime() - graceMs);
  const candidates = await listReservations({ before, limit });
  const result: RunAttachmentSweepResult = { deleted: 0, retained: 0, failed: 0 };
  for (const storageKey of candidates) {
    try {
      const deleted = await deleteIfReserved({
        storageKey,
        before,
        deleteObject: () => deleteObject(storageKey),
      });
      if (deleted) result.deleted += 1;
      else result.retained += 1;
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
