/**
 * Product promise:
 * An operator who has deleted the historical run and Project objects from object storage and its
 * sandbox provider can finish the Skills Hub-only cutover from the deployment itself, so the API
 * pre-deploy migration stops failing without anyone hand-editing the production database.
 *
 * Regression caught:
 * Every API deploy after the Skills Hub cutover fails forever on a populated database because
 * migration 0063 fails closed and no code path can drain the retired runtime tables. Draining
 * without the explicit acknowledgement, or draining tables the migration does not drop, would
 * silently discard rows whose external objects still exist.
 *
 * Why integrated:
 * The guard is PostgreSQL PL/pgSQL executed by the real Drizzle migrator against a database that
 * replayed the real migration history through 0062; nothing about it is observable in isolation.
 *
 * Failure proof:
 * Removing the drain leaves the second run failing on the guard; running it without the
 * acknowledgement makes the unacknowledged case succeed and lose the seeded ownership rows.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SKILLS_HUB_CUTOVER_ACK_ENV, SKILLS_HUB_CUTOVER_ACK_VALUE, run } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Skills Hub cutover acknowledgement test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `companion_cutover_ack_${randomUUID().replaceAll("-", "")}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";

let upgradeSql: ReturnType<typeof postgres>;

async function applyMigrationFile(name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  for (const statement of source.split("--> statement-breakpoint")) {
    const sql = statement.trim();
    if (sql) await upgradeSql.unsafe(sql);
  }
}

/** Replay history through 0062 and tell Drizzle it is already there, exactly like a live database. */
async function replayHistoryThrough0062(): Promise<void> {
  const historical = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0063_skills_hub_only.sql")
    .sort();
  for (const migration of historical) await applyMigrationFile(migration);

  const journal = JSON.parse(await readFile(`${migrationsDir}/meta/_journal.json`, "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const lastApplied = journal.entries.find((entry) => entry.tag === "0062_agent_delegation_tokens");
  if (!lastApplied) throw new Error("migration journal no longer contains 0062_agent_delegation_tokens");

  await upgradeSql.unsafe('create schema if not exists "drizzle"');
  await upgradeSql.unsafe(`
    create table if not exists "drizzle"."__drizzle_migrations" (
      id serial primary key,
      hash text not null,
      created_at bigint
    )
  `);
  await upgradeSql`
    insert into "drizzle"."__drizzle_migrations" ("hash", "created_at")
    values ('replayed-through-0062', ${lastApplied.when})
  `;
}

async function runMigrations(acknowledged: boolean): Promise<void> {
  const previous = {
    migrationUrl: process.env.DATABASE_MIGRATION_URL,
    url: process.env.DATABASE_URL,
    ack: process.env[SKILLS_HUB_CUTOVER_ACK_ENV],
    runtimeRole: process.env.DATABASE_RUNTIME_ROLE,
    apiRole: process.env.DATABASE_API_ROLE,
    workerRole: process.env.DATABASE_WORKER_ROLE,
  };
  process.env.DATABASE_MIGRATION_URL = upgradeUrl.toString();
  process.env.DATABASE_URL = upgradeUrl.toString();
  delete process.env.DATABASE_RUNTIME_ROLE;
  delete process.env.DATABASE_API_ROLE;
  delete process.env.DATABASE_WORKER_ROLE;
  if (acknowledged) process.env[SKILLS_HUB_CUTOVER_ACK_ENV] = SKILLS_HUB_CUTOVER_ACK_VALUE;
  else delete process.env[SKILLS_HUB_CUTOVER_ACK_ENV];

  try {
    await run();
  } finally {
    for (const [key, value] of [
      ["DATABASE_MIGRATION_URL", previous.migrationUrl],
      ["DATABASE_URL", previous.url],
      [SKILLS_HUB_CUTOVER_ACK_ENV, previous.ack],
      ["DATABASE_RUNTIME_ROLE", previous.runtimeRole],
      ["DATABASE_API_ROLE", previous.apiRole],
      ["DATABASE_WORKER_ROLE", previous.workerRole],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("Skills Hub cutover acknowledgement", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });
    await replayHistoryThrough0062();
  }, 60_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 1 });
  });

  it("blocks the pre-deploy migration until the operator acknowledges external cleanup", async () => {
    const orgId = randomUUID();
    await upgradeSql`
      insert into project_attachment_uploads
        (storage_key, org_id, project_id, creator_id, kind, committed_at)
      values ('projects/still-in-object-storage', ${orgId}::uuid, ${randomUUID()}::uuid, 'owner', 'file', clock_timestamp())
    `;

    await expect(runMigrations(false)).rejects.toThrow(
      "Skills Hub-only migration requires runtime resource cleanup first",
    );

    const [preserved] = await upgradeSql<{ storageKey: string }[]>`
      select storage_key as "storageKey" from project_attachment_uploads
    `;
    expect(preserved?.storageKey).toBe("projects/still-in-object-storage");
  }, 120_000);

  it("completes the cutover once the acknowledgement is set, and stays a no-op afterwards", async () => {
    await runMigrations(true);

    const [retired] = await upgradeSql<{ projects: string | null; runs: string | null }[]>`
      select
        to_regclass('public.projects')::text as projects,
        to_regclass('public.skill_runs')::text as runs
    `;
    expect(retired).toEqual({ projects: null, runs: null });

    // The Companions migrations that shipped after the cutover now reach the database.
    const [companions] = await upgradeSql<{ boxes: string | null; providers: string | null }[]>`
      select
        to_regclass('public.companions')::text as boxes,
        to_regclass('public.companion_provider_connections')::text as providers
    `;
    expect(companions?.boxes).not.toBeNull();
    expect(companions?.providers).not.toBeNull();

    // Skills Hub data is untouched by the drain.
    const [retained] = await upgradeSql<{ skills: string | null; secrets: string | null }[]>`
      select to_regclass('public.skills')::text as skills, to_regclass('public.secrets')::text as secrets
    `;
    expect(retained).toEqual({ skills: "skills", secrets: "secrets" });

    await expect(runMigrations(true)).resolves.toBeUndefined();
  }, 120_000);
});
