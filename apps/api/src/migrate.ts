import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const MIGRATION_LOCK_CLASS_ID = 72_401;
const MIGRATION_LOCK_OBJECT_ID = 20_260_608;
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;
const RUNTIME_GRANTS_BEGIN = "-- companion-runtime-grants-begin";
const RUNTIME_GRANTS_END = "-- companion-runtime-grants-end";
const DATABASE_ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;

export const CUTOVER_GUARD_SQLSTATE = "55000";
export const CUTOVER_GUARD_MESSAGE = "Skills Hub-only migration requires runtime resource cleanup first";
export const SKILLS_HUB_CUTOVER_ACK_ENV = "COMPANION_SKILLS_HUB_CUTOVER_ACK";
export const SKILLS_HUB_CUTOVER_ACK_VALUE = "external-cleanup-complete";

/**
 * Every table `0063_skills_hub_only.sql` drops. Nothing the Skills Hub keeps references them, so
 * emptying the whole set in one statement satisfies the migration's fail-closed guard without
 * depending on delete ordering. `migrate.test.ts` keeps this list identical to the migration.
 */
export const SKILLS_HUB_RETIRED_TABLES = [
  "project_model_provider_inputs",
  "project_secret_inputs",
  "project_file_versions",
  "project_files",
  "project_attachments",
  "project_attachment_uploads",
  "project_questions",
  "project_session_events",
  "project_prompts",
  "project_sessions",
  "project_skill_snapshots",
  "project_skills",
  "project_workspaces",
  "project_worker_lease_contexts",
  "project_worker_heartbeats",
  "projects",
  "skill_run_artifacts",
  "skill_run_attachment_uploads",
  "skill_run_attachments",
  "skill_run_events",
  "skill_run_prompts",
  "skill_run_worker_heartbeats",
  "skill_run_jobs",
  "skill_run_variable_inputs",
  "skill_run_model_provider_inputs",
  "skill_run_secret_inputs",
  "skill_run_skills",
  "skill_runs",
  "skill_run_prewarm_skills",
  "skill_run_prewarms",
  "sandbox_usage_sessions",
  "user_run_preferences",
  "skill_run_config_variables",
  "skill_run_config_secrets",
  "skill_run_configs",
  "model_provider_credential_versions",
  "model_provider_connections",
  "user_model_preferences",
  "org_model_preferences",
] as const;

export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_MIGRATION_URL or DATABASE_URL is required to apply database migrations");
  }
  return url;
}

export function databaseRuntimeRole(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.DATABASE_RUNTIME_ROLE;
  if (configured === undefined || configured === "") return null;
  if (configured !== configured.trim() || !DATABASE_ROLE_PATTERN.test(configured)) {
    throw new Error("DATABASE_RUNTIME_ROLE must be a lowercase PostgreSQL identifier (1-63 characters)");
  }
  return configured;
}

export interface DatabaseRuntimeRoles {
  apiRole: string;
  workerRole: string;
  legacySingleRole: boolean;
  retiredRuntimeRole: string | null;
}

function databaseRole(name: string, configured: string | undefined): string | null {
  if (configured === undefined || configured === "") return null;
  if (configured !== configured.trim() || !DATABASE_ROLE_PATTERN.test(configured)) {
    throw new Error(`${name} must be a lowercase PostgreSQL identifier (1-63 characters)`);
  }
  return configured;
}

export function databaseRuntimeRoles(env: NodeJS.ProcessEnv = process.env): DatabaseRuntimeRoles | null {
  const apiRole = databaseRole("DATABASE_API_ROLE", env.DATABASE_API_ROLE);
  const workerRole = databaseRole("DATABASE_WORKER_ROLE", env.DATABASE_WORKER_ROLE);
  const legacyRole = databaseRuntimeRole(env);
  const retiredRuntimeRole = databaseRole(
    "DATABASE_RETIRED_RUNTIME_ROLE",
    env.DATABASE_RETIRED_RUNTIME_ROLE,
  );

  if (apiRole !== null || workerRole !== null) {
    if (legacyRole !== null) {
      throw new Error("DATABASE_RUNTIME_ROLE cannot be combined with DATABASE_API_ROLE or DATABASE_WORKER_ROLE");
    }
    if (apiRole === null || workerRole === null) {
      throw new Error("DATABASE_API_ROLE and DATABASE_WORKER_ROLE must be configured together");
    }
    if (apiRole === workerRole) {
      throw new Error("DATABASE_API_ROLE and DATABASE_WORKER_ROLE must be distinct");
    }
    return { apiRole, workerRole, legacySingleRole: false, retiredRuntimeRole };
  }

  if (retiredRuntimeRole !== null) {
    throw new Error(
      "DATABASE_RETIRED_RUNTIME_ROLE requires DATABASE_API_ROLE and DATABASE_WORKER_ROLE",
    );
  }
  if (legacyRole === null) return null;
  return {
    apiRole: legacyRole,
    workerRole: legacyRole,
    legacySingleRole: true,
    retiredRuntimeRole: null,
  };
}

/**
 * Migration 0063 refuses to drop the runtime tables while they still hold the only references to
 * externally provisioned objects. A deployment whose previous release already stopped running the
 * cleanup worker can no longer drain them from the product, so the operator deletes those objects
 * with the storage and provider tooling and then acknowledges it here. The exact literal keeps a
 * generic truthy value from discarding rows whose external objects still exist.
 */
export function skillsHubCutoverAcknowledged(env: NodeJS.ProcessEnv = process.env): boolean {
  const configured = env[SKILLS_HUB_CUTOVER_ACK_ENV];
  if (configured === undefined || configured.trim() === "") return false;
  if (configured.trim() !== SKILLS_HUB_CUTOVER_ACK_VALUE) {
    throw new Error(
      `${SKILLS_HUB_CUTOVER_ACK_ENV} must be exactly "${SKILLS_HUB_CUTOVER_ACK_VALUE}" or unset`,
    );
  }
  return true;
}

export interface RetiredTableCount {
  table: string;
  rows: number;
}

async function retiredRuntimeTableCounts(
  client: ReturnType<typeof postgres>,
): Promise<RetiredTableCount[]> {
  const present = await client<{ name: string }[]>`
    select c.relname as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
      and c.relname = any(${[...SKILLS_HUB_RETIRED_TABLES]})
    order by c.relname
  `;
  if (present.length === 0) return [];

  const counts = present
    .map((row) => `select '${row.name}' as table_name, count(*)::bigint as rows from public."${row.name}"`)
    .join(" union all ");
  const rows = await client.unsafe<{ table_name: string; rows: string }[]>(counts);
  return rows.map((row) => ({ table: row.table_name, rows: Number(row.rows) }));
}

/**
 * Empty the retired runtime tables so migration 0063 observes a drained database. This runs only
 * with an explicit operator acknowledgement, only inside the migration lock, and is a no-op once
 * 0063 has dropped the tables, so the variable can stay set on the service without further effect.
 */
export async function drainRetiredRuntimeTables(
  client: ReturnType<typeof postgres>,
  log: (message: string) => void = console.log,
): Promise<RetiredTableCount[]> {
  const counts = await retiredRuntimeTableCounts(client);
  if (counts.length === 0) {
    log("Skills Hub cutover already applied; no retired runtime tables remain");
    return [];
  }

  const discarded = counts.filter((entry) => entry.rows > 0);
  const total = discarded.reduce((sum, entry) => sum + entry.rows, 0);
  log(
    `${SKILLS_HUB_CUTOVER_ACK_ENV} is set: emptying ${counts.length} retired runtime tables ` +
      `(${total} historical rows) before migration 0063`,
  );
  for (const entry of discarded) log(`  ${entry.table}: ${entry.rows}`);

  await client.unsafe(
    `truncate table ${counts.map((entry) => `public."${entry.table}"`).join(", ")}`,
  );
  return discarded;
}

async function isReadableMigrationFolder(path: string): Promise<boolean> {
  try {
    await access(join(path, "meta", "_journal.json"), constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function migrationLockTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.COMPANION_MIGRATION_LOCK_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIGRATION_LOCK_TIMEOUT_MS;
}

async function acquireMigrationLock(client: ReturnType<typeof postgres>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    const [row] = await client<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID}) as locked
    `;
    if (row?.locked) return;
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for Drizzle migration lock after ${timeoutMs}ms`);
    }
    await sleep(Math.min(1_000, Math.max(1, deadline - Date.now())));
  }
}

export async function resolveMigrationsFolder(input?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  scriptDir?: string;
}): Promise<string> {
  const env = input?.env ?? process.env;
  const cwd = input?.cwd ?? process.cwd();
  const scriptDir = input?.scriptDir ?? dirname(fileURLToPath(import.meta.url));
  if (env.COMPANION_MIGRATIONS_DIR) {
    if (await isReadableMigrationFolder(env.COMPANION_MIGRATIONS_DIR)) return env.COMPANION_MIGRATIONS_DIR;
    throw new Error(`COMPANION_MIGRATIONS_DIR does not contain a readable Drizzle journal: ${env.COMPANION_MIGRATIONS_DIR}`);
  }

  const candidates = [
    join(cwd, "packages", "db", "drizzle"),
    join(cwd, "..", "..", "packages", "db", "drizzle"),
    join(scriptDir, "drizzle"),
    join(scriptDir, "..", "..", "..", "packages", "db", "drizzle"),
  ];

  for (const candidate of candidates) {
    if (await isReadableMigrationFolder(candidate)) return candidate;
  }

  throw new Error(`could not find Drizzle migrations folder; checked: ${candidates.join(", ")}`);
}

export async function resolveRuntimeRoleGrantsFile(input?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  scriptDir?: string;
}): Promise<string> {
  const env = input?.env ?? process.env;
  const cwd = input?.cwd ?? process.cwd();
  const scriptDir = input?.scriptDir ?? dirname(fileURLToPath(import.meta.url));
  const explicit = env.COMPANION_RUNTIME_GRANTS_FILE;
  if (explicit) {
    try {
      await access(explicit, constants.R_OK);
      return explicit;
    } catch {
      throw new Error(`COMPANION_RUNTIME_GRANTS_FILE is not readable: ${explicit}`);
    }
  }

  const candidates = [
    join(cwd, "packages", "db", "runtime-role-grants.sql"),
    join(cwd, "..", "..", "packages", "db", "runtime-role-grants.sql"),
    join(scriptDir, "runtime-role-grants.sql"),
    join(scriptDir, "..", "..", "..", "packages", "db", "runtime-role-grants.sql"),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return candidate;
    } catch {
      // Try the next source-tree or packaged-build location.
    }
  }
  throw new Error(`could not find runtime role grants file; checked: ${candidates.join(", ")}`);
}

export function extractRuntimeRoleGrantBlock(source: string): string {
  const begin = source.indexOf(RUNTIME_GRANTS_BEGIN);
  const end = source.indexOf(RUNTIME_GRANTS_END);
  if (begin < 0 || end < 0 || end <= begin) {
    throw new Error("runtime role grants file is missing its marked SQL block");
  }
  const block = source.slice(begin + RUNTIME_GRANTS_BEGIN.length, end).trim();
  if (!block) throw new Error("runtime role grants SQL block is empty");
  return block;
}

async function applyRuntimeRoleGrants(
  client: ReturnType<typeof postgres>,
  runtimeRoles: DatabaseRuntimeRoles,
  grantsFile: string,
): Promise<void> {
  const source = await readFile(grantsFile, "utf8");
  const grantBlock = extractRuntimeRoleGrantBlock(source);
  if (runtimeRoles.legacySingleRole) {
    await client`select set_config('companion.runtime_role', ${runtimeRoles.apiRole}, false)`;
  } else {
    await client`select set_config('companion.api_role', ${runtimeRoles.apiRole}, false)`;
    await client`select set_config('companion.worker_role', ${runtimeRoles.workerRole}, false)`;
    if (runtimeRoles.retiredRuntimeRole) {
      await client`select set_config('companion.retired_runtime_role', ${runtimeRoles.retiredRuntimeRole}, false)`;
    }
  }
  try {
    await client.unsafe(grantBlock);
  } finally {
    await client.unsafe("reset companion.api_role").catch(() => undefined);
    await client.unsafe("reset companion.worker_role").catch(() => undefined);
    await client.unsafe("reset companion.retired_runtime_role").catch(() => undefined);
    await client.unsafe("reset companion.runtime_role").catch(() => undefined);
  }
}

export async function run(): Promise<void> {
  const migrationsFolder = await resolveMigrationsFolder();
  const runtimeRoles = databaseRuntimeRoles();
  const cutoverAcknowledged = skillsHubCutoverAcknowledged();
  const grantsFile = runtimeRoles ? await resolveRuntimeRoleGrantsFile() : null;
  const client = postgres(databaseUrl(), { max: 1 });
  const database = drizzle(client);
  let lockAcquired = false;

  console.log("Applying Drizzle migrations");
  console.log(`Migrations folder: ${migrationsFolder}`);

  try {
    await acquireMigrationLock(client, migrationLockTimeoutMs());
    lockAcquired = true;
    if (cutoverAcknowledged) await drainRetiredRuntimeTables(client);
    await migrate(database, { migrationsFolder });
    console.log("Drizzle migrations applied");
    if (runtimeRoles && grantsFile) {
      await applyRuntimeRoleGrants(client, runtimeRoles, grantsFile);
      const roleSummary = runtimeRoles.legacySingleRole
        ? runtimeRoles.apiRole
        : `API ${runtimeRoles.apiRole} and worker ${runtimeRoles.workerRole}`;
      console.log(`Runtime database grants applied to ${roleSummary}`);
    }
  } finally {
    if (lockAcquired) {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID})`.catch(
        () => undefined,
      );
    }
    await client.end();
  }
}

interface DatabaseErrorFields extends Error {
  code?: string;
  detail?: string;
  hint?: string;
  where?: string;
}

/**
 * Drizzle rethrows a driver failure wrapped in a generic error whose message is the entire failed
 * statement, so the SQLSTATE, DETAIL and HINT PostgreSQL raised sit on the cause chain.
 */
function databaseErrorFields(error: Error): DatabaseErrorFields | null {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    const candidate = current as DatabaseErrorFields;
    if (candidate.code || candidate.detail || candidate.hint) return candidate;
    current = candidate.cause;
  }
  return null;
}

/**
 * A failed pre-deploy migration is usually diagnosed from the deploy log alone, where the raw error
 * is a stack trace wrapped around a full SQL dump. Lead with what PostgreSQL actually reported, and
 * spell out the remediation for the fail-closed Skills Hub cutover guard, which no code change can
 * clear on its own.
 */
export function formatMigrationFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const database = databaseErrorFields(error);
  const lines = [database?.message ?? error.message];
  if (database?.code) lines.push(`SQLSTATE: ${database.code}`);
  if (database?.detail) lines.push(`DETAIL: ${database.detail}`);
  if (database?.hint) lines.push(`HINT: ${database.hint}`);
  if (database?.where) lines.push(`WHERE: ${database.where}`);

  if (database?.code === CUTOVER_GUARD_SQLSTATE && database.message === CUTOVER_GUARD_MESSAGE) {
    lines.push(
      "",
      "Migration 0063_skills_hub_only.sql refuses to drop the retired Project and run tables while",
      "they still hold the only references to objects this deployment provisioned in object storage",
      "and sandbox providers. Every deploy fails here until those rows are gone.",
      "",
      "To finish the cutover, delete the historical Project and run objects with your object-storage",
      "and provider tooling, then set the Railway API service variable",
      `${SKILLS_HUB_CUTOVER_ACK_ENV}=${SKILLS_HUB_CUTOVER_ACK_VALUE} and redeploy. See "Skills`,
      'Hub-only cutover" in deploy/railway/README.md.',
    );
  }

  lines.push("", error.stack ?? error.message);
  return lines.join("\n");
}

function isMain(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && pathToFileURL(entrypoint).href === import.meta.url);
}

if (isMain()) {
  run().catch((error: unknown) => {
    console.error("Failed to apply Drizzle migrations");
    console.error(formatMigrationFailure(error));
    process.exitCode = 1;
  });
}
