import { and, asc, eq, gt, inArray, isNull, lt, max, notInArray, or, sql } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import {
  RUN_PROMPT_MAX,
  RUN_REACTIVATION_RETENTION_MS,
  RUN_WARNING_SNAPSHOT_MAX,
  runChatEventSchema,
  type RunChatEvent,
  type RunChatHistoryItem,
  type RunEventEnvelope,
  type RunPhase,
  type SkillRunAttachmentRow,
  type SkillRunStatus,
} from "@companion/contracts";
import { redactAndBoundRunEvents, type RunRedactor } from "./runRedaction";
import {
  RunBusyError,
  RunValidationError,
  attachmentWorkspacePath,
  capTranscript,
  composeRunPrompt,
  consumeRunAttachmentUploadReservations,
  deterministicRunMessageId,
  hashRunPayload,
  normalizeRunTranscript,
  releaseRunAttachmentUploadReservations,
  validateRunMessageAttachments,
  type CreateRunAttachment,
} from "./skillRuns";
import { assertMember, type ActorContext } from "./services";
import {
  extendSandboxUsageReservation,
  reserveSandboxUsage,
  SANDBOX_FOLLOWUP_RESERVATION_MS,
  SANDBOX_RUN_ACTIVATION_RESERVATION_MS,
} from "./billing";

export type ClaimedRunJob = typeof schema.skillRunJobs.$inferSelect;
export type RunPromptRow = typeof schema.skillRunPrompts.$inferSelect;

type RawClaimedRunJob = Omit<
  ClaimedRunJob,
  "availableAt" | "leaseExpiresAt" | "heartbeatAt" | "createdAt" | "updatedAt"
> & {
  availableAt: unknown;
  leaseExpiresAt: unknown;
  heartbeatAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
};

/** Raw `execute(sql)` results bypass Drizzle's column decoders, so PostgreSQL timestamps are strings. */
function claimedRunTimestamp(value: unknown): Date {
  if (value instanceof Date) return value;
  if (typeof value === "string" || typeof value === "number") return new Date(value);
  return new Date(Number.NaN);
}

function optionalClaimedRunTimestamp(value: unknown): Date | null {
  return value === null || value === undefined ? null : claimedRunTimestamp(value);
}

function parseClaimedRunJob(row: RawClaimedRunJob): ClaimedRunJob {
  return {
    ...row,
    availableAt: claimedRunTimestamp(row.availableAt),
    leaseExpiresAt: optionalClaimedRunTimestamp(row.leaseExpiresAt),
    heartbeatAt: optionalClaimedRunTimestamp(row.heartbeatAt),
    createdAt: claimedRunTimestamp(row.createdAt),
    updatedAt: claimedRunTimestamp(row.updatedAt),
  };
}

/** Minimal non-secret state exposed only to the worker that currently owns this exact run lease. */
export interface RunWorkerLeaseControl {
  status: SkillRunStatus;
  phase: RunPhase;
  cancelRequestedAt: Date | null;
  sandboxName: string | null;
  sandboxId: string | null;
  timeoutMs: number;
  membershipActive: boolean;
}

export class LostRunLeaseError extends Error {
  constructor() {
    super("run worker lease was lost");
    this.name = "LostRunLeaseError";
  }
}

/** Advertise a fully configured worker replica through a short database-backed liveness lease. */
export async function heartbeatRunWorker(input: {
  workerId: string;
  ttlSeconds?: number;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const ttlSeconds = input.ttlSeconds ?? 15;
  if (ttlSeconds < 5 || ttlSeconds > 300) throw new Error("invalid run worker heartbeat ttl");
  await database.execute(sql`
    select companion_heartbeat_skill_run_worker(${input.workerId}, ${ttlSeconds}, 1)
  `);
}

export async function removeRunWorkerHeartbeat(input: {
  workerId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await database.execute(sql`select companion_remove_skill_run_worker(${input.workerId})`);
}

/** Boolean-only readiness probe used by the API; expired replicas are never considered ready. */
export async function isRunWorkerReady(input: { database?: Db } = {}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`select companion_skill_run_worker_ready() as ready`);
  const row = Array.from(result as unknown as Iterable<{ ready: boolean }>)[0];
  return row?.ready ?? false;
}

/** Follow-up uploads are admitted only when this run is leased by a protocol-capable worker. */
async function isRunAttachmentWorkerReady(input: {
  orgId: string;
  runId: string;
  creatorId: string;
  database: Db;
}): Promise<boolean> {
  const result = await input.database.execute(sql`
    select companion_skill_run_attachment_worker_ready(
      ${input.orgId}::uuid,
      ${input.runId}::uuid,
      ${input.creatorId}
    ) as ready
  `);
  const row = Array.from(result as unknown as Iterable<{ ready: boolean }>)[0];
  return row?.ready ?? false;
}

/** Reactivation has no active lease yet, so require any live protocol-capable worker. */
async function isAnyRunAttachmentWorkerReady(database: Db): Promise<boolean> {
  const result = await database.execute(sql`
    select companion_skill_run_attachment_worker_ready() as ready
  `);
  const row = Array.from(result as unknown as Iterable<{ ready: boolean }>)[0];
  return row?.ready ?? false;
}

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

async function assertLiveRunJobLease(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  runId: string;
  workerId?: string;
}): Promise<void> {
  if (!input.workerId) return;
  const rows = await input.database
    .select({ id: schema.skillRunJobs.id })
    .from(schema.skillRunJobs)
    .where(
      and(
        eq(schema.skillRunJobs.orgId, input.orgId),
        eq(schema.skillRunJobs.runId, input.runId),
        eq(schema.skillRunJobs.creatorId, input.actor.id),
        eq(schema.skillRunJobs.status, "leased"),
        eq(schema.skillRunJobs.leaseOwner, input.workerId),
        sql`${schema.skillRunJobs.leaseExpiresAt} > clock_timestamp()`,
      ),
    )
    .for("update");
  if (!rows[0]) throw new LostRunLeaseError();
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
      claimed."lease_reclaim_count" as "leaseReclaimCount",
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
  return Array.from(result as unknown as Iterable<RawClaimedRunJob>, parseClaimedRunJob);
}

/** Hold the reservation row lock across S3 deletion so a retry must wait and then recreate bytes. */
export async function deleteRunAttachmentOrphanIfReserved(input: {
  storageKey: string;
  before: Date;
  deleteObject: () => Promise<void>;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return database.transaction(async (transaction) => {
    const locked = await (transaction as unknown as Db).execute(sql`
      select companion_lock_skill_run_attachment_orphan(
        ${input.storageKey},
        ${input.before.toISOString()}::timestamp with time zone
      ) as locked
    `);
    const row = Array.from(locked as unknown as Iterable<{ locked: boolean }>)[0];
    if (row?.locked !== true) return false;
    await input.deleteObject();
    await (transaction as unknown as Db).execute(sql`
      select companion_complete_skill_run_attachment_orphan(${input.storageKey})
    `);
    return true;
  });
}

export async function listRunAttachmentOrphanReservations(input: {
  before: Date;
  limit?: number;
  database?: Db;
}): Promise<string[]> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select storage_key as "storageKey"
    from companion_list_skill_run_attachment_orphans(
      ${input.before.toISOString()}::timestamp with time zone,
      ${input.limit ?? 250}
    )
  `);
  return Array.from(result as unknown as Iterable<{ storageKey: string }>).map((row) => row.storageKey);
}

/** Back off a failed delete only if no retry or durable attachment superseded the old candidate. */
export async function deferRunAttachmentOrphanReservation(input: {
  storageKey: string;
  before: Date;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select companion_defer_skill_run_attachment_orphan(
      ${input.storageKey},
      ${input.before.toISOString()}::timestamp with time zone
    ) as deferred
  `);
  const row = Array.from(result as unknown as Iterable<{ deferred: boolean }>)[0];
  return row?.deferred ?? false;
}

/**
 * Read only the sandbox identity/control fields bound to an unexpired worker lease. This RPC is the
 * recovery seam used after creator RLS correctly hides a run whose owner left the organization.
 */
export async function getRunWorkerLeaseControl(input: {
  orgId: string;
  runId: string;
  creatorId: string;
  workerId: string;
  database?: Db;
}): Promise<RunWorkerLeaseControl | null> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select
      control."status",
      control."phase",
      control."cancel_requested_at" as "cancelRequestedAt",
      control."sandbox_name" as "sandboxName",
      control."sandbox_id" as "sandboxId",
      control."timeout_ms" as "timeoutMs",
      control."membership_active" as "membershipActive"
    from companion_get_skill_run_worker_control(
      ${input.orgId}::uuid,
      ${input.runId}::uuid,
      ${input.creatorId},
      ${input.workerId}
    ) as control
  `);
  return Array.from(result as unknown as Iterable<RunWorkerLeaseControl>)[0] ?? null;
}

/**
 * Atomically terminalize a leased run only when its creator membership no longer exists. Sandbox
 * teardown stays outside PostgreSQL; `cleanupConfirmed` is true only after provider destroy succeeds.
 */
export async function terminalizeRevokedRunLease(input: {
  orgId: string;
  runId: string;
  creatorId: string;
  workerId: string;
  cleanupConfirmed: boolean;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select companion_terminalize_revoked_skill_run(
      ${input.orgId}::uuid,
      ${input.runId}::uuid,
      ${input.creatorId},
      ${input.workerId},
      ${input.cleanupConfirmed}
    ) as completed
  `);
  const row = Array.from(result as unknown as Iterable<{ completed: boolean }>)[0];
  return row?.completed ?? false;
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
      heartbeatAt: sql`clock_timestamp()`,
      leaseExpiresAt: sql`clock_timestamp() + make_interval(secs => ${leaseSeconds})`,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.skillRunJobs.orgId, input.orgId),
        eq(schema.skillRunJobs.runId, input.runId),
        eq(schema.skillRunJobs.creatorId, input.actor.id),
        eq(schema.skillRunJobs.status, "leased"),
        eq(schema.skillRunJobs.leaseOwner, input.workerId),
        sql`${schema.skillRunJobs.leaseExpiresAt} > clock_timestamp()`,
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
  phase?: RunPhase;
  errorCode?: string | null;
  userMessage?: string | null;
  sandboxId?: string | null;
  sandboxDomain?: string | null;
  opencodeSessionId?: string | null;
  lastActiveAt?: Date | null;
  frozenAt?: Date | null;
  reactivatableUntil?: Date | null;
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
          ...(input.phase !== undefined ? { phase: input.phase } : {}),
          ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
          ...(input.userMessage !== undefined ? { userMessage: input.userMessage } : {}),
          ...(input.sandboxId !== undefined ? { sandboxId: input.sandboxId } : {}),
          ...(input.sandboxDomain !== undefined ? { sandboxDomain: input.sandboxDomain } : {}),
          ...(input.opencodeSessionId !== undefined ? { opencodeSessionId: input.opencodeSessionId } : {}),
          ...(input.lastActiveAt !== undefined ? { lastActiveAt: input.lastActiveAt } : {}),
          ...(input.frozenAt !== undefined ? { frozenAt: input.frozenAt } : {}),
          ...(input.reactivatableUntil !== undefined ? { reactivatableUntil: input.reactivatableUntil } : {}),
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
              : {
                  ...(input.phase !== undefined ? { phase: input.phase } : {}),
                  updatedAt: now,
                },
          )
          .where(
            and(
              eq(schema.skillRunJobs.orgId, input.orgId),
              eq(schema.skillRunJobs.runId, input.runId),
              eq(schema.skillRunJobs.creatorId, input.actor.id),
              eq(schema.skillRunJobs.status, "leased"),
              eq(schema.skillRunJobs.leaseOwner, input.workerId),
              sql`${schema.skillRunJobs.leaseExpiresAt} > clock_timestamp()`,
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
  const now = new Date();
  const rows = await database
    .update(schema.skillRunJobs)
    .set({
      status: "completed",
      phase: "complete",
      leaseOwner: null,
      leaseExpiresAt: null,
      heartbeatAt: now,
      updatedAt: now,
    })
    .where(
      and(
        eq(schema.skillRunJobs.orgId, input.orgId),
        eq(schema.skillRunJobs.runId, input.runId),
        eq(schema.skillRunJobs.creatorId, input.actor.id),
        eq(schema.skillRunJobs.status, "leased"),
        eq(schema.skillRunJobs.leaseOwner, input.workerId),
        sql`${schema.skillRunJobs.leaseExpiresAt} > clock_timestamp()`,
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
  const now = new Date();
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    // Global lock order is run → job (Cancel and prompt operations use the same order).
    const runs = await tx
      .select({
        id: schema.skillRuns.id,
        cancelRequestedAt: schema.skillRuns.cancelRequestedAt,
        transcriptEventSequence: schema.skillRuns.transcriptEventSequence,
      })
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
          sql`${schema.skillRunJobs.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .for("update");
    const job = jobs[0];
    if (!job) return "lost_lease";
    // Leave the lease in place so this same worker can snapshot and destroy immediately.
    if (run.cancelRequestedAt !== null) return "cancel_requested";
    const retry = input.transient && job.attempt < job.maxAttempts;
    const released = await tx
      .update(schema.skillRunJobs)
      .set({
        status: retry ? "queued" : "failed",
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
          sql`${schema.skillRunJobs.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: schema.skillRunJobs.id });
    if (!released[0]) return "lost_lease";
    if (!retry) {
      const terminalEvent = runChatEventSchema.parse(
        input.redactor
          ? input.redactor.redactPayload({
              type: "run.error",
              code: input.errorCode,
              message: input.userMessage,
              phase: job.phase,
            })
          : {
              type: "run.error",
              code: input.errorCode,
              message: input.userMessage,
              phase: job.phase,
            },
      );
      const sequenceRows = await tx
        .select({ value: max(schema.skillRunEvents.sequence) })
        .from(schema.skillRunEvents)
        .where(and(eq(schema.skillRunEvents.orgId, input.orgId), eq(schema.skillRunEvents.runId, input.runId)));
      await tx.insert(schema.skillRunEvents).values({
        orgId: input.orgId,
        runId: input.runId,
        sequence: Math.max(
          Number(sequenceRows[0]?.value ?? 0),
          run.transcriptEventSequence,
        ) + 1,
        ...eventParts(terminalEvent),
      });
      await tx
        .update(schema.skillRuns)
        .set({
          status: "error",
          phase: job.phase,
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
  attachments?: CreateRunAttachment[];
  /** Set only after the API has verified runtime configuration and a live worker heartbeat. */
  reactivationAvailable?: boolean;
  database?: Db;
}): Promise<{
  id: string;
  messageId: string;
  status: RunPromptRow["status"];
  attachments: SkillRunAttachmentRow[];
  reactivated: boolean;
}> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const text = input.text.trim();
  const attachments = input.attachments ?? [];
  if (text.length > RUN_PROMPT_MAX) {
    throw new RunValidationError("the prompt is invalid", "invalid_prompt");
  }
  validateRunMessageAttachments({ text, attachments });
  const payloadHash = hashRunPayload({
    text,
    attachments: attachments
      .map(({ id, fileName, contentType, byteSize }) => ({ id, fileName, contentType, byteSize }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  });
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
      const existingAttachments = await transaction
        .select()
        .from(schema.skillRunAttachments)
        .where(
          and(
            eq(schema.skillRunAttachments.orgId, input.orgId),
            eq(schema.skillRunAttachments.runId, input.runId),
            eq(schema.skillRunAttachments.promptId, existing[0].id),
          ),
        );
      await releaseRunAttachmentUploadReservations({
        database: transaction,
        actor: input.actor,
        orgId: input.orgId,
        attachments,
      });
      return {
        id: existing[0].id,
        messageId: existing[0].messageId,
        status: existing[0].status,
        attachments: existingAttachments.map((attachment) => ({
          id: attachment.id,
          prompt_id: existing[0]!.id,
          message_id: existing[0]!.messageId,
          prompt_ordinal: existing[0]!.ordinal,
          file_name: attachment.fileName,
          content_type: attachment.contentType,
          byte_size: attachment.byteSize,
        })),
        reactivated: false,
      };
    }
    const terminalReactivation = run.status === "frozen" || run.status === "canceled";
    if (terminalReactivation) {
      if (!input.reactivationAvailable) {
        throw new RunValidationError("RunSkill is unavailable because no configured run worker is currently online.", "runtime_unavailable");
      }
      const now = new Date();
      if (
        run.sandboxCleanedAt !== null
        || run.reactivatableUntil === null
        || run.reactivatableUntil.getTime() <= now.getTime()
        || run.cleanupLeaseOwner !== null
      ) {
        throw new RunBusyError("this run can no longer be reactivated", "run_reactivation_expired");
      }
    } else if (
      run.status !== "running"
      || run.cancelRequestedAt !== null
      || ["freeze", "cancel", "cleanup", "complete"].includes(run.phase)
    ) {
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
    if (attachments.length > 0) {
      const attachmentWorkerReady = terminalReactivation
        ? await isAnyRunAttachmentWorkerReady(transaction)
        : await isRunAttachmentWorkerReady({
            orgId: input.orgId,
            runId: input.runId,
            creatorId: input.actor.id,
            database: transaction,
          });
      if (!attachmentWorkerReady) {
        throw new RunBusyError(
          "this run's worker cannot accept attachments yet",
          "attachment_worker_unavailable",
        );
      }
    }
    const existingAttachmentBytes = await transaction
      .select({ bytes: sql<number>`coalesce(sum(${schema.skillRunAttachments.byteSize}), 0)` })
      .from(schema.skillRunAttachments)
      .where(
        and(
          eq(schema.skillRunAttachments.orgId, input.orgId),
          eq(schema.skillRunAttachments.runId, input.runId),
        ),
      );
    validateRunMessageAttachments({
      text,
      attachments,
      existingBytes: Number(existingAttachmentBytes[0]?.bytes ?? 0),
    });
    const skills = await transaction
      .select({ slug: schema.skills.slug })
      .from(schema.skills)
      .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.id, run.skillId)));
    const skillSlug = skills[0]?.slug;
    if (!skillSlug) throw new RunValidationError("skill not found", "skill_not_found");
    const ordinalRows = await transaction
      .select({ value: max(schema.skillRunPrompts.ordinal) })
      .from(schema.skillRunPrompts)
      .where(
        and(eq(schema.skillRunPrompts.orgId, input.orgId), eq(schema.skillRunPrompts.runId, input.runId)),
      );
    const ordinal = Number(ordinalRows[0]?.value ?? 0) + 1;
    const promptCreatedAt = new Date();
    if (terminalReactivation) {
      await reserveSandboxUsage({
        orgId: input.orgId,
        creatorId: input.actor.id,
        kind: "run",
        sourceId: input.runId,
        sandboxName: run.sandboxName ?? `run-${input.runId}`,
        activationRevision: run.activationRevision + 1,
        reservationMs: SANDBOX_RUN_ACTIVATION_RESERVATION_MS,
        database: transaction,
        now: promptCreatedAt,
      });
    } else {
      await extendSandboxUsageReservation({
        orgId: input.orgId,
        sourceId: input.runId,
        activationRevision: run.activationRevision,
        additionalMs: SANDBOX_FOLLOWUP_RESERVATION_MS,
        database: transaction,
        now: promptCreatedAt,
      });
    }
    if (terminalReactivation) {
      // A queued run can be canceled before OpenCode exists. Replay its immutable initial prompt
      // first so the newly entered follow-up continues the same logical conversation.
      if (!run.opencodeSessionId) {
        await transaction
          .update(schema.skillRunPrompts)
          .set({
            status: "queued",
            attempt: 0,
            availableAt: promptCreatedAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            heartbeatAt: null,
            errorCode: null,
            userMessage: null,
            completedAt: null,
            updatedAt: promptCreatedAt,
          })
          .where(
            and(
              eq(schema.skillRunPrompts.orgId, input.orgId),
              eq(schema.skillRunPrompts.runId, input.runId),
              eq(schema.skillRunPrompts.kind, "initial"),
              eq(schema.skillRunPrompts.status, "canceled"),
            ),
          );
      }
      const resetJobs = await transaction
        .update(schema.skillRunJobs)
        .set({
          status: "queued",
          phase: "queued",
          attempt: 0,
          leaseReclaimCount: 0,
          availableAt: promptCreatedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          heartbeatAt: null,
          lastErrorCode: null,
          updatedAt: promptCreatedAt,
        })
        .where(
          and(
            eq(schema.skillRunJobs.orgId, input.orgId),
            eq(schema.skillRunJobs.runId, input.runId),
            eq(schema.skillRunJobs.creatorId, input.actor.id),
          ),
        )
        .returning({ id: schema.skillRunJobs.id });
      if (!resetJobs[0]) throw new Error("run reactivation found no matching job");
      const resetRuns = await transaction
        .update(schema.skillRuns)
        .set({
          status: "queued",
          phase: "queued",
          errorCode: null,
          userMessage: null,
          cancelRequestedAt: null,
          frozenAt: null,
          reactivatableUntil: null,
          activationRevision: sql`${schema.skillRuns.activationRevision} + 1`,
          cleanupLeaseOwner: null,
          cleanupLeaseExpiresAt: null,
          lastActiveAt: promptCreatedAt,
          updatedAt: promptCreatedAt,
        })
        .where(
          and(
            eq(schema.skillRuns.orgId, input.orgId),
            eq(schema.skillRuns.id, input.runId),
            eq(schema.skillRuns.creatorId, input.actor.id),
          ),
        )
        .returning({ id: schema.skillRuns.id });
      if (!resetRuns[0]) throw new Error("run reactivation lost ownership before reset");
    }
    const runtimePrompt = composeRunPrompt({
      prompt: text,
      skillSlug,
      attachments: attachments.map((attachment) => ({
        fileName: attachment.fileName,
        workspacePath: attachmentWorkspacePath(attachment),
      })),
    });
    const inserted = await transaction
      .insert(schema.skillRunPrompts)
      .values({
        orgId: input.orgId,
        runId: input.runId,
        ordinal,
        kind: "follow_up",
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        messageId: deterministicRunMessageId(input.runId, ordinal, promptCreatedAt.getTime()),
        userText: text,
        prompt: runtimePrompt,
        status: "queued",
        createdAt: promptCreatedAt,
        updatedAt: promptCreatedAt,
      })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("prompt insert returned no row");
    if (attachments.length > 0) {
      await consumeRunAttachmentUploadReservations({
        database: transaction,
        actor: input.actor,
        orgId: input.orgId,
        attachments,
      });
      await transaction.insert(schema.skillRunAttachments).values(
        attachments.map((attachment) => ({
          id: attachment.id,
          orgId: input.orgId,
          runId: input.runId,
          promptId: row.id,
          fileName: attachment.fileName,
          contentType: attachment.contentType,
          byteSize: attachment.byteSize,
          storageKey: attachment.storageKey,
        })),
      );
      await transaction.delete(schema.skillRunAttachmentUploads).where(
        inArray(schema.skillRunAttachmentUploads.storageKey, attachments.map((attachment) => attachment.storageKey)),
      );
    }
    await transaction
      .update(schema.skillRuns)
      .set({ lastActiveAt: promptCreatedAt, updatedAt: promptCreatedAt })
      .where(
        and(
          eq(schema.skillRuns.orgId, input.orgId),
          eq(schema.skillRuns.id, input.runId),
          eq(schema.skillRuns.creatorId, input.actor.id),
        ),
      );
    if (terminalReactivation) {
      await transaction.insert(schema.auditLog).values({
        orgId: input.orgId,
        actorId: input.actor.id,
        action: "skill.run.reactivated",
        targetType: "skill_run",
        targetId: input.runId,
        metadata: { previous_status: run.status },
      });
    }
    return {
      id: row.id,
      messageId: row.messageId,
      status: "queued" as const,
      reactivated: terminalReactivation,
      attachments: attachments.map((attachment) => ({
        id: attachment.id,
        prompt_id: row.id,
        message_id: row.messageId,
        prompt_ordinal: row.ordinal,
        file_name: attachment.fileName,
        content_type: attachment.contentType,
        byte_size: attachment.byteSize,
      })),
    };
  };
  try {
    return await database.transaction(async (transaction) => execute(transaction as unknown as Db));
  } catch (error) {
    if (isUniqueViolation(error)) {
      return database.transaction(async (transaction) => execute(transaction as unknown as Db));
    }
    throw error;
  }
}

/** Cheap, side-effect-free rejection pass before the API writes multipart bytes to object storage. */
export async function preflightRunPromptUpload(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  text: string;
  idempotencyKey: string;
  attachments: CreateRunAttachment[];
  reactivationAvailable?: boolean;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  validateRunMessageAttachments({ text: input.text.trim(), attachments: input.attachments });
  const run = await ownedRun({ ...input, database });
  const replay = await database
    .select({ id: schema.skillRunPrompts.id })
    .from(schema.skillRunPrompts)
    .where(and(
      eq(schema.skillRunPrompts.orgId, input.orgId),
      eq(schema.skillRunPrompts.runId, input.runId),
      eq(schema.skillRunPrompts.idempotencyKey, input.idempotencyKey),
    ));
  if (replay[0]) return;
  const terminalReactivation = run.status === "frozen" || run.status === "canceled";
  if (terminalReactivation) {
    if (!input.reactivationAvailable) {
      throw new RunValidationError("RunSkill is unavailable because no configured run worker is currently online.", "runtime_unavailable");
    }
    if (
      run.sandboxCleanedAt !== null
      || run.reactivatableUntil === null
      || run.reactivatableUntil.getTime() <= Date.now()
      || run.cleanupLeaseOwner !== null
    ) {
      throw new RunBusyError("this run can no longer be reactivated", "run_reactivation_expired");
    }
  } else if (run.status !== "running" || run.cancelRequestedAt !== null || ["freeze", "cancel", "cleanup", "complete"].includes(run.phase)) {
    throw new RunBusyError("this run is not ready for another prompt", "run_not_running");
  }
  const active = await database
    .select({ id: schema.skillRunPrompts.id })
    .from(schema.skillRunPrompts)
    .where(and(
      eq(schema.skillRunPrompts.orgId, input.orgId),
      eq(schema.skillRunPrompts.runId, input.runId),
      inArray(schema.skillRunPrompts.status, ["queued", "processing"]),
    ));
  if (active[0]) throw new RunBusyError("another prompt is already pending", "prompt_already_pending");
  const attachmentWorkerReady = terminalReactivation
    ? await isAnyRunAttachmentWorkerReady(database)
    : await isRunAttachmentWorkerReady({
        orgId: input.orgId,
        runId: input.runId,
        creatorId: input.actor.id,
        database,
      });
  if (!attachmentWorkerReady) {
    throw new RunBusyError("this run's worker cannot accept attachments yet", "attachment_worker_unavailable");
  }
  const bytes = await database
    .select({ value: sql<number>`coalesce(sum(${schema.skillRunAttachments.byteSize}), 0)` })
    .from(schema.skillRunAttachments)
    .where(and(eq(schema.skillRunAttachments.orgId, input.orgId), eq(schema.skillRunAttachments.runId, input.runId)));
  validateRunMessageAttachments({
    text: input.text.trim(),
    attachments: input.attachments,
    existingBytes: Number(bytes[0]?.value ?? 0),
  });
}

/**
 * Atomically close follow-up admission before inactivity teardown. Enqueue takes the same run lock,
 * so it either wins first (and this returns `prompt_pending`) or observes phase=freeze and rejects.
 */
export async function beginRunFreeze(input: {
  actor: ActorContext;
  orgId: string;
  runId: string;
  workerId: string;
  database?: Db;
}): Promise<"ready" | "prompt_pending" | "cancel_requested" | "lost_lease"> {
  const database = input.database ?? db;
  const now = new Date();
  try {
    return await database.transaction(async (transaction) => {
      const tx = transaction as unknown as Db;
      const run = await ownedRun({ ...input, database: tx, lock: true });
      const jobs = await tx
        .select({ id: schema.skillRunJobs.id })
        .from(schema.skillRunJobs)
        .where(
          and(
            eq(schema.skillRunJobs.orgId, input.orgId),
            eq(schema.skillRunJobs.runId, input.runId),
            eq(schema.skillRunJobs.creatorId, input.actor.id),
            eq(schema.skillRunJobs.status, "leased"),
            eq(schema.skillRunJobs.leaseOwner, input.workerId),
            sql`${schema.skillRunJobs.leaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .for("update");
      if (!jobs[0]) throw new LostRunLeaseError();
      if (run.cancelRequestedAt !== null || run.status === "canceled") return "cancel_requested";
      if (run.status !== "running") throw new LostRunLeaseError();
      const prompts = await tx
        .select({ id: schema.skillRunPrompts.id })
        .from(schema.skillRunPrompts)
        .where(
          and(
            eq(schema.skillRunPrompts.orgId, input.orgId),
            eq(schema.skillRunPrompts.runId, input.runId),
            inArray(schema.skillRunPrompts.status, ["queued", "processing"]),
          ),
        )
        .limit(1);
      if (prompts[0]) return "prompt_pending";
      const runs = await tx
        .update(schema.skillRuns)
        .set({ phase: "freeze", updatedAt: now })
        .where(
          and(
            eq(schema.skillRuns.orgId, input.orgId),
            eq(schema.skillRuns.id, input.runId),
            eq(schema.skillRuns.creatorId, input.actor.id),
            eq(schema.skillRuns.status, "running"),
            isNull(schema.skillRuns.cancelRequestedAt),
          ),
        )
        .returning({ id: schema.skillRuns.id });
      if (!runs[0]) throw new LostRunLeaseError();
      const updatedJobs = await tx
        .update(schema.skillRunJobs)
        .set({ phase: "freeze", updatedAt: now })
        .where(
          and(
            eq(schema.skillRunJobs.orgId, input.orgId),
            eq(schema.skillRunJobs.runId, input.runId),
            eq(schema.skillRunJobs.status, "leased"),
            eq(schema.skillRunJobs.leaseOwner, input.workerId),
            sql`${schema.skillRunJobs.leaseExpiresAt} > clock_timestamp()`,
          ),
        )
        .returning({ id: schema.skillRunJobs.id });
      if (!updatedJobs[0]) throw new LostRunLeaseError();
      return "ready";
    });
  } catch (error) {
    if (error instanceof LostRunLeaseError) return "lost_lease";
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
    await assertLiveRunJobLease({ ...input, database: tx });
    if (run.status !== "running" || run.cancelRequestedAt !== null) return null;
    const rows = await tx
      .select()
      .from(schema.skillRunPrompts)
      .where(
        and(
          eq(schema.skillRunPrompts.orgId, input.orgId),
          eq(schema.skillRunPrompts.runId, input.runId),
          sql`${schema.skillRunPrompts.availableAt} <= clock_timestamp()`,
          or(
            and(eq(schema.skillRunPrompts.status, "queued"), lt(schema.skillRunPrompts.attempt, 10)),
            and(
              eq(schema.skillRunPrompts.status, "processing"),
              sql`${schema.skillRunPrompts.leaseExpiresAt} <= clock_timestamp()`,
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
        // Lease recovery resumes the already-persisted deterministic message id. Only a prompt
        // explicitly returned to `queued` by failRunPrompt consumes another execution attempt.
        attempt: prompt.status === "queued" ? prompt.attempt + 1 : prompt.attempt,
        leaseReclaimCount:
          prompt.status === "processing" ? prompt.leaseReclaimCount + 1 : prompt.leaseReclaimCount,
        leaseOwner: input.workerId,
        leaseExpiresAt: sql`clock_timestamp() + make_interval(secs => ${leaseSeconds})`,
        heartbeatAt: sql`clock_timestamp()`,
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
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await ownedRun({ ...input, database: tx, lock: true });
    await assertLiveRunJobLease({ ...input, database: tx });
    const now = new Date();
    const rows = await tx
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
          sql`${schema.skillRunPrompts.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: schema.skillRunPrompts.id });
    return Boolean(rows[0]);
  });
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
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await ownedRun({ ...input, database: tx, lock: true });
    await assertLiveRunJobLease({ ...input, database: tx });
    const now = new Date();
    const rows = await tx
      .update(schema.skillRunPrompts)
      .set({
        heartbeatAt: sql`clock_timestamp()`,
        leaseExpiresAt: sql`clock_timestamp() + make_interval(secs => ${leaseSeconds})`,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.skillRunPrompts.orgId, input.orgId),
          eq(schema.skillRunPrompts.runId, input.runId),
          eq(schema.skillRunPrompts.id, input.promptId),
          eq(schema.skillRunPrompts.status, "processing"),
          eq(schema.skillRunPrompts.leaseOwner, input.workerId),
          sql`${schema.skillRunPrompts.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: schema.skillRunPrompts.id });
    return Boolean(rows[0]);
  });
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
  const retry = input.retry ?? false;
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    await ownedRun({ ...input, database: tx, lock: true });
    await assertLiveRunJobLease({ ...input, database: tx });
    const now = new Date();
    const rows = await tx
      .update(schema.skillRunPrompts)
      .set({
        status: retry ? "queued" : "error",
        availableAt: retry ? new Date(now.getTime() + (input.backoffMs ?? 1_000)) : now,
        leaseOwner: null,
        leaseExpiresAt: null,
        heartbeatAt: now,
        errorCode: input.errorCode,
        userMessage: input.userMessage,
        updatedAt: now,
      })
      .where(
        and(
          eq(schema.skillRunPrompts.orgId, input.orgId),
          eq(schema.skillRunPrompts.runId, input.runId),
          eq(schema.skillRunPrompts.id, input.promptId),
          eq(schema.skillRunPrompts.status, "processing"),
          eq(schema.skillRunPrompts.leaseOwner, input.workerId),
          sql`${schema.skillRunPrompts.leaseExpiresAt} > clock_timestamp()`,
        ),
      )
      .returning({ id: schema.skillRunPrompts.id });
    return Boolean(rows[0]);
  });
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
      const reactivatableUntil = new Date(now.getTime() + RUN_REACTIVATION_RETENTION_MS);
      await tx
        .update(schema.skillRuns)
        .set({
          status: "canceled",
          phase: "complete",
          cancelRequestedAt: now,
          frozenAt: now,
          reactivatableUntil,
          sandboxCleanedAt: null,
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
  /** When supplied, recorder writes are accepted only while this worker owns an unexpired job lease. */
  workerId?: string;
  redactor?: RunRedactor;
  database?: Db;
}): Promise<RunEventEnvelope[]> {
  if (input.events.length === 0) return [];
  const database = input.database ?? db;
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const runs = await tx
      .select({
        id: schema.skillRuns.id,
        warnings: schema.skillRuns.warnings,
        transcriptEventSequence: schema.skillRuns.transcriptEventSequence,
      })
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
    await assertLiveRunJobLease({ ...input, database: tx });
    const sequenceRows = await tx
      .select({ value: max(schema.skillRunEvents.sequence) })
      .from(schema.skillRunEvents)
      .where(and(eq(schema.skillRunEvents.orgId, input.orgId), eq(schema.skillRunEvents.runId, input.runId)));
    const first = Math.max(Number(sequenceRows[0]?.value ?? 0), run.transcriptEventSequence) + 1;
    const normalized = redactAndBoundRunEvents(input.events, input.redactor).map((event) =>
      runChatEventSchema.parse(event),
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
  /** Optional event committed with the snapshot so SSE observes only a matching watermark. */
  barrierEvent?: RunChatEvent;
  /** Worker-owned snapshots must not outlive their orchestration lease. */
  workerId?: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  return database.transaction(async (transaction) => {
    const tx = transaction as unknown as Db;
    const runs = await tx
      .select({ id: schema.skillRuns.id, transcriptEventSequence: schema.skillRuns.transcriptEventSequence })
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
    await assertLiveRunJobLease({ ...input, database: tx });
    const promptRows = await tx
      .select({ messageId: schema.skillRunPrompts.messageId, userText: schema.skillRunPrompts.userText })
      .from(schema.skillRunPrompts)
      .where(
        and(
          eq(schema.skillRunPrompts.orgId, input.orgId),
          eq(schema.skillRunPrompts.runId, input.runId),
        ),
      )
      .orderBy(asc(schema.skillRunPrompts.ordinal));
    const visibleItems = normalizeRunTranscript(input.items, promptRows);
    const transcript = capTranscript(input.redactor.redactPayload(visibleItems));
    const sequenceRows = await tx
      .select({ value: max(schema.skillRunEvents.sequence) })
      .from(schema.skillRunEvents)
      .where(and(eq(schema.skillRunEvents.orgId, input.orgId), eq(schema.skillRunEvents.runId, input.runId)));
    let transcriptSequence = Math.max(
      Number(sequenceRows[0]?.value ?? 0),
      runs[0]?.transcriptEventSequence ?? 0,
    );
    if (input.barrierEvent) {
      const barrier = runChatEventSchema.parse(
        input.redactor.redactPayload(input.barrierEvent),
      );
      transcriptSequence += 1;
      await tx.insert(schema.skillRunEvents).values({
        orgId: input.orgId,
        runId: input.runId,
        sequence: transcriptSequence,
        ...eventParts(barrier),
      });
    }
    const rows = await tx
      .update(schema.skillRuns)
      .set({
        transcript,
        transcriptEventSequence: transcriptSequence,
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
