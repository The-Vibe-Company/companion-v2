/**
 * Product promise:
 * Deploying delete resumption converts only accepted, retryable legacy failures back into durable
 * work and quarantines executors that do not know how to release a non-terminal provider poll.
 *
 * Why integrated:
 * The guarantee spans migration-time data repair, overloaded SECURITY DEFINER entrypoints and real
 * PostgreSQL ACLs. A unit mock cannot prove the rolling-deploy guard or the backfill predicate.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("delete resume migration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `delete_resume_${suffix}`;
const runtimeRole = `delete_resume_runtime_${suffix.slice(0, 10)}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const upgradeUrl = new URL(databaseUrl);
upgradeUrl.pathname = `/${databaseName}`;
upgradeUrl.search = "";
let upgradeSql: ReturnType<typeof postgres>;

const actorId = `delete-resume-owner-${suffix}`;
const orgId = randomUUID();
const eligibleCompanionId = randomUUID();
const providerCheckpointCompanionId = randomUUID();
const ineligibleCompanionIds = [randomUUID(), randomUUID(), randomUUID()];

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
  const nonce = "b".repeat(32);
  await upgradeSql`
    select
      set_config('companion.api_role', 'delete_resume_api', false),
      set_config('companion.worker_role', 'delete_resume_worker', false),
      set_config('companion.companion_runtime_role', ${runtimeRole}, false),
      set_config('companion.retired_runtime_role', '', false),
      set_config('companion.runtime_grants_nonce', ${nonce}, false)
  `;
  await upgradeSql`
    select set_config(
      'companion.runtime_grants_verified',
      'v1:' || md5(concat_ws(
        chr(31), current_setting('companion.runtime_grants_nonce'), current_database(),
        current_user, pg_backend_pid()::text, current_setting('companion.api_role'),
        current_setting('companion.worker_role'),
        current_setting('companion.companion_runtime_role'),
        current_setting('companion.retired_runtime_role')
      )), false
    )
  `;
}

async function seedHistoricalRuntimeAcl(): Promise<void> {
  await upgradeSql.unsafe(
    "revoke all on function public.companion_runtime_authorize_desktop(uuid,uuid,text) from public",
  );
  await upgradeSql.unsafe(
    "revoke all on function public.companion_runtime_claim_work(text,integer,integer,bigint) from public",
  );
  await upgradeSql.unsafe(
    `grant execute on function public.companion_runtime_authorize_desktop(uuid,uuid,text) to ${runtimeRole}`,
  );
  await upgradeSql.unsafe(
    `grant execute on function public.companion_runtime_claim_work(text,integer,integer,bigint) to ${runtimeRole}`,
  );
  await upgradeSql.unsafe(
    "revoke all on function public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) from public",
  );
  await upgradeSql.unsafe(
    `grant execute on function public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) to ${runtimeRole}`,
  );
}

async function insertFailedDelete(input: {
  companionId: string;
  checkpoint: string;
  providerOperationId: string | null;
  errorCode: string;
}): Promise<string> {
  const operationId = randomUUID();
  await upgradeSql`
    insert into companion_operations(
      id, org_id, companion_id, request_id, kind, trigger, actor_id, runtime_generation,
      status, checkpoint, provider_operation_id, started_at, settled_at,
      last_error_code, last_error_message, last_error_action
    ) values (
      ${operationId}::uuid, ${orgId}::uuid, ${input.companionId}::uuid, ${randomUUID()}::uuid,
      'delete', 'user', ${actorId}, 1, 'failed', ${input.checkpoint},
      ${input.providerOperationId}, now() - interval '1 hour', now() - interval '30 minutes',
      ${input.errorCode}, 'Legacy expurgated delete failure.', 'retry'
    )
  `;
  return operationId;
}

describe("0114 accepted delete resumption upgrade", () => {
  let newestEligibleOperationId = "";
  let olderEligibleOperationId = "";
  let providerCheckpointOperationId = "";

  beforeAll(async () => {
    await adminSql.unsafe(`create role ${runtimeRole} login nosuperuser nobypassrls noinherit`);
    await adminSql.unsafe(`create database "${databaseName}"`);
    await adminSql.unsafe(`grant connect on database "${databaseName}" to ${runtimeRole}`);
    upgradeSql = postgres(upgradeUrl.toString(), { max: 1 });

    const historicalMigrations = (await readdir(migrationsDir))
      .filter((name) => /^\d{4}_.+\.sql$/.test(name) && name < "0114_companion_delete_resume.sql")
      .sort();
    for (const migration of historicalMigrations) {
      if (migration === "0094_companion_runtime_cutover.sql") await satisfyRuntimeCutoverGuard();
      if (migration === "0095_companion_runtime_desktop_replay_recovery.sql") {
        await seedHistoricalRuntimeAcl();
      }
      await applyMigrationFile(migration);
    }
    // Production reapplies the split-role grants after the post-cutover migration phase. Seed the
    // same single executor ACL after 0113's CREATE OR REPLACE surfaces and before 0114 mirrors it.
    await upgradeSql.unsafe(
      "revoke all on function public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) from public",
    );
    await upgradeSql.unsafe(
      `grant execute on function public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer) to ${runtimeRole}`,
    );

    await upgradeSql`
      insert into "user" (id, name, email, email_verified)
      values (${actorId}, 'Delete Resume Owner', ${`${actorId}@example.test`}, true)
    `;
    await upgradeSql`
      insert into organizations (id, name, slug)
      values (${orgId}::uuid, 'Delete Resume Upgrade', ${`delete-resume-${suffix}`})
    `;
    await upgradeSql`
      insert into memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${actorId}, 'owner')
    `;
    for (const companionId of [
      eligibleCompanionId,
      providerCheckpointCompanionId,
      ...ineligibleCompanionIds,
    ]) {
      await upgradeSql`
        insert into companions (id, org_id, owner_id, name)
        values (${companionId}::uuid, ${orgId}::uuid, ${actorId}, ${`Delete ${companionId}`})
      `;
      await upgradeSql`
        insert into companion_runtime_instances (org_id, companion_id)
        values (${orgId}::uuid, ${companionId}::uuid)
      `;
    }

    olderEligibleOperationId = await insertFailedDelete({
      companionId: eligibleCompanionId,
      checkpoint: "provider_delete_requested",
      providerOperationId: "accepted-delete-old",
      errorCode: "box_delete_blocked",
    });
    newestEligibleOperationId = await insertFailedDelete({
      companionId: eligibleCompanionId,
      checkpoint: "waiting_deleted",
      providerOperationId: "accepted-delete-new",
      errorCode: "box_delete_deadline_exceeded",
    });
    providerCheckpointOperationId = await insertFailedDelete({
      companionId: providerCheckpointCompanionId,
      checkpoint: "provider_delete_requested",
      providerOperationId: "accepted-delete-provider-checkpoint",
      errorCode: "box_delete_blocked",
    });
    await insertFailedDelete({
      companionId: ineligibleCompanionIds[0]!,
      checkpoint: "waiting_deleted",
      providerOperationId: null,
      errorCode: "box_delete_deadline_exceeded",
    });
    await insertFailedDelete({
      companionId: ineligibleCompanionIds[1]!,
      checkpoint: "pending",
      providerOperationId: "not-yet-accepted",
      errorCode: "box_delete_deadline_exceeded",
    });
    await insertFailedDelete({
      companionId: ineligibleCompanionIds[2]!,
      checkpoint: "waiting_deleted",
      providerOperationId: "non-retryable",
      errorCode: "runtime_execution_failed",
    });

    await applyMigrationFile("0114_companion_delete_resume.sql");
  }, 120_000);

  afterAll(async () => {
    await upgradeSql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`drop role if exists ${runtimeRole}`);
    await adminSql.end({ timeout: 1 });
  });

  it("requeues only the newest eligible failed delete and preserves its provider operation", async () => {
    const operations = await upgradeSql<Array<{
      id: string;
      status: string;
      providerOperationId: string | null;
      errorCode: string | null;
    }>>`
      select id::text, status::text, provider_operation_id as "providerOperationId",
        last_error_code as "errorCode"
      from companion_operations where kind = 'delete' order by created_at, id
    `;
    expect(operations.find((operation) => operation.id === newestEligibleOperationId)).toEqual({
      id: newestEligibleOperationId,
      status: "pending",
      providerOperationId: "accepted-delete-new",
      errorCode: null,
    });
    expect(operations.find((operation) => operation.id === olderEligibleOperationId)?.status)
      .toBe("failed");
    expect(operations.find((operation) => operation.id === providerCheckpointOperationId)).toEqual({
      id: providerCheckpointOperationId,
      status: "pending",
      providerOperationId: "accepted-delete-provider-checkpoint",
      errorCode: null,
    });
    expect(operations.filter((operation) => operation.status === "pending")).toHaveLength(2);
  });

  it("quarantines the old claim signature and grants only the guarded resume surface", async () => {
    const [disabledGate] = await upgradeSql<Array<{ epoch: string }>>`
      select gate_epoch::text as epoch from companion_runtime_control where id = 'runtime-v2'
    `;
    await upgradeSql`
      select * from public.companion_runtime_enable(
        ${disabledGate!.epoch}::bigint, 'delete-resume-migration-test'
      )
    `;
    const [gate] = await upgradeSql<Array<{ epoch: string }>>`
      select gate_epoch::text as epoch from companion_runtime_control where id = 'runtime-v2'
    `;
    const claims = await upgradeSql.begin(async (transaction) => {
      await transaction.unsafe(`set local role ${runtimeRole}`);
      const oldClaims = await transaction`
        select * from public.companion_runtime_claim_work(
          'old-delete-runtime', 10, 30, ${gate!.epoch}::bigint, 1
        )
      `;
      const newClaims = await transaction<Array<{
        workId: string;
        checkpoint: string;
        providerOperationId: string | null;
      }>>`
        select work_id::text as "workId", checkpoint,
          provider_operation_id as "providerOperationId"
        from public.companion_runtime_claim_work(
          'new-delete-runtime', 10, 30, ${gate!.epoch}::bigint, 1, 1
        )
      `;
      return { oldClaims, newClaims };
    });
    expect(claims.oldClaims).toEqual([]);
    expect(claims.newClaims.map((claim) => claim.workId)).toContain(newestEligibleOperationId);
    expect(claims.newClaims).toContainEqual({
      workId: providerCheckpointOperationId,
      checkpoint: "provider_delete_requested",
      providerOperationId: "accepted-delete-provider-checkpoint",
    });
    const [acl] = await upgradeSql<Array<{
      runtimeDefer: boolean;
      publicDefer: boolean;
      internalClaim: boolean;
    }>>`
      select
        has_function_privilege(
          ${runtimeRole},
          'public.companion_runtime_defer_delete(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)',
          'EXECUTE'
        ) as "runtimeDefer",
        exists (
          select 1 from pg_proc procedure
          cross join lateral aclexplode(
            coalesce(procedure.proacl, acldefault('f', procedure.proowner))
          ) acl
          where procedure.oid =
            'public.companion_runtime_defer_delete(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)'::regprocedure
            and acl.grantee = 0 and acl.privilege_type = 'EXECUTE'
        ) as "publicDefer",
        has_function_privilege(
          ${runtimeRole},
          'public.companion_runtime_claim_work_without_delete_resume_guard(text,integer,integer,bigint,integer)',
          'EXECUTE'
        ) as "internalClaim"
    `;
    expect(acl).toEqual({ runtimeDefer: true, publicDefer: false, internalClaim: false });
  });
});
