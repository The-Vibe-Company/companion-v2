import { and, asc, isNull, lt, eq } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type { SandboxRef } from "./runRuntime";
import {
  markRunInterrupted,
  runJobAlive,
  sandboxNameForRun,
  teardownSandbox,
  type RunControlContext,
  type RunRow,
} from "./skillRuns";

/**
 * Periodic sandbox sweep — the safety net behind the in-path teardown in `skillRuns.ts`. Two jobs:
 *
 * 1. TERMINAL DRAIN: `frozen`/`error` rows with `sandbox_cleaned_at` still NULL (an in-path destroy
 *    failed, or the row predates cleanup) get their sandbox destroyed and are marked cleaned.
 * 2. ORPHAN KILL: `starting`/`running` rows whose in-process job is gone (API died mid-run) are
 *    rewritten exactly like the lazy read-time recovery (`markRunInterrupted`), then destroyed.
 *
 * Deployment assumption: like `liveRunJobs`, the orphan kill assumes the documented MONO-PROCESS
 * API (`jobAlive` only sees this process). The cutoff `updatedAt + 2×timeoutMs + graceMs` is
 * deliberately conservative — `extendTimeout` is ADDITIVE in the Vercel SDK, so a run's true
 * deadline can exceed `updatedAt + timeoutMs` after a follow-up prompt (each prompt bumps
 * `updatedAt` first, bounding the common case) — but a horizontally-scaled deployment could still
 * kill a live run mid-turn on another instance; fix run-liveness tracking before scaling out.
 *
 * Runs cross-org on the plain `db` handle (the app connects as table owner, bypassing non-forced
 * RLS — this is a system job, not an actor request). Every runtime call happens OUTSIDE any
 * transaction, per the house rule in `skillRuns.ts`.
 */

export interface RunSweepResult {
  /** Terminal rows whose sandbox was destroyed and marked cleaned. */
  destroyed: number;
  /** Stale starting/running rows rewritten as interrupted, then destroyed and marked cleaned. */
  orphansKilled: number;
  /** Rows whose destroy failed — left NULL and retried on the next tick. */
  failed: number;
}

export async function sweepRunSandboxes(input: {
  ctx: RunControlContext;
  database?: Db;
  /** Usually `runJobAlive`; injectable for tests. */
  jobAlive?: (runId: string) => boolean;
  /** Max rows handled per tick (oldest first). Default 25. */
  batchSize?: number;
  /** Keeps the sweep off rows an in-flight job may still be tearing down. Default 2 min. */
  graceMs?: number;
  /** Injectable clock for tests. */
  now?: () => Date;
}): Promise<RunSweepResult> {
  const { ctx } = input;
  const database = input.database ?? db;
  const alive = input.jobAlive ?? runJobAlive;
  const batchSize = input.batchSize ?? 25;
  const graceMs = input.graceMs ?? 120_000;
  const at = (input.now ?? (() => new Date()))();

  const result: RunSweepResult = { destroyed: 0, orphansKilled: 0, failed: 0 };

  const rows = await database
    .select()
    .from(schema.skillRuns)
    .where(
      and(
        isNull(schema.skillRuns.sandboxCleanedAt),
        lt(schema.skillRuns.updatedAt, new Date(at.getTime() - graceMs)),
      ),
    )
    .orderBy(asc(schema.skillRuns.updatedAt));

  // Re-filter in JS: the hand-rolled fakeDbs ignore non-key predicates, and re-checking in code
  // keeps the sweep correct even if the query above drifts. Batch cap applied here, not via
  // `.limit()` (which the fakes don't implement).
  const pending = (Array.isArray(rows) ? (rows as RunRow[]) : [])
    .filter((row) => row.sandboxCleanedAt == null && row.updatedAt.getTime() < at.getTime() - graceMs)
    .sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
  const work: Array<{ row: RunRow; orphan: boolean }> = [];
  for (const row of pending) {
    if (row.status === "frozen" || row.status === "error") {
      work.push({ row, orphan: false });
    } else if (
      (row.status === "starting" || row.status === "running") &&
      !alive(row.id) &&
      // 2× the timeout: extendTimeout is additive, so one extension can push the true deadline
      // past updatedAt + timeoutMs (see the deployment-assumption note above).
      row.updatedAt.getTime() < at.getTime() - (2 * row.timeoutMs + graceMs)
    ) {
      work.push({ row, orphan: true });
    }
  }

  for (const { row, orphan } of work.slice(0, batchSize)) {
    const ref: SandboxRef = {
      sandboxName: row.sandboxName ?? sandboxNameForRun(row.orgId, row.id),
      sandboxId: row.sandboxId,
      region: ctx.region,
      timeoutMs: row.timeoutMs,
    };
    try {
      // Persist the terminal status BEFORE any teardown, so a crash mid-sweep degrades to a
      // retry on the next tick — never to a stuck starting/running row.
      if (orphan) await markRunInterrupted(database, row);
      if (!(await teardownSandbox(ctx, ref))) {
        result.failed += 1;
        continue;
      }
      await database
        .update(schema.skillRuns)
        .set({ sandboxCleanedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.skillRuns.id, row.id), eq(schema.skillRuns.orgId, row.orgId)));
      if (orphan) result.orphansKilled += 1;
      else result.destroyed += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`[runs] sweep of ${row.id} failed:`, error instanceof Error ? error.message : error);
    }
  }

  return result;
}
