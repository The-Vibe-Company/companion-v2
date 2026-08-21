/**
 * Product promise:
 * Deploying deferred Skill updates preserves lifecycle work that was already durable. In
 * particular, legacy Stop operations had no Skill target or resource snapshot because Stop did not
 * update Skills before migration 0113.
 *
 * Regression caught:
 * Adding the new Stop constraints before backfilling those historical nulls makes the production
 * migration fail as soon as any pending or settled Stop row exists.
 *
 * Why integrated:
 * This is an upgrade-only data-shape guarantee. The test replays the real PostgreSQL migrations
 * through 0112, creates Stop rows through the historical trigger, and then applies the exact 0113
 * SQL before checking both the data and validated constraints.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("deferred Skill update migration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `deferred_skill_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";

const orgId = randomUUID();
const companionId = randomUUID();
const skillId = randomUUID();
const versionId = randomUUID();
const actorId = "deferred-skill-upgrade-owner";
const runtimeRole = `deferred_runtime_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
let upgradeSql: ReturnType<typeof postgres>;

async function applyMigrationFile(name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await upgradeSql.begin(async (transaction) => {
    for (const statement of statements) await transaction.unsafe(statement);
  });
}

async function satisfyRuntimeCutoverGuard(): Promise<void> {
  const nonce = "a".repeat(32);
  await upgradeSql`
    select
      set_config('companion.api_role', 'migration_api', false),
      set_config('companion.worker_role', 'migration_worker', false),
      set_config('companion.companion_runtime_role', ${runtimeRole}, false),
      set_config('companion.retired_runtime_role', '', false),
      set_config('companion.runtime_grants_nonce', ${nonce}, false)
  `;
  await upgradeSql`
    select set_config(
      'companion.runtime_grants_verified',
      'v1:' || md5(concat_ws(
        chr(31),
        current_setting('companion.runtime_grants_nonce'),
        current_database(),
        current_user,
        pg_backend_pid()::text,
        current_setting('companion.api_role'),
        current_setting('companion.worker_role'),
        current_setting('companion.companion_runtime_role'),
        current_setting('companion.retired_runtime_role')
      )),
      false
    )
  `;
}

async function seedHistoricalRuntimeAcl(): Promise<void> {
  await upgradeSql.unsafe(
    `revoke all on function public.companion_runtime_authorize_desktop(uuid,uuid,text) from public`,
  );
  await upgradeSql.unsafe(
    `revoke all on function public.companion_runtime_claim_work(text,integer,integer,bigint) from public`,
  );
  await upgradeSql.unsafe(
    `grant execute on function public.companion_runtime_authorize_desktop(uuid,uuid,text) to ${runtimeRole}`,
  );
  await upgradeSql.unsafe(
    `grant execute on function public.companion_runtime_claim_work(text,integer,integer,bigint) to ${runtimeRole}`,
  );
}

describe("0113 deferred Skill update upgrade", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create role ${runtimeRole} login nosuperuser nobypassrls noinherit`);
    await adminSql.unsafe(`create database "${databaseName}"`);
    await adminSql.unsafe(`grant connect on database "${databaseName}" to ${runtimeRole}`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const historicalMigrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0113_defer_skill_updates_to_pi_stop.sql")
      .sort();
    for (const migration of historicalMigrations) {
      if (migration === "0094_companion_runtime_cutover.sql") await satisfyRuntimeCutoverGuard();
      if (migration === "0095_companion_runtime_desktop_replay_recovery.sql") {
        await seedHistoricalRuntimeAcl();
      }
      await applyMigrationFile(migration);
    }

    await upgradeSql`
      insert into "user" (id, name, email, email_verified)
      values (${actorId}, 'Upgrade Owner', 'deferred-upgrade@example.test', true)
    `;
    await upgradeSql`
      insert into profiles (id, email, name, initials)
      values (${actorId}, 'deferred-upgrade@example.test', 'Upgrade Owner', 'UO')
    `;
    await upgradeSql`
      insert into organizations (id, name, slug)
      values (${orgId}::uuid, 'Deferred Skill Upgrade', ${`deferred-skill-${orgId}`})
    `;
    await upgradeSql`
      insert into memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${actorId}, 'owner')
    `;
    await upgradeSql`
      insert into skills (
        id, org_id, slug, display_name, description, creator_id, scope
      ) values (
        ${skillId}::uuid, ${orgId}::uuid, 'upgrade-skill', 'Upgrade Skill',
        'Migration regression fixture', ${actorId}, 'personal'
      )
    `;
    await upgradeSql`
      insert into skill_versions (
        id, org_id, skill_id, version, frontmatter, body, size_bytes, checksum,
        storage_path, created_by
      ) values (
        ${versionId}::uuid, ${orgId}::uuid, ${skillId}::uuid, '1.0.0',
        '{"name":"upgrade-skill","description":"Migration regression fixture"}',
        '# Upgrade Skill', 15, ${`sha256:${"a".repeat(64)}`},
        'integration/upgrade-skill/1.0.0.tar.gz', ${actorId}
      )
    `;
    await upgradeSql`
      update skills set current_version_id = ${versionId}::uuid where id = ${skillId}::uuid
    `;
    await upgradeSql`
      insert into companions (id, org_id, owner_id, name, selected_skill_ids)
      values (
        ${companionId}::uuid, ${orgId}::uuid, ${actorId}, 'Upgrade Companion',
        ${upgradeSql.json([skillId])}
      )
    `;
    await upgradeSql`
      insert into companion_runtime_instances (org_id, companion_id)
      values (${orgId}::uuid, ${companionId}::uuid)
    `;

    for (const requestId of [randomUUID(), randomUUID()]) {
      await upgradeSql`
        insert into companion_operations (
          org_id, companion_id, request_id, kind, trigger, actor_id, runtime_generation
        ) values (
          ${orgId}::uuid, ${companionId}::uuid, ${requestId}::uuid,
          'stop', 'user', ${actorId}, 1
        )
      `;
    }
    await upgradeSql`
      update companion_operations
      set status = 'succeeded', checkpoint = 'box_archived', settled_at = now()
      where companion_id = ${companionId}::uuid
        and id = (
          select id from companion_operations
          where companion_id = ${companionId}::uuid
          order by id limit 1
        )
    `;

    await applyMigrationFile("0113_defer_skill_updates_to_pi_stop.sql");
  }, 120_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`drop role if exists ${runtimeRole}`);
    await adminSql.end({ timeout: 1 });
  });

  it("backfills pending and settled legacy Stops with an authorized immutable Skill snapshot", async () => {
    const operations = await upgradeSql<Array<{
      targetSkillsRevision: number;
      selectedSkillIds: unknown;
      skillRefs: unknown;
      skillUpdateSelectedSkillIds: string[];
      skillUpdateRefs: Array<{ skill_id: string; current_version_id: string }>;
    }>>`
      select
        target_skills_revision as "targetSkillsRevision",
        selected_skill_ids as "selectedSkillIds",
        skill_refs as "skillRefs",
        skill_update_selected_skill_ids as "skillUpdateSelectedSkillIds",
        skill_update_refs as "skillUpdateRefs"
      from companion_operations
      where companion_id = ${companionId}::uuid and kind = 'stop'
      order by status
    `;

    expect(operations).toHaveLength(2);
    for (const operation of operations) {
      expect(operation).toEqual({
        targetSkillsRevision: 1,
        selectedSkillIds: null,
        skillRefs: null,
        skillUpdateSelectedSkillIds: [skillId],
        skillUpdateRefs: [{ skill_id: skillId, current_version_id: versionId }],
      });
    }
  });

  it("installs the tightened Stop constraints as validated", async () => {
    const constraints = await upgradeSql<Array<{ name: string; validated: boolean }>>`
      select conname as name, convalidated as validated
      from pg_constraint
      where conrelid = 'public.companion_operations'::regclass
        and conname in (
          'companion_operations_target_revision_check',
          'companion_operations_resource_snapshot_check'
        )
      order by conname
    `;
    expect(constraints).toEqual([
      { name: "companion_operations_resource_snapshot_check", validated: true },
      { name: "companion_operations_target_revision_check", validated: true },
    ]);
  });

  it("keeps the newly separated Skill update snapshot immutable", async () => {
    await expect(upgradeSql`
      update companion_operations
      set skill_update_refs = '[]'::jsonb
      where companion_id = ${companionId}::uuid and kind = 'stop'
    `).rejects.toMatchObject({ code: "23514" });
  });
});
