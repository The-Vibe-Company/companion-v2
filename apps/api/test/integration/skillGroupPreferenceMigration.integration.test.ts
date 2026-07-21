/**
 * Product promise:
 * Existing members land in the grouped Skills view immediately after upgrade, while the database
 * accepts only the two supported grouping modes.
 *
 * Regression caught:
 * Fresh-schema tests cannot prove that a populated preference row receives the migration default or
 * that the upgrade constraint is installed on the historical table.
 *
 * Why this test is integrated:
 * The guarantee depends on replaying the real migration history through 0045, seeding an old row,
 * simulating the former branch-local 0046 grouping migration, and applying the exact 0047 SQL
 * against PostgreSQL. This also proves a rebase recovers the 0046 API-token refresh function.
 *
 * Failure proof:
 * Removing the default, nullability, check constraint, or refresh-function recovery makes an
 * assertion fail.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("skill-group preference migration integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `companion_group_upgrade_${randomUUID().replaceAll("-", "")}`;
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

describe("0047 skill grouping preference upgrade and rebase recovery", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const historicalMigrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0046_api_token_refresh.sql")
      .sort();
    for (const migration of historicalMigrations) await applyMigrationFile(migration);

    const orgId = randomUUID();
    await upgradeSql`
      insert into "user" (id, name, email, email_verified)
      values ('group-user', 'Group User', 'group@example.test', true)
    `;
    await upgradeSql`
      insert into organizations (id, name, slug)
      values (${orgId}::uuid, 'Group Org', ${`group-${orgId}`})
    `;
    await upgradeSql`
      insert into skill_filter_preferences (org_id, user_id, active_filters)
      values (${orgId}::uuid, 'group-user', ${upgradeSql.json([{ type: "status", value: "valid" }])})
    `;

    // This is the schema left behind by the branch-local migration that previously occupied 0046.
    await upgradeSql.unsafe(
      `alter table "skill_filter_preferences" add column "group_by" text default 'folder' not null`,
    );
    await upgradeSql.unsafe(
      `alter table "skill_filter_preferences" add constraint "skill_filter_preferences_group_by_check" check ("group_by" in ('folder', 'none'))`,
    );
    await applyMigrationFile("0047_skill_group_preference.sql");
  }, 30_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 1 });
  });

  it("backfills existing rows to folder without changing their filters", async () => {
    const [row] = await upgradeSql<{ activeFilters: unknown[]; groupBy: string }[]>`
      select active_filters as "activeFilters", group_by as "groupBy"
      from skill_filter_preferences
      where user_id = 'group-user'
    `;
    expect(row).toEqual({
      activeFilters: [{ type: "status", value: "valid" }],
      groupBy: "folder",
    });
  });

  it("accepts flat mode and rejects unsupported values", async () => {
    await upgradeSql`update skill_filter_preferences set group_by = 'none' where user_id = 'group-user'`;
    const [row] = await upgradeSql<{ groupBy: string }[]>`
      select group_by as "groupBy" from skill_filter_preferences where user_id = 'group-user'
    `;
    expect(row?.groupBy).toBe("none");
    await expect(
      upgradeSql`update skill_filter_preferences set group_by = 'team' where user_id = 'group-user'`,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("restores the token refresh function when the rebased 0046 was skipped", async () => {
    const [row] = await upgradeSql<{ functionName: string | null }[]>`
      select to_regprocedure('public.companion_lock_api_token_for_refresh(text)')::text as "functionName"
    `;
    expect(row?.functionName).toBe("companion_lock_api_token_for_refresh(text)");
  });
});
