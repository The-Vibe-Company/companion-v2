/**
 * Product promise:
 * The Skills Hub-only cutover never loses the sole database references to historical runtime
 * objects before the old release has deleted those objects from external providers.
 *
 * Regression caught:
 * A direct DROP of runtime tables would make S3 keys and sandbox/checkpoint identities unreachable,
 * retaining sensitive objects and billable provider resources indefinitely.
 *
 * Why integrated:
 * This is an upgrade-only guarantee. It depends on replaying the real migration history through
 * 0061, seeding an old durable ownership row, and executing the exact 0062 PostgreSQL guard.
 *
 * Failure proof:
 * Removing or moving the guard after the first DROP lets the populated migration succeed or lose
 * the seeded ownership row.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Skills Hub cutover migration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `companion_skills_cutover_${randomUUID().replaceAll("-", "")}`;
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

describe("0062 Skills Hub-only resource cutover", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const historicalMigrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0062_skills_hub_only.sql")
      .sort();
    for (const migration of historicalMigrations) await applyMigrationFile(migration);
  }, 30_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 1 });
  });

  it("fails before dropping ownership rows, then succeeds after external cleanup is acknowledged", async () => {
    await upgradeSql`
      insert into project_attachment_uploads
        (storage_key, org_id, project_id, creator_id, kind, committed_at)
      values (
        'projects/cutover-sensitive-object',
        ${randomUUID()}::uuid,
        ${randomUUID()}::uuid,
        'cutover-owner',
        'file',
        clock_timestamp()
      )
    `;

    await expect(applyMigrationFile("0062_skills_hub_only.sql")).rejects.toThrow(
      "Skills Hub-only migration requires runtime resource cleanup first",
    );

    const [preserved] = await upgradeSql<{ tableName: string | null; storageKey: string }[]>`
      select
        to_regclass('public.project_attachment_uploads')::text as "tableName",
        storage_key as "storageKey"
      from project_attachment_uploads
    `;
    expect(preserved).toEqual({
      tableName: "project_attachment_uploads",
      storageKey: "projects/cutover-sensitive-object",
    });

    // This row may be removed only after the operator has deleted the named external object. The
    // migration then proves no database-owned cleanup obligation remains before dropping tables.
    await upgradeSql`delete from project_attachment_uploads`;
    await applyMigrationFile("0062_skills_hub_only.sql");

    const [removed] = await upgradeSql<{ tableName: string | null }[]>`
      select to_regclass('public.project_attachment_uploads')::text as "tableName"
    `;
    expect(removed).toEqual({ tableName: null });
  }, 30_000);
});
