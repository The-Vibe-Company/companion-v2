/**
 * Product promise:
 * Removing skill stars is a one-release destructive upgrade that preserves every unrelated saved
 * filter in order, keeps public previews readable without popularity metadata, and removes all
 * historical star storage.
 *
 * Regression caught:
 * Fresh-schema tests cannot detect an upgrade-only failure in the JSONB cleanup, populated-table
 * drop, or PostgreSQL function OUT-column recreation.
 *
 * Why this test is integrated:
 * The guarantee depends on replaying the real migration history through 0043, seeding old data, and
 * then applying the exact 0044 SQL against PostgreSQL.
 *
 * Failure proof:
 * Removing the ordinality sort, leaving star_count in the recreated function, or retaining the
 * skill_stars table makes this test fail.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("skill-star migration integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `companion_star_upgrade_${randomUUID().replaceAll("-", "")}`;
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

describe("0044 skill-star removal upgrade", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const historicalMigrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0044_remove_skill_stars.sql")
      .sort();
    for (const migration of historicalMigrations) await applyMigrationFile(migration);

    const orgId = randomUUID();
    const skillId = randomUUID();
    const versionId = randomUUID();
    await upgradeSql`
      insert into "user" (id, name, email, email_verified)
      values ('upgrade-user', 'Upgrade User', 'upgrade@example.test', true)
    `;
    await upgradeSql`
      insert into profiles (id, email, name, initials)
      values ('upgrade-user', 'upgrade@example.test', 'Upgrade User', 'UU')
    `;
    await upgradeSql`
      insert into organizations (id, name, slug)
      values (${orgId}::uuid, 'Upgrade Org', ${`upgrade-${orgId}`})
    `;
    await upgradeSql`
      insert into memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, 'upgrade-user', 'owner')
    `;
    await upgradeSql`
      insert into skills (id, org_id, slug, display_name, description, creator_id, scope, share_token)
      values (
        ${skillId}::uuid,
        ${orgId}::uuid,
        'upgrade-preview',
        'Upgrade preview',
        'Preview after migration',
        'upgrade-user',
        'org',
        'upgrade-share-token'
      )
    `;
    await upgradeSql`
      insert into skill_versions
        (id, org_id, skill_id, version, frontmatter, body, size_bytes, checksum, storage_path, created_by)
      values (
        ${versionId}::uuid,
        ${orgId}::uuid,
        ${skillId}::uuid,
        '1.0.0',
        '{"name":"upgrade-preview","description":"Preview after migration"}',
        '# Upgrade preview',
        32,
        ${`sha256:${"a".repeat(64)}`},
        'integration/upgrade-preview/1.0.0.tar.gz',
        'upgrade-user'
      )
    `;
    await upgradeSql`
      update skills set current_version_id = ${versionId}::uuid where id = ${skillId}::uuid
    `;
    await upgradeSql`
      insert into skill_stars (org_id, skill_id, user_id)
      values (${orgId}::uuid, ${skillId}::uuid, 'upgrade-user')
    `;
    await upgradeSql`
      insert into skill_filter_preferences (org_id, user_id, active_filters)
      values (
        ${orgId}::uuid,
        'upgrade-user',
        ${upgradeSql.json([
          { type: "status", value: "valid" },
          { type: "starred", value: "true" },
          { type: "deps", value: "has" },
          { type: "label", value: "engineering/tools" },
        ])}
      )
    `;

    await applyMigrationFile("0044_remove_skill_stars.sql");
  }, 30_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 1 });
  });

  it("preserves unrelated preferences in order and removes the populated star table", async () => {
    const [preferences] = await upgradeSql<{ activeFilters: unknown[] }[]>`
      select active_filters as "activeFilters"
      from skill_filter_preferences
      where user_id = 'upgrade-user'
    `;
    expect(preferences?.activeFilters).toEqual([
      { type: "status", value: "valid" },
      { type: "deps", value: "has" },
      { type: "label", value: "engineering/tools" },
    ]);

    const [storage] = await upgradeSql<{ tableName: string | null }[]>`
      select to_regclass('public.skill_stars')::text as "tableName"
    `;
    expect(storage).toEqual({ tableName: null });
  });

  it("recreates the public preview with the final star-free shape", async () => {
    const [row] = await upgradeSql<{ preview: Record<string, unknown> }[]>`
      select to_jsonb(preview) as preview
      from companion_public_skill_preview('upgrade-share-token') preview
    `;
    expect(row?.preview).toMatchObject({
      slug: "upgrade-preview",
      display_name: "Upgrade preview",
      description: "Preview after migration",
      creator_name: "Upgrade User",
      creator_initials: "UU",
      current_version: "1.0.0",
    });
    expect(row?.preview).not.toHaveProperty("star_count");
  });
});
