/**
 * Product promise:
 * Existing Added skills upgrade to Both without losing their recorded version or chronology, while
 * new rows may independently represent Remote or Local delivery but never an empty delivery state.
 *
 * Regression caught:
 * Fresh-schema tests cannot prove the 0064 backfill preserves populated install rows.
 *
 * Why this test is integrated:
 * The guarantee depends on replaying the real migration history through 0063 and applying the exact
 * 0064 SQL and PostgreSQL CHECK constraint to populated data.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("remote catalog migration integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `companion_remote_catalog_${randomUUID().replaceAll("-", "")}`;
const orgId = randomUUID();
const skillId = randomUUID();
const legacyWriterSkillId = randomUUID();
const originalTimestamp = "2026-08-01T12:34:56.000Z";
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

describe("0064 Remote and Local delivery-state upgrade", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const historicalMigrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0064_remote_skill_catalog.sql")
      .sort();
    for (const migration of historicalMigrations) await applyMigrationFile(migration);

    await upgradeSql`
      insert into "user" (id, name, email, email_verified)
      values ('remote-user', 'Remote User', 'remote@example.test', true)
    `;
    await upgradeSql`
      insert into profiles (id, email, name, initials)
      values ('remote-user', 'remote@example.test', 'Remote User', 'RU')
    `;
    await upgradeSql`
      insert into organizations (id, name, slug)
      values (${orgId}::uuid, 'Remote Org', ${`remote-${orgId}`})
    `;
    await upgradeSql`
      insert into skills (id, org_id, slug, display_name, description, creator_id, scope, share_token)
      values (
        ${skillId}::uuid,
        ${orgId}::uuid,
        'remote-upgrade',
        'Remote upgrade',
        'Migration fixture',
        'remote-user',
        'org',
        'remote-upgrade-share-token'
      )
    `;
    await upgradeSql`
      insert into skill_installs
        (org_id, user_id, skill_id, installed_version, agent_label, source, installed_at, last_reported_at)
      values (
        ${orgId}::uuid,
        'remote-user',
        ${skillId}::uuid,
        '2.3.4',
        'Claude Code',
        'agent',
        ${originalTimestamp}::timestamptz,
        ${originalTimestamp}::timestamptz
      )
    `;

    await applyMigrationFile("0064_remote_skill_catalog.sql");
  }, 30_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 1 });
  });

  it("backfills existing installs to Both without changing their version or timestamps", async () => {
    const [row] = await upgradeSql<{
      version: string;
      installedAt: Date;
      remoteEnabledAt: Date;
      localInstalledAt: Date;
    }[]>`
      select
        installed_version as version,
        installed_at as "installedAt",
        remote_enabled_at as "remoteEnabledAt",
        local_installed_at as "localInstalledAt"
      from skill_installs
      where org_id = ${orgId}::uuid and user_id = 'remote-user' and skill_id = ${skillId}::uuid
    `;
    expect(row?.version).toBe("2.3.4");
    expect(row?.installedAt.toISOString()).toBe(originalTimestamp);
    expect(row?.remoteEnabledAt.toISOString()).toBe(originalTimestamp);
    expect(row?.localInstalledAt.toISOString()).toBe(originalTimestamp);
  });

  it("accepts either independent delivery mode and rejects rows with neither", async () => {
    await upgradeSql`
      update skill_installs
      set remote_enabled_at = null
      where org_id = ${orgId}::uuid and user_id = 'remote-user' and skill_id = ${skillId}::uuid
    `;
    await upgradeSql`
      update skill_installs
      set remote_enabled_at = now(), local_installed_at = null
      where org_id = ${orgId}::uuid and user_id = 'remote-user' and skill_id = ${skillId}::uuid
    `;
    await expect(
      upgradeSql`
        update skill_installs
        set remote_enabled_at = null, local_installed_at = null
        where org_id = ${orgId}::uuid and user_id = 'remote-user' and skill_id = ${skillId}::uuid
      `,
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("keeps legacy insert writers valid during a rolling deployment", async () => {
    await upgradeSql`
      insert into skills (id, org_id, slug, display_name, description, creator_id, scope, share_token)
      values (
        ${legacyWriterSkillId}::uuid,
        ${orgId}::uuid,
        'legacy-writer',
        'Legacy writer',
        'Rolling deployment fixture',
        'remote-user',
        'org',
        'legacy-writer-share-token'
      )
    `;
    await upgradeSql`
      insert into skill_installs
        (org_id, user_id, skill_id, installed_version, agent_label, source, installed_at, last_reported_at)
      values (
        ${orgId}::uuid,
        'remote-user',
        ${legacyWriterSkillId}::uuid,
        '1.0.0',
        'Legacy agent',
        'agent',
        ${originalTimestamp}::timestamptz,
        ${originalTimestamp}::timestamptz
      )
    `;
    const [row] = await upgradeSql<{ remoteEnabledAt: Date; localInstalledAt: Date }[]>`
      select
        remote_enabled_at as "remoteEnabledAt",
        local_installed_at as "localInstalledAt"
      from skill_installs
      where org_id = ${orgId}::uuid
        and user_id = 'remote-user'
        and skill_id = ${legacyWriterSkillId}::uuid
    `;
    expect(row?.remoteEnabledAt.toISOString()).toBe(originalTimestamp);
    expect(row?.localInstalledAt.toISOString()).toBe(originalTimestamp);
  });

  it("upgrades a legacy upsert conflict on a Remote-only row to Both", async () => {
    await upgradeSql`
      insert into skill_installs
        (org_id, user_id, skill_id, installed_version, agent_label, source, installed_at, last_reported_at)
      values (
        ${orgId}::uuid,
        'remote-user',
        ${skillId}::uuid,
        '2.4.0',
        'Legacy agent',
        'agent',
        ${originalTimestamp}::timestamptz,
        now()
      )
      on conflict (org_id, user_id, skill_id) do update set
        installed_version = excluded.installed_version,
        agent_label = excluded.agent_label,
        source = excluded.source,
        last_reported_at = excluded.last_reported_at
    `;
    const [row] = await upgradeSql<{
      version: string;
      remoteEnabledAt: Date;
      localInstalledAt: Date;
    }[]>`
      select
        installed_version as version,
        remote_enabled_at as "remoteEnabledAt",
        local_installed_at as "localInstalledAt"
      from skill_installs
      where org_id = ${orgId}::uuid and user_id = 'remote-user' and skill_id = ${skillId}::uuid
    `;
    expect(row?.version).toBe("2.4.0");
    expect(row?.remoteEnabledAt).toBeInstanceOf(Date);
    expect(row?.localInstalledAt).toBeInstanceOf(Date);
  });
});
