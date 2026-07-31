import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq, isNull, lt, sql } from "drizzle-orm";
import {
  gateSkillDatabaseSql,
  SKILL_DB_MAX_BYTES,
  SKILL_DB_MAX_RESULT_BYTES,
  SKILL_DB_MAX_RESULT_ROWS,
  SKILL_DB_RATE_LIMIT_PER_MINUTE,
  SKILL_DB_STATEMENT_TIMEOUT_MS,
  skillDatabaseDeclarationSchema,
  type SkillDatabaseAudience,
  type SkillDatabaseDeclaration,
  type SkillDatabaseStatementInput,
  type SkillDatabaseStatementMode,
  type SkillDatabaseStatementResult,
  type SkillDatabaseTable,
} from "@companion/contracts";
import { db, schema, withTenantContext, type Db, type SkillDatabaseStoredColumn } from "@companion/db";
import { canAccessSkill, canAccessSkillDatabaseRealm } from "./authz";
import {
  SkillDatabaseError,
  type SkillDatabaseRuntime,
  type SkillDatabaseStorage,
} from "./skillDatabaseRuntime";

export interface SkillDatabaseActor {
  id: string;
  email: string;
  name: string;
}

export type SkillDatabaseServiceErrorCode =
  | "skill_not_found"
  | "skill_database_not_declared"
  | "skill_database_no_realm"
  | "skill_database_rate_limited"
  | "skill_database_archived"
  | "skill_database_disabled";

export class SkillDatabaseServiceError extends Error {
  readonly code: SkillDatabaseServiceErrorCode;

  constructor(code: SkillDatabaseServiceErrorCode, message: string) {
    super(message);
    this.name = "SkillDatabaseServiceError";
    this.code = code;
  }
}

class SkillDatabaseRealmBusyError extends Error {
  constructor() {
    super("skill database realm is busy");
    this.name = "SkillDatabaseRealmBusyError";
  }
}

function stableDeclarationJson(declaration: SkillDatabaseDeclaration): string {
  const tables = Object.fromEntries(
    Object.entries(declaration.tables)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, table]) => [
        name,
        {
          audience: table.audience,
          columns: Object.fromEntries(Object.entries(table.columns).sort(([a], [b]) => a.localeCompare(b))),
          primary_key: table.primary_key,
          unique: table.unique,
        },
      ]),
  );
  return JSON.stringify({ tables });
}

function declarationChecksum(declaration: SkillDatabaseDeclaration): string {
  return `sha256:${createHash("sha256").update(stableDeclarationJson(declaration)).digest("hex")}`;
}

export function skillDatabasesEnabled(): boolean {
  return process.env.COMPANION_SKILL_DATABASES_ENABLED?.trim().toLowerCase() === "true";
}

function assertSkillDatabasesEnabled(): void {
  if (!skillDatabasesEnabled()) {
    throw new SkillDatabaseServiceError(
      "skill_database_disabled",
      "Skill Databases are not enabled for this deployment",
    );
  }
}

function declarationFromFrontmatter(frontmatter: string): {
  declared: boolean;
  declaration: SkillDatabaseDeclaration;
} {
  try {
    const stored = JSON.parse(frontmatter) as { companion?: { database?: unknown } };
    return {
      declared: stored.companion?.database !== undefined,
      declaration: skillDatabaseDeclarationSchema.parse(stored.companion?.database),
    };
  } catch (error) {
    throw new Error(`could not persist skill database declaration: ${(error as Error).message}`);
  }
}

function columnsFromTable(table: SkillDatabaseTable): SkillDatabaseStoredColumn[] {
  return Object.entries(table.columns).map(([name, column]) => ({
    name,
    type: column.type,
    nullable: column.nullable,
    ...(column.default !== undefined ? { default: column.default } : {}),
  }));
}

function normalizedConstraint(value: string[] | string[][]): string {
  return JSON.stringify(value);
}

function existingColumnMatches(
  existing: SkillDatabaseStoredColumn,
  desired: SkillDatabaseStoredColumn,
): boolean {
  return existing.name === desired.name
    && existing.type === desired.type
    && existing.nullable === desired.nullable
    && existing.default === desired.default;
}

/**
 * Persist the current manifest projection. Publishing is the compatibility gate; physical SQLite
 * files are migrated lazily when each realm is next opened.
 */
export async function persistSkillDatabaseDeclarations(input: {
  orgId: string;
  skillId: string;
  frontmatter: string;
  database: Db;
}): Promise<void> {
  // Serialize manifest projections per skill. Without this lock, concurrent additive publishes can
  // calculate the same generation from stale rows and leave a realm on an incomplete migration.
  await input.database.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`skilldb-schema:${input.skillId}`}, 0))`,
  );
  const parsed = declarationFromFrontmatter(input.frontmatter);
  const existingSchema = await input.database.query.skillDatabaseSchemas.findFirst({
    where: and(
      eq(schema.skillDatabaseSchemas.orgId, input.orgId),
      eq(schema.skillDatabaseSchemas.skillId, input.skillId),
    ),
  });
  if (parsed.declared || existingSchema) assertSkillDatabasesEnabled();
  if (!parsed.declared && !existingSchema) return;

  const declaration = parsed.declaration;
  const checksum = declarationChecksum(declaration);
  if (existingSchema?.declarationsChecksum === checksum) return;

  const existingTables = existingSchema
    ? await input.database
      .select()
      .from(schema.skillDatabaseTables)
      .where(and(
        eq(schema.skillDatabaseTables.orgId, input.orgId),
        eq(schema.skillDatabaseTables.skillId, input.skillId),
      ))
    : [];
  const existingByName = new Map(existingTables.map((table) => [table.tableName, table]));
  let ddlChanged = !existingSchema;
  const now = new Date();

  for (const [tableName, table] of Object.entries(declaration.tables)) {
    const existing = existingByName.get(tableName);
    const desiredColumns = columnsFromTable(table);
    if (existing) {
      if (
        existing.audience !== table.audience
        || normalizedConstraint(existing.primaryKey) !== normalizedConstraint(table.primary_key)
        || normalizedConstraint(existing.uniqueConstraints) !== normalizedConstraint(table.unique)
      ) {
        throw new Error(`incompatible database declaration for ${tableName}: audience, primary key, and unique constraints are immutable`);
      }
      const priorByName = new Map(existing.columns.map((column) => [column.name, column]));
      for (const desired of desiredColumns) {
        const prior = priorByName.get(desired.name);
        if (prior && !existingColumnMatches(prior, desired)) {
          throw new Error(`incompatible database declaration for ${tableName}.${desired.name}: existing columns are immutable`);
        }
        if (prior && "retiredAt" in prior) ddlChanged = true;
        if (!prior) {
          if (!desired.nullable && desired.default === undefined) {
            throw new Error(`incompatible database declaration for ${tableName}.${desired.name}: a new column must be nullable or have a default`);
          }
          ddlChanged = true;
        }
      }
      const desiredNames = new Set(desiredColumns.map((column) => column.name));
      for (const prior of existing.columns.filter((column) => !("retiredAt" in column))) {
        if (!desiredNames.has(prior.name) && !prior.nullable && prior.default === undefined) {
          throw new Error(
            `incompatible database declaration for ${tableName}.${prior.name}: a required column without a default cannot be retired`,
          );
        }
      }
      if (existing.retiredAt) {
        ddlChanged = true;
        const activePrior = existing.columns.filter((column) => !("retiredAt" in column));
        const desiredByName = new Map(desiredColumns.map((column) => [column.name, column]));
        if (
          activePrior.length !== desiredColumns.length
          || activePrior.some((column) => {
            const desired = desiredByName.get(column.name);
            return !desired || !existingColumnMatches(column, desired);
          })
        ) {
          throw new Error(`incompatible database declaration for ${tableName}: a retired table may only be restored unchanged`);
        }
      }
    } else {
      ddlChanged = true;
    }
  }

  const generation = existingSchema
    ? existingSchema.generation + (ddlChanged ? 1 : 0)
    : 1;
  await input.database
    .insert(schema.skillDatabaseSchemas)
    .values({
      orgId: input.orgId,
      skillId: input.skillId,
      generation,
      declarationsChecksum: checksum,
    })
    .onConflictDoUpdate({
      target: [schema.skillDatabaseSchemas.orgId, schema.skillDatabaseSchemas.skillId],
      set: { generation, declarationsChecksum: checksum, updatedAt: now },
    });

  for (const [tableName, table] of Object.entries(declaration.tables)) {
    const existing = existingByName.get(tableName);
    const desiredColumns = columnsFromTable(table);
    const desiredNames = new Set(desiredColumns.map((column) => column.name));
    const retainedColumns = [
      ...desiredColumns,
      ...(existing?.columns ?? [])
        .filter((column) => !desiredNames.has(column.name))
        .map((column) => ({ ...column, retiredAt: "retiredAt" in column ? column.retiredAt : now.toISOString() })),
    ];
    await input.database
      .insert(schema.skillDatabaseTables)
      .values({
        orgId: input.orgId,
        skillId: input.skillId,
        tableName,
        audience: table.audience,
        columns: retainedColumns,
        primaryKey: table.primary_key,
        uniqueConstraints: table.unique,
        retiredAt: null,
      })
      .onConflictDoUpdate({
        target: [
          schema.skillDatabaseTables.orgId,
          schema.skillDatabaseTables.skillId,
          schema.skillDatabaseTables.tableName,
        ],
        set: {
          columns: retainedColumns,
          retiredAt: null,
          updatedAt: now,
        },
      });
  }

  const desiredNames = new Set(Object.keys(declaration.tables));
  for (const existing of existingTables) {
    if (!desiredNames.has(existing.tableName) && !existing.retiredAt) {
      await input.database
        .update(schema.skillDatabaseTables)
        .set({ retiredAt: now, updatedAt: now })
        .where(and(
          eq(schema.skillDatabaseTables.orgId, input.orgId),
          eq(schema.skillDatabaseTables.skillId, input.skillId),
          eq(schema.skillDatabaseTables.tableName, existing.tableName),
        ));
    }
  }
}

function positiveEnv(name: string, fallback: number): number {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function skillDatabaseLimitsFromEnv() {
  return {
    maxBytes: positiveEnv("COMPANION_SKILL_DB_MAX_BYTES", SKILL_DB_MAX_BYTES),
    statementTimeoutMs: positiveEnv("COMPANION_SKILL_DB_STATEMENT_TIMEOUT_MS", SKILL_DB_STATEMENT_TIMEOUT_MS),
    maxResultRows: SKILL_DB_MAX_RESULT_ROWS,
    maxResultBytes: SKILL_DB_MAX_RESULT_BYTES,
  };
}

async function assertRateLimit(orgId: string, userId: string): Promise<void> {
  const limit = positiveEnv("COMPANION_SKILL_DB_RATE_LIMIT_PER_MINUTE", SKILL_DB_RATE_LIMIT_PER_MINUTE);
  const now = new Date();
  const windowStart = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const count = await withTenantContext({ orgId, userId }, async (database) => {
    const [row] = await database
      .insert(schema.skillDatabaseRateWindows)
      .values({ orgId, userId, windowStart, queryCount: 1 })
      .onConflictDoUpdate({
        target: [
          schema.skillDatabaseRateWindows.orgId,
          schema.skillDatabaseRateWindows.userId,
          schema.skillDatabaseRateWindows.windowStart,
        ],
        set: { queryCount: sql`${schema.skillDatabaseRateWindows.queryCount} + 1` },
      })
      .returning({ queryCount: schema.skillDatabaseRateWindows.queryCount });
    await database
      .delete(schema.skillDatabaseRateWindows)
      .where(and(
        eq(schema.skillDatabaseRateWindows.orgId, orgId),
        eq(schema.skillDatabaseRateWindows.userId, userId),
        lt(schema.skillDatabaseRateWindows.windowStart, windowStart),
      ));
    return row?.queryCount ?? limit + 1;
  });
  if (count > limit) {
    throw new SkillDatabaseServiceError("skill_database_rate_limited", "skill database rate limit exceeded");
  }
}

async function accessibleSkill(database: Db, actor: SkillDatabaseActor, orgId: string, slug: string) {
  const membership = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, actor.id)),
  });
  if (!membership) throw new Error("not a member of this organization");
  const skill = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, orgId), eq(schema.skills.slug, slug)),
  });
  if (!skill || !canAccessSkill(actor.id, skill)) {
    throw new SkillDatabaseServiceError("skill_not_found", "skill not found");
  }
  return skill;
}

/** Load the current manifest declaration for reconstruction paths such as browser inline edits. */
export async function getCurrentSkillDatabaseDeclaration(input: {
  actor: SkillDatabaseActor;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillDatabaseDeclaration> {
  const database = input.database ?? db;
  const skill = await accessibleSkill(database, input.actor, input.orgId, input.slug);
  if (!skill.currentVersionId) return { tables: {} };
  const version = await database.query.skillVersions.findFirst({
    where: and(
      eq(schema.skillVersions.orgId, input.orgId),
      eq(schema.skillVersions.id, skill.currentVersionId),
    ),
  });
  return version ? declarationFromFrontmatter(version.frontmatter).declaration : { tables: {} };
}

function tableFromStored(row: typeof schema.skillDatabaseTables.$inferSelect): SkillDatabaseTable {
  const columns = Object.fromEntries(
    row.columns
      .filter((column) => !("retiredAt" in column))
      .map((column) => [
        column.name,
        {
          type: column.type,
          nullable: column.nullable,
          ...(column.default !== undefined ? { default: column.default } : {}),
        },
      ]),
  );
  return {
    audience: row.audience,
    columns,
    primary_key: row.primaryKey,
    unique: row.uniqueConstraints,
  };
}

export async function describeSkillDatabase(input: {
  actor: SkillDatabaseActor;
  orgId: string;
  slug: string;
  database?: Db;
}) {
  assertSkillDatabasesEnabled();
  const database = input.database ?? db;
  const skill = await accessibleSkill(database, input.actor, input.orgId, input.slug);
  const databaseSchema = await database.query.skillDatabaseSchemas.findFirst({
    where: and(
      eq(schema.skillDatabaseSchemas.orgId, input.orgId),
      eq(schema.skillDatabaseSchemas.skillId, skill.id),
    ),
  });
  if (!databaseSchema) {
    throw new SkillDatabaseServiceError("skill_database_not_declared", "skill does not declare a database");
  }
  const tables = await database
    .select()
    .from(schema.skillDatabaseTables)
    .where(and(
      eq(schema.skillDatabaseTables.orgId, input.orgId),
      eq(schema.skillDatabaseTables.skillId, skill.id),
      isNull(schema.skillDatabaseTables.retiredAt),
    ));
  const realms = await database
    .select()
    .from(schema.skillDatabaseRealms)
    .where(and(
      eq(schema.skillDatabaseRealms.orgId, input.orgId),
      eq(schema.skillDatabaseRealms.skillId, skill.id),
    ));
  return {
    skill_id: skill.id,
    slug: skill.slug,
    schema_generation: databaseSchema.generation,
    limits: skillDatabaseLimitsFromEnv(),
    tables: tables.map((table) => ({
      name: table.tableName,
      audience: table.audience,
      columns: table.columns.filter((column) => !("retiredAt" in column)),
      primary_key: table.primaryKey,
      unique: table.uniqueConstraints,
    })),
    realms: realms
      .filter((realm) => canAccessSkillDatabaseRealm(input.actor.id, realm))
      .map((realm) => ({
        audience: realm.audience,
        size_bytes: realm.sizeBytes,
        schema_generation: realm.schemaGeneration,
        last_accessed_at: realm.lastAccessedAt.toISOString(),
      })),
  };
}

type SkillDatabaseStorageKey = (input: {
  orgId: string;
  skillId: string;
  realmId: string;
  audience: SkillDatabaseAudience;
  userId?: string;
}) => string;

type SkillDatabaseExecutionInput = {
  actor: SkillDatabaseActor;
  orgId: string;
  slug: string;
  statement: SkillDatabaseStatementInput;
  mode: SkillDatabaseStatementMode;
  runtime: SkillDatabaseRuntime;
  storage: SkillDatabaseStorage;
  storageKey: SkillDatabaseStorageKey;
};

/**
 * Commit the realm registry before any object-store write. If a later request crashes after S3
 * succeeds, the durable row remains available for recovery and eventual trigger-driven cleanup.
 */
async function ensureSkillDatabaseRealm(
  input: SkillDatabaseExecutionInput & { database: Db },
): Promise<string> {
  const database = input.database;
  const skill = await accessibleSkill(database, input.actor, input.orgId, input.slug);
  if (input.mode === "write" && skill.archivedAt) {
    throw new SkillDatabaseServiceError("skill_database_archived", "archived skill databases are read-only");
  }
  const databaseSchema = await database.query.skillDatabaseSchemas.findFirst({
    where: and(
      eq(schema.skillDatabaseSchemas.orgId, input.orgId),
      eq(schema.skillDatabaseSchemas.skillId, skill.id),
    ),
  });
  if (!databaseSchema) {
    throw new SkillDatabaseServiceError("skill_database_not_declared", "skill does not declare a database");
  }
  const declared = await database.query.skillDatabaseTables.findFirst({
    where: and(
      eq(schema.skillDatabaseTables.orgId, input.orgId),
      eq(schema.skillDatabaseTables.skillId, skill.id),
      eq(schema.skillDatabaseTables.audience, input.statement.audience),
      isNull(schema.skillDatabaseTables.retiredAt),
    ),
  });
  if (!declared) {
    throw new SkillDatabaseServiceError(
      "skill_database_no_realm",
      `skill does not declare ${input.statement.audience} database tables`,
    );
  }

  const ownerId = input.statement.audience === "personal" ? input.actor.id : null;
  const realmId = randomUUID();
  const storageKey = input.storageKey({
    orgId: input.orgId,
    skillId: skill.id,
    realmId,
    audience: input.statement.audience,
    ...(ownerId ? { userId: ownerId } : {}),
  });
  await database
    .insert(schema.skillDatabaseRealms)
    .values({
      id: realmId,
      orgId: input.orgId,
      skillId: skill.id,
      audience: input.statement.audience,
      ownerId,
      storageKey,
    })
    .onConflictDoNothing();
  const realm = await database.query.skillDatabaseRealms.findFirst({
    where: and(
      eq(schema.skillDatabaseRealms.orgId, input.orgId),
      eq(schema.skillDatabaseRealms.skillId, skill.id),
      eq(schema.skillDatabaseRealms.audience, input.statement.audience),
      ownerId ? eq(schema.skillDatabaseRealms.ownerId, ownerId) : isNull(schema.skillDatabaseRealms.ownerId),
    ),
  });
  if (!realm || !canAccessSkillDatabaseRealm(input.actor.id, realm)) {
    throw new SkillDatabaseServiceError("skill_database_no_realm", "skill database realm not found");
  }
  return realm.id;
}

async function executeSkillDatabaseStatementInTenant(input: SkillDatabaseExecutionInput & {
  realmId: string;
  gatedSql: string;
  database: Db;
}) {
  assertSkillDatabasesEnabled();
  const database = input.database;
  const skill = await accessibleSkill(database, input.actor, input.orgId, input.slug);
  if (input.mode === "write" && skill.archivedAt) {
    throw new SkillDatabaseServiceError("skill_database_archived", "archived skill databases are read-only");
  }
  // Publication owns this key exclusively while replacing generation + table projections.
  // Executions take it shared so different realms remain concurrent but each execution observes
  // one generation/table snapshot. Try-locking routes contention through the bounded outside-tx
  // retry loop instead of parking an application connection behind publication.
  const schemaLockResult = await database.execute(sql`
    select pg_try_advisory_xact_lock_shared(
      hashtextextended(${`skilldb-schema:${skill.id}`}, 0)
    ) as locked
  `);
  const schemaLocked = Array.from(
    schemaLockResult as unknown as Iterable<{ locked: boolean }>,
  )[0]?.locked;
  if (schemaLocked !== true) throw new SkillDatabaseRealmBusyError();
  const lockResult = await database.execute(sql`
    select pg_try_advisory_xact_lock(hashtextextended(${`skilldb:${input.realmId}`}, 0)) as locked
  `);
  const locked = Array.from(
    lockResult as unknown as Iterable<{ locked: boolean }>,
  )[0]?.locked;
  if (locked !== true) throw new SkillDatabaseRealmBusyError();
  const databaseSchema = await database.query.skillDatabaseSchemas.findFirst({
    where: and(
      eq(schema.skillDatabaseSchemas.orgId, input.orgId),
      eq(schema.skillDatabaseSchemas.skillId, skill.id),
    ),
  });
  if (!databaseSchema) {
    throw new SkillDatabaseServiceError("skill_database_not_declared", "skill does not declare a database");
  }
  const declared = await database
    .select()
    .from(schema.skillDatabaseTables)
    .where(and(
      eq(schema.skillDatabaseTables.orgId, input.orgId),
      eq(schema.skillDatabaseTables.skillId, skill.id),
      eq(schema.skillDatabaseTables.audience, input.statement.audience),
      isNull(schema.skillDatabaseTables.retiredAt),
    ));
  if (!declared.length) {
    throw new SkillDatabaseServiceError("skill_database_no_realm", `skill does not declare ${input.statement.audience} database tables`);
  }

  let realm;
  try {
    [realm] = await database
      .select()
      .from(schema.skillDatabaseRealms)
      .where(and(
        eq(schema.skillDatabaseRealms.id, input.realmId),
        eq(schema.skillDatabaseRealms.orgId, input.orgId),
        eq(schema.skillDatabaseRealms.skillId, skill.id),
        eq(schema.skillDatabaseRealms.audience, input.statement.audience),
      ))
      .limit(1)
      .for("update", { noWait: true });
  } catch (error) {
    if (
      error && typeof error === "object"
      && (
        ("code" in error && error.code === "55P03")
        || ("cause" in error && error.cause && typeof error.cause === "object"
          && "code" in error.cause && error.cause.code === "55P03")
      )
    ) {
      throw new SkillDatabaseRealmBusyError();
    }
    throw error;
  }
  if (!realm || !canAccessSkillDatabaseRealm(input.actor.id, realm)) {
    throw new SkillDatabaseServiceError("skill_database_no_realm", "skill database realm not found");
  }
  // Keep the database connection and realm lock bounded even when object storage stalls. One
  // deadline covers both reads and writes, including SQLite execution between them.
  const storageSignal = AbortSignal.timeout(
    positiveEnv("COMPANION_SKILL_DB_STORAGE_TIMEOUT_MS", 5_000),
  );
  let stored;
  try {
    stored = await input.storage.get(realm.storageKey, storageSignal);
  } catch (error) {
    if (error instanceof SkillDatabaseError) throw error;
    throw new SkillDatabaseError("storage_unavailable", "skill database storage is unavailable", { cause: error });
  }
  if (
    !stored
    && (realm.etag !== null || realm.sizeBytes > 0 || realm.schemaGeneration > 0)
  ) {
    throw new SkillDatabaseError(
      "storage_unavailable",
      "skill database object is missing; restore it from object storage version history",
    );
  }
  let runtimeResult;
  try {
    runtimeResult = await input.runtime.execute({
      image: stored?.body ?? null,
      tables: Object.fromEntries(declared.map((table) => [table.tableName, tableFromStored(table)])),
      schemaGeneration: databaseSchema.generation,
      fileSchemaGeneration: realm.schemaGeneration,
      sql: input.gatedSql,
      params: input.statement.params,
      mode: input.mode,
      limits: skillDatabaseLimitsFromEnv(),
      signal: storageSignal,
      queueIfBusy: false,
    });
  } catch (error) {
    if (error instanceof SkillDatabaseError) throw error;
    throw new SkillDatabaseError("sql_error", (error as Error).message, { cause: error });
  }

  let etag = stored?.etag ?? realm.etag;
  if (runtimeResult.image) {
    try {
      const put = await input.storage.put(
        realm.storageKey,
        runtimeResult.image,
        stored ? { ifMatch: stored.etag } : { ifNoneMatch: "*" },
        storageSignal,
      );
      etag = put.etag;
    } catch (error) {
      if (error instanceof SkillDatabaseError) throw error;
      throw new SkillDatabaseError("storage_unavailable", "skill database storage is unavailable", { cause: error });
    }
  }
  const [updatedRealm] = await database
    .update(schema.skillDatabaseRealms)
    .set({
      ...(runtimeResult.image
        ? {
          sizeBytes: runtimeResult.dbSizeBytes,
          etag,
          schemaGeneration: databaseSchema.generation,
        }
        : {}),
      lastAccessedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(schema.skillDatabaseRealms.id, realm.id))
    .returning({ id: schema.skillDatabaseRealms.id });
  if (!updatedRealm) {
    throw new SkillDatabaseError("storage_unavailable", "skill database realm disappeared during execution");
  }
  return {
    columns: runtimeResult.columns,
    rows: runtimeResult.rows,
    row_count: runtimeResult.rows.length,
    changes: runtimeResult.changes,
    last_insert_rowid: runtimeResult.lastInsertRowid,
    read_only: runtimeResult.readOnly,
    db_size_bytes: runtimeResult.dbSizeBytes,
    schema_generation: databaseSchema.generation,
  };
}

/**
 * Execute outside an API-owned transaction. Rate accounting completes first, then the tenant
 * transaction owns the realm advisory lock for the full read/execute/write cycle.
 */
export async function executeSkillDatabaseStatement(
  input: SkillDatabaseExecutionInput,
): Promise<SkillDatabaseStatementResult> {
  assertSkillDatabasesEnabled();
  let gated;
  try {
    gated = gateSkillDatabaseSql(input.statement.sql, input.mode);
  } catch (error) {
    throw new SkillDatabaseError("forbidden_statement", (error as Error).message, { cause: error });
  }
  await assertRateLimit(input.orgId, input.actor.id);
  const realmId = await withTenantContext(
    { orgId: input.orgId, userId: input.actor.id },
    (database) => ensureSkillDatabaseRealm({ ...input, database }),
  );
  const lockWaitMs = positiveEnv(
    "COMPANION_SKILL_DB_LOCK_WAIT_MS",
    skillDatabaseLimitsFromEnv().statementTimeoutMs + 500,
  );
  const deadline = Date.now() + lockWaitMs;
  for (;;) {
    try {
      return await withTenantContext(
        { orgId: input.orgId, userId: input.actor.id },
        (database) => executeSkillDatabaseStatementInTenant({
          ...input,
          realmId,
          gatedSql: gated.sql,
          database,
        }),
      );
    } catch (error) {
      if (!(error instanceof SkillDatabaseRealmBusyError)) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SkillDatabaseError("overloaded", "skill database realm is busy; retry later");
      }
      // Wait outside PostgreSQL so a hot realm cannot consume the application connection pool.
      await delay(Math.min(25, remaining));
    }
  }
}
