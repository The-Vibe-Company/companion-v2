import { sql } from "drizzle-orm";
import { settleLatestSandboxUsage } from "@companion/core";
import { teardownSandbox } from "@companion/core/services";
import { db, withTenantContext, type Db } from "@companion/db";
import type { RunSandboxRuntime } from "@companion/core";

export interface ClaimedRunCleanup {
  orgId: string;
  runId: string;
  creatorId: string;
  sandboxId: string | null;
  sandboxName: string | null;
  cleanupAttempt: number;
}

/** Cross-tenant claims are allowed only through the narrow SECURITY DEFINER migration function. */
export async function claimRunCleanups(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  database?: Db;
}): Promise<ClaimedRunCleanup[]> {
  const database = input.database ?? db;
  const limit = input.limit ?? 1;
  const leaseSeconds = input.leaseSeconds ?? 30;
  if (!input.workerId.trim()) throw new Error("worker id is required");
  if (limit < 1 || limit > 32 || leaseSeconds < 5 || leaseSeconds > 300) {
    throw new Error("invalid run cleanup claim limits");
  }
  const result = await database.execute(sql`
    select
      org_id as "orgId",
      run_id as "runId",
      creator_id as "creatorId",
      sandbox_id as "sandboxId",
      sandbox_name as "sandboxName",
      cleanup_attempt as "cleanupAttempt"
    from companion_claim_skill_run_cleanups(
      ${input.workerId},
      ${limit},
      ${leaseSeconds}
    )
  `);
  return Array.from(result as unknown as Iterable<ClaimedRunCleanup>);
}

/** Mark cleanup complete only while the caller still owns the system lease. */
export async function completeRunCleanup(input: {
  orgId: string;
  runId: string;
  workerId: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select companion_complete_skill_run_cleanup(
      ${input.orgId}::uuid,
      ${input.runId}::uuid,
      ${input.workerId}
    ) as completed
  `);
  const row = Array.from(result as unknown as Iterable<{ completed: boolean }>)[0];
  return row?.completed === true;
}

/**
 * Destroy one terminal sandbox from its narrow system claim. A provider failure intentionally
 * leaves the cleanup lease untouched; another worker can retry after its bounded expiry.
 */
export async function processClaimedRunCleanup(input: {
  claim: ClaimedRunCleanup;
  workerId: string;
  runtime: RunSandboxRuntime;
  region: string;
  timeoutMs: number;
  complete?: typeof completeRunCleanup;
  settle?: (claim: ClaimedRunCleanup) => Promise<void>;
}): Promise<"completed" | "retry" | "lost_lease"> {
  const hasSandboxReference = Boolean(input.claim.sandboxName || input.claim.sandboxId);
  // Provider I/O must not hold a PostgreSQL tenant transaction open. The signed cleanup claim is
  // already scoped to one org/run/creator; the narrow completion RPC rechecks the worker lease.
  const cleaned = hasSandboxReference
    ? await teardownSandbox(input.runtime, {
        // Names are deterministic and persisted at run creation. The id remains provenance;
        // the current Vercel SDK resolves persistent sandboxes by name.
        sandboxName: input.claim.sandboxName ?? input.claim.sandboxId!,
        sandboxId: input.claim.sandboxId,
        region: input.region,
        timeoutMs: input.timeoutMs,
      })
    : true;
  if (!cleaned) return "retry";
  if (input.claim.sandboxName) {
    const settle = input.settle ?? ((claim: ClaimedRunCleanup) => withTenantContext(
      { orgId: claim.orgId, userId: claim.creatorId },
      (database) => settleLatestSandboxUsage({
        orgId: claim.orgId,
        sandboxName: claim.sandboxName!,
        database,
      }),
    ));
    try {
      await settle(input.claim);
    } catch {
      // Provider teardown is idempotent. Keep the cleanup lease incomplete until accounting is
      // durably settled, then retry both operations on the next claim.
      return "retry";
    }
  }
  const completed = await (input.complete ?? completeRunCleanup)({
    orgId: input.claim.orgId,
    runId: input.claim.runId,
    workerId: input.workerId,
  });
  return completed ? "completed" : "lost_lease";
}

export interface RunCleanupScheduler {
  run(): Promise<void>;
  stop(): Promise<void>;
}

/** Coordinate cleanup claims without ever starting provider teardown after shutdown begins. */
export function createRunCleanupScheduler(input: {
  workerId: string;
  concurrency: number;
  leaseSeconds: number;
  runtime: RunSandboxRuntime;
  region: string;
  timeoutMs: number;
  claim?: typeof claimRunCleanups;
  process?: typeof processClaimedRunCleanup;
}): RunCleanupScheduler {
  const active = new Map<string, Promise<void>>();
  let stopped = false;
  let claiming: Promise<void> | null = null;

  const run = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (claiming) return claiming;
    const capacity = input.concurrency - active.size;
    if (capacity <= 0) return Promise.resolve();
    claiming = (async () => {
      const claims = await (input.claim ?? claimRunCleanups)({
        workerId: input.workerId,
        limit: capacity,
        leaseSeconds: input.leaseSeconds,
      });
      // Claims raced by stop are deliberately left for their short system leases to expire.
      if (stopped) return;
      for (const claim of claims) {
        const key = `${claim.orgId}:${claim.runId}`;
        if (active.has(key)) continue;
        const task = (input.process ?? processClaimedRunCleanup)({
          claim,
          workerId: input.workerId,
          runtime: input.runtime,
          region: input.region,
          timeoutMs: input.timeoutMs,
        })
          .catch(() => "retry" as const)
          .then(() => undefined)
          .finally(() => { active.delete(key); });
        active.set(key, task);
      }
    })().finally(() => { claiming = null; });
    return claiming;
  };

  return {
    run,
    async stop() {
      stopped = true;
      await claiming?.catch(() => undefined);
      // No provider destroy is allowed to outlive supervisor shutdown.
      await Promise.allSettled(active.values());
    },
  };
}
