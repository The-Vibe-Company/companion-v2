/**
 * Product promise:
 * Projects created before Files reconciliation was introduced keep working after an upgrade, and a
 * cold Project blocked on a stale provider marker can be reclaimed once its queued conversation no
 * longer requires a missing model credential.
 *
 * Regression caught:
 * Editing the already-applied 0054 migration makes fresh databases pass while deployed databases
 * never receive the reconciliation fence, index, constraint, or repaired workspace claim function.
 *
 * Why this test is integrated:
 * The guarantee depends on replaying the real migration history through 0055 against PostgreSQL,
 * preserving an existing prompt, and then applying the exact 0056 SQL.
 *
 * Failure proof:
 * Removing the 0056 column, constraint, partial index, or CREATE OR REPLACE function makes one of the
 * assertions below fail.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error(
    "project prompt reconciliation migration integration test requires an explicit disposable DATABASE_URL",
  );
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const databaseName = `companion_project_reconciliation_${randomUUID().replaceAll("-", "")}`;
const orgId = "00000000-0000-0000-0000-0000000000a1";
const projectId = "10000000-0000-0000-0000-0000000000a1";
const sessionId = "20000000-0000-0000-0000-0000000000a1";
const promptId = "30000000-0000-0000-0000-0000000000a1";
const creatorId = "project-reconciliation-user";
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

describe("0056 Project prompt Files reconciliation upgrade", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const historicalMigrations = (await readdir(migrationsDir))
      .filter(
        (name) =>
          /^\d{4}_.+\.sql$/.test(name) &&
          name < "0056_project_prompt_file_reconciliation.sql",
      )
      .sort();
    for (const migration of historicalMigrations) await applyMigrationFile(migration);

    await upgradeSql`
      insert into "user" (id, name, email, email_verified)
      values (
        ${creatorId},
        'Project Reconciliation User',
        'project-reconciliation@example.test',
        true
      )
    `;
    await upgradeSql`
      insert into organizations (id, name, slug)
      values (${orgId}::uuid, 'Project Reconciliation Org', 'project-reconciliation-org')
    `;
    await upgradeSql`
      insert into memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${creatorId}, 'developer')
    `;
    await upgradeSql`
      insert into projects (
        id,
        org_id,
        creator_id,
        idempotency_key,
        payload_hash,
        name,
        default_model
      )
      values (
        ${projectId}::uuid,
        ${orgId}::uuid,
        ${creatorId},
        'project-upgrade-key',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'Upgrade Project',
        'test/model'
      )
    `;
    await upgradeSql`
      insert into project_workspaces (
        org_id,
        project_id,
        creator_id,
        status,
        sandbox_name,
        desired_generation,
        applied_generation,
        last_error_code
      )
      values (
        ${orgId}::uuid,
        ${projectId}::uuid,
        ${creatorId},
        'error',
        'project-reconciliation-sandbox',
        1,
        1,
        'project_provider_unavailable'
      )
    `;
    await upgradeSql`
      insert into project_sessions (
        id,
        org_id,
        project_id,
        creator_id,
        title,
        model,
        model_provider,
        model_credential_env_keys,
        status
      )
      values (
        ${sessionId}::uuid,
        ${orgId}::uuid,
        ${projectId}::uuid,
        ${creatorId},
        'Upgrade conversation',
        'test/model',
        'test',
        '{}'::text[],
        'queued'
      )
    `;
    await upgradeSql`
      insert into project_prompts (
        id,
        org_id,
        project_id,
        session_id,
        creator_id,
        sequence,
        text,
        status,
        idempotency_key,
        payload_hash,
        usage_activation_revision,
        usage_reservation_ms,
        opencode_message_id
      )
      values (
        ${promptId}::uuid,
        ${orgId}::uuid,
        ${projectId}::uuid,
        ${sessionId}::uuid,
        ${creatorId},
        1,
        'Continue after upgrade',
        'queued',
        'prompt-upgrade-key',
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        1,
        0,
        'project-upgrade-message'
      )
    `;

    const blockedBeforeUpgrade = await upgradeSql`
      select project_id
      from companion_claim_project_workspaces('migration-worker-before', 1, 30)
    `;
    expect(blockedBeforeUpgrade).toHaveLength(0);

    await applyMigrationFile("0056_project_prompt_file_reconciliation.sql");
  }, 60_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.end({ timeout: 1 });
  });

  it("adds a durable reconciliation fence without rewriting existing prompts", async () => {
    const prompts = await upgradeSql<
      { id: string; fileReconciliationEventSequence: number | null }[]
    >`
      select
        id::text as id,
        file_reconciliation_event_sequence as "fileReconciliationEventSequence"
      from project_prompts
      where id = ${promptId}::uuid
    `;
    expect(prompts).toEqual([
      {
        id: promptId,
        fileReconciliationEventSequence: null,
      },
    ]);

    await expect(
      upgradeSql`
        update project_prompts
        set file_reconciliation_event_sequence = 0
        where id = ${promptId}::uuid
      `,
    ).rejects.toMatchObject({ code: "23514" });

    await expect(
      upgradeSql`
        update project_prompts
        set file_reconciliation_event_sequence = 1
        where id = ${promptId}::uuid
      `,
    ).resolves.toBeDefined();
  });

  it("installs the pending reconciliation index and repaired claim function", async () => {
    const indexes = await upgradeSql<{ definition: string }[]>`
      select indexdef as definition
      from pg_indexes
      where schemaname = 'public'
        and indexname = 'project_prompts_file_reconciliation_idx'
    `;
    expect(indexes).toHaveLength(1);
    expect(indexes[0]?.definition).toContain(
      "WHERE ((status = 'completed'::project_prompt_status) AND (file_reconciliation_event_sequence IS NULL))",
    );

    const claimed = await upgradeSql<{ projectId: string }[]>`
      select project_id::text as "projectId"
      from companion_claim_project_workspaces('migration-worker-after', 1, 30)
    `;
    expect(claimed).toEqual([{ projectId }]);
  });
});
