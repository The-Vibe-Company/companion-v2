import {
  claimSkillDatabaseObjectDeletions,
  completeSkillDatabaseObjectDeletion,
  deferSkillDatabaseObjectDeletion,
  type SkillDatabaseObjectDeletion,
} from "@companion/core";
import { deleteSkillArchive } from "@companion/storage";
import type { Supervisor } from "./billingSupervisor";

export interface SkillDatabaseObjectSweepResult {
  deleted: number;
  failed: number;
}

/** Drain the durable realm-deletion outbox. S3 DELETE is idempotent, so an expired claim is safe. */
export async function sweepSkillDatabaseObjects(input: {
  limit?: number;
  claim?: typeof claimSkillDatabaseObjectDeletions;
  complete?: typeof completeSkillDatabaseObjectDeletion;
  defer?: typeof deferSkillDatabaseObjectDeletion;
  deleteObject?: (storageKey: string, signal: AbortSignal) => Promise<void>;
} = {}): Promise<SkillDatabaseObjectSweepResult> {
  const claim = input.claim ?? claimSkillDatabaseObjectDeletions;
  const complete = input.complete ?? completeSkillDatabaseObjectDeletion;
  const deferDeletion = input.defer ?? deferSkillDatabaseObjectDeletion;
  const deleteObject = input.deleteObject
    ?? ((storageKey, signal) => deleteSkillArchive({ key: storageKey, signal }));
  const deleteTimeoutMs = boundedPositiveEnv("COMPANION_SKILL_DB_DELETE_TIMEOUT_MS", 5_000, 60_000);
  const deleteTimeoutSeconds = Math.ceil(deleteTimeoutMs / 1_000);
  const requestedLimit = Math.max(1, Math.min(1_000, Math.floor(input.limit ?? 100)));
  // The database function caps leases at one hour. Size the batch so every sequential delete can
  // consume its full deadline plus 30 seconds of acknowledgement overhead before any claim expires.
  const limit = Math.min(requestedLimit, Math.floor((3_600 - 30) / deleteTimeoutSeconds));
  const leaseSeconds = (limit * deleteTimeoutSeconds) + 30;
  const deletions = await claim({ limit, leaseSeconds });
  const result = { deleted: 0, failed: 0 };
  for (const deletion of deletions) {
    try {
      await deleteObject(deletion.storageKey, AbortSignal.timeout(deleteTimeoutMs));
      if (await complete({ deletion })) result.deleted += 1;
    } catch {
      result.failed += 1;
      await deferDeletion({ deletion }).catch(() => false);
    }
  }
  return result;
}

function boundedPositiveEnv(name: string, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

function cleanupIntervalMs(): number {
  const parsed = Number.parseInt(process.env.COMPANION_SKILL_DB_CLEANUP_INTERVAL_MS ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 ? parsed : 60_000;
}

export async function startSkillDatabaseCleanupSupervisor(input: {
  sweep?: () => Promise<SkillDatabaseObjectSweepResult>;
  intervalMs?: number;
} = {}): Promise<Supervisor | null> {
  // Cleanup is lifecycle infrastructure, not a request capability. It must keep draining deletion
  // intents while the public feature flag is disabled or rolled back.
  const sweep = input.sweep ?? (() => sweepSkillDatabaseObjects());
  let stopping = false;
  let active: Promise<void> | null = null;
  const run = () => {
    if (stopping || active) return;
    active = sweep().then(() => undefined, () => undefined).finally(() => {
      active = null;
    });
  };
  run();
  const timer = setInterval(run, input.intervalMs ?? cleanupIntervalMs());
  return {
    async stop() {
      stopping = true;
      clearInterval(timer);
      await active;
    },
  };
}

export type { SkillDatabaseObjectDeletion };
