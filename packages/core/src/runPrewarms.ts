import { randomUUID } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type { RunPrewarmTicket } from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import { canAccessSkill } from "./authz";
import { assertMember, type ActorContext } from "./services";
import {
  buildSkillBundle,
  resolveRunRuntimeContext,
  resolveRunDependencyClosure,
  type ResolvedRunSkill,
  type RunControlContext,
} from "./skillRuns";
import type { SkillArchiveFetcher, SkillBundle } from "./runRuntime";

export const RUN_PREWARM_CLIENT_LEASE_MS = 30_000;
export const RUN_PREWARM_MAX_AGE_MS = 5 * 60_000;
export const RUN_PREWARM_MAX_PER_CREATOR = 2;

export type RunPrewarmRow = typeof schema.skillRunPrewarms.$inferSelect;

export interface ClaimedRunPrewarm extends RunPrewarmRow {}

export interface RunPrewarmPlan {
  row: RunPrewarmRow;
  skills: Array<{ slug: string; version: string; storagePath: string }>;
}

export interface AdoptedRunPrewarm {
  id: string;
  status: RunPrewarmRow["status"];
  phase: RunPrewarmRow["phase"];
  sandboxName: string;
  sandboxId: string | null;
  sandboxDomain: string | null;
  leaseExpiresAt: Date | null;
}

export function sandboxNameForPrewarm(id: string): string {
  return `prewarm-${id.toLowerCase()}`;
}

function ticket(row: RunPrewarmRow): RunPrewarmTicket {
  return { id: row.id, status: row.status, expires_at: row.absoluteExpiresAt.toISOString() };
}

/** Create a secretless warm-up and immutable skill closure, bounded per member. */
export async function createRunPrewarm(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  ctx: RunControlContext;
  database?: Db;
}): Promise<RunPrewarmTicket | null> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const ctx = await resolveRunRuntimeContext(input.ctx, database);
  if (ctx.runtimeAvailable === false || !ctx.goldenSnapshotId) return null;
  const skills = await database
    .select({
      id: schema.skills.id,
      currentVersionId: schema.skills.currentVersionId,
      scope: schema.skills.scope,
      creatorId: schema.skills.creatorId,
      archivedAt: schema.skills.archivedAt,
    })
    .from(schema.skills)
    .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, input.slug)));
  const skill = skills[0];
  if (!skill || skill.archivedAt || !skill.currentVersionId || !canAccessSkill(input.actor.id, skill)) return null;
  const closure = await resolveRunDependencyClosure({
    actor: input.actor,
    orgId: input.orgId,
    slug: input.slug,
    skillVersionId: skill.currentVersionId,
    database,
  });
  const create = async (transaction: Db): Promise<RunPrewarmTicket | null> => {
    await transaction.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:run-prewarm:${input.orgId}:${input.actor.id}`}))`);
    const now = new Date();
    const active = await transaction
      .select({ id: schema.skillRunPrewarms.id })
      .from(schema.skillRunPrewarms)
      .where(and(
        eq(schema.skillRunPrewarms.orgId, input.orgId),
        eq(schema.skillRunPrewarms.creatorId, input.actor.id),
        isNull(schema.skillRunPrewarms.adoptedRunId),
        isNull(schema.skillRunPrewarms.sandboxCleanedAt),
        inArray(schema.skillRunPrewarms.status, ["queued", "warming", "ready"]),
        gt(schema.skillRunPrewarms.clientLeaseExpiresAt, now),
        gt(schema.skillRunPrewarms.absoluteExpiresAt, now),
      ));
    if (active.length >= RUN_PREWARM_MAX_PER_CREATOR) return null;
    const id = randomUUID();
    const inserted = await transaction
      .insert(schema.skillRunPrewarms)
      .values({
        id,
        orgId: input.orgId,
        skillId: closure[0]!.skill_id,
        creatorId: input.actor.id,
        skillVersionId: closure[0]!.skill_version_id,
        sandboxName: sandboxNameForPrewarm(id),
        goldenSnapshotId: ctx.goldenSnapshotId!,
        timeoutMs: ctx.timeoutMs,
        clientLeaseExpiresAt: new Date(now.getTime() + RUN_PREWARM_CLIENT_LEASE_MS),
        absoluteExpiresAt: new Date(now.getTime() + RUN_PREWARM_MAX_AGE_MS),
      })
      .returning();
    const row = inserted[0]!;
    await transaction.insert(schema.skillRunPrewarmSkills).values(closure.map((item) => ({
      orgId: input.orgId,
      prewarmId: id,
      skillId: item.skill_id,
      skillVersionId: item.skill_version_id,
      isRoot: item.root,
      mountOrder: item.mountOrder,
    })));
    return ticket(row);
  };
  return database.transaction((transaction) => create(transaction as unknown as Db));
}

export async function heartbeatRunPrewarm(input: {
  actor: ActorContext;
  orgId: string;
  prewarmId: string;
  database?: Db;
}): Promise<RunPrewarmTicket | null> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const rows = await database
    .update(schema.skillRunPrewarms)
    .set({
      clientLeaseExpiresAt: sql`LEAST(${schema.skillRunPrewarms.absoluteExpiresAt}, clock_timestamp() + interval '30 seconds')`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.skillRunPrewarms.orgId, input.orgId),
      eq(schema.skillRunPrewarms.id, input.prewarmId),
      eq(schema.skillRunPrewarms.creatorId, input.actor.id),
      isNull(schema.skillRunPrewarms.adoptedRunId),
      inArray(schema.skillRunPrewarms.status, ["queued", "warming", "ready"]),
      gt(schema.skillRunPrewarms.absoluteExpiresAt, new Date()),
    ))
    .returning();
  return rows[0] ? ticket(rows[0]) : null;
}

/** Idempotent browser abandonment. An already-adopted sandbox belongs to its run and is untouched. */
export async function cancelRunPrewarm(input: {
  actor: ActorContext;
  orgId: string;
  prewarmId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await database
    .update(schema.skillRunPrewarms)
    .set({ status: "canceled", updatedAt: new Date() })
    .where(and(
      eq(schema.skillRunPrewarms.orgId, input.orgId),
      eq(schema.skillRunPrewarms.id, input.prewarmId),
      eq(schema.skillRunPrewarms.creatorId, input.actor.id),
      isNull(schema.skillRunPrewarms.adoptedRunId),
      inArray(schema.skillRunPrewarms.status, ["queued", "warming", "ready"]),
    ));
}

/** Atomically transfer a compatible live warm-up to the run. Invalid tickets are a cold miss. */
export async function adoptRunPrewarm(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  runId: string;
  prewarmId?: string | null;
  closure: ResolvedRunSkill[];
  goldenSnapshotId: string;
  timeoutMs: number;
}): Promise<AdoptedRunPrewarm | null> {
  if (!input.prewarmId) return null;
  const rows = await input.database
    .select()
    .from(schema.skillRunPrewarms)
    .where(and(
      eq(schema.skillRunPrewarms.orgId, input.orgId),
      eq(schema.skillRunPrewarms.id, input.prewarmId),
      eq(schema.skillRunPrewarms.creatorId, input.actor.id),
    ))
    .for("update");
  const row = rows[0];
  const now = Date.now();
  if (!row || row.adoptedRunId || row.sandboxCleanedAt || !["queued", "warming", "ready"].includes(row.status)
    || row.clientLeaseExpiresAt.getTime() <= now || row.absoluteExpiresAt.getTime() <= now
    || row.goldenSnapshotId !== input.goldenSnapshotId || row.timeoutMs !== input.timeoutMs) return null;
  const pins = await input.database
    .select()
    .from(schema.skillRunPrewarmSkills)
    .where(and(eq(schema.skillRunPrewarmSkills.orgId, input.orgId), eq(schema.skillRunPrewarmSkills.prewarmId, row.id)))
    .orderBy(asc(schema.skillRunPrewarmSkills.mountOrder));
  if (pins.length !== input.closure.length || pins.some((pin, index) => {
    const expected = input.closure[index];
    return !expected || pin.skillId !== expected.skill_id || pin.skillVersionId !== expected.skill_version_id;
  })) return null;
  await input.database
    .update(schema.skillRunPrewarms)
    .set({ adoptedRunId: input.runId, updatedAt: new Date() })
    .where(and(eq(schema.skillRunPrewarms.orgId, input.orgId), eq(schema.skillRunPrewarms.id, row.id), isNull(schema.skillRunPrewarms.adoptedRunId)));
  return {
    id: row.id,
    status: row.status,
    phase: row.phase,
    sandboxName: row.sandboxName,
    sandboxId: row.sandboxId,
    sandboxDomain: row.sandboxDomain,
    leaseExpiresAt: row.leaseExpiresAt,
  };
}

export async function getAdoptedRunPrewarm(input: {
  database: Db;
  orgId: string;
  runId: string;
  prewarmId: string;
}): Promise<AdoptedRunPrewarm | null> {
  const rows = await input.database.select().from(schema.skillRunPrewarms).where(and(
    eq(schema.skillRunPrewarms.orgId, input.orgId),
    eq(schema.skillRunPrewarms.id, input.prewarmId),
    eq(schema.skillRunPrewarms.adoptedRunId, input.runId),
  ));
  const row = rows[0];
  return row ? {
    id: row.id,
    status: row.status,
    phase: row.phase,
    sandboxName: row.sandboxName,
    sandboxId: row.sandboxId,
    sandboxDomain: row.sandboxDomain,
    leaseExpiresAt: row.leaseExpiresAt,
  } : null;
}

export async function claimRunPrewarms(input: {
  workerId: string;
  limit: number;
  leaseSeconds: number;
  database?: Db;
}): Promise<ClaimedRunPrewarm[]> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select claimed.id, claimed.org_id as "orgId", claimed.skill_id as "skillId",
      claimed.creator_id as "creatorId", claimed.skill_version_id as "skillVersionId",
      claimed.status, claimed.phase, claimed.sandbox_name as "sandboxName",
      claimed.sandbox_id as "sandboxId", claimed.sandbox_domain as "sandboxDomain",
      claimed.golden_snapshot_id as "goldenSnapshotId", claimed.timeout_ms as "timeoutMs",
      claimed.client_lease_expires_at as "clientLeaseExpiresAt",
      claimed.absolute_expires_at as "absoluteExpiresAt", claimed.adopted_run_id as "adoptedRunId",
      claimed.available_at as "availableAt", claimed.attempt, claimed.max_attempts as "maxAttempts",
      claimed.lease_owner as "leaseOwner", claimed.lease_expires_at as "leaseExpiresAt",
      claimed.heartbeat_at as "heartbeatAt", claimed.error_code as "errorCode",
      claimed.sandbox_cleaned_at as "sandboxCleanedAt", claimed.cleanup_lease_owner as "cleanupLeaseOwner",
      claimed.cleanup_lease_expires_at as "cleanupLeaseExpiresAt", claimed.created_at as "createdAt",
      claimed.updated_at as "updatedAt"
    from companion_claim_skill_run_prewarms(${input.workerId}, ${input.limit}, ${input.leaseSeconds}) as claimed
  `);
  return Array.from(result as unknown as Iterable<Record<string, unknown>>).map((raw) => ({
    ...raw,
    clientLeaseExpiresAt: new Date(raw.clientLeaseExpiresAt as string),
    absoluteExpiresAt: new Date(raw.absoluteExpiresAt as string),
    availableAt: new Date(raw.availableAt as string),
    leaseExpiresAt: raw.leaseExpiresAt ? new Date(raw.leaseExpiresAt as string) : null,
    heartbeatAt: raw.heartbeatAt ? new Date(raw.heartbeatAt as string) : null,
    cleanupLeaseExpiresAt: raw.cleanupLeaseExpiresAt ? new Date(raw.cleanupLeaseExpiresAt as string) : null,
    sandboxCleanedAt: raw.sandboxCleanedAt ? new Date(raw.sandboxCleanedAt as string) : null,
    createdAt: new Date(raw.createdAt as string),
    updatedAt: new Date(raw.updatedAt as string),
  }) as ClaimedRunPrewarm);
}

export async function loadRunPrewarmPlan(input: {
  actor: ActorContext;
  orgId: string;
  prewarmId: string;
  database?: Db;
}): Promise<RunPrewarmPlan> {
  const database = input.database ?? db;
  const rows = await database.select().from(schema.skillRunPrewarms).where(and(
    eq(schema.skillRunPrewarms.orgId, input.orgId),
    eq(schema.skillRunPrewarms.id, input.prewarmId),
    eq(schema.skillRunPrewarms.creatorId, input.actor.id),
  ));
  const row = rows[0];
  if (!row) throw new Error("prewarm not found");
  const skills = await database
    .select({ slug: schema.skills.slug, version: schema.skillVersions.version, storagePath: schema.skillVersions.storagePath })
    .from(schema.skillRunPrewarmSkills)
    .innerJoin(schema.skills, and(eq(schema.skills.orgId, schema.skillRunPrewarmSkills.orgId), eq(schema.skills.id, schema.skillRunPrewarmSkills.skillId)))
    .innerJoin(schema.skillVersions, and(eq(schema.skillVersions.orgId, schema.skillRunPrewarmSkills.orgId), eq(schema.skillVersions.id, schema.skillRunPrewarmSkills.skillVersionId)))
    .where(and(eq(schema.skillRunPrewarmSkills.orgId, input.orgId), eq(schema.skillRunPrewarmSkills.prewarmId, row.id)))
    .orderBy(asc(schema.skillRunPrewarmSkills.mountOrder));
  return { row, skills };
}

export async function materializeRunPrewarmSkills(
  plan: RunPrewarmPlan,
  fetchArchive: SkillArchiveFetcher,
  signal?: AbortSignal,
): Promise<SkillBundle[]> {
  return Promise.all(plan.skills.map((skill) => buildSkillBundle(skill.slug, skill.version, skill.storagePath, fetchArchive, signal)));
}

export async function updateClaimedRunPrewarm(input: {
  actor: ActorContext;
  orgId: string;
  prewarmId: string;
  workerId: string;
  phase?: RunPrewarmRow["phase"];
  status?: RunPrewarmRow["status"];
  sandboxId?: string;
  sandboxDomain?: string;
  errorCode?: string | null;
  complete?: boolean;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const rows = await database.update(schema.skillRunPrewarms).set({
    ...(input.phase ? { phase: input.phase } : {}),
    ...(input.status ? { status: input.status } : {}),
    ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
    ...(input.sandboxDomain ? { sandboxDomain: input.sandboxDomain } : {}),
    ...(input.errorCode !== undefined ? { errorCode: input.errorCode } : {}),
    ...(input.complete ? { leaseOwner: null, leaseExpiresAt: null } : {}),
    heartbeatAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(schema.skillRunPrewarms.orgId, input.orgId),
    eq(schema.skillRunPrewarms.id, input.prewarmId),
    eq(schema.skillRunPrewarms.creatorId, input.actor.id),
    eq(schema.skillRunPrewarms.status, "warming"),
    isNull(schema.skillRunPrewarms.sandboxCleanedAt),
    eq(schema.skillRunPrewarms.leaseOwner, input.workerId),
    gt(schema.skillRunPrewarms.leaseExpiresAt, new Date()),
  )).returning({ id: schema.skillRunPrewarms.id });
  return Boolean(rows[0]);
}

export async function heartbeatClaimedRunPrewarm(input: {
  actor: ActorContext;
  orgId: string;
  prewarmId: string;
  workerId: string;
  leaseSeconds: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const rows = await database.update(schema.skillRunPrewarms).set({
    heartbeatAt: new Date(),
    leaseExpiresAt: sql`clock_timestamp() + make_interval(secs => ${input.leaseSeconds})`,
    updatedAt: new Date(),
  }).where(and(
    eq(schema.skillRunPrewarms.orgId, input.orgId),
    eq(schema.skillRunPrewarms.id, input.prewarmId),
    eq(schema.skillRunPrewarms.creatorId, input.actor.id),
    inArray(schema.skillRunPrewarms.status, ["warming", "canceled"]),
    isNull(schema.skillRunPrewarms.sandboxCleanedAt),
    eq(schema.skillRunPrewarms.leaseOwner, input.workerId),
    gt(schema.skillRunPrewarms.leaseExpiresAt, new Date()),
  )).returning({ id: schema.skillRunPrewarms.id });
  return Boolean(rows[0]);
}

/**
 * Release a worker lease after any in-flight provider operation has settled. Persisting the
 * identity first lets cleanup destroy a sandbox that was canceled while its fork was in progress.
 */
export async function releaseClaimedRunPrewarm(input: {
  actor: ActorContext;
  orgId: string;
  prewarmId: string;
  workerId: string;
  sandboxId?: string;
  sandboxDomain?: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const rows = await database.update(schema.skillRunPrewarms).set({
    ...(input.sandboxId ? { sandboxId: input.sandboxId } : {}),
    ...(input.sandboxDomain ? { sandboxDomain: input.sandboxDomain } : {}),
    leaseOwner: null,
    leaseExpiresAt: null,
    heartbeatAt: new Date(),
    updatedAt: new Date(),
  }).where(and(
    eq(schema.skillRunPrewarms.orgId, input.orgId),
    eq(schema.skillRunPrewarms.id, input.prewarmId),
    eq(schema.skillRunPrewarms.creatorId, input.actor.id),
    inArray(schema.skillRunPrewarms.status, ["warming", "canceled", "failed"]),
    eq(schema.skillRunPrewarms.leaseOwner, input.workerId),
  )).returning({ id: schema.skillRunPrewarms.id });
  return Boolean(rows[0]);
}

export interface ClaimedRunPrewarmCleanup {
  orgId: string;
  id: string;
  creatorId: string;
  sandboxId: string | null;
  sandboxName: string;
  timeoutMs: number;
}

export async function claimRunPrewarmCleanups(input: {
  workerId: string;
  limit: number;
  leaseSeconds: number;
  database?: Db;
}): Promise<ClaimedRunPrewarmCleanup[]> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select org_id as "orgId", id, creator_id as "creatorId", sandbox_id as "sandboxId",
      sandbox_name as "sandboxName", timeout_ms as "timeoutMs"
    from companion_claim_skill_run_prewarm_cleanups(${input.workerId}, ${input.limit}, ${input.leaseSeconds})
  `);
  return Array.from(result as unknown as Iterable<ClaimedRunPrewarmCleanup>);
}

export async function completeRunPrewarmCleanup(input: {
  orgId: string;
  prewarmId: string;
  workerId: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select companion_complete_skill_run_prewarm_cleanup(${input.orgId}::uuid, ${input.prewarmId}::uuid, ${input.workerId}) as completed
  `);
  return Array.from(result as unknown as Iterable<{ completed: boolean }>)[0]?.completed === true;
}

export async function purgeRunPrewarms(input: { limit?: number; database?: Db } = {}): Promise<number> {
  const database = input.database ?? db;
  const result = await database.execute(sql`select companion_purge_skill_run_prewarms(${input.limit ?? 1000}) as count`);
  return Number(Array.from(result as unknown as Iterable<{ count: number | string }>)[0]?.count ?? 0);
}
