import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type { SandboxRef } from "./runRuntime";
import { sandboxNameForRun, teardownSandbox, type RunControlContext, type RunRow } from "./skillRuns";

/**
 * Terminal-sandbox safety net. Durable jobs and expiring PostgreSQL leases own active-run recovery;
 * this sweeper must never infer liveness from an API process or kill a starting/running run.
 */
export interface RunSweepResult {
  destroyed: number;
  failed: number;
}
export async function sweepRunSandboxes(input: {
  ctx: RunControlContext;
  database?: Db;
  batchSize?: number;
  graceMs?: number;
  now?: () => Date;
}): Promise<RunSweepResult> {
  const database = input.database ?? db;
  const runtime = input.ctx.runtime;
  if (!runtime) throw new Error("run sandbox runtime is not configured");
  const batchSize = input.batchSize ?? 25;
  const graceMs = input.graceMs ?? 120_000;
  const at = (input.now ?? (() => new Date()))();
  const result: RunSweepResult = { destroyed: 0, failed: 0 };

  const rows = await database
    .select()
    .from(schema.skillRuns)
    .where(
      and(
        isNull(schema.skillRuns.sandboxCleanedAt),
        inArray(schema.skillRuns.status, ["frozen", "error", "canceled"]),
        lt(schema.skillRuns.updatedAt, new Date(at.getTime() - graceMs)),
      ),
    )
    .orderBy(asc(schema.skillRuns.updatedAt));

  const pending = (rows as RunRow[])
    .filter(
      (row) =>
        row.sandboxCleanedAt === null &&
        (row.status === "frozen" || row.status === "error" || row.status === "canceled") &&
        row.updatedAt.getTime() < at.getTime() - graceMs,
    )
    .slice(0, batchSize);

  for (const row of pending) {
    const ref: SandboxRef = {
      sandboxName: row.sandboxName ?? sandboxNameForRun(row.orgId, row.id),
      sandboxId: row.sandboxId,
      region: input.ctx.region,
      timeoutMs: row.timeoutMs,
    };
    if (!(await teardownSandbox(runtime, ref))) {
      result.failed += 1;
      continue;
    }
    await database
      .update(schema.skillRuns)
      .set({ sandboxCleanedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.skillRuns.orgId, row.orgId), eq(schema.skillRuns.id, row.id)));
    result.destroyed += 1;
  }
  return result;
}
