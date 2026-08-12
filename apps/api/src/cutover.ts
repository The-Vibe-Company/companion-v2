/**
 * One-shot Skills Hub-only cutover maintenance command.
 *
 * Migration `0063_skills_hub_only.sql` fails closed while the retired Project and run tables still
 * hold the only references to objects this deployment provisioned in object storage and at its
 * sandbox provider. The release that owned the cleanup worker no longer exists, so this command
 * performs that cleanup once, in the order the guard requires: every object is deleted from storage
 * before the row naming it is removed, and the provider-side resources this codebase can no longer
 * reach are reported for the operator to release and confirm.
 *
 * It never runs as part of a deployment. See "Skills Hub-only cutover" in deploy/railway/README.md.
 */
import { pathToFileURL } from "node:url";
import { deleteStorageObject, getStorageConfig } from "@companion/storage";
import postgres from "postgres";
import {
  MIGRATION_LOCK_CLASS_ID,
  MIGRATION_LOCK_OBJECT_ID,
  databaseUrl,
  formatMigrationFailure,
} from "./migrate";

/** Tables whose rows name an object in the configured bucket. */
export const STORAGE_OBLIGATION_TABLES = [
  "project_attachment_uploads",
  "project_attachments",
  "project_files",
  "project_file_versions",
  "skill_run_attachment_uploads",
  "skill_run_attachments",
  "skill_run_artifacts",
] as const;

/** Tables whose rows name a sandbox or checkpoint held by an external provider. */
export const SANDBOX_OBLIGATION_TABLES = ["skill_runs", "skill_run_prewarms", "project_workspaces"] as const;

/**
 * Every table `0063_skills_hub_only.sql` drops. Once storage and provider obligations are settled
 * these rows carry no external reference, so the final step empties the whole set in one statement
 * instead of depending on delete ordering. `cutover.test.ts` keeps this list identical to the
 * migration.
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

export type Sql = ReturnType<typeof postgres>;

export interface Preflight {
  pendingStorage: number;
  pendingProjects: number;
  pendingSandboxes: number;
  activeUsage: number;
}

export interface StorageObligation {
  key: string;
  tables: string[];
}

export interface SandboxObligation {
  source: string;
  orgId: string;
  sandboxName: string | null;
  sandboxId: string | null;
  checkpointId: string | null;
}

export interface UsageObligation {
  id: string;
  orgId: string;
  startedAt: string;
}

export interface CutoverOptions {
  confirmProviderCleanup: boolean;
  skipObjectDelete: boolean;
  dryRun: boolean;
  concurrency: number;
}

export const DEFAULT_CUTOVER_OPTIONS: CutoverOptions = {
  confirmProviderCleanup: false,
  skipObjectDelete: false,
  dryRun: false,
  concurrency: 8,
};

export type ObjectDeleter = (key: string) => Promise<void>;

export function isPreflightSatisfied(preflight: Preflight): boolean {
  return (
    preflight.pendingStorage === 0 &&
    preflight.pendingProjects === 0 &&
    preflight.pendingSandboxes === 0 &&
    preflight.activeUsage === 0
  );
}

export async function existingTables(client: Sql, names: readonly string[]): Promise<string[]> {
  if (names.length === 0) return [];
  const rows = await client<{ name: string }[]>`
    select c.relname as name
    from pg_catalog.pg_class c
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' and c.relname = any(${[...names]})
    order by c.relname
  `;
  return rows.map((row) => row.name);
}

/** The same four counts migration 0063 computes, so the report matches the deploy log exactly. */
export async function preflight(client: Sql): Promise<Preflight> {
  const storageTables = await existingTables(client, STORAGE_OBLIGATION_TABLES);
  const sandboxTables = await existingTables(client, SANDBOX_OBLIGATION_TABLES);
  const otherTables = await existingTables(client, ["projects", "sandbox_usage_sessions"]);

  let pendingStorage = 0;
  for (const table of storageTables) {
    const [row] = await client.unsafe<{ count: string }[]>(
      `select count(*)::bigint as count from public."${table}"`,
    );
    pendingStorage += Number(row?.count ?? 0);
  }

  let pendingSandboxes = 0;
  for (const table of sandboxTables.filter((name) => name !== "project_workspaces")) {
    const [row] = await client.unsafe<{ count: string }[]>(
      `select count(*)::bigint as count from public."${table}"
       where sandbox_cleaned_at is null and (sandbox_name is not null or sandbox_id is not null)`,
    );
    pendingSandboxes += Number(row?.count ?? 0);
  }

  let pendingProjects = 0;
  if (otherTables.includes("projects")) {
    const [row] = await client.unsafe<{ count: string }[]>(
      "select count(*)::bigint as count from public.projects",
    );
    pendingProjects = Number(row?.count ?? 0);
  }

  let activeUsage = 0;
  if (otherTables.includes("sandbox_usage_sessions")) {
    const [row] = await client.unsafe<{ count: string }[]>(
      "select count(*)::bigint as count from public.sandbox_usage_sessions where ended_at is null",
    );
    activeUsage = Number(row?.count ?? 0);
  }

  return { pendingStorage, pendingProjects, pendingSandboxes, activeUsage };
}

/** Distinct object keys, with every table that still references each one. */
export async function storageObligations(client: Sql): Promise<StorageObligation[]> {
  const tables = await existingTables(client, STORAGE_OBLIGATION_TABLES);
  const byKey = new Map<string, string[]>();
  for (const table of tables) {
    const rows = await client.unsafe<{ key: string }[]>(
      `select distinct storage_key as key from public."${table}" where storage_key is not null`,
    );
    for (const row of rows) {
      const existing = byKey.get(row.key);
      if (existing) existing.push(table);
      else byKey.set(row.key, [table]);
    }
  }
  return [...byKey.entries()]
    .map(([key, keyTables]) => ({ key, tables: keyTables }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

/** Sandbox and checkpoint identities no code in this release can reach any more. */
export async function sandboxObligations(client: Sql): Promise<SandboxObligation[]> {
  const tables = await existingTables(client, SANDBOX_OBLIGATION_TABLES);
  const obligations: SandboxObligation[] = [];
  for (const table of tables) {
    const query =
      table === "project_workspaces"
        ? `select org_id as "orgId", sandbox_name as "sandboxName", null::text as "sandboxId",
             checkpoint_id as "checkpointId"
           from public.project_workspaces
           where sandbox_name is not null or checkpoint_id is not null`
        : `select org_id as "orgId", sandbox_name as "sandboxName", sandbox_id as "sandboxId",
             null::text as "checkpointId"
           from public."${table}"
           where sandbox_cleaned_at is null and (sandbox_name is not null or sandbox_id is not null)`;
    const rows = await client.unsafe<Omit<SandboxObligation, "source">[]>(query);
    for (const row of rows) obligations.push({ source: table, ...row });
  }
  return obligations;
}

/** Usage sessions that were never settled, so their billing record ends with this cutover. */
export async function usageObligations(client: Sql): Promise<UsageObligation[]> {
  const [table] = await existingTables(client, ["sandbox_usage_sessions"]);
  if (!table) return [];
  return client.unsafe<UsageObligation[]>(
    `select id::text as id, org_id::text as "orgId", started_at::text as "startedAt"
     from public.sandbox_usage_sessions where ended_at is null order by started_at`,
  );
}

function formatPreflight(preflight: Preflight): string {
  return (
    `pending storage records=${preflight.pendingStorage}, Projects=${preflight.pendingProjects}, ` +
    `sandboxes=${preflight.pendingSandboxes}, active usage sessions=${preflight.activeUsage}`
  );
}

/**
 * Read-only inventory of everything migration 0063 is waiting on. The operator keeps this output:
 * after the cutover it is the only remaining record of which external objects existed.
 */
export async function report(client: Sql, log: (message: string) => void = console.log): Promise<Preflight> {
  const counts = await preflight(client);
  log(`Skills Hub cutover preflight: ${formatPreflight(counts)}`);
  if (isPreflightSatisfied(counts)) {
    log("No cutover obligations remain; migration 0063 will apply on the next deploy.");
    return counts;
  }

  const objects = await storageObligations(client);
  log(`\nObject-storage obligations (distinct keys in the configured bucket): ${objects.length}`);
  for (const object of objects) log(`  ${object.key}  [${object.tables.join(", ")}]`);

  const sandboxes = await sandboxObligations(client);
  log(`\nProvider obligations (sandbox and checkpoint identities): ${sandboxes.length}`);
  for (const sandbox of sandboxes) {
    log(
      `  ${sandbox.source}: org=${sandbox.orgId} sandbox=${sandbox.sandboxName ?? "-"} ` +
        `id=${sandbox.sandboxId ?? "-"} checkpoint=${sandbox.checkpointId ?? "-"}`,
    );
  }

  const usage = await usageObligations(client);
  log(`\nUnsettled usage sessions: ${usage.length}`);
  for (const session of usage) log(`  ${session.id} org=${session.orgId} started=${session.startedAt}`);

  log(
    "\nSave this output. Then run the purge step described in the Skills Hub-only cutover section " +
      "of deploy/railway/README.md.",
  );
  return counts;
}

async function forEachWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  handler: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, queue.length)) }, async () => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await handler(next);
  });
  await Promise.all(workers);
}

export interface PurgeResult {
  deletedObjects: number;
  skippedObjects: number;
  emptiedTables: number;
  preflight: Preflight;
}

/**
 * Settle every cutover obligation. Object deletion comes first and each row is removed only after
 * its object is gone, so an interrupted run never loses a reference it did not clear. The remaining
 * rows are emptied only once no storage obligation is left and the operator has confirmed the
 * provider-side resources named by `report` were released.
 */
export async function purge(input: {
  client: Sql;
  deleteObject: ObjectDeleter;
  options?: Partial<CutoverOptions>;
  log?: (message: string) => void;
}): Promise<PurgeResult> {
  const options = { ...DEFAULT_CUTOVER_OPTIONS, ...input.options };
  const log = input.log ?? console.log;
  const { client } = input;

  const before = await preflight(client);
  log(`Skills Hub cutover preflight: ${formatPreflight(before)}`);
  if (isPreflightSatisfied(before)) {
    log("No cutover obligations remain; migration 0063 will apply on the next deploy.");
    return { deletedObjects: 0, skippedObjects: 0, emptiedTables: 0, preflight: before };
  }

  // Refuse before deleting anything: a run that is not allowed to finish must not destroy the
  // objects an operator is still deciding about.
  const sandboxes = await sandboxObligations(client);
  const usage = await usageObligations(client);
  if (!options.confirmProviderCleanup && (sandboxes.length > 0 || usage.length > 0 || before.pendingProjects > 0)) {
    throw new Error(
      "provider-backed rows remain (sandbox and checkpoint identities=" +
        `${sandboxes.length}, unsettled usage sessions=${usage.length}, Projects=${before.pendingProjects}). ` +
        "Release those resources at the provider, then re-run with --confirm-provider-cleanup. " +
        "Nothing has been deleted.",
    );
  }

  const objects = await storageObligations(client);
  let deletedObjects = 0;
  let skippedObjects = 0;
  if (options.skipObjectDelete) {
    skippedObjects = objects.length;
    log(
      `Leaving ${objects.length} objects in the bucket at the operator's request. After this run no ` +
        "row references them, so these keys are the only remaining record:",
    );
    for (const object of objects) log(`  ${object.key}`);
  } else {
    log(`${options.dryRun ? "Would delete" : "Deleting"} ${objects.length} objects from the configured bucket`);
    await forEachWithConcurrency(objects, options.concurrency, async (object) => {
      if (options.dryRun) {
        log(`  would delete ${object.key}`);
        return;
      }
      await input.deleteObject(object.key);
      deletedObjects += 1;
      log(`  deleted ${object.key}`);
    });
  }

  if (!options.dryRun) {
    // Only rows whose object is gone are removed, so a failure above leaves the reference intact.
    for (const object of objects) {
      for (const table of object.tables) {
        await client.unsafe(`delete from public."${table}" where storage_key = $1`, [object.key]);
      }
    }
  }

  log(`Discarding ${sandboxes.length} provider identities and ${usage.length} usage sessions:`);
  for (const sandbox of sandboxes) {
    log(`  ${sandbox.source}: sandbox=${sandbox.sandboxName ?? "-"} id=${sandbox.sandboxId ?? "-"}`);
  }

  const retired = await existingTables(client, SKILLS_HUB_RETIRED_TABLES);
  if (options.dryRun) {
    log(`Would empty ${retired.length} retired runtime tables`);
    return { deletedObjects, skippedObjects, emptiedTables: 0, preflight: before };
  }

  if (retired.length > 0) {
    await client.unsafe(`truncate table ${retired.map((table) => `public."${table}"`).join(", ")}`);
    log(`Emptied ${retired.length} retired runtime tables`);
  }

  const after = await preflight(client);
  if (!isPreflightSatisfied(after)) {
    throw new Error(
      `cutover did not drain the database (${formatPreflight(after)}); stop web and API traffic so ` +
        "the previous release cannot create new Projects or runs, then re-run",
    );
  }
  log(`Skills Hub cutover complete: ${formatPreflight(after)}. Redeploy the API service.`);
  return { deletedObjects, skippedObjects, emptiedTables: retired.length, preflight: after };
}

export interface CutoverInvocation {
  command: "report" | "purge";
  options: CutoverOptions;
}

export function parseCutoverArgs(argv: readonly string[]): CutoverInvocation {
  const [command, ...flags] = argv;
  if (command !== "report" && command !== "purge") {
    throw new Error("usage: node dist/cutover.js report|purge [--confirm-provider-cleanup] [--skip-object-delete] [--dry-run]");
  }
  const options = { ...DEFAULT_CUTOVER_OPTIONS };
  for (const flag of flags) {
    if (flag === "--confirm-provider-cleanup") options.confirmProviderCleanup = true;
    else if (flag === "--skip-object-delete") options.skipObjectDelete = true;
    else if (flag === "--dry-run") options.dryRun = true;
    else throw new Error(`unknown cutover flag: ${flag}`);
  }
  return { command, options };
}

export async function run(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const invocation = parseCutoverArgs(argv);
  const client = postgres(databaseUrl(), { max: 1 });
  let lockAcquired = false;
  try {
    // Share the migrator's advisory lock so a deploy attempt cannot race the cutover.
    const [lock] = await client<{ locked: boolean }[]>`
      select pg_try_advisory_lock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID}) as locked
    `;
    if (!lock?.locked) throw new Error("another migration or cutover holds the Drizzle migration lock");
    lockAcquired = true;

    if (invocation.command === "report") {
      await report(client);
      return;
    }

    // Object-storage credentials are only required when this run will delete objects, so an
    // operator who already removed them elsewhere is not blocked by rotated keys.
    const config = invocation.options.skipObjectDelete ? null : getStorageConfig();
    if (config) console.log(`Object storage: bucket ${config.bucket} at ${config.endpoint}`);
    await purge({
      client,
      deleteObject: (key) =>
        config
          ? deleteStorageObject({ key, config })
          : Promise.reject(new Error("object deletion is disabled for this run")),
      options: invocation.options,
    });
  } finally {
    if (lockAcquired) {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_CLASS_ID}, ${MIGRATION_LOCK_OBJECT_ID})`.catch(
        () => undefined,
      );
    }
    await client.end();
  }
}

function isMain(): boolean {
  const entrypoint = process.argv[1];
  return Boolean(entrypoint && pathToFileURL(entrypoint).href === import.meta.url);
}

if (isMain()) {
  run().catch((error: unknown) => {
    console.error("Skills Hub cutover failed");
    console.error(formatMigrationFailure(error));
    process.exitCode = 1;
  });
}
