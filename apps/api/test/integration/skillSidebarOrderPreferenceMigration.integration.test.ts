/**
 * Product promise:
 * Existing members keep their saved Skills filters and grouping after upgrade, and receive an empty
 * personal sidebar order without sharing it with another member.
 *
 * Regression caught:
 * Fresh-schema tests cannot prove that a populated preference row receives the JSONB migration
 * default or that two users in the same organization retain independent order snapshots.
 *
 * Why this test is integrated:
 * The guarantee depends on replaying the real migration history through 0047 and applying the exact
 * 0048 SQL against populated PostgreSQL rows.
 *
 * Failure proof:
 * Removing the default, nullability, or per-row storage makes an assertion fail.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("skill sidebar-order migration integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `companion_sidebar_order_${randomUUID().replaceAll("-", "")}`;
const orgA = "00000000-0000-0000-0000-0000000000a1";
const orgB = "00000000-0000-0000-0000-0000000000b2";
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

describe("0048 personal sidebar category order upgrade", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const historicalMigrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0048_skill_sidebar_order_preference.sql")
      .sort();
    for (const migration of historicalMigrations) await applyMigrationFile(migration);

    await upgradeSql`
      insert into "user" (id, name, email, email_verified)
      values
        ('sidebar-user-a', 'Sidebar User A', 'sidebar-a@example.test', true),
        ('sidebar-user-b', 'Sidebar User B', 'sidebar-b@example.test', true)
    `;
    await upgradeSql`
      insert into organizations (id, name, slug)
      values
        (${orgA}::uuid, 'Sidebar Org A', 'sidebar-org-a'),
        (${orgB}::uuid, 'Sidebar Org B', 'sidebar-org-b')
    `;
    await upgradeSql`
      insert into skill_filter_preferences (org_id, user_id, active_filters, group_by)
      values
        (${orgA}::uuid, 'sidebar-user-a', ${upgradeSql.json([{ type: "status", value: "valid" }])}, 'none'),
        (${orgA}::uuid, 'sidebar-user-b', '[]'::jsonb, 'folder'),
        (${orgB}::uuid, 'sidebar-user-a', '[]'::jsonb, 'folder')
    `;

    await applyMigrationFile("0048_skill_sidebar_order_preference.sql");
  }, 30_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 1 });
  });

  it("backfills without changing existing preferences and stores independent user orders", async () => {
    const rows = await upgradeSql<{ orgId: string; userId: string; activeFilters: unknown[]; groupBy: string; sidebarOrder: unknown }[]>`
      select
        org_id::text as "orgId",
        user_id as "userId",
        active_filters as "activeFilters",
        group_by as "groupBy",
        sidebar_order as "sidebarOrder"
      from skill_filter_preferences
      order by org_id, user_id
    `;
    expect(rows).toEqual([
      {
        orgId: orgA,
        userId: "sidebar-user-a",
        activeFilters: [{ type: "status", value: "valid" }],
        groupBy: "none",
        sidebarOrder: { mine: [], org: [] },
      },
      {
        orgId: orgA,
        userId: "sidebar-user-b",
        activeFilters: [],
        groupBy: "folder",
        sidebarOrder: { mine: [], org: [] },
      },
      {
        orgId: orgB,
        userId: "sidebar-user-a",
        activeFilters: [],
        groupBy: "folder",
        sidebarOrder: { mine: [], org: [] },
      },
    ]);

    await upgradeSql`
      update skill_filter_preferences
      set sidebar_order = ${upgradeSql.json({ mine: ["drafts"], org: ["marketing", "growth"] })}
      where org_id = ${orgA}::uuid and user_id = 'sidebar-user-a'
    `;
    const updated = await upgradeSql<{ orgId: string; userId: string; sidebarOrder: unknown }[]>`
      select org_id::text as "orgId", user_id as "userId", sidebar_order as "sidebarOrder"
      from skill_filter_preferences
      order by org_id, user_id
    `;
    expect(updated).toEqual([
      { orgId: orgA, userId: "sidebar-user-a", sidebarOrder: { mine: ["drafts"], org: ["marketing", "growth"] } },
      { orgId: orgA, userId: "sidebar-user-b", sidebarOrder: { mine: [], org: [] } },
      { orgId: orgB, userId: "sidebar-user-a", sidebarOrder: { mine: [], org: [] } },
    ]);
  });
});
