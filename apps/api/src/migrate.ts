import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const MIGRATION_LOCK_CLASS_ID = 72_401;
export const MIGRATION_LOCK_OBJECT_ID = 20_260_608;
const DEFAULT_MIGRATION_LOCK_TIMEOUT_MS = 60_000;
const RUNTIME_GRANTS_BEGIN = "-- companion-runtime-grants-begin";
const RUNTIME_GRANTS_END = "-- companion-runtime-grants-end";
const DATABASE_ROLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
export const RUNTIME_V2_FINAL_CUTOVER_TAG = "0094_companion_runtime_cutover";

export const CUTOVER_GUARD_SQLSTATE = "55000";
export const CUTOVER_GUARD_MESSAGE = "Skills Hub-only migration requires runtime resource cleanup first";
export const RUNTIME_V2_CUTOVER_GUARD_MESSAGE = "Runtime v2 final cutover preflight failed";
export const RUNTIME_V2_GRANTS_GUARD_MESSAGE =
  "Runtime v2 final cutover grants were not verified on this connection";
export function databaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const url = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_MIGRATION_URL or DATABASE_URL is required to apply database migrations");
  }
  return url;
}

export interface DatabaseRuntimeRoles {
  apiRole: string;
  workerRole: string;
  companionRuntimeRole: string;
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
  const legacyRuntimeRole = databaseRole("DATABASE_RUNTIME_ROLE", env.DATABASE_RUNTIME_ROLE);
  if (legacyRuntimeRole !== null) {
    throw new Error(
      "DATABASE_RUNTIME_ROLE is a retired union credential; disable it with NOLOGIN, drain its sessions, and name it with DATABASE_RETIRED_RUNTIME_ROLE",
    );
  }
  const apiRole = databaseRole("DATABASE_API_ROLE", env.DATABASE_API_ROLE);
  const workerRole = databaseRole("DATABASE_WORKER_ROLE", env.DATABASE_WORKER_ROLE);
  const companionRuntimeRole = databaseRole(
    "DATABASE_COMPANION_RUNTIME_ROLE",
    env.DATABASE_COMPANION_RUNTIME_ROLE,
  );
  const retiredRuntimeRole = databaseRole(
    "DATABASE_RETIRED_RUNTIME_ROLE",
    env.DATABASE_RETIRED_RUNTIME_ROLE,
  );
  if (
    apiRole === null
    && workerRole === null
    && companionRuntimeRole === null
    && retiredRuntimeRole === null
  ) return null;
  if (apiRole === null || workerRole === null || companionRuntimeRole === null) {
    throw new Error(
      "DATABASE_API_ROLE, DATABASE_WORKER_ROLE, and DATABASE_COMPANION_RUNTIME_ROLE must be configured together; DATABASE_RETIRED_RUNTIME_ROLE is optional only for a fresh install with no legacy union role",
    );
  }
  const configuredRoles = [apiRole, workerRole, companionRuntimeRole, retiredRuntimeRole]
    .filter((role): role is string => role !== null);
  if (new Set(configuredRoles).size !== configuredRoles.length) {
    throw new Error("API, worker, Companion runtime, and retired runtime database roles must be distinct");
  }
  return {
    apiRole,
    workerRole,
    companionRuntimeRole,
    retiredRuntimeRole,
  };
}

interface DrizzleJournalEntry {
  tag: string;
  when: number;
  [key: string]: unknown;
}

interface DrizzleJournal {
  entries: DrizzleJournalEntry[];
  [key: string]: unknown;
}

export interface MigrationPhases {
  checkpointFolder: string;
  hasFinalCutover: boolean;
  finalCutoverWhen: number | null;
  cleanup: () => Promise<void>;
}

function parseMigrationJournal(source: string, journalPath: string): DrizzleJournal {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`migration journal is not valid JSON: ${journalPath}`, { cause: error });
  }
  if (
    !parsed
    || typeof parsed !== "object"
    || !Array.isArray((parsed as { entries?: unknown }).entries)
    || !(parsed as { entries: unknown[] }).entries.every(
      (entry) => entry
        && typeof entry === "object"
        && typeof (entry as { tag?: unknown }).tag === "string"
        && typeof (entry as { when?: unknown }).when === "number"
        && Number.isFinite((entry as { when: number }).when),
    )
  ) {
    throw new Error(`migration journal has an invalid entries array: ${journalPath}`);
  }
  return parsed as DrizzleJournal;
}

/**
 * PostgreSQL Drizzle commits all pending entries in one transaction. Presenting it with a journal
 * ending at additive 0093 creates a deliberate, one-way compatibility checkpoint before the
 * destructive cutover migration can be considered. The full journal (including every migration
 * after 0094) is used only after the exact role-grant block succeeds.
 */
export async function prepareMigrationPhases(migrationsFolder: string): Promise<MigrationPhases> {
  const journalPath = join(migrationsFolder, "meta", "_journal.json");
  const journal = parseMigrationJournal(await readFile(journalPath, "utf8"), journalPath);
  const cutoverIndex = journal.entries.findIndex((entry) => entry.tag === RUNTIME_V2_FINAL_CUTOVER_TAG);
  if (cutoverIndex < 0) {
    return {
      checkpointFolder: migrationsFolder,
      hasFinalCutover: false,
      finalCutoverWhen: null,
      cleanup: async () => undefined,
    };
  }
  const checkpointFolder = await mkdtemp(join(tmpdir(), "companion-migrations-through-0093-"));
  try {
    await mkdir(join(checkpointFolder, "meta"), { recursive: true });
    const checkpointJournal: DrizzleJournal = {
      ...journal,
      entries: journal.entries.slice(0, cutoverIndex),
    };
    await writeFile(
      join(checkpointFolder, "meta", "_journal.json"),
      `${JSON.stringify(checkpointJournal, null, 2)}\n`,
      "utf8",
    );
    await Promise.all(
      checkpointJournal.entries.map((entry) =>
        copyFile(join(migrationsFolder, `${entry.tag}.sql`), join(checkpointFolder, `${entry.tag}.sql`)),
      ),
    );
  } catch (error) {
    await rm(checkpointFolder, { recursive: true, force: true });
    throw error;
  }

  return {
    checkpointFolder,
    hasFinalCutover: true,
    finalCutoverWhen: journal.entries[cutoverIndex]?.when ?? null,
    cleanup: () => rm(checkpointFolder, { recursive: true, force: true }),
  };
}

async function isFinalCutoverPending(
  client: ReturnType<typeof postgres>,
  finalCutoverWhen: number,
): Promise<boolean> {
  const [row] = await client<Array<{ pending: boolean }>>`
    select coalesce(max(created_at), 0) < ${finalCutoverWhen} as pending
    from drizzle.__drizzle_migrations
  `;
  return row?.pending ?? true;
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
  // A previous invocation on a reused connection must never satisfy 0094. The grants block creates
  // a new nonce and writes the verified marker only after every validation and ACL change succeeds.
  await client.unsafe("reset companion.runtime_grants_verified").catch(() => undefined);
  await client.unsafe("reset companion.runtime_grants_nonce").catch(() => undefined);
  await client`select
    set_config('companion.api_role', ${runtimeRoles.apiRole}, false),
    set_config('companion.worker_role', ${runtimeRoles.workerRole}, false),
    set_config('companion.companion_runtime_role', ${runtimeRoles.companionRuntimeRole}, false),
    set_config('companion.retired_runtime_role', ${runtimeRoles.retiredRuntimeRole ?? ""}, false)`;
  await client.unsafe(grantBlock);
}

async function resetRuntimeRoleGrantSession(client: ReturnType<typeof postgres>): Promise<void> {
  await client.unsafe("reset companion.api_role").catch(() => undefined);
  await client.unsafe("reset companion.worker_role").catch(() => undefined);
  await client.unsafe("reset companion.companion_runtime_role").catch(() => undefined);
  await client.unsafe("reset companion.retired_runtime_role").catch(() => undefined);
  await client.unsafe("reset companion.runtime_grants_nonce").catch(() => undefined);
  await client.unsafe("reset companion.runtime_grants_verified").catch(() => undefined);
}

export async function run(input?: { env?: NodeJS.ProcessEnv }): Promise<void> {
  const env = input?.env ?? process.env;
  const migrationsFolder = await resolveMigrationsFolder({ env });
  const runtimeRoles = databaseRuntimeRoles(env);
  const migrationUrl = databaseUrl(env);
  const phases = await prepareMigrationPhases(migrationsFolder);
  let client: ReturnType<typeof postgres>;
  try {
    client = postgres(migrationUrl, { max: 1 });
  } catch (error) {
    await phases.cleanup();
    throw error;
  }
  const database = drizzle(client);
  let lockAcquired = false;

  console.log("Applying Drizzle migrations");
  console.log(`Migrations folder: ${migrationsFolder}`);

  try {
    await acquireMigrationLock(client, migrationLockTimeoutMs(env));
    lockAcquired = true;
    await migrate(database, { migrationsFolder: phases.checkpointFolder });
    const finalCutoverPending = phases.finalCutoverWhen === null
      ? false
      : await isFinalCutoverPending(client, phases.finalCutoverWhen);
    if (phases.hasFinalCutover) {
      if (finalCutoverPending) {
        console.log("Drizzle compatibility checkpoint applied through 0093");
      } else {
        console.log("Runtime v2 final cutover is already recorded; skipping pre-cutover grants");
      }
      // Required whether or not the cutover is still pending: post-cutover migrations now DROP and
      // CREATE functions, which discards their ACLs, so a run without role variables would leave the
      // executor unable to call the surface it needs and report success.
      if (!runtimeRoles) {
        throw new Error(
          "Runtime v2 migrations require DATABASE_API_ROLE, DATABASE_WORKER_ROLE, and DATABASE_COMPANION_RUNTIME_ROLE; set DATABASE_RETIRED_RUNTIME_ROLE as well when upgrading a legacy union role",
        );
      }
    }
    if (runtimeRoles && (!phases.hasFinalCutover || finalCutoverPending)) {
      const grantsFile = await resolveRuntimeRoleGrantsFile({ env });
      await applyRuntimeRoleGrants(client, runtimeRoles, grantsFile);
      const roleSummary = [
        `API ${runtimeRoles.apiRole}`,
        `worker ${runtimeRoles.workerRole}`,
        `Companion runtime ${runtimeRoles.companionRuntimeRole}`,
        ...(runtimeRoles.retiredRuntimeRole
          ? [`retired runtime ${runtimeRoles.retiredRuntimeRole}`]
          : []),
      ].join(", ");
      console.log(`Runtime database grants verified for ${roleSummary}`);
    }
    if (phases.hasFinalCutover) {
      await migrate(database, { migrationsFolder });
      if (runtimeRoles) {
        // The pre-cutover pass grants the surface that existed at 0093, and it is skipped entirely
        // once the cutover is recorded. Everything applied after it is therefore invisible to it,
        // and a post-cutover migration that has to DROP + CREATE a function — a changed return type
        // or parameter list cannot be replaced in place — resets that function's ACL outright.
        //
        // This runs unconditionally rather than only when this invocation applied something. The
        // hook is idempotent, and gating it on "did this run apply a migration" would make a deploy
        // that died between the migration and the grant unrepairable: every later run would see
        // nothing left to apply and skip the repair forever, leaving the executor permanently
        // without EXECUTE on the functions it needs.
        const grantsFile = await resolveRuntimeRoleGrantsFile({ env });
        await applyRuntimeRoleGrants(client, runtimeRoles, grantsFile);
        console.log("Runtime database grants verified after the post-cutover migrations");
      }
    }
    console.log("Drizzle migrations applied");
    await client`select pg_advisory_unlock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID})`;
    lockAcquired = false;
  } finally {
    await resetRuntimeRoleGrantSession(client);
    if (lockAcquired) {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID})`.catch(
        () => undefined,
      );
    }
    try {
      await client.end();
    } finally {
      await phases.cleanup();
    }
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
      "and sandbox providers. Every deploy fails here until those obligations are settled; no",
      "application code change can clear them.",
      "",
      "Run the one-shot cutover command against this database to inventory and settle them:",
      "  node dist/cutover.js report",
      "  node dist/cutover.js purge --confirm-provider-cleanup",
      'See "Skills Hub-only cutover" in deploy/railway/README.md for the full runbook.',
    );
  }

  if (
    database?.code === CUTOVER_GUARD_SQLSTATE
    && database.message === RUNTIME_V2_CUTOVER_GUARD_MESSAGE
  ) {
    lines.push(
      "",
      "Migration 0094_companion_runtime_cutover.sql refuses to remove the legacy Box/Pi executor",
      "until the Companions flag and Runtime v2 database gate are off, every claim is neutral, old",
      "API/worker replicas are drained, every legacy Box deletion is durably confirmed, and the",
      "legacy database aggregate is empty.",
      "",
      "Run the one-shot command from the runtime image against the migration-owner URL before retrying:",
      "  node dist/companionPurge.js report",
      "  node dist/companionPurge.js purge --dry-run",
      "  node dist/companionPurge.js purge --confirm-delete-all-companions",
      'See "Companions Runtime v2" in docs/runbooks/companions-runtime.md for the full runbook.',
    );
  }

  if (
    database?.code === CUTOVER_GUARD_SQLSTATE
    && database.message === RUNTIME_V2_GRANTS_GUARD_MESSAGE
  ) {
    lines.push(
      "",
      "Migration 0094 must be invoked by the two-phase API migration runner on one physical",
      "PostgreSQL connection. It checkpoints through additive migration 0093, validates the exact",
      "API/worker/runtime roles, retires any named legacy union credential, and only then presents 0094.",
      "",
      "Set DATABASE_API_ROLE, DATABASE_WORKER_ROLE, and DATABASE_COMPANION_RUNTIME_ROLE. For an",
      "upgrade, first make the former union role NOLOGIN, drain all of its sessions, and set",
      "DATABASE_RETIRED_RUNTIME_ROLE to that exact role name. Do not execute 0094 directly.",
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
