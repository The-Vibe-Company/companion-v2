import { sql } from "drizzle-orm";
import type { RunSandboxRuntime, SandboxRuntimeObservation } from "@companion/core";
import { db, type Db } from "@companion/db";

export interface ClaimedRunRuntimeReconciliation {
  orgId: string;
  runId: string;
  creatorId: string;
  sandboxId: string | null;
  sandboxName: string;
  timeoutMs: number;
  activationRevision: number;
  reconcileGeneration: number;
  runtimeDeadlineAt: Date | null;
}

function lifecycleLog(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, string | number | boolean | null>,
): void {
  console[level](JSON.stringify({ subsystem: "sandbox_lifecycle", event, ...fields }));
}

export async function claimRunRuntimeReconciliations(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  orgIds?: ReadonlySet<string>;
  database?: Db;
}): Promise<ClaimedRunRuntimeReconciliation[]> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select
      org_id as "orgId",
      run_id as "runId",
      creator_id as "creatorId",
      sandbox_id as "sandboxId",
      sandbox_name as "sandboxName",
      timeout_ms as "timeoutMs",
      activation_revision as "activationRevision",
      reconcile_generation as "reconcileGeneration",
      runtime_deadline_at as "runtimeDeadlineAt"
    from companion_claim_skill_run_runtime_reconciliations(
      ${input.workerId},
      ${input.limit ?? 1},
      ${input.leaseSeconds ?? 30},
      ${input.orgIds && input.orgIds.size > 0 ? [...input.orgIds].join(",") : null}
    )
  `);
  return Array.from(result as unknown as Iterable<ClaimedRunRuntimeReconciliation>);
}

export async function completeRunRuntimeReconciliation(input: {
  claim: ClaimedRunRuntimeReconciliation;
  workerId: string;
  observation: SandboxRuntimeObservation;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select companion_complete_skill_run_runtime_reconciliation(
      ${input.claim.orgId}::uuid,
      ${input.claim.runId}::uuid,
      ${input.workerId},
      ${input.claim.activationRevision},
      ${input.claim.reconcileGeneration},
      ${input.observation.state}::sandbox_provider_state,
      ${input.observation.expiresAt?.toISOString() ?? null}::timestamp with time zone
    ) as completed
  `);
  return Array.from(result as unknown as Iterable<{ completed: boolean }>)[0]?.completed === true;
}

export async function processRunRuntimeReconciliation(input: {
  claim: ClaimedRunRuntimeReconciliation;
  workerId: string;
  runtime: RunSandboxRuntime;
  region: string;
  complete?: typeof completeRunRuntimeReconciliation;
  now?: () => number;
}): Promise<"completed" | "lost_lease" | "retry"> {
  const now = input.now?.() ?? Date.now();
  const ref = {
    sandboxName: input.claim.sandboxName,
    sandboxId: input.claim.sandboxId,
    region: input.region,
    timeoutMs: input.claim.timeoutMs,
  };
  let observation: SandboxRuntimeObservation;
  try {
    observation = await input.runtime.observe(ref, AbortSignal.timeout(10_000));
    const deadlineMs = input.claim.runtimeDeadlineAt?.getTime() ?? null;
    const expiresAtMs = observation.expiresAt?.getTime() ?? null;
    if (
      observation.state === "running"
      && deadlineMs !== null
      && deadlineMs > now
      && (expiresAtMs === null || expiresAtMs < deadlineMs)
      && input.runtime.extendTimeout
    ) {
      const additionalMs = Math.max(0, deadlineMs - (expiresAtMs ?? now));
      if (additionalMs > 0) {
        try {
          observation = await input.runtime.extendTimeout(
            ref,
            additionalMs,
            AbortSignal.timeout(10_000),
          );
          lifecycleLog("info", "reconcile_extended", {
            runId: input.claim.runId,
            activationRevision: input.claim.activationRevision,
            additionalMs,
          });
        } catch {
          // The mutation may have reached the provider. Re-observe before allowing a retry.
          observation = await input.runtime.observe(ref, AbortSignal.timeout(10_000));
        }
      }
    }
  } catch {
    lifecycleLog("warn", "reconcile_provider_failed", {
      runId: input.claim.runId,
      activationRevision: input.claim.activationRevision,
    });
    return "retry";
  }
  const completed = await (input.complete ?? completeRunRuntimeReconciliation)({
    claim: input.claim,
    workerId: input.workerId,
    observation,
  });
  lifecycleLog(completed ? "info" : "warn", "reconcile_completed", {
    runId: input.claim.runId,
    activationRevision: input.claim.activationRevision,
    providerState: observation.state,
    completed,
  });
  return completed ? "completed" : "lost_lease";
}

export function createRunRuntimeReconciler(input: {
  workerId: string;
  concurrency: number;
  leaseSeconds: number;
  runtime: RunSandboxRuntime;
  region: string;
  orgIds?: ReadonlySet<string>;
  claim?: typeof claimRunRuntimeReconciliations;
  process?: typeof processRunRuntimeReconciliation;
}): { run(): Promise<void>; stop(): Promise<void> } {
  const active = new Map<string, Promise<void>>();
  let stopped = false;
  let claiming: Promise<void> | null = null;
  return {
    run() {
      if (stopped) return Promise.resolve();
      if (claiming) return claiming;
      const capacity = input.concurrency - active.size;
      if (capacity <= 0) return Promise.resolve();
      claiming = (async () => {
        const claims = await (input.claim ?? claimRunRuntimeReconciliations)({
          workerId: input.workerId,
          limit: capacity,
          leaseSeconds: input.leaseSeconds,
          orgIds: input.orgIds,
        });
        if (stopped) return;
        for (const claim of claims) {
          const key = `${claim.orgId}:${claim.runId}:${claim.activationRevision}`;
          if (active.has(key)) continue;
          const task = (input.process ?? processRunRuntimeReconciliation)({
            claim,
            workerId: input.workerId,
            runtime: input.runtime,
            region: input.region,
          })
            .catch(() => "retry" as const)
            .then(() => undefined)
            .finally(() => active.delete(key));
          active.set(key, task);
        }
      })().finally(() => {
        claiming = null;
      });
      return claiming;
    },
    async stop() {
      stopped = true;
      await claiming?.catch(() => undefined);
      await Promise.allSettled(active.values());
    },
  };
}
