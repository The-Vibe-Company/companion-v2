import { and, asc, eq, gt, inArray, isNull, lt, lte, max, notInArray, or, sql } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import {
  RUN_PROMPT_MAX,
  RUN_WARNING_SNAPSHOT_MAX,
  runChatEventSchema,
  type RunChatEvent,
  type RunChatHistoryItem,
  type RunEventEnvelope,
  type RunPhase,
  type SkillRunStatus,
} from "@companion/contracts";
import type { RunRedactor } from "./runRedaction";
import {
  RunBusyError,
  RunValidationError,
  capTranscript,
  deterministicRunMessageId,
  hashRunPayload,
} from "./skillRuns";
import { assertMember, type ActorContext } from "./services";

export type ClaimedRunJob = typeof schema.skillRunJobs.$inferSelect;
export type RunPromptRow = typeof schema.skillRunPrompts.$inferSelect;

class LostRunLeaseError extends Error {}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "23505",
  );
}

async function ownedRun(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  database: Db;
  lock?: boolean;
}) {
  const query = input.database
    .select()
    .from(schema.skillRuns)
    .where(
      and(
        eq(schema.skillRuns.orgId, input.orgId),
        eq(schema.skillRuns.id, input.runId),
        eq(schema.skillRuns.creatorId, input.actor.id),
      ),
    );
  const rows = input.lock ? await query.for("update") : await query;
  const row = rows[0];
  if (!row) throw new RunValidationError("run not found", "run_not_found");
  return row;
}

/** Claim jobs across tenants through the narrow SECURITY DEFINER function from migration 0034. */
export async function claimRunJobs(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  database?: Db;
}): Promise<ClaimedRunJob[]> {
  const database = input.database ?? db;
  const limit = input.limit ?? 1;
  const leaseSeconds = input.leaseSeconds ?? 30;
  if (!input.workerId.trim()) throw new Error("worker id is required");
  if (limit < 1 || limit > 32 || leaseSeconds < 5 || leaseSeconds > 300) {
    throw new Error("invalid run job claim limits");
  }
  const result = await database.execute(sql`
    select
      claimed."id",
      claimed."org_id" as "orgId",
      claimed."run_id" as "runId",
      claimed."creator_id" as "creatorId",
      claimed."status",
      claimed."phase",
      claimed."attempt",
      claimed."max_attempts" as "maxAttempts",
      claimed."available_at" as "availableAt",
      claimed."lease_owner" as "leaseOwner",
      claimed."lease_expires_at" as "leaseExpiresAt",
      claimed."heartbeat_at" as "heartbeatAt",
      claimed."last_error_code" as "lastErrorCode",
      claimed."created_at" as "createdAt",
      claimed."updated_at" as "updatedAt"
    from companion_claim_skill_run_jobs(
      ${input.workerId},
      ${limit},
      ${leaseSeconds}
    ) as claimed
  `);
  return Array.from(result as unknown as Iterable<ClaimedRunJob>);
}

export async function heartbeatRunJob(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  workerId: string;
  leaseSeconds?: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const leaseSeconds = input.leaseSeconds ?? 30;
  if (leaseSeconds < 5 || leaseSeconds > 300) throw new Error("invalid run job lease duration");
  const now = new Date();
  const rows = await database
    .update(schema.skillRunJobs)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.skillRunJobs.orgId, input.orgId),
        eq(schema.skillRunJobs.runId, input.runId),
        eq(schema.skillRunJobs.creatorId, input.actor.id),
        eq(schema.skillRunJobs.status, "leased"),
        eq(schema.skillRunJobs.leaseOwner, input.workerId),
      ),
    )
    .returning({ id: schema.skillRunJobs.id });
  return Boolean(rows[0]);
}

export async function updateRunWorkerState(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  workerId?: string;
  status?: SkillRunStatus;
  phase: RunPhase;
  errorCode?: string | null;
  userMessage?: string | null;
  sandboxId?: string | null;
  sandboxDomain?: string | null;
  opencodeSessionId?: string | null;
  lastActiveAt?: Date | null;
  frozenAt?: Date | null;
  sandboxCleanedAt?: Date | null;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const now = new Date();
  try {
    return await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const runWhere = [
        eq(schema.skillRuns.orgId, input.orgId),
        eq(schema.skillRuns.id, input.runId),
        eq(schema.skillRuns.creatorId, input.actor.id),
      ];
      if (input.workerId) {
        // A worker that races with Cancel (or that retained a stale lease after another terminal
        // transition) must not move the public run back to an active phase. The one allowed
        // transition after a cancellation request is the worker's own terminal canceled update.
        runWhere.push(notInArray(schema.skillRuns.status, ["frozen", "error", "canceled"]));
        if (input.status !== "canceled") runWhere.push(isNull(schema.skillRuns.cancelRequestedAt));
      }
      const rows = await tx
        .update(schema.skillRuns)
        .set({
          ...(input.status !== undefined ? { status: input.status } : {}),
          phase: input.phase,
          ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
          ...(input.userMessage !== undefined ? { userMessage: input.userMessage } : {}),
          ...(input.sandboxId !== undefined ? { sandboxId: input.sandboxId } : {}),
          ...(input.sandboxDomain !== undefined ? { sandboxDomain: input.sandboxDomain } : {}),
          ...(input.opencodeSessionId !== undefined ? { opencodeSessionId: input.opencodeSessionId } : {}),
          ...(input.lastActiveAt !== undefined ? { lastActiveAt: input.lastActiveAt } : {}),
          ...(input.frozenAt !== undefined ? { frozenAt: input.frozenAt } : {}),
          ...(input.sandboxCleanedAt !== undefined ? { sandboxCleanedAt: input.sandboxCleanedAt } : {}),
          updatedAt: now,
        })
        .where(and(...runWhere))
        .returning({ id: schema.skillRuns.id });
      if (!rows[0] && input.workerId) throw new LostRunLeaseError();
      if (input.workerId) {
        const terminal = input.status && ["frozen", "error", "canceled"].includes(input.status);
        const jobStatus =
          input.status === "frozen" ? "completed" : input.status === "error" ? "failed" : "canceled";
        const jobs = await tx
          .update(schema.skillRunJobs)
          .set(
            terminal
              ? {
                  status: jobStatus,
                  phase: "complete",
                  leaseOwner: null,
                  leaseExpiresAt: null,
                  heartbeatAt: now,
                  updatedAt: now,
                }
              : { phase: input.phase, updatedAt: now },
          )
          .where(
            and(
              eq(schema.skillRunJobs.orgId, input.orgId),
              eq(schema.skillRunJobs.runId, input.runId),
              eq(schema.skillRunJobs.creatorId, input.actor.id),
              eq(schema.skillRunJobs.status, "leased"),
              eq(schema.skillRunJobs.leaseOwner, input.workerId),
            ),
          )
          .returning({ id: schema.skillRunJobs.id });
        if (!jobs[0]) throw new LostRunLeaseError();
      }
      return Boolean(rows[0]);
    });
  } catch (error) {
    if (error instanceof LostRunLeaseError) return false;
    throw error;
  }
}

export async function getRunWorkerState(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  database?: Db;
}): Promise<{
  status: SkillRunStatus;
  phase: RunPhase;
  cancelRequested: boolean;
  sessionId: string | null;
}> {
  const database = input.database ?? db;
  const run = await ownedRun({ ...input, database });
  return {
    status: run.status,
    phase: run.phase,
    cancelRequested: run.cancelRequestedAt !== null,
    sessionId: run.opencodeSessionId,
  };
}

export async function completeRunJob(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  workerId: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const rows = await database
    .update(schema.skillRunJobs)
    .set({
      status: "completed",
      phase: "complete",
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.skillRunJobs.orgId, input.orgId),
        eq(schema.skillRunJobs.runId, input.runId),
        eq(schema.skillRunJobs.creatorId, input.actor.id),
        eq(schema.skillRunJobs.status, "leased"),
        eq(schema.skillRunJobs.leaseOwner, input.workerId),
      ),
    )
    .returning({ id: schema.skillRunJobs.id });
  return Boolean(rows[0]);
}

/** Release a transient failure with backoff, or mark both job and run terminal after final failure. */
export async function failOrRetryRunJob(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  workerId: string;
  errorCode: string;
  userMessage: string;
  transient: boolean;
  backoffMs?: number;
  redactor?: RunRedactor;
  database?: Db;
}): Promise<"queued" | "failed" | "cancel_requested" | "lost_lease"> {
  const database = input.database ?? db;
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // Global lock order is run → job (Cancel and prompt operations use the same order).
    const runs = await tx
      .select({ id: schema.skillRuns.id, cancelRequestedAt: schema.skillRuns.cancelRequestedAt })
      .from(schema.skillRuns)
      .where(
        and(
          eq(schema.skillRuns.orgId, input.orgId),
          eq(schema.skillRuns.id, input.runId),
          eq(schema.skillRuns.creatorId, input.actor.id),
        ),
      )
      .for("update");
    const run = runs[0];
    if (!run) return "lost_lease";
    const jobs = await tx
      .select()
      .from(schema.skillRunJobs)
      .where(
        and(
          eq(schema.skillRunJobs.orgId, input.orgId),
          eq(schema.skillRunJobs.runId, input.runId),
          eq(schema.skillRunJobs.creatorId, input.actor.id),
          eq(schema.skillRunJobs.status, "leased"),
          eq(schema.skillRunJobs.leaseOwner, input.workerId),
        ),
      )
      .for("update");
    const job = jobs[0];
    if (!job) return "lost_lease";
    // Leave the lease in place so this same worker can snapshot and destroy immediately.
    if (run.cancelRequestedAt !== null) return "cancel_requested";
    const retry = input.transient && job.attempt < job.maxAttempts;
    await tx
      .update(schema.skillRunJobs)
      .set({
        status: retry ? "queued" : "failed",
        ...(!retry ? { phase: "cleanup" as const } : {}),
        availableAt: retry ? new Date(Date.now() + (input.backoffMs ?? 2 ** job.attempt * 1_000)) : job.availableAt,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: new Date(),
        lastErrorCode: input.errorCode,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.skillRunJobs.orgId, input.orgId),
          eq(schema.skillRunJobs.id, job.id),
          eq(schema.skillRunJobs.status, "leased"),
          eq(schema.skillRunJobs.leaseOwner, input.workerId),
        ),
      );
    if (!retry) {
      const terminalEvent = runChatEventSchema.parse(
        input.redactor
          ? input.redactor.redactPayload({
              type: "run.error",
              code: input.errorCode,
              message: input.userMessage,
              phase: "cleanup",
            })
          : {
              type: "run.error",
              code: input.errorCode,
              message: input.userMessage,
              phase: "cleanup",
            },
      );
      const sequenceRows = await tx
        .select({ value: max(schema.skillRunEvents.sequence) })
        .from(schema.skillRunEvents)
        .where(and(eq(schema.skillRunEvents.orgId, input.orgId), eq(schema.skillRunEvents.runId, input.runId)));
      await tx.insert(schema.skillRunEvents).values({
        orgId: input.orgId,
        runId: input.runId,
        sequence: Number(sequenceRows[0]?.value ?? 0) + 1,
        ...eventParts(terminalEvent),
      });
      await tx
        .update(schema.skillRuns)
        .set({
          status: "error",
          phase: "cleanup",
          errorCode: input.errorCode,
          userMessage: input.userMessage,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.skillRuns.orgId, input.orgId),
            eq(schema.skillRuns.id, input.runId),
            eq(schema.skillRuns.creatorId, input.actor.id),
          ),
        );
    }
    return retry ? "queued" : "failed";
  });
}

export async function enqueueRunPrompt(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  text: string;
  idempotencyKey: string;
  database?: Db;
}): Promise<{ id: string; messageId: string; status: RunPromptRow["status"] }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const text = input.text.trim();
  if (!text || text.length > RUN_PROMPT_MAX) {
    throw new RunValidationError("the prompt is invalid", "invalid_prompt");
  }
  const payloadHash = hashRunPayload({ text });
  const execute = async (transaction: Db) => {
    // Serialize prompt creation with cancellation. Otherwise Cancel could clear pending prompts,
    // then a racing API transaction could insert a new prompt onto an already-canceling run.
    const run = await ownedRun({ ...input, database: transaction, lock: true });
    const existing = await transaction
      .select()
      .from(schema.skillRunPrompts)
      .where(
        and(
          eq(schema.skillRunPrompts.orgId, input.orgId),
          eq(schema.skillRunPrompts.runId, input.runId),
          eq(schema.skillRunPrompts.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (existing[0]) {
      if (existing[0].payloadHash !== payloadHash) {
        throw new RunBusyError("this idempotency key was already used with another prompt", "idempotency_conflict");
      }
      return {
        id: existing[0].id,
        messageId: existing[0].messageId,
        status: existing[0].status,
      };
    }
    if (run.status !== "running" || run.cancelRequestedAt !== null) {
      throw new RunBusyError("this run is not ready for another prompt", "run_not_running");
    }
    const active = await transaction
      .select({ id: schema.skillRunPrompts.id })
      .from(schema.skillRunPrompts)
      .where(
        and(
          eq(schema.skillRunPrompts.orgId, input.orgId),
          eq(schema.skillRunPrompts.runId, input.runId),
          inArray(schema.skillRunPrompts.status, ["queued", "processing"]),
        ),
      );
    if (active[0]) throw new RunBusyError("another prompt is already pending", "prompt_already_pending");
    const ordinalRows = await transaction
      .select({ value: max(schema.skillRunPrompts.ordinal) })
      .from(schema.skillRunPrompts)
      .where(
        and(eq(schema.skillRunPrompts.orgId, input.orgId), eq(schema.skillRunPrompts.runId, input.runId)),
      );
    const ordinal = Number(ordinalRows[0]?.value ?? 0) + 1;
    const inserted = await transaction
      .insert(schema.skillRunPrompts)
      .values({
        orgId: input.orgId,
        runId: input.runId,
        ordinal,
        kind: "follow_up",
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        messageId: deterministicRunMessageId(input.runId, ordinal),
        prompt: text,
        status: "queued",
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("prompt insert returned no row");
    await transaction
      .update(schema.skillRuns)
      .set({ lastActiveAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.skillRuns.orgId, input.orgId),
          eq(schema.skillRuns.id, input.runId),
          eq(schema.skillRuns.creatorId, input.actor.id),
        ),
      );
    return { id: row.id, messageId: row.messageId, status: "queued" as const };
  };
  try {
    return await database.transaction(async (transaction) => execute(transaction as unknown as Db));
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new RunBusyError("another prompt is already pending", "prompt_already_pending");
    }
    throw error;
  }
}

/** Claim the next prompt for a run; expired processing leases are reclaimed without a duplicate id. */
export async function claimNextRunPrompt(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  workerId: string;
  leaseSeconds?: number;
  database?: Db;
}): Promise<RunPromptRow | null> {
  const database = input.database ?? db;
  const leaseSeconds = input.leaseSeconds ?? 30;
  if (leaseSeconds < 5 || leaseSeconds > 300) throw new Error("invalid prompt lease duration");
  const now = new Date();
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const run = await ownedRun({ ...input, database: tx, lock: true });
    if (run.status !== "running" || run.cancelRequestedAt !== null) return null;
    const rows = await tx
      .select()
      .from(schema.skillRunPrompts)
      .where(
        and(
          eq(schema.skillRunPrompts.orgId, input.orgId),
          eq(schema.skillRunPrompts.runId, input.runId),
          lte(schema.skillRunPrompts.availableAt, now),
          lt(schema.skillRunPrompts.attempt, 10),
          or(
            eq(schema.skillRunPrompts.status, "queued"),
            and(
              eq(schema.skillRunPrompts.status, "processing"),
              sql`${schema.skillRunPrompts.leaseExpiresAt} <= ${now}`,
            ),
          ),
        ),
      )
      .orderBy(asc(schema.skillRunPrompts.ordinal))
      .limit(1)
      .for("update", { skipLocked: true });
    const prompt = rows[0];
    if (!prompt) return null;
    const updated = await tx
      .update(schema.skillRunPrompts)
      .set({
        status: "processing",
        attempt: prompt.attempt + 1,
        leaseOwner: input.workerId,
        leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000),
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.skillRunPrompts.orgId, input.orgId),
          eq(schema.skillRunPrompts.id, prompt.id),
        ),
      )
      .returning();
    return updated[0] ?? null;
  });
}

export async function completeRunPrompt(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  promptId: string;
  workerId: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  await ownedRun({ ...input, database });
  const now = new Date();
  const rows = await database
    .update(schema.skillRunPrompts)
    .set({
      status: "completed",
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      completedAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.skillRunPrompts.orgId, input.orgId),
        eq(schema.skillRunPrompts.runId, input.runId),
        eq(schema.skillRunPrompts.id, input.promptId),
        eq(schema.skillRunPrompts.status, "processing"),
        eq(schema.skillRunPrompts.leaseOwner, input.workerId),
      ),
    )
    .returning({ id: schema.skillRunPrompts.id });
  return Boolean(rows[0]);
}

export async function heartbeatRunPrompt(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  promptId: string;
  workerId: string;
  leaseSeconds?: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const leaseSeconds = input.leaseSeconds ?? 30;
  if (leaseSeconds < 5 || leaseSeconds > 300) throw new Error("invalid prompt lease duration");
  await ownedRun({ ...input, database });
  const now = new Date();
  const rows = await database
    .update(schema.skillRunPrompts)
    .set({
      heartbeatAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseSeconds * 1_000),
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.skillRunPrompts.orgId, input.orgId),
        eq(schema.skillRunPrompts.runId, input.runId),
        eq(schema.skillRunPrompts.id, input.promptId),
        eq(schema.skillRunPrompts.status, "processing"),
        eq(schema.skillRunPrompts.leaseOwner, input.workerId),
      ),
    )
    .returning({ id: schema.skillRunPrompts.id });
  return Boolean(rows[0]);
}

export async function failRunPrompt(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  promptId: string;
  workerId: string;
  errorCode: string;
  userMessage: string;
  retry?: boolean;
  backoffMs?: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  await ownedRun({ ...input, database });
  const retry = input.retry ?? false;
  const rows = await database
    .update(schema.skillRunPrompts)
    .set({
      status: retry ? "queued" : "error",
      availableAt: retry ? new Date(Date.now() + (input.backoffMs ?? 1_000)) : new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: new Date(),
      errorCode: input.errorCode,
      userMessage: input.userMessage,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.skillRunPrompts.orgId, input.orgId),
        eq(schema.skillRunPrompts.runId, input.runId),
        eq(schema.skillRunPrompts.id, input.promptId),
        eq(schema.skillRunPrompts.status, "processing"),
        eq(schema.skillRunPrompts.leaseOwner, input.workerId),
      ),
    )
    .returning({ id: schema.skillRunPrompts.id });
  return Boolean(rows[0]);
}

export async function requestRunCancellation(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  database?: Db;
}): Promise<{ status: SkillRunStatus; requested: boolean }> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const run = await ownedRun({ ...input, database: tx, lock: true });
    if (run.status === "frozen" || run.status === "error" || run.status === "canceled") {
      return { status: run.status, requested: false };
    }
    if (run.cancelRequestedAt !== null) return { status: run.status, requested: false };
    const now = new Date();
    if (run.status === "queued") {
      await tx
        .update(schema.skillRuns)
        .set({
          status: "canceled",
          phase: "complete",
          cancelRequestedAt: now,
          frozenAt: now,
          sandboxCleanedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.skillRuns.orgId, input.orgId),
            eq(schema.skillRuns.id, input.runId),
            eq(schema.skillRuns.creatorId, input.actor.id),
          ),
        );
      await tx
        .update(schema.skillRunJobs)
        .set({
          status: "canceled",
          phase: "complete",
          leaseOwner: null,
          leaseExpiresAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(schema.skillRunJobs.orgId, input.orgId),
            eq(schema.skillRunJobs.runId, input.runId),
            eq(schema.skillRunJobs.creatorId, input.actor.id),
          ),
        );
      await tx
        .update(schema.skillRunPrompts)
        .set({ status: "canceled", leaseOwner: null, leaseExpiresAt: null, updatedAt: now })
        .where(
          and(
            eq(schema.skillRunPrompts.orgId, input.orgId),
            eq(schema.skillRunPrompts.runId, input.runId),
            inArray(schema.skillRunPrompts.status, ["queued", "processing"]),
          ),
        );
      await tx.insert(schema.auditLog).values({
        orgId: input.orgId,
        actorId: input.actor.id,
        action: "skill.run.cancel",
        targetType: "skill_run",
        targetId: input.runId,
        metadata: { queued: true },
      });
      return { status: "canceled", requested: true };
    }
    await tx
      .update(schema.skillRuns)
      .set({ phase: "cancel", cancelRequestedAt: now, updatedAt: now })
      .where(
        and(
          eq(schema.skillRuns.orgId, input.orgId),
          eq(schema.skillRuns.id, input.runId),
          eq(schema.skillRuns.creatorId, input.actor.id),
        ),
      );
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "skill.run.cancel_requested",
      targetType: "skill_run",
      targetId: input.runId,
    });
    return { status: run.status, requested: true };
  });
}

function eventParts(event: RunChatEvent): { type: string; payload: Record<string, unknown> } {
  const { type, ...payload } = event;
  return { type, payload };
}

/** Append a batch under a row lock so sequences stay gap-free across worker retries. */
export async function appendRunEvents(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  events: RunChatEvent[];
  redactor?: RunRedactor;
  database?: Db;
}): Promise<RunEventEnvelope[]> {
  if (input.events.length === 0) return [];
  const database = input.database ?? db;
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const runs = await tx
      .select({ id: schema.skillRuns.id, warnings: schema.skillRuns.warnings })
      .from(schema.skillRuns)
      .where(
        and(
          eq(schema.skillRuns.orgId, input.orgId),
          eq(schema.skillRuns.id, input.runId),
          eq(schema.skillRuns.creatorId, input.actor.id),
        ),
      )
      .for("update");
    const run = runs[0];
    if (!run) throw new RunValidationError("run not found", "run_not_found");
    const sequenceRows = await tx
      .select({ value: max(schema.skillRunEvents.sequence) })
      .from(schema.skillRunEvents)
      .where(and(eq(schema.skillRunEvents.orgId, input.orgId), eq(schema.skillRunEvents.runId, input.runId)));
    const first = Number(sequenceRows[0]?.value ?? 0) + 1;
    const normalized = input.events.map((event) =>
      runChatEventSchema.parse(input.redactor ? input.redactor.redactPayload(event) : event),
    );
    const newWarnings = normalized.filter(
      (event): event is Extract<RunChatEvent, { type: "run.warning" }> => event.type === "run.warning",
    );
    if (newWarnings.length > 0) {
      const warnings = Array.isArray(run.warnings) ? [...run.warnings] : [];
      const seen = new Set(
        warnings.map((warning) => JSON.stringify([warning.code, warning.phase, warning.message])),
      );
      for (const warning of newWarnings) {
        const snapshot = { code: warning.code, message: warning.message, phase: warning.phase };
        const fingerprint = JSON.stringify([snapshot.code, snapshot.phase, snapshot.message]);
        if (seen.has(fingerprint)) continue;
        seen.add(fingerprint);
        warnings.push(snapshot);
      }
      await tx
        .update(schema.skillRuns)
        .set({ warnings: warnings.slice(-RUN_WARNING_SNAPSHOT_MAX) })
        .where(
          and(
            eq(schema.skillRuns.orgId, input.orgId),
            eq(schema.skillRuns.id, input.runId),
            eq(schema.skillRuns.creatorId, input.actor.id),
          ),
        );
    }
    const inserted = await tx
      .insert(schema.skillRunEvents)
      .values(
        normalized.map((event, index) => ({
          orgId: input.orgId,
          runId: input.runId,
          sequence: first + index,
          ...eventParts(event),
        })),
      )
      .returning();
    return inserted.map((row, index) => ({
      sequence: row.sequence,
      event: normalized[index]!,
      created_at: row.createdAt.toISOString(),
    }));
  });
}

export async function appendRunEvent(
  input: Omit<Parameters<typeof appendRunEvents>[0], "events"> & { event: RunChatEvent },
): Promise<RunEventEnvelope> {
  const rows = await appendRunEvents({ ...input, events: [input.event] });
  return rows[0]!;
}

export async function listRunEvents(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  afterSequence?: number;
  limit?: number;
  database?: Db;
}): Promise<RunEventEnvelope[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await ownedRun({ ...input, database });
  const limit = Math.max(1, Math.min(input.limit ?? 500, 1_000));
  const condition = and(
    eq(schema.skillRunEvents.orgId, input.orgId),
    eq(schema.skillRunEvents.runId, input.runId),
    ...(input.afterSequence ? [gt(schema.skillRunEvents.sequence, input.afterSequence)] : []),
  );
  const rows = await database
    .select()
    .from(schema.skillRunEvents)
    .where(condition)
    .orderBy(asc(schema.skillRunEvents.sequence))
    .limit(limit);
  return rows.map((row) => ({
    sequence: row.sequence,
    event: runChatEventSchema.parse({ type: row.type, ...row.payload }),
    created_at: row.createdAt.toISOString(),
  }));
}

export async function persistRunTranscript(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  items: RunChatHistoryItem[];
  redactor: RunRedactor;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const transcript = capTranscript(input.redactor.redactPayload(input.items));
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const runs = await tx
      .select({ id: schema.skillRuns.id })
      .from(schema.skillRuns)
      .where(
        and(
          eq(schema.skillRuns.orgId, input.orgId),
          eq(schema.skillRuns.id, input.runId),
          eq(schema.skillRuns.creatorId, input.actor.id),
        ),
      )
      .for("update");
    if (!runs[0]) return false;
    const sequenceRows = await tx
      .select({ value: max(schema.skillRunEvents.sequence) })
      .from(schema.skillRunEvents)
      .where(and(eq(schema.skillRunEvents.orgId, input.orgId), eq(schema.skillRunEvents.runId, input.runId)));
    const rows = await tx
      .update(schema.skillRuns)
      .set({
        transcript,
        transcriptEventSequence: Number(sequenceRows[0]?.value ?? 0),
        transcriptUpdatedAt: new Date(),
        lastActiveAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.skillRuns.orgId, input.orgId),
          eq(schema.skillRuns.id, input.runId),
          eq(schema.skillRuns.creatorId, input.actor.id),
        ),
      )
      .returning({ id: schema.skillRuns.id });
    return Boolean(rows[0]);
  });
}

export async function cleanupExpiredRunEvents(input: {
  limit?: number;
  database?: Db;
}): Promise<number> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select companion_cleanup_skill_run_events(${input.limit ?? 1000}) as count
  `);
  const row = Array.from(result as unknown as Iterable<{ count: number }>)[0];
  return Number(row?.count ?? 0);
}
