/**
 * Product promise:
 * the isolated Runtime v2 login can fetch only lease-authorized material and can commit a typed
 * broker projection before ACK without ever receiving direct table privileges. Desktop minting
 * exposes only a fully staged warm Box whose personal Skills and MCP pins belong to that actor.
 *
 * Regression caught:
 * a forged tenant/fence, response-lost projection retry, revoked actor, duplicate generation Box,
 * Viewer request, revision drift, or Owner/Editor resource-owner swap must not expose a Box,
 * leak credentials, duplicate transcript rows, or cross a stale lease epoch.
 *
 * Why integrated:
 * the guarantees depend on real SECURITY DEFINER ownership, FORCE RLS, triggers, enum/check
 * constraints, and transactional cursor/projection writes.
 */
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  companionOperationSchema,
  companionTranscriptEntrySchema,
  companionTurnSchema,
  type CompanionConfigProposal,
} from "@companion/contracts";
import {
  RuntimeDatabaseRoleError,
  verifyRuntimeDatabaseRole,
} from "@companion/db/runtime-role";
import {
  PostgresRuntimeStore,
  type LeaseFence,
  type RuntimeSqlClient,
} from "@companion/companion-runtime";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("Companion runtime executor integration test requires an explicit disposable DATABASE_URL");
}

const migrationsDir = fileURLToPath(new URL("../../../../packages/db/drizzle/", import.meta.url));
const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
const databaseName = `runtime_exec_${suffix}`;
const apiRole = `runtime_exec_api_${suffix}`;
const workerRole = `runtime_exec_worker_${suffix}`;
const runtimeRole = `runtime_exec_role_${suffix}`;
const executorId = `runtime-executor-${suffix}`;
const adminSql = postgres(databaseUrl, { max: 1 });
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.pathname = `/${databaseName}`;
runtimeUrl.search = "";

type Sql = ReturnType<typeof postgres>;
type Tx = postgres.TransactionSql;

interface Claim {
  orgId: string;
  companionId: string;
  claimToken: string;
  claimEpoch: string;
  gateEpoch: string;
  workKind: "operation" | "decision" | "attempt" | "settings" | "health";
  workId: string;
  checkpointSequence: string;
  runtimeGeneration: string;
}

const ids = {
  orgA: randomUUID(),
  orgB: randomUUID(),
  ownerA: `runtime-exec-owner-a-${suffix}`,
  editorA: `runtime-exec-editor-a-${suffix}`,
  viewerA: `runtime-exec-viewer-a-${suffix}`,
  revokedA: `runtime-exec-revoked-a-${suffix}`,
  ownerB: `runtime-exec-owner-b-${suffix}`,
  skill: randomUUID(),
  skillVersion: randomUUID(),
  orgSkill: randomUUID(),
  orgSkillVersion: randomUUID(),
  editorSkill: randomUUID(),
  editorSkillVersion: randomUUID(),
  mcpAccount: randomUUID(),
  mcpGeneration: randomUUID(),
  editorMcpAccount: randomUUID(),
  editorMcpGeneration: randomUUID(),
  revokedMcpAccount: randomUUID(),
  revokedMcpGeneration: randomUUID(),
};
const providerId = `runtime-exec-${suffix}`;
const providerGeneration = randomUUID();
const checksum = `sha256:${"a".repeat(64)}`;
let sql: Sql | undefined;

async function applyMigrationFile(client: Sql, name: string): Promise<void> {
  const source = await readFile(`${migrationsDir}/${name}`, "utf8");
  const statements = source
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter(Boolean);
  await client.begin(async (tx) => {
    for (const statement of statements) await tx.unsafe(statement);
  });
}

async function migrationFileNames(): Promise<string[]> {
  return (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

async function replayMigrations(client: Sql, names: string[]): Promise<void> {
  for (const name of names) await applyMigrationFile(client, name);
}

async function applySplitGrants(database: Sql | undefined = sql): Promise<void> {
  if (!database) throw new Error("runtime executor database is not initialized");
  const grants = extractRuntimeRoleGrantBlock(
    await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
  );
  const connection = await database.reserve();
  try {
    await connection`select set_config('companion.api_role', ${apiRole}, false)`;
    await connection`select set_config('companion.worker_role', ${workerRole}, false)`;
    await connection`select set_config('companion.companion_runtime_role', ${runtimeRole}, false)`;
    await connection`select set_config('companion.retired_runtime_role', '', false)`;
    await connection.unsafe(grants);
  } finally {
    connection.release();
  }
}

async function asRuntime<T>(action: (tx: Tx) => Promise<T>): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${runtimeRole}`);
    return { value: await action(tx) };
  });
  return wrapped.value;
}

async function asApi<T>(input: {
  orgId: string;
  actorId: string;
  action: (tx: Tx) => PromiseLike<T>;
}): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${apiRole}`);
    await tx`select set_config('app.org_id', ${input.orgId}, true)`;
    await tx`select set_config('app.user_id', ${input.actorId}, true)`;
    return { value: await input.action(tx) };
  });
  return wrapped.value;
}

async function asApplicationRoleWithForgedProtocol<T>(input: {
  role: string;
  action: (tx: Tx) => PromiseLike<T>;
}): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${input.role}`);
    await tx`select set_config('app.org_id', ${ids.orgA}, true)`;
    await tx`select set_config('app.user_id', ${ids.ownerA}, true)`;
    await tx`select set_config('app.companion_runtime_protocol', '2', true)`;
    return { value: await input.action(tx) };
  });
  return wrapped.value;
}

async function asOwnerV2<T>(action: (tx: Tx) => PromiseLike<T>): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx`select set_config('app.companion_runtime_protocol', '2', true)`;
    return { value: await action(tx) };
  });
  return wrapped.value;
}

async function createCompanion(input: {
  actorId?: string;
  boxReady?: boolean;
  workspaceRole?: "editor" | "viewer";
  selectedSkillIds?: string[];
  selectedMcpAccountIds?: string[];
} = {}): Promise<{ companionId: string; turnId: string; attemptId: string; prompt: string }> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const companionId = randomUUID();
  const turnId = randomUUID();
  const attemptId = randomUUID();
  const clientMessageId = randomUUID();
  const prompt = `durable prompt ${clientMessageId}`;
  const actorId = input.actorId ?? ids.ownerA;
  const selectedSkillIds = input.selectedSkillIds ?? [ids.skill];
  const selectedMcpAccountIds = input.selectedMcpAccountIds ?? [ids.mcpAccount];
  const mcpGenerations = new Map<string, string>([
    [ids.mcpAccount, ids.mcpGeneration],
    [ids.editorMcpAccount, ids.editorMcpGeneration],
    [ids.revokedMcpAccount, ids.revokedMcpGeneration],
  ]);
  const mcpCredentialRefs = selectedMcpAccountIds.map((accountId) => ({
    account_id: accountId,
    credential_generation: mcpGenerations.get(accountId) ?? ids.mcpGeneration,
  }));
  await sql`
    insert into companions (
      id, org_id, owner_id, name, model_id, provider_ids,
      selected_skill_ids, selected_mcp_account_ids
    ) values (
      ${companionId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Runtime executor fixture',
      'fixture-model', ${sql.json([providerId])}, ${sql.json(selectedSkillIds)},
      ${sql.json(selectedMcpAccountIds)}
    )
  `;
  if (input.workspaceRole) {
    await sql`
      insert into companion_workspace_access (
        org_id, companion_id, owner_id, role, granted_by
      ) values (
        ${ids.orgA}::uuid, ${companionId}::uuid, ${ids.ownerA},
        ${input.workspaceRole}, ${ids.ownerA}
      )
    `;
  }
  await sql`
    insert into companion_runtime_instances (
      org_id, companion_id, box_id, box_state, pi_state, pi_invocation_id,
      disk_layout_version, applied_settings_revision, applied_skills_revision,
      applied_client_surface, health_due_at
    ) values (
      ${ids.orgA}::uuid, ${companionId}::uuid,
      ${input.boxReady ? "bx_23456789" : null},
      ${input.boxReady ? "ready" : "absent"},
      ${input.boxReady ? "idle" : "absent"},
      ${input.boxReady ? `pi-${attemptId}` : null},
      ${input.boxReady ? 14 : 0}, 1, 1, 'web', now() + interval '1 day'
    )
  `;
  await sql`
    insert into companion_threads(org_id, companion_id, next_ordinal, last_message_at)
    values (${ids.orgA}::uuid, ${companionId}::uuid, 1, now())
  `;
  await sql`
    insert into companion_transcript_entries(
      org_id, companion_id, event_id, ordinal, role, content, author_id
    ) values (
      ${ids.orgA}::uuid, ${companionId}::uuid, ${`msg:${clientMessageId}`},
      0, 'user', ${prompt}, ${actorId}
    )
  `;
  await sql`
    insert into companion_turns (
      id, org_id, companion_id, client_message_id, message_event_id,
      queue_sequence, actor_id, client_surface, status,
      inactivity_deadline_at, absolute_deadline_at
    ) values (
      ${turnId}::uuid, ${ids.orgA}::uuid, ${companionId}::uuid,
      ${clientMessageId}::uuid, ${`msg:${clientMessageId}`}, 1,
      ${actorId}, 'web', 'running', now() + interval '10 minutes', now() + interval '2 hours'
    )
  `;
  await sql`
    insert into companion_turn_attempts (
      id, org_id, companion_id, turn_id, attempt_number, actor_id,
      runtime_generation, settings_revision, skills_revision, model_id,
      provider_ids, provider_credential_refs, selected_skill_ids,
      selected_mcp_account_ids, mcp_credential_refs,
      status, checkpoint, dispatch_state, command_id,
      dispatch_accepted_at, pi_invocation_id, last_activity_at
    ) values (
      ${attemptId}::uuid, ${ids.orgA}::uuid, ${companionId}::uuid, ${turnId}::uuid,
      1, ${actorId}, 1, 1, 1, 'fixture-model', ${sql.json([providerId])},
      ${sql.json([{
        provider_id: providerId,
        credential_generation: providerGeneration,
        credential_version: 1,
      }])}, ${sql.json(selectedSkillIds)}, ${sql.json(selectedMcpAccountIds)},
      ${sql.json(mcpCredentialRefs)},
      'running', 'running', 'accepted', ${randomUUID()}::uuid,
      now(), ${`pi-${attemptId}`}, now()
    )
  `;
  return { companionId, turnId, attemptId, prompt };
}

async function claimWork(): Promise<Claim> {
  const rows = await asRuntime((tx) => tx<Array<Claim>>`
    select org_id::text as "orgId", companion_id::text as "companionId",
      claim_token::text as "claimToken", claim_epoch::text as "claimEpoch",
      gate_epoch::text as "gateEpoch", work_kind::text as "workKind",
      work_id::text as "workId", checkpoint_sequence::text as "checkpointSequence",
      runtime_generation::text as "runtimeGeneration"
    from public.companion_runtime_claim_work(${executorId}, 1, 30, (
      select gate_epoch from public.companion_runtime_gate_status()
    ))
  `);
  if (!rows[0]) throw new Error("expected one Runtime v2 claim");
  return rows[0];
}

async function release(claim: Claim): Promise<void> {
  await asRuntime((tx) => tx`
    select public.companion_runtime_release_lease(
      ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
      ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
      ${claim.workKind}, ${claim.workId}::uuid
    )
  `);
}

async function removeCompanion(companionId: string): Promise<void> {
  if (!sql) return;
  await sql`delete from companion_decision_deliveries where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_runtime_event_projections where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_runtime_duplicate_cleanups where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_turn_attempts where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_operations where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_turns where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_runtime_leases where companion_id = ${companionId}::uuid`;
  await sql`delete from companion_runtime_instances where companion_id = ${companionId}::uuid`;
  await sql`delete from companions where id = ${companionId}::uuid`;
}

interface DesktopAuthorization {
  authorized: boolean;
  denialCode: string | null;
  boxId: string | null;
  boxState: string | null;
  generation: string | null;
}

async function authorizeDesktop(input: {
  companionId: string;
  orgId?: string;
  actorId: string;
}): Promise<DesktopAuthorization[]> {
  return await asRuntime((tx) => tx<Array<DesktopAuthorization>>`
    select authorized, denial_code as "denialCode", box_id as "boxId",
      box_state::text as "boxState", runtime_generation::text as generation
    from public.companion_runtime_authorize_desktop(
      ${input.orgId ?? ids.orgA}::uuid, ${input.companionId}::uuid, ${input.actorId}
    )
  `);
}

describe("Companion runtime executor PostgreSQL surface", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${runtimeRole} login nosuperuser nobypassrls noinherit;
    `);
    await adminSql.unsafe(`create database "${databaseName}"`);
    const migrationSql = postgres(runtimeUrl.toString(), { max: 1 });
    const migrations = await migrationFileNames();
    const cutoverIndex = migrations.findIndex((name) => name.startsWith("0094_"));
    if (cutoverIndex < 0) throw new Error("Runtime v2 cutover migration is missing");
    try {
      await replayMigrations(migrationSql, migrations.slice(0, cutoverIndex));
      await applySplitGrants(migrationSql);
      await replayMigrations(migrationSql, migrations.slice(cutoverIndex));
      // The two-phase migration runner re-applies the grants hook after the post-cutover phase, for
      // the same reason it is needed here: a migration that has to DROP + CREATE a function resets
      // that function's ACL, so grants taken before the phase describe a surface that no longer
      // exists. Mirroring production ordering is what makes this suite's ACL assertions meaningful.
      await applySplitGrants(migrationSql);
    } finally {
      await migrationSql.end();
    }
    // Runtime grant application and the cutover guard require one physical
    // migration connection. The behavior tests deliberately use a wider pool
    // so Promise.all exercises concurrent database transactions instead of a
    // serialized single-connection queue.
    sql = postgres(runtimeUrl.toString(), { max: 4 });

    for (const [index, userId] of [
      ids.ownerA, ids.editorA, ids.viewerA, ids.revokedA, ids.ownerB,
    ].entries()) {
      await sql`
        insert into "user" (id, name, email, email_verified)
        values (${userId}, ${`Runtime executor actor ${index}`}, ${`${userId}@example.test`}, true)
      `;
    }
    await sql`
      insert into organizations(id, name, slug, kind) values
        (${ids.orgA}::uuid, 'Runtime executor A', ${`runtime-exec-a-${suffix}`}, 'team'),
        (${ids.orgB}::uuid, 'Runtime executor B', ${`runtime-exec-b-${suffix}`}, 'team')
    `;
    await sql`
      insert into memberships(org_id, user_id, org_role) values
        (${ids.orgA}::uuid, ${ids.ownerA}, 'owner'),
        (${ids.orgA}::uuid, ${ids.editorA}, 'developer'),
        (${ids.orgA}::uuid, ${ids.viewerA}, 'developer'),
        (${ids.orgA}::uuid, ${ids.revokedA}, 'developer'),
        (${ids.orgB}::uuid, ${ids.ownerB}, 'owner')
    `;
    await sql`
      insert into companion_provider_connections(
        org_id, provider_id, auth_method, credential_generation, credential_version,
        ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
      ) values (
        ${ids.orgA}::uuid, ${providerId}, 'api_key', ${providerGeneration}::uuid, 1,
        'ciphertext-provider', 'iv-provider', 'tag-provider', 'wrapped-provider',
        'wrap-iv-provider', 'wrap-tag-provider', 'key-provider', ${ids.ownerA}
      )
    `;
    await sql`
      insert into skills(id, org_id, slug, description, creator_id, scope)
      values
        (
          ${ids.skill}::uuid, ${ids.orgA}::uuid, ${`runtime-skill-${suffix}`},
          'Runtime immutable Skill fixture', ${ids.ownerA}, 'personal'
        ),
        (
          ${ids.orgSkill}::uuid, ${ids.orgA}::uuid, ${`runtime-org-skill-${suffix}`},
          'Runtime organization Skill fixture', ${ids.ownerA}, 'org'
        ),
        (
          ${ids.editorSkill}::uuid, ${ids.orgA}::uuid, ${`runtime-editor-skill-${suffix}`},
          'Runtime Editor Skill fixture', ${ids.editorA}, 'personal'
        )
    `;
    await sql`
      insert into skill_versions(
        id, org_id, skill_id, version, frontmatter, tools, size_bytes,
        checksum, storage_path, validation, created_by
      ) values
        (
          ${ids.skillVersion}::uuid, ${ids.orgA}::uuid, ${ids.skill}::uuid, '1.0.0',
          'name: runtime-fixture', '[]'::jsonb, 42, ${checksum},
          ${`skills/${ids.skillVersion}.tar.gz`}, 'valid', ${ids.ownerA}
        ),
        (
          ${ids.orgSkillVersion}::uuid, ${ids.orgA}::uuid, ${ids.orgSkill}::uuid, '1.0.0',
          'name: runtime-org-fixture', '[]'::jsonb, 42, ${`sha256:${"b".repeat(64)}`},
          ${`skills/${ids.orgSkillVersion}.tar.gz`}, 'valid', ${ids.ownerA}
        ),
        (
          ${ids.editorSkillVersion}::uuid, ${ids.orgA}::uuid, ${ids.editorSkill}::uuid, '1.0.0',
          'name: runtime-editor-fixture', '[]'::jsonb, 42, ${`sha256:${"c".repeat(64)}`},
          ${`skills/${ids.editorSkillVersion}.tar.gz`}, 'valid', ${ids.editorA}
        )
    `;
    await sql`
      update skills skill
      set current_version_id = version.version_id
      from (values
        (${ids.skill}::uuid, ${ids.skillVersion}::uuid),
        (${ids.orgSkill}::uuid, ${ids.orgSkillVersion}::uuid),
        (${ids.editorSkill}::uuid, ${ids.editorSkillVersion}::uuid)
      ) version(skill_id, version_id)
      where skill.id = version.skill_id
    `;
    await sql`
      insert into companion_mcp_accounts(
        id, org_id, owner_id, provider, label, transport, account_config,
        credential_generation, ciphertext, iv, auth_tag, wrapped_dek,
        wrap_iv, wrap_auth_tag, key_id
      ) values
        (
          ${ids.mcpAccount}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'fixture-mcp',
          'Runtime fixture', 'http', ${sql.json({ endpoint: "fixture" })},
          ${ids.mcpGeneration}::uuid, 'ciphertext-mcp', 'iv-mcp', 'tag-mcp',
          'wrapped-mcp', 'wrap-iv-mcp', 'wrap-tag-mcp', 'key-mcp'
        ),
        (
          ${ids.editorMcpAccount}::uuid, ${ids.orgA}::uuid, ${ids.editorA}, 'fixture-mcp',
          'Runtime fixture', 'http', ${sql.json({ endpoint: "editor-fixture" })},
          ${ids.editorMcpGeneration}::uuid, 'ciphertext-editor-mcp', 'iv-editor-mcp',
          'tag-editor-mcp', 'wrapped-editor-mcp', 'wrap-iv-editor-mcp',
          'wrap-tag-editor-mcp', 'key-editor-mcp'
        ),
        (
          ${ids.revokedMcpAccount}::uuid, ${ids.orgA}::uuid, ${ids.revokedA}, 'fixture-mcp',
          'Revocation fixture', 'http', ${sql.json({ endpoint: "revoked-fixture" })},
          ${ids.revokedMcpGeneration}::uuid, 'ciphertext-revoked-mcp', 'iv-revoked-mcp',
          'tag-revoked-mcp', 'wrapped-revoked-mcp', 'wrap-iv-revoked-mcp',
          'wrap-tag-revoked-mcp', 'key-revoked-mcp'
        )
    `;
    const [gate] = await sql<Array<{ gateEpoch: string }>>`
      select gate_epoch::text as "gateEpoch" from companion_runtime_control
    `;
    await sql`
      select * from public.companion_runtime_enable(
        ${gate?.gateEpoch ?? "1"}::bigint, 'runtime-executor-integration'
      )
    `;
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    await adminSql.unsafe(`drop database if exists "${databaseName}" with (force)`);
    await adminSql.unsafe(`drop role if exists ${runtimeRole}, ${workerRole}, ${apiRole}`);
    await adminSql.end({ timeout: 1 });
  });

  it("grants only the narrow SECURITY DEFINER executor functions", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const [acl] = await sql<Array<{
      privateTableReads: number;
      callableFunctions: number;
      helperCallable: boolean;
    }>>`
      select
        (
          select count(*)::int from unnest(array[
            'companion_runtime_control', 'companion_runtime_instances', 'companion_turns',
            'companion_turn_attempts', 'companion_operations', 'companion_decision_deliveries',
            'companion_runtime_leases', 'companion_runtime_duplicate_cleanups',
            'companion_runtime_event_projections', 'companion_runtime_desktop_requests',
            'companion_message_attachments'
          ]) protected(table_name)
          where has_table_privilege(${runtimeRole}, 'public.' || protected.table_name, 'SELECT')
        ) as "privateTableReads",
        (
          select count(*)::int from unnest(array[
            'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_get_config_catalog(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_mint_hub_token(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_get_attempt_terminal_projection(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)',
            'public.companion_runtime_cas_mcp_oauth(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)',
            'public.companion_runtime_register_duplicate_cleanups(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text[])',
            'public.companion_runtime_checkpoint_duplicate_cleanup(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,bigint,public.companion_duplicate_cleanup_status,text)',
            'public.companion_runtime_authorize_desktop(uuid,uuid,text)',
            'public.companion_runtime_consume_desktop_request(text,bigint,integer)',
            'public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)',
            'public.companion_runtime_record_attempt_outputs(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,jsonb,timestamp with time zone)'
          ]) protected(signature)
          where has_function_privilege(${runtimeRole}, protected.signature, 'EXECUTE')
        ) as "callableFunctions",
        has_function_privilege(
          ${runtimeRole}, 'public.companion_runtime_guard_duplicate_cleanup()', 'EXECUTE'
        ) as "helperCallable"
    `;
    expect(acl).toEqual({ privateTableReads: 0, callableFunctions: 11, helperCallable: false });
    await expect(asRuntime((tx) => tx`select * from companion_turn_attempts`))
      .rejects.toThrow(/permission denied/i);

    await expect(asRuntime(async (tx) => {
      await verifyRuntimeDatabaseRole(tx as unknown as Pick<Sql, "unsafe">, runtimeRole);
    })).resolves.toBeUndefined();

    const [owner] = await sql<Array<{ name: string }>>`
      select current_user::text as name
    `;
    await expect(verifyRuntimeDatabaseRole(sql, owner?.name ?? ""))
      .rejects.toBeInstanceOf(RuntimeDatabaseRoleError);

    const apiSignatures = [
      "public.companion_api_create_companion(uuid,text,text,text,text,jsonb,boolean,jsonb,uuid)",
      "public.companion_api_update_companion(uuid,uuid,jsonb)",
      "public.companion_api_set_initial_provider(uuid,uuid,text,text)",
      "public.companion_api_set_workspace_access(uuid,uuid,public.companion_share_role)",
      "public.companion_api_update_member_state(uuid,uuid,boolean,boolean,boolean)",
      "public.companion_api_mark_thread_read(uuid,uuid)",
      "public.companion_api_enqueue_turn(uuid,uuid,uuid,text,public.companion_client_surface,jsonb)",
      "public.companion_api_read_attachment(uuid,uuid,uuid)",
      "public.companion_api_read_runtime(uuid,uuid)",
      "public.companion_api_list_runtime(uuid)",
      "public.companion_api_read_thread(uuid,uuid)",
      "public.companion_api_enqueue_operation(uuid,uuid,uuid,public.companion_operation_kind,public.companion_client_surface)",
      "public.companion_api_retry_turn(uuid,uuid,uuid,uuid,public.companion_client_surface)",
      "public.companion_api_cancel_turn(uuid,uuid,uuid)",
      "public.companion_api_answer_decision(uuid,uuid,text,text,text)",
      "public.companion_api_answer_config_decision(uuid,uuid,text,text)",
      "public.companion_api_get_decision(uuid,uuid,text)",
      "public.companion_api_bump_skill_revision(uuid,uuid)",
    ];
    const apiAcl = await sql<Array<{
      signature: string;
      api: boolean;
      worker: boolean;
      runtime: boolean;
    }>>`
      select signature,
        has_function_privilege(${apiRole}, signature, 'EXECUTE') as api,
        has_function_privilege(${workerRole}, signature, 'EXECUTE') as worker,
        has_function_privilege(${runtimeRole}, signature, 'EXECUTE') as runtime
      from unnest(${apiSignatures}::text[]) signatures(signature)
      order by signature
    `;
    expect(apiAcl).toHaveLength(apiSignatures.length);
    expect(apiAcl.every((entry) => entry.api && !entry.worker && !entry.runtime)).toBe(true);

    const [apiIsolation] = await sql<Array<{
      privateTableReads: number;
      helperCallable: boolean;
    }>>`
      select
        (
          select count(*)::int from unnest(array[
            'companion_runtime_instances', 'companion_turns', 'companion_turn_attempts',
            'companion_operations', 'companion_decision_deliveries',
            'companion_runtime_leases'
          ]) protected(table_name)
          where has_table_privilege(${apiRole}, 'public.' || protected.table_name, 'SELECT')
        ) as "privateTableReads",
        has_function_privilege(
          ${apiRole}, 'public.companion_api_actor(uuid)', 'EXECUTE'
        ) as "helperCallable"
    `;
    expect(apiIsolation).toEqual({ privateTableReads: 0, helperCallable: false });
  });

  it("atomically accepts only one initial provider selection", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const database = sql;
    const [created] = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ companionId: string }>>`
        select companion_id::text as "companionId"
        from public.companion_api_create_companion(
          ${ids.orgA}::uuid,
          'Atomic initial provider',
          null::text,
          null::text,
          null::text,
          '[]'::jsonb,
          false,
          '[]'::jsonb,
          null::uuid
        )
      `,
    });
    if (!created) throw new Error("failed to create the initial-provider fixture");

    try {
      await database`
        insert into companion_workspace_access(
          org_id, companion_id, owner_id, role, granted_by
        ) values (
          ${ids.orgA}::uuid, ${created.companionId}::uuid, ${ids.ownerA}, 'editor', ${ids.ownerA}
        )
      `;
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx`
          select * from public.companion_api_set_initial_provider(
            ${ids.orgA}::uuid,
            ${created.companionId}::uuid,
            ${providerId},
            'editor-model'
          )
        `,
      })).rejects.toMatchObject({ code: "42501" });

      const attempts = await Promise.allSettled([
        asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx) => tx`
            select * from public.companion_api_set_initial_provider(
              ${ids.orgA}::uuid,
              ${created.companionId}::uuid,
              ${providerId},
              'fixture-model-a'
            )
          `,
        }),
        asApi({
          orgId: ids.orgA,
          actorId: ids.ownerA,
          action: (tx) => tx`
            select * from public.companion_api_set_initial_provider(
              ${ids.orgA}::uuid,
              ${created.companionId}::uuid,
              ${providerId},
              'fixture-model-b'
            )
          `,
        }),
      ]);

      expect(attempts.map((attempt) => attempt.status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const rejected = attempts.find((attempt) => attempt.status === "rejected");
      if (!rejected || rejected.status !== "rejected") {
        throw new Error("expected one conflicting provider selection");
      }
      expect(rejected.reason).toMatchObject({ code: "55000" });

      const [stored] = await database<Array<{
        providerIds: string[];
        modelId: string;
        settingsRevision: string;
        auditCount: number;
      }>>`
        select companion.provider_ids as "providerIds", companion.model_id as "modelId",
          instance.desired_settings_revision::text as "settingsRevision",
          (
            select count(*)::int from audit_log audit
            where audit.org_id = companion.org_id
              and audit.target_id = companion.id::text
              and audit.action = 'companion.settings.updated'
          ) as "auditCount"
        from companions companion
        join companion_runtime_instances instance
          on instance.org_id = companion.org_id and instance.companion_id = companion.id
        where companion.org_id = ${ids.orgA}::uuid
          and companion.id = ${created.companionId}::uuid
      `;
      expect(stored?.providerIds).toEqual([providerId]);
      expect(["fixture-model-a", "fixture-model-b"]).toContain(stored?.modelId);
      expect(stored).toMatchObject({ settingsRevision: "2", auditCount: 1 });
    } finally {
      await database`
        delete from audit_log
        where org_id = ${ids.orgA}::uuid and target_id = ${created.companionId}
      `;
      await removeCompanion(created.companionId);
    }
  });

  it("keeps Companion aggregate DML behind API capabilities even with a forged protocol GUC", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const capabilityTables = [
      "companions",
      "companion_workspace_access",
      "companion_member_state",
      "companion_threads",
      "companion_transcript_entries",
    ];
    const workerForbiddenTables = [
      ...capabilityTables,
      "companion_provider_connections",
      "companion_mcp_accounts",
    ];
    const tableAcl = await sql<Array<{
      tableName: string;
      apiSelect: boolean;
      apiInsert: boolean;
      apiUpdate: boolean;
      apiDelete: boolean;
      workerSelect: boolean;
      workerInsert: boolean;
      workerUpdate: boolean;
      workerDelete: boolean;
    }>>`
      select table_name as "tableName",
        has_table_privilege(${apiRole}, 'public.' || table_name, 'SELECT') as "apiSelect",
        has_table_privilege(${apiRole}, 'public.' || table_name, 'INSERT') as "apiInsert",
        has_table_privilege(${apiRole}, 'public.' || table_name, 'UPDATE') as "apiUpdate",
        has_table_privilege(${apiRole}, 'public.' || table_name, 'DELETE') as "apiDelete",
        has_table_privilege(${workerRole}, 'public.' || table_name, 'SELECT') as "workerSelect",
        has_table_privilege(${workerRole}, 'public.' || table_name, 'INSERT') as "workerInsert",
        has_table_privilege(${workerRole}, 'public.' || table_name, 'UPDATE') as "workerUpdate",
        has_table_privilege(${workerRole}, 'public.' || table_name, 'DELETE') as "workerDelete"
      from unnest(${workerForbiddenTables}::text[]) tables(table_name)
      order by table_name
    `;
    expect(tableAcl).toHaveLength(workerForbiddenTables.length);
    for (const acl of tableAcl) {
      if (capabilityTables.includes(acl.tableName)) {
        expect(acl.apiSelect, `${acl.tableName} remains an API read projection`).toBe(true);
        expect(
          [acl.apiInsert, acl.apiUpdate, acl.apiDelete],
          `${acl.tableName} API writes require a capability function`,
        ).toEqual([false, false, false]);
      }
      expect(
        [acl.workerSelect, acl.workerInsert, acl.workerUpdate, acl.workerDelete],
        `${acl.tableName} is outside the worker boundary`,
      ).toEqual([false, false, false, false]);
    }

    const directDml = capabilityTables.flatMap((table) => [
      `insert into public.${table} default values`,
      `update public.${table} set org_id = org_id where false`,
      `delete from public.${table} where false`,
    ]);
    for (const role of [apiRole, workerRole]) {
      for (const statement of directDml) {
        await expect(asApplicationRoleWithForgedProtocol({
          role,
          action: (tx) => tx.unsafe(statement),
        })).rejects.toThrow(/permission denied/i);
      }
    }

    let companionId = "";
    try {
      const created = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Capability-only fixture', ${null}::text,
            ${null}::text, ${null}::text, '[]'::jsonb, false, '[]'::jsonb, ${null}::uuid
          )
        `,
      });
      companionId = created[0]?.companionId ?? "";
      expect(companionId).toMatch(/^[0-9a-f-]{36}$/);

      const sharing = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ role: string }>>`
          select workspace_role::text as role
          from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });
      expect(sharing).toEqual([{ role: "editor" }]);

      const memberState = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ hidden: boolean }>>`
          select hidden
          from public.companion_api_update_member_state(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${null}::boolean, true, ${null}::boolean
          )
        `,
      });
      expect(memberState).toEqual([{ hidden: true }]);

      const clientMessageId = randomUUID();
      const enqueued = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: { client_message_id: string }; replayed: boolean }>>`
          select turn, replayed
          from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'Capability-backed send', 'web', '[]'::jsonb
          )
        `,
      });
      expect(enqueued).toEqual([{
        turn: expect.objectContaining({ client_message_id: clientMessageId }),
        replayed: false,
      }]);
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("carries a send's attachments through replay, projection, and the executor's material", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const created = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ companionId: string }>>`
        select companion_id::text as "companionId"
        from public.companion_api_create_companion(
          ${ids.orgA}::uuid, 'Attachment fixture', null,
          ${null}::text, ${null}::text, ${tx.json([])}::jsonb,
          false, ${tx.json([])}::jsonb
        )
      `,
    });
    const companionId = created[0]!.companionId;
    try {
    const clientMessageId = randomUUID();
    const attachments = [
      {
        storage_key: `companion-attachments/${ids.orgA}/${companionId}/${clientMessageId}/0-${"a".repeat(64)}`,
        content_type: "image/png",
        byte_size: 2048,
        sha256: "a".repeat(64),
        filename: "chart.png",
        position: 0,
      },
      {
        storage_key: `companion-attachments/${ids.orgA}/${companionId}/${clientMessageId}/1-${"b".repeat(64)}`,
        content_type: "application/pdf",
        byte_size: 4096,
        sha256: "b".repeat(64),
        filename: "report.pdf",
        position: 1,
      },
    ];
    type AttachmentInput = (typeof attachments)[number];
    const enqueue = (list: AttachmentInput[]) => asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ replayed: boolean }>>`
        select replayed from public.companion_api_enqueue_turn(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
          'Look at these', 'web', ${tx.json(list)}::jsonb
        )
      `,
    });

    expect((await enqueue(attachments))[0]?.replayed).toBe(false);
    // Identical bytes are the same intent however many times the request arrives, and no second row
    // is written for them.
    expect((await enqueue(attachments))[0]?.replayed).toBe(true);
    const [rowCount] = await sql<Array<{ count: number }>>`
      select count(*)::int as count from companion_message_attachments
      where companion_id = ${companionId}::uuid
    `;
    expect(rowCount?.count).toBe(2);

    // A different file at the same position is a different message, and says so.
    await expect(enqueue([{ ...attachments[0]!, sha256: "c".repeat(64) }, attachments[1]!]))
      .rejects.toMatchObject({ code: "23505" });
    await expect(enqueue([attachments[0]!])).rejects.toMatchObject({ code: "23505" });

    // The reader's projection carries metadata and an id, and never a storage key.
    const thread = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ entries: Array<Record<string, unknown>> }>>`
        select entries from public.companion_api_read_thread(
          ${ids.orgA}::uuid, ${companionId}::uuid
        )
      `,
    });
    const projected = thread[0]!.entries[0]!.attachments as Array<Record<string, unknown>>;
    expect(projected).toEqual([
      expect.objectContaining({
        kind: "user_upload",
        content_type: "image/png",
        filename: "chart.png",
        byte_size: 2048,
        position: 0,
      }),
      expect.objectContaining({ content_type: "application/pdf", filename: "report.pdf", position: 1 }),
    ]);
    expect(JSON.stringify(projected)).not.toContain("companion-attachments/");

    // The read route re-authorizes on every request: an Editor may read, a non-member may not.
    const attachmentId = projected[0]!.id as string;
    const asset = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ storage_key: string; filename: string }>>`
        select storage_key, filename from public.companion_api_read_attachment(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    });
    expect(asset[0]?.storage_key).toBe(attachments[0]!.storage_key);
    await expect(asApi({
      orgId: ids.orgA,
      actorId: ids.ownerB,
      action: (tx) => tx`
        select * from public.companion_api_read_attachment(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    })).rejects.toThrow();
    await expect(asApi({
      orgId: ids.orgB,
      actorId: ids.ownerB,
      action: (tx) => tx`
        select * from public.companion_api_read_attachment(
          ${ids.orgB}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    })).rejects.toMatchObject({ code: "P0002" });

    // A Viewer reads and downloads attachments -- that is the whole point of a shared thread, and
    // this read is PostgreSQL plus object storage, so it never wakes the Box.
    await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx`
        select * from public.companion_api_set_workspace_access(
          ${ids.orgA}::uuid, ${companionId}::uuid, 'viewer'::public.companion_share_role
        )
      `,
    });
    const viewerRead = await asApi({
      orgId: ids.orgA,
      actorId: ids.viewerA,
      action: (tx) => tx<Array<{ filename: string }>>`
        select filename from public.companion_api_read_attachment(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    });
    expect(viewerRead[0]?.filename).toBe("chart.png");

    // A Viewer still cannot send, so the same share does not open the upload path.
    await expect(enqueue(attachments)).resolves.toBeDefined();
    await expect(asApi({
      orgId: ids.orgA,
      actorId: ids.viewerA,
      action: (tx) => tx`
        select * from public.companion_api_enqueue_turn(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
          'viewer send', 'web', ${tx.json(attachments)}::jsonb
        )
      `,
    })).rejects.toMatchObject({ code: "42501" });

    // Revoking the workspace share takes the bytes away at the next request, not at the next cache
    // expiry -- nothing signed or long-lived was ever minted.
    await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx`
        select * from public.companion_api_set_workspace_access(
          ${ids.orgA}::uuid, ${companionId}::uuid, null::public.companion_share_role
        )
      `,
    });
    await expect(asApi({
      orgId: ids.orgA,
      actorId: ids.viewerA,
      action: (tx) => tx`
        select * from public.companion_api_read_attachment(
          ${ids.orgA}::uuid, ${companionId}::uuid, ${attachmentId}::uuid
        )
      `,
    })).rejects.toMatchObject({ code: "P0002" });

    // A key outside this tenant's own prefix is refused before any row is written.
    await expect(enqueue([{
      ...attachments[0]!,
      storage_key: `companion-attachments/${ids.orgB}/${companionId}/${clientMessageId}/0-${"a".repeat(64)}`,
    }])).rejects.toMatchObject({ code: "22023" });

    // Removing the entry removes its files and schedules exactly those objects for deletion.
    await asOwnerV2((tx) => tx`
      delete from companion_transcript_entries
      where companion_id = ${companionId}::uuid
    `);
    const queued = await sql<Array<{ storage_key: string }>>`
      select storage_key from skill_database_object_deletions
      where org_id = ${ids.orgA}::uuid and storage_key like ${`companion-attachments/${ids.orgA}/${companionId}/%`}
      order by storage_key
    `;
    expect(queued.map((row) => row.storage_key))
      .toEqual(attachments.map((attachment) => attachment.storage_key).sort());
    } finally {
      await removeCompanion(companionId);
    }
  });

  it("records Pi's outputs once and makes an image-only turn a visible output", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ boxReady: true });
    await asOwnerV2((tx) => tx`
      update companion_turn_attempts
      set checkpoint = 'agent_settled', event_cursor = 4
      where id = ${fixture.attemptId}::uuid
    `);
    const claim = await claimWork();
    try {
    expect(claim.workKind).toBe("attempt");

    const outputs = [{
      storage_key: `companion-attachments/${ids.orgA}/${fixture.companionId}/outputs/${fixture.attemptId}/0-${"d".repeat(64)}`,
      content_type: "image/png",
      byte_size: 512,
      sha256: "d".repeat(64),
      filename: "plot.png",
      position: 0,
    }];
    const record = () => asRuntime((tx) => tx<Array<{ recorded: number; has_visible_output: boolean }>>`
      select recorded, has_visible_output
      from public.companion_runtime_record_attempt_outputs(
        ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
        ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
        'attempt', ${claim.workId}::uuid, ${tx.json(outputs)}::jsonb, now()
      )
    `);

    const first = await record();
    // Pi said nothing at all, so the image is the whole reply: without this entry the turn would
    // settle `empty_response`.
    expect(first[0]).toEqual({ recorded: 1, has_visible_output: true });

    // A call that committed and lost its answer is repeated. It must change nothing.
    const replay = await record();
    expect(replay[0]).toEqual({ recorded: 1, has_visible_output: true });
    const [rows] = await sql<Array<{ count: number }>>`
      select count(*)::int as count from companion_message_attachments
      where companion_id = ${fixture.companionId}::uuid and kind = 'pi_output'
    `;
    expect(rows?.count).toBe(1);
    const entries = await sql<Array<{ event_id: string; ordinal: number; content: string }>>`
      select event_id, ordinal, content from companion_transcript_entries
      where companion_id = ${fixture.companionId}::uuid and role = 'assistant'
    `;
    expect(entries).toEqual([{
      event_id: `v2:${fixture.attemptId}:outputs`,
      ordinal: 1,
      content: "",
    }]);

    // The reader's projection is what the browser parses, so the outputs entry has to carry its
    // files as `pi_output` on an assistant entry, in dense order, with no storage key.
    const thread = await asApi({
      orgId: ids.orgA,
      actorId: ids.ownerA,
      action: (tx) => tx<Array<{ entries: Array<Record<string, unknown>> }>>`
        select entries from public.companion_api_read_thread(
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid
        )
      `,
    });
    const outputsEntry = thread[0]!.entries
      .find((entry) => entry.event_id === `v2:${fixture.attemptId}:outputs`)!;
    expect(outputsEntry.role).toBe("assistant");
    expect(outputsEntry.attachments).toEqual([expect.objectContaining({
      kind: "pi_output",
      content_type: "image/png",
      filename: "plot.png",
      position: 0,
    })]);
    expect(JSON.stringify(outputsEntry)).not.toContain("companion-attachments/");

    // A takeover reads the harvest as already done and does not repeat it.
    const terminal = await asRuntime((tx) => tx<Array<{ outputs_harvested: boolean }>>`
      select outputs_harvested from public.companion_runtime_get_attempt_terminal_projection(
        ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
        ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
        'attempt', ${claim.workId}::uuid
      )
    `);
    expect(terminal[0]?.outputs_harvested).toBe(true);

    // A succeeded turn proves Pi settled it; the harvest does not weaken that.
    const settled = await asRuntime((tx) => tx<Array<{ settled: boolean }>>`
      select public.companion_runtime_settle(
        ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
        ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
        'attempt', ${claim.workId}::uuid, 'succeeded', null, null, null
      ) as settled
    `);
    expect(settled[0]?.settled).toBe(true);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("refuses attempt outputs that are not bounded images", async () => {
    const fixture = await createCompanion({ boxReady: true });
    if (!sql) throw new Error("runtime executor database is not initialized");
    await asOwnerV2((tx) => tx`
      update companion_turn_attempts
      set checkpoint = 'agent_settled', event_cursor = 4
      where id = ${fixture.attemptId}::uuid
    `);
    const claim = await claimWork();
    try {
    const valid = {
      storage_key: `companion-attachments/${ids.orgA}/${fixture.companionId}/outputs/${fixture.attemptId}/0-${"d".repeat(64)}`,
      content_type: "image/png",
      byte_size: 512,
      sha256: "d".repeat(64),
      filename: "plot.png",
      position: 0,
    };
    const record = (list: (typeof valid)[]) =>
      asRuntime((tx) => tx`
        select * from public.companion_runtime_record_attempt_outputs(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${tx.json(list)}::jsonb, now()
        )
      `);

    // A document, an oversized file, a bad digest, and a name that could traverse are all refused
    // before anything is written.
    await expect(record([{ ...valid, content_type: "application/pdf" }]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(record([{ ...valid, byte_size: 20 * 1024 * 1024 }]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(record([{ ...valid, sha256: "not-a-digest" }]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(record([{ ...valid, filename: "../escape.png" }]))
      .rejects.toMatchObject({ code: "22023" });
    await expect(record(Array.from({ length: 11 }, (_unused, index) => ({ ...valid, position: index }))))
      .rejects.toMatchObject({ code: "22023" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("persists API intents atomically, projects exact queue state, and enforces tenant ACLs", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    let duplicateId = "";
    try {
      const created = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          companionId: string;
          settingsRevision: string;
          skillsRevision: number;
        }>>`
          select companion_id::text as "companionId",
            desired_settings_revision::text as "settingsRevision",
            skills_revision as "skillsRevision"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'API capability fixture', 'Initial persona',
            ${null}::text, ${null}::text, ${tx.json([ids.skill])}::jsonb,
            false, ${tx.json([ids.mcpAccount])}::jsonb
          )
        `,
      });
      expect(created).toEqual([{
        companionId: expect.any(String),
        settingsRevision: "1",
        skillsRevision: 1,
      }]);
      companionId = created[0]!.companionId;

      const [atomicProjection] = await sql<Array<{
        ownerId: string;
        runtimeRows: number;
        providerIds: string[];
      }>>`
        select companion.owner_id as "ownerId", companion.provider_ids as "providerIds",
          (select count(*)::int from companion_runtime_instances instance
            where instance.org_id = companion.org_id
              and instance.companion_id = companion.id) as "runtimeRows"
        from companions companion
        where companion.org_id = ${ids.orgA}::uuid and companion.id = ${companionId}::uuid
      `;
      expect(atomicProjection).toEqual({
        ownerId: ids.ownerA,
        runtimeRows: 1,
        providerIds: [],
      });

      const [duplicated] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'API capability copy', 'Initial persona',
            ${null}::text, ${null}::text, '[]'::jsonb,
            false, '[]'::jsonb, ${companionId}::uuid
          )
        `,
      });
      duplicateId = duplicated?.companionId ?? "";
      const [duplicateAudit] = await sql<Array<{
        action: string;
        actorId: string | null;
        metadata: Record<string, unknown>;
      }>>`
        select action, actor_id as "actorId", metadata
        from audit_log
        where org_id = ${ids.orgA}::uuid and target_id = ${duplicateId}
      `;
      expect(duplicateAudit).toEqual({
        action: "companion.duplicated",
        actorId: ids.ownerA,
        metadata: { source_companion_id: companionId },
      });

      const updated = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          settingsRevision: string;
          skillsRevision: number;
          settingsChanged: boolean;
          skillsChanged: boolean;
        }>>`
          select desired_settings_revision::text as "settingsRevision",
            skills_revision as "skillsRevision", settings_changed as "settingsChanged",
            skills_changed as "skillsChanged"
          from public.companion_api_update_companion(
            ${ids.orgA}::uuid, ${companionId}::uuid,
            ${tx.json({ name: "API capability renamed", persona: "Updated persona" })}::jsonb
          )
        `,
      });
      expect(updated).toEqual([{
        settingsRevision: "2",
        skillsRevision: 1,
        settingsChanged: true,
        skillsChanged: false,
      }]);

      const [skillBump] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ changed: number }>>`
          select public.companion_api_bump_skill_revision(
            ${ids.orgA}::uuid, ${ids.skill}::uuid
          ) as changed
        `,
      });
      expect(skillBump?.changed).toBe(1);
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx`
          select public.companion_api_bump_skill_revision(
            ${ids.orgA}::uuid, ${ids.skill}::uuid
          )
        `,
      })).rejects.toMatchObject({ code: "P0002" });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });
      await sql`
        update companions
        set selected_skill_ids = ${sql.json([ids.skill, ids.editorSkill, ids.orgSkill])},
            selected_mcp_account_ids = ${sql.json([ids.mcpAccount, ids.editorMcpAccount])}
        where org_id = ${ids.orgA}::uuid and id = ${companionId}::uuid
      `;
      const [editorRuntime] = await asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx<Array<{
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
        }>>`
          select selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds"
          from public.companion_api_read_runtime(${ids.orgA}::uuid, ${companionId}::uuid)
        `,
      });
      expect(editorRuntime).toEqual({
        selectedSkillIds: [ids.editorSkill, ids.orgSkill],
        selectedMcpAccountIds: [ids.editorMcpAccount],
      });
      const [editorList] = await asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx<Array<{
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
        }>>`
          select selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds"
          from public.companion_api_list_runtime(${ids.orgA}::uuid)
          where companion_id = ${companionId}::uuid
        `,
      });
      expect(editorList).toEqual(editorRuntime);
      const clientMessageId = randomUUID();
      const enqueue = () => asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx: Tx) => tx<Array<{
          turn: Record<string, unknown>;
          operation: Record<string, unknown>;
          replayed: boolean;
        }>>`
          select * from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'One durable message', 'web', '[]'::jsonb
          )
        `,
      });
      const first = await enqueue();
      const replay = await enqueue();
      expect(first).toHaveLength(1);
      expect(first[0]?.replayed).toBe(false);
      expect(first[0]?.turn).toMatchObject({
        client_message_id: clientMessageId,
        companion_id: companionId,
        status: "queued",
        queue_sequence: 1,
        latest_attempt: null,
        replying: false,
        error: null,
      });
      expect(first[0]?.operation).toMatchObject({
        companion_id: companionId,
        request_id: clientMessageId,
        source_turn_id: first[0]?.turn.id,
        kind: "start",
        trigger: "turn",
        status: "pending",
        queue_sequence: 1,
        error: null,
      });
      expect(companionTurnSchema.safeParse(first[0]?.turn).success).toBe(true);
      expect(companionOperationSchema.safeParse(first[0]?.operation).success).toBe(true);
      expect(replay).toEqual([{ ...first[0], replayed: true }]);

      const [allocation] = await sql<Array<{
        turns: number;
        messages: number;
        operations: number;
        nextTurn: string;
        nextOperation: string;
      }>>`
        select
          (select count(*)::int from companion_turns where companion_id = ${companionId}::uuid) as turns,
          (select count(*)::int from companion_transcript_entries
            where companion_id = ${companionId}::uuid and role = 'user') as messages,
          (select count(*)::int from companion_operations
            where companion_id = ${companionId}::uuid) as operations,
          instance.next_turn_sequence::text as "nextTurn",
          instance.next_operation_sequence::text as "nextOperation"
        from companion_runtime_instances instance
        where instance.companion_id = ${companionId}::uuid
      `;
      expect(allocation).toEqual({
        turns: 1,
        messages: 1,
        operations: 1,
        nextTurn: "2",
        nextOperation: "2",
      });

      await sql`
        update companion_runtime_instances
        set box_id = 'bx_2345678d', box_state = 'ready', pi_state = 'idle',
          disk_layout_version = 14, pi_invocation_id = 'pi-api-capability'
        where companion_id = ${companionId}::uuid
      `;
      const ownerRuntime = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          accessRole: string;
          generation: string;
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
          boxId: string | null;
          queuedCount: number;
          activeTurn: unknown;
        }>>`
          select access_role as "accessRole", generation::text,
            selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds", box_id as "boxId",
            queued_count as "queuedCount", active_turn as "activeTurn"
          from public.companion_api_read_runtime(${ids.orgA}::uuid, ${companionId}::uuid)
        `,
      });
      expect(ownerRuntime).toEqual([{
        accessRole: "owner",
        generation: "1",
        selectedSkillIds: [ids.skill, ids.orgSkill],
        selectedMcpAccountIds: [ids.mcpAccount],
        boxId: "bx_2345678d",
        queuedCount: 1,
        activeTurn: null,
      }]);

      const thread = await asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx<Array<{
          accessRole: string;
          entries: Array<Record<string, unknown>>;
          queuedCount: number;
          interruptedTurn: unknown;
        }>>`
          select access_role as "accessRole", entries, queued_count as "queuedCount",
            interrupted_turn as "interruptedTurn"
          from public.companion_api_read_thread(${ids.orgA}::uuid, ${companionId}::uuid)
        `,
      });
      expect(thread).toHaveLength(1);
      expect(thread[0]).toMatchObject({
        accessRole: "editor",
        queuedCount: 1,
        interruptedTurn: null,
      });
      expect(thread[0]?.entries).toEqual([expect.objectContaining({
        event_id: `msg:${clientMessageId}`,
        ordinal: 0,
        role: "user",
        content: "One durable message",
        author_id: ids.editorA,
        author_name: null,
        tool: null,
        decision: null,
      })]);
      const parsedEntry = companionTranscriptEntrySchema.safeParse(thread[0]?.entries[0]);
      expect(
        parsedEntry.success,
        parsedEntry.success
          ? undefined
          : `${parsedEntry.error.message}: ${JSON.stringify(thread[0]?.entries[0])}`,
      ).toBe(true);
      const [memberState] = await asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx<Array<{
          pinnedAt: Date | null;
          hidden: boolean;
          lastReadOrdinal: number | null;
        }>>`
          select pinned_at as "pinnedAt", hidden,
            last_read_ordinal as "lastReadOrdinal"
          from public.companion_api_update_member_state(
            ${ids.orgA}::uuid, ${companionId}::uuid, true, null, null
          )
        `,
      });
      expect(memberState).toEqual({
        pinnedAt: expect.any(Date),
        hidden: false,
        lastReadOrdinal: 0,
      });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'viewer'
          )
        `,
      });
      const viewerRuntime = await asApi({
        orgId: ids.orgA,
        actorId: ids.viewerA,
        action: (tx) => tx<Array<{
          accessRole: string;
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
          boxId: string | null;
        }>>`
          select access_role as "accessRole", selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds", box_id as "boxId"
          from public.companion_api_read_runtime(${ids.orgA}::uuid, ${companionId}::uuid)
        `,
      });
      expect(viewerRuntime).toEqual([{
        accessRole: "viewer",
        selectedSkillIds: [ids.orgSkill],
        selectedMcpAccountIds: [],
        boxId: null,
      }]);
      const viewerList = await asApi({
        orgId: ids.orgA,
        actorId: ids.viewerA,
        action: (tx) => tx<Array<{
          companionId: string;
          accessRole: string;
          selectedSkillIds: string[];
          selectedMcpAccountIds: string[];
          boxId: string | null;
        }>>`
          select companion_id::text as "companionId", access_role as "accessRole",
            selected_skill_ids as "selectedSkillIds",
            selected_mcp_account_ids as "selectedMcpAccountIds", box_id as "boxId"
          from public.companion_api_list_runtime(${ids.orgA}::uuid)
          where companion_id = ${companionId}::uuid
        `,
      });
      expect(viewerList).toEqual([{
        companionId,
        accessRole: "viewer",
        selectedSkillIds: [ids.orgSkill],
        selectedMcpAccountIds: [],
        boxId: null,
      }]);
      await expect(enqueue()).rejects.toMatchObject({ code: "42501" });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });
      await expect(asApi({
        orgId: ids.orgB,
        actorId: ids.ownerB,
        action: (tx) => tx`
          select * from public.companion_api_read_runtime(
            ${ids.orgB}::uuid, ${companionId}::uuid
          )
        `,
      })).rejects.toMatchObject({ code: "P0002" });

      await sql`
        delete from memberships where org_id = ${ids.orgA}::uuid and user_id = ${ids.viewerA}
      `;
      try {
        await expect(asApi({
          orgId: ids.orgA,
          actorId: ids.viewerA,
          action: (tx) => tx`
            select * from public.companion_api_update_member_state(
              ${ids.orgA}::uuid, ${companionId}::uuid, true, null, null
            )
          `,
        })).rejects.toMatchObject({ code: "42501" });
      } finally {
        await sql`
          insert into memberships(org_id, user_id, org_role)
          values (${ids.orgA}::uuid, ${ids.viewerA}, 'developer')
          on conflict (org_id, user_id) do nothing
        `;
      }

      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx) => tx`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${randomUUID()}::uuid,
            'delete', 'web'
          )
        `,
      })).rejects.toMatchObject({ code: "42501" });

      const stopRequestId = randomUUID();
      const enqueueStop = () => asApi({
        orgId: ids.orgA,
        actorId: ids.editorA,
        action: (tx: Tx) => tx<Array<{ operation: Record<string, unknown>; replayed: boolean }>>`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${stopRequestId}::uuid,
            'stop', 'web'
          )
        `,
      });
      const stop = await enqueueStop();
      expect(stop).toEqual([{
        operation: expect.objectContaining({
          request_id: stopRequestId,
          kind: "stop",
          status: "pending",
          queue_sequence: 2,
        }),
        replayed: false,
      }]);
      expect(await enqueueStop()).toEqual([{ ...stop[0], replayed: true }]);

      for (const [initialSurface, conflictingSurface] of [
        ["web", "native_mobile"],
        ["native_mobile", "web"],
      ] as const) {
        const startRequestId = randomUUID();
        const enqueueStart = (surface: "web" | "native_mobile") => asApi({
          orgId: ids.orgA,
          actorId: ids.editorA,
          action: (tx: Tx) => tx<Array<{ replayed: boolean }>>`
            select replayed from public.companion_api_enqueue_operation(
              ${ids.orgA}::uuid, ${companionId}::uuid, ${startRequestId}::uuid,
              'start', ${surface}::public.companion_client_surface
            )
          `,
        });
        expect(await enqueueStart(initialSurface)).toEqual([{ replayed: false }]);
        expect(await enqueueStart(initialSurface)).toEqual([{ replayed: true }]);
        await expect(enqueueStart(conflictingSurface)).rejects.toMatchObject({ code: "22023" });
      }

      const deleteRequestId = randomUUID();
      const enqueueDelete = () => asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{ operation: Record<string, unknown>; replayed: boolean }>>`
          select * from public.companion_api_enqueue_operation(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${deleteRequestId}::uuid,
            'delete', 'web'
          )
        `,
      });
      const deletion = await enqueueDelete();
      expect(deletion[0]).toMatchObject({
        operation: { request_id: deleteRequestId, kind: "delete", status: "pending" },
        replayed: false,
      });
      expect(await enqueueDelete()).toEqual([{ ...deletion[0], replayed: true }]);

      const audits = await sql<Array<{
        action: string;
        actorId: string | null;
        metadata: Record<string, unknown>;
      }>>`
        select action, actor_id as "actorId", metadata
        from audit_log
        where org_id = ${ids.orgA}::uuid and target_id = ${companionId}
        order by created_at, action
      `;
      expect(audits.filter((entry) => entry.action === "companion.settings.updated"))
        .toEqual([expect.objectContaining({
          actorId: ids.ownerA,
          metadata: expect.objectContaining({ name: true, persona: true }),
        })]);
      expect(audits.filter((entry) => entry.action === "companion.share.workspace.updated"))
        .toHaveLength(3);
      expect(audits.filter((entry) => entry.action === "companion.delete.requested"))
        .toEqual([expect.objectContaining({
          actorId: ids.ownerA,
          metadata: { operation_id: deletion[0]?.operation.id },
        })]);
    } finally {
      if (duplicateId) await removeCompanion(duplicateId);
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("enqueues an already-warm send without a start operation and dispatches it directly", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const created = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Warm send fixture', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created[0]?.companionId ?? "";

      // Simulate a Companion that already finished its cold start on an earlier message: the Box is
      // observed ready and Pi is idle before this send, exactly as it is moments after Pi replies.
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_warmsend', box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'pi-already-warm', disk_layout_version = 14,
          applied_settings_revision = desired_settings_revision,
          applied_skills_revision = 1, applied_client_surface = 'web',
          last_observed_at = now()
        where companion_id = ${companionId}::uuid
      `;

      const clientMessageId = randomUUID();
      const enqueued = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          turn: Record<string, unknown>;
          operation: Record<string, unknown> | null;
          replayed: boolean;
        }>>`
          select * from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'Already warm, no wake needed', 'web', '[]'::jsonb
          )
        `,
      });
      expect(enqueued[0]?.replayed).toBe(false);
      expect(enqueued[0]?.operation).toBeNull();
      expect(companionTurnSchema.safeParse(enqueued[0]?.turn).success).toBe(true);
      const turnId = enqueued[0]?.turn.id;

      // Sending the identical message again must still replay idempotently even though no operation
      // was ever created to prove the first insert's completeness.
      const replay = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{ turn: Record<string, unknown>; replayed: boolean }>>`
          select turn, replayed from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'Already warm, no wake needed', 'web', '[]'::jsonb
          )
        `,
      });
      expect(replay[0]?.replayed).toBe(true);
      expect(replay[0]?.turn.id).toBe(turnId);

      const [operationCount] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from companion_operations
        where companion_id = ${companionId}::uuid
      `;
      expect(operationCount).toEqual({ count: 0 });

      // No 'start' operation stands between the send and dispatch: the very next claim picks the
      // turn itself up directly as an 'attempt', ready to prompt the already-idle Pi.
      const claim = await claimWork();
      expect(claim).toMatchObject({ workKind: "attempt", companionId });
      const [claimedAttempt] = await sql<Array<{ turnId: string }>>`
        select turn_id::text as "turnId" from companion_turn_attempts
        where id = ${claim.workId}::uuid
      `;
      expect(claimedAttempt).toEqual({ turnId });
      await release(claim);

      const [instance] = await sql<Array<{ boxState: string; piState: string; piInvocationId: string }>>`
        select box_state::text as "boxState", pi_state::text as "piState",
          pi_invocation_id as "piInvocationId"
        from companion_runtime_instances where companion_id = ${companionId}::uuid
      `;
      expect(instance).toEqual({
        boxState: "ready", piState: "idle", piInvocationId: "pi-already-warm",
      });
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("still enqueues a start operation when the cached warm observation is stale", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const created = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Stale warm send fixture', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created[0]?.companionId ?? "";

      // Same cached box_state='ready'/pi_state='idle' as a genuinely warm instance, but the last
      // observation is older than the periodic health check's own cadence: nothing has re-verified
      // Pi is still actually alive recently enough to trust for a direct dispatch.
      await sql`
        update companion_runtime_instances
        set box_id = 'bx_2345678s', box_state = 'ready', pi_state = 'idle',
          pi_invocation_id = 'pi-stale-observed', disk_layout_version = 14,
          applied_settings_revision = desired_settings_revision,
          applied_skills_revision = 1, applied_client_surface = 'web',
          last_observed_at = now() - interval '10 minutes'
        where companion_id = ${companionId}::uuid
      `;

      const clientMessageId = randomUUID();
      const enqueued = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          turn: Record<string, unknown>;
          operation: Record<string, unknown> | null;
          replayed: boolean;
        }>>`
          select * from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            'Stale observation still needs a start', 'web', '[]'::jsonb
          )
        `,
      });
      expect(enqueued[0]?.operation).toMatchObject({ kind: "start", status: "pending" });

      const [operationCount] = await sql<Array<{ count: number }>>`
        select count(*)::int as count from companion_operations
        where companion_id = ${companionId}::uuid
      `;
      expect(operationCount).toEqual({ count: 1 });
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("accepts only exact sequential and concurrent client_message_id replays", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Concurrent enqueue fixture', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      companionId = created?.companionId ?? "";
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${companionId}::uuid, 'editor'
          )
        `,
      });

      const clientMessageId = randomUUID();
      const enqueue = (
        actorId = ids.editorA,
        content = "Concurrent durable message",
        surface: "web" | "mobile_web" = "web",
      ) => asApi({
        orgId: ids.orgA,
        actorId,
        action: (tx: Tx) => tx<Array<{
          turn: Record<string, unknown>;
          replayed: boolean;
        }>>`
          select turn, replayed from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            ${content}, ${surface}::companion_client_surface, '[]'::jsonb
          )
        `,
      });

      const concurrent = await Promise.all([enqueue(), enqueue()]);
      expect(concurrent.flatMap((result) => result.map((row) => row.replayed)).sort())
        .toEqual([false, true]);
      expect(new Set(concurrent.flatMap((result) => result.map((row) => row.turn.id))).size).toBe(1);
      await expect(enqueue(ids.editorA, "  Concurrent durable message  "))
        .resolves.toEqual([expect.objectContaining({ replayed: true })]);

      await expect(enqueue(ids.editorA, "Different content"))
        .rejects.toMatchObject({ code: "23505" });
      await expect(enqueue(ids.editorA, "Concurrent durable message", "mobile_web"))
        .rejects.toMatchObject({ code: "23505" });
      await expect(enqueue(ids.ownerA))
        .rejects.toMatchObject({ code: "23505" });

      const [stored] = await sql<Array<{ turns: number; messages: number; operations: number }>>`
        select
          (select count(*)::int from companion_turns
            where companion_id = ${companionId}::uuid) as turns,
          (select count(*)::int from companion_transcript_entries
            where companion_id = ${companionId}::uuid and role = 'user') as messages,
          (select count(*)::int from companion_operations
            where companion_id = ${companionId}::uuid) as operations
      `;
      expect(stored).toEqual({ turns: 1, messages: 1, operations: 1 });
    } finally {
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("hands an explicit retry through restart_pi, preserves the later queue, and cancels safely", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    let claimed: Claim | undefined;
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Retry handoff fixture', null, null, null,
            '[]'::jsonb, false, '[]'::jsonb
          )
        `,
      });
      if (!created) throw new Error("expected an API-created Companion");
      companionId = created.companionId;
      const enqueue = (clientMessageId: string, content: string) => asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{ turn: Record<string, unknown> }>>`
          select turn from public.companion_api_enqueue_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${clientMessageId}::uuid,
            ${content}, 'web', '[]'::jsonb
          )
        `,
      });
      const [first] = await enqueue(randomUUID(), "First ambiguous turn");
      const [later] = await enqueue(randomUUID(), "Later ordered turn");
      const firstTurnId = first?.turn.id;
      const laterTurnId = later?.turn.id;
      if (typeof firstTurnId !== "string" || typeof laterTurnId !== "string") {
        throw new Error("expected durable turn ids");
      }

      await sql`
        update companion_operations
        set status = 'cancelled', settled_at = now(), updated_at = now()
        where companion_id = ${companionId}::uuid and kind = 'start' and status = 'pending'
      `;
      await sql`
        update companion_turns
        set status = 'interrupted', absolute_deadline_at = now(), settled_at = now(),
          state_changed_at = now(), last_error_code = 'dispatch_ambiguous',
          last_error_message = 'Pi acceptance could not be proven.',
          last_error_action = 'retry', updated_at = now()
        where id = ${firstTurnId}::uuid
      `;

      const retryId = randomUUID();
      const retry = () => asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{ operation: Record<string, unknown>; replayed: boolean }>>`
          select * from public.companion_api_retry_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${firstTurnId}::uuid,
            ${retryId}::uuid, 'web'
          )
        `,
      });
      const firstRetry = await retry();
      expect(firstRetry).toEqual([{
        operation: expect.objectContaining({
          request_id: retryId,
          source_turn_id: firstTurnId,
          kind: "restart_pi",
          trigger: "user",
          status: "pending",
          queue_sequence: 3,
        }),
        replayed: false,
      }]);
      expect(await retry()).toEqual([{ ...firstRetry[0], replayed: true }]);

      claimed = await claimWork();
      expect(claimed).toMatchObject({
        companionId,
        workKind: "operation",
        workId: firstRetry[0]?.operation.id,
      });
      const turnStatesDuringRecycle = await sql<Array<{
        id: string;
        status: string;
        errorCode: string | null;
      }>>`
        select id::text as id, status::text as status, last_error_code as "errorCode"
        from companion_turns
        where companion_id = ${companionId}::uuid
        order by queue_sequence
      `;
      expect(turnStatesDuringRecycle).toEqual([
        { id: firstTurnId, status: "interrupted", errorCode: "dispatch_ambiguous" },
        { id: laterTurnId, status: "queued", errorCode: null },
      ]);

      await sql`
        update companion_operations
        set checkpoint = 'pi_ready', status = 'succeeded', settled_at = now(), updated_at = now()
        where id = ${claimed.workId}::uuid and status = 'running'
      `;
      await release(claimed);
      claimed = undefined;
      const [reopened] = await sql<Array<{
        status: string;
        settledAt: Date | null;
        errorCode: string | null;
      }>>`
        select status::text as status, settled_at as "settledAt",
          last_error_code as "errorCode"
        from companion_turns where id = ${firstTurnId}::uuid
      `;
      expect(reopened).toEqual({ status: "queued", settledAt: null, errorCode: null });

      const attemptId = randomUUID();
      await sql`
        insert into companion_turn_attempts(
          id, org_id, companion_id, turn_id, attempt_number, actor_id,
          runtime_generation, settings_revision, skills_revision, model_id,
          provider_ids, selected_skill_ids, selected_mcp_account_ids
        ) values (
          ${attemptId}::uuid, ${ids.orgA}::uuid, ${companionId}::uuid,
          ${firstTurnId}::uuid, 1, ${ids.ownerA}, 1, 1, 1, null,
          '[]'::jsonb, '[]'::jsonb, '[]'::jsonb
        )
      `;
      const [attempt] = await sql<Array<{ retryId: string | null }>>`
        select retry_id::text as "retryId" from companion_turn_attempts
        where id = ${attemptId}::uuid
      `;
      expect(attempt?.retryId).toBe(retryId);

      await sql`
        update companion_turns
        set status = 'interrupted', absolute_deadline_at = now(), settled_at = now(),
          state_changed_at = now(), last_error_code = 'dispatch_ambiguous',
          last_error_message = 'The later turn also needs an explicit choice.',
          last_error_action = 'retry', updated_at = now()
        where id = ${laterTurnId}::uuid
      `;
      const cancelled = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: Record<string, unknown> }>>`
          select * from public.companion_api_cancel_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${laterTurnId}::uuid
          )
        `,
      });
      expect(cancelled).toEqual([{
        turn: expect.objectContaining({
          id: laterTurnId,
          status: "cancelled",
          error: null,
          settled_at: expect.any(String),
        }),
      }]);
      expect(companionTurnSchema.safeParse(cancelled[0]?.turn).success).toBe(true);
      const cancelledReplay = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ turn: Record<string, unknown> }>>`
          select * from public.companion_api_cancel_turn(
            ${ids.orgA}::uuid, ${companionId}::uuid, ${laterTurnId}::uuid
          )
        `,
      });
      expect(cancelledReplay).toEqual(cancelled);
      const [queueState] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ queuedCount: number; interruptedTurn: unknown }>>`
          select queued_count as "queuedCount", interrupted_turn as "interruptedTurn"
          from public.companion_api_read_thread(${ids.orgA}::uuid, ${companionId}::uuid)
        `,
      });
      expect(queueState).toEqual({ queuedCount: 1, interruptedTurn: null });
    } finally {
      if (claimed) await release(claimed);
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("persists decision answers as a durable outbox and updates the PostgreSQL transcript", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ boxReady: true });
    const requestKey = `question-${randomUUID()}`;
    const deliveryId = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    try {
      await sql`
        update companion_turn_attempts
        set status = 'needs_input', checkpoint = 'needs_input', updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await sql`
        update companion_turns
        set status = 'needs_input', state_changed_at = now(), updated_at = now()
        where id = ${fixture.turnId}::uuid
      `;
      const decision = {
        request_id: requestKey,
        kind: "question",
        name: "ask_user",
        title: "Choose a safe direction",
        detail: "The answer must survive a browser disconnect.",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: expiresAt,
      };
      await sql`
        insert into companion_decision_deliveries(
          id, org_id, companion_id, turn_id, attempt_id,
          request_key, request_kind, expires_at
        ) values (
          ${deliveryId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          ${requestKey}, 'question', ${expiresAt}
        )
      `;
      await sql`
        insert into companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, decision
        ) values (
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${`decision:${requestKey}`}, 1, 'decision', ${decision.title}, ${sql.json(decision)}
        )
      `;
      await sql`
        update companion_threads set next_ordinal = 2, updated_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;

      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'allow', null
          )
        `,
      })).rejects.toMatchObject({ code: "22023" });

      const answer = () => asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          deliveryId: string;
          turnId: string;
          decisionStatus: string;
          deliveryState: string;
          respondedAt: Date;
        }>>`
          select delivery_id::text as "deliveryId", turn_id::text as "turnId",
            decision_status::text as "decisionStatus",
            delivery_state::text as "deliveryState", responded_at as "respondedAt"
          from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'answer', 'Use the safe path'
          )
        `,
      });
      const answered = await answer();
      expect(answered).toEqual([{
        deliveryId,
        turnId: fixture.turnId,
        decisionStatus: "answered",
        deliveryState: "pending",
        respondedAt: expect.any(Date),
      }]);
      expect(await answer()).toEqual(answered);
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'answer', 'A conflicting replay'
          )
        `,
      })).rejects.toMatchObject({ code: "55000" });

      const [projection] = await sql<Array<{
        actorId: string | null;
        responseText: string | null;
        decisionStatus: string;
        transcriptDecision: Record<string, unknown>;
      }>>`
        select delivery.actor_id as "actorId", delivery.response_text as "responseText",
          delivery.decision_status::text as "decisionStatus",
          entry.decision as "transcriptDecision"
        from companion_decision_deliveries delivery
        join companion_transcript_entries entry
          on entry.companion_id = delivery.companion_id
         and entry.decision ->> 'request_id' = delivery.request_key
        where delivery.id = ${deliveryId}::uuid
      `;
      expect(projection).toMatchObject({
        actorId: ids.ownerA,
        responseText: "Use the safe path",
        decisionStatus: "answered",
        transcriptDecision: {
          request_id: requestKey,
          status: "answered",
          answer: "Use the safe path",
          decided_by_id: ids.ownerA,
          decided_by_name: "Runtime executor actor 0",
          decided_at: expect.any(String),
        },
      });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, 'viewer'
          )
        `,
      });
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.viewerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'answer', 'Use the safe path'
          )
        `,
      })).rejects.toMatchObject({ code: "42501" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("stores config proposals, rejects the generic answer path, and builds a confirm response", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    const proposal = {
      kind: "config",
      add_skill_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    };
    try {
      await expect(sql`
        insert into companion_decision_deliveries(
          org_id, companion_id, turn_id, attempt_id, request_key, request_kind, expires_at
        ) values (
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          'config-missing-proposal', 'config_proposal', now() + interval '5 minutes'
        )
      `).rejects.toMatchObject({ code: "23514" });
      await expect(sql`
        insert into companion_decision_deliveries(
          org_id, companion_id, turn_id, attempt_id, request_key, request_kind, expires_at, proposal
        ) values (
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          'question-with-proposal', 'question', now() + interval '5 minutes',
          ${sql.json(proposal)}
        )
      `).rejects.toMatchObject({ code: "23514" });

      const claim = await claimWork();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const decision = {
        request_id: "config-1",
        kind: "config",
        name: "config",
        title: "Add the search skill",
        detail: "Add the search skill",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: expiresAt,
        proposal,
      };
      const events = [{
        sequence: "1",
        type: "decision",
        entry_key: "decision:1",
        request_key: "config-1",
        request_kind: "config_proposal",
        content: decision.title,
        proposal,
        decision,
        expires_at: expiresAt,
      }];
      await asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 1, now(), 0, 0, 0
        )
      `);
      const [stored] = await sql<Array<{ kind: string; proposal: unknown }>>`
        select request_kind::text as kind, proposal
        from companion_decision_deliveries
        where attempt_id = ${fixture.attemptId}::uuid and request_key = 'config-1'
      `;
      expect(stored).toEqual({ kind: "config_proposal", proposal });
      const [transcript] = await sql<Array<{ proposal: unknown }>>`
        select decision -> 'proposal' as proposal
        from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid and role = 'decision'
      `;
      expect(transcript?.proposal).toEqual(proposal);

      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            'config-1', 'allow', null
          )
        `,
      })).rejects.toMatchObject({ code: "22023" });

      await release(claim);
      await sql`
        update companion_decision_deliveries
        set decision_status = 'allowed', actor_id = ${ids.ownerA},
          responded_at = now(), updated_at = now()
        where attempt_id = ${fixture.attemptId}::uuid and request_key = 'config-1'
      `;
      const decisionClaim = await claimWork();
      expect(decisionClaim.workKind).toBe("decision");
      const response = await asRuntime((tx) => tx<Array<{
        kind: string;
        payload: Record<string, unknown>;
      }>>`
        select decision_request_kind::text as kind, decision_response_payload as payload
        from public.companion_runtime_get_material(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, 30
        )
      `);
      expect(response).toEqual([{
        kind: "config_proposal",
        payload: { type: "extension_ui_response", id: "config-1", confirmed: true },
      }]);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("applies an approved config proposal under the approver and rolls back on validation failure", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ selectedSkillIds: [ids.skill] });
    const requestKey = "config-apply-1";
    const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
    const proposal: CompanionConfigProposal = {
      kind: "config",
      add_skill_ids: [ids.orgSkill],
      remove_skill_ids: [ids.skill],
    };
    const foreignProposal: CompanionConfigProposal = {
      kind: "config",
      add_skill_ids: [ids.editorSkill],
    };
    const connectProposal: CompanionConfigProposal = {
      kind: "config",
      connect_plugin: { server_name: "github", reason: "Need issues" },
    };

    // The module-level handle is optional, and TypeScript does not carry the guard above into a
    // nested closure, so this helper holds the checked handle itself.
    const db = sql;
    async function insertPending(key: string, nextProposal: CompanionConfigProposal): Promise<string> {
      const deliveryId = randomUUID();
      const decision = {
        request_id: key,
        kind: "config",
        name: "config",
        title: "Apply these settings",
        detail: "Apply these settings",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: expiresAt,
        proposal: nextProposal,
      };
      await db`
        update companion_turn_attempts
        set status = 'needs_input', checkpoint = 'needs_input', updated_at = now()
        where id = ${fixture.attemptId}::uuid
      `;
      await db`
        insert into companion_decision_deliveries(
          id, org_id, companion_id, turn_id, attempt_id,
          request_key, request_kind, expires_at, proposal
        ) values (
          ${deliveryId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid,
          ${key}, 'config_proposal', ${expiresAt}, ${db.json(nextProposal)}
        )
      `;
      await db`
        insert into companion_transcript_entries(
          org_id, companion_id, event_id, ordinal, role, content, decision
        )
        select ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${`decision:${key}`}, next_ordinal, 'decision', ${decision.title},
          ${db.json(decision)}
        from companion_threads
        where companion_id = ${fixture.companionId}::uuid
      `;
      await db`
        update companion_threads set next_ordinal = next_ordinal + 1, updated_at = now()
        where companion_id = ${fixture.companionId}::uuid
      `;
      return deliveryId;
    }

    try {
      const deliveryId = await insertPending(requestKey, proposal);
      const [read] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{
          requestKind: string;
          proposal: unknown;
        }>>`
          select request_kind::text as "requestKind", proposal
          from public.companion_api_get_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${requestKey}
          )
        `,
      });
      expect(read).toEqual({ requestKind: "config_proposal", proposal });

      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'allow', null
          )
        `,
      })).rejects.toMatchObject({ code: "22023" });

      const allow = () => asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx: Tx) => tx<Array<{
          deliveryId: string;
          decisionStatus: string;
        }>>`
          select delivery_id::text as "deliveryId",
            decision_status::text as "decisionStatus"
          from public.companion_api_answer_config_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${requestKey}, 'allow'
          )
        `,
      });
      const allowed = await allow();
      expect(allowed).toEqual([{ deliveryId, decisionStatus: "allowed" }]);
      expect(await allow()).toEqual(allowed);

      const [applied] = await sql<Array<{
        selectedSkillIds: unknown;
        skillsRevision: number;
        desiredSettingsRevision: number;
      }>>`
        select companion.selected_skill_ids as "selectedSkillIds",
          companion.skills_revision as "skillsRevision",
          instance.desired_settings_revision::int as "desiredSettingsRevision"
        from companions companion
        join companion_runtime_instances instance
          on instance.companion_id = companion.id
        where companion.id = ${fixture.companionId}::uuid
      `;
      expect(applied).toMatchObject({
        selectedSkillIds: [ids.orgSkill],
        skillsRevision: 2,
        desiredSettingsRevision: 2,
      });

      const foreignKey = "config-foreign-1";
      await insertPending(foreignKey, foreignProposal);
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_answer_config_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${foreignKey}, 'allow'
          )
        `,
      })).rejects.toMatchObject({ code: "22023" });
      const [stillPending] = await sql<Array<{ status: string }>>`
        select decision_status::text as status
        from companion_decision_deliveries
        where companion_id = ${fixture.companionId}::uuid and request_key = ${foreignKey}
      `;
      expect(stillPending).toEqual({ status: "pending" });
      const [unchanged] = await sql<Array<{ selectedSkillIds: unknown }>>`
        select selected_skill_ids as "selectedSkillIds"
        from companions where id = ${fixture.companionId}::uuid
      `;
      expect(unchanged?.selectedSkillIds).toEqual([ids.orgSkill]);

      const connectKey = "config-connect-1";
      const connectId = await insertPending(connectKey, connectProposal);
      const [connected] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ deliveryId: string; decisionStatus: string }>>`
          select delivery_id::text as "deliveryId",
            decision_status::text as "decisionStatus"
          from public.companion_api_answer_config_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
            ${connectKey}, 'allow'
          )
        `,
      });
      expect(connected).toEqual({ deliveryId: connectId, decisionStatus: "allowed" });
      const [afterConnect] = await sql<Array<{
        selectedSkillIds: unknown;
        desiredSettingsRevision: number;
      }>>`
        select companion.selected_skill_ids as "selectedSkillIds",
          instance.desired_settings_revision::int as "desiredSettingsRevision"
        from companions companion
        join companion_runtime_instances instance on instance.companion_id = companion.id
        where companion.id = ${fixture.companionId}::uuid
      `;
      expect(afterConnect).toMatchObject({
        selectedSkillIds: [ids.orgSkill],
        desiredSettingsRevision: 2,
      });

      // A Viewer who really can see this Companion is still refused the editor-gated read, rather
      // than being refused only because the Companion was never shared with them.
      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          select * from public.companion_api_set_workspace_access(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, 'viewer'
          )
        `,
      });
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.viewerA,
        action: (tx) => tx`
          select * from public.companion_api_get_decision(
            ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${requestKey}
          )
        `,
      })).rejects.toMatchObject({ code: "42501" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("returns a claim-fenced config catalog without credentials", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const [row] = await asRuntime((tx) => tx<Array<{ catalog: Record<string, unknown> }>>`
        select catalog
        from public.companion_runtime_get_config_catalog(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(row?.catalog).toMatchObject({
        companion: {
          model_id: "fixture-model",
          provider_id: providerId,
        },
      });
      const skills = row?.catalog.skills as Array<{ id: string; selected: boolean; slug: string }>;
      expect(skills.some((skill) => skill.id === ids.skill && skill.selected)).toBe(true);
      expect(skills.some((skill) => skill.id === ids.orgSkill)).toBe(true);
      expect(JSON.stringify(row?.catalog)).not.toMatch(/ciphertext|wrapped_dek|auth_tag|storage_path/i);
      await release(claim);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("pins write-on-behalf true and accepts an ephemeral companion-sourced token", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    let companionId = "";
    const companionTokenId = randomUUID();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    try {
      const [created] = await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx<Array<{ companionId: string }>>`
          select companion_id::text as "companionId"
          from public.companion_api_create_companion(
            ${ids.orgA}::uuid, 'Hub access fixture', null::text,
            null::text, null::text, '[]'::jsonb,
            true, '[]'::jsonb, null::uuid
          )
        `,
      });
      companionId = created?.companionId ?? "";
      // Skills Hub access is unconditional, so the legacy flag can never disagree with the token
      // the Box receives.
      const [initial] = await sql<Array<{ canWriteSkills: boolean }>>`
        select can_write_skills as "canWriteSkills" from companions where id = ${companionId}::uuid
      `;
      expect(initial).toEqual({ canWriteSkills: true });

      await asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          insert into api_tokens (
            id, org_id, user_id, name, token_prefix, token_hash, scopes,
            source_type, source_agent_id, expires_at
          ) values (
            ${companionTokenId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA},
            'Ephemeral companion hub token', 'cmp_pat_hub', ${`hub-${companionTokenId}`},
            ${tx.json([
              "skills:read",
              "skills:write",
              "secrets:read",
              "database:read",
              "database:write",
            ])}::jsonb,
            'companion', ${companionId}, ${expiresAt}
          )
        `,
      });
      const [token] = await sql<Array<{ sourceType: string; sourceAgentId: string }>>`
        select source_type as "sourceType", source_agent_id as "sourceAgentId"
        from api_tokens where id = ${companionTokenId}::uuid
      `;
      expect(token).toEqual({ sourceType: "companion", sourceAgentId: companionId });

      // A companion-sourced token still must name a Companion: provenance stays fail-closed.
      await expect(asApi({
        orgId: ids.orgA,
        actorId: ids.ownerA,
        action: (tx) => tx`
          insert into api_tokens (
            id, org_id, user_id, name, token_prefix, token_hash, scopes,
            source_type, source_agent_id, expires_at
          ) values (
            ${randomUUID()}::uuid, ${ids.orgA}::uuid, ${ids.ownerA},
            'Companion token without provenance', 'cmp_pat_bad', ${`bad-${companionTokenId}`},
            ${tx.json(["skills:read"])}::jsonb, 'companion', null, ${expiresAt}
          )
        `,
      })).rejects.toMatchObject({ code: "23514" });
    } finally {
      if (sql) await sql`delete from api_tokens where id = ${companionTokenId}::uuid`;
      if (companionId) await removeCompanion(companionId);
    }
  });

  it("mints a claim-fenced hub token and rotates the previous one", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const mint = () => asRuntime((tx) => tx<Array<{ token: string }>>`
        select token
        from public.companion_runtime_mint_hub_token(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      const [first] = await mint();
      expect(first?.token).toMatch(/^cmp_pat_[0-9a-f]{48}$/);
      const [second] = await mint();
      expect(second?.token).toMatch(/^cmp_pat_[0-9a-f]{48}$/);
      expect(second?.token).not.toEqual(first?.token);
      const [counts] = await sql<Array<{ live: number; revoked: number }>>`
        select
          count(*) filter (where revoked_at is null)::int as live,
          count(*) filter (where revoked_at is not null)::int as revoked
        from api_tokens
        where source_type = 'companion' and source_agent_id = ${fixture.companionId}
      `;
      expect(counts).toEqual({ live: 1, revoked: 1 });
      expect(JSON.stringify(counts)).not.toContain("cmp_pat_");
      // Access is unconditional, so the scope set is fixed — and never widens past reading secrets.
      const [live] = await sql<Array<{ scopes: string[] }>>`
        select scopes from api_tokens
        where source_type = 'companion' and source_agent_id = ${fixture.companionId}
          and revoked_at is null
      `;
      expect(live?.scopes).toEqual([
        "skills:read",
        "skills:write",
        "secrets:read",
        "database:read",
        "database:write",
      ]);
      await release(claim);
    } finally {
      await sql`delete from api_tokens where source_agent_id = ${fixture.companionId}`;
      await removeCompanion(fixture.companionId);
    }
  });

  it("rejects effective CREATE inherited through PUBLIC in verification and the real grant hook", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    await sql.unsafe(`grant create on database "${databaseName}" to public`);
    try {
      await expect(asRuntime(async (tx) => {
        await verifyRuntimeDatabaseRole(tx as unknown as Pick<Sql, "unsafe">, runtimeRole);
      })).rejects.toBeInstanceOf(RuntimeDatabaseRoleError);
      await expect(applySplitGrants()).rejects.toThrow(/must not have database or public schema CREATE/i);
    } finally {
      await sql.unsafe(`revoke create on database "${databaseName}" from public`);
      await applySplitGrants();
    }
  });

  it("atomically consumes one desktop request id across independent runtime connections", async () => {
    const timestamp = Math.floor(Date.now() / 1_000);
    const requestId = randomUUID();
    const consume = async (): Promise<boolean> => await asRuntime(async (tx) => {
      const [row] = await tx<Array<{ consumed: boolean }>>`
        select public.companion_runtime_consume_desktop_request(
          ${requestId}, ${timestamp}::bigint, 30
        ) as consumed
      `;
      return row?.consumed ?? false;
    });
    expect((await Promise.all([consume(), consume()])).sort()).toEqual([false, true]);
    // A later process/connection sees the durable id and rejects it for the rest of the window.
    expect(await consume()).toBe(false);
  });

  it("projects JSONB and advances the durable cursor through PostgresRuntimeStore", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    // Production createRuntimeDatabase uses prepare:false. Exercise that exact postgres.js
    // serialization boundary instead of this suite's default prepared fixture connection.
    const storeSql = postgres(runtimeUrl.toString(), { max: 1, prepare: false });
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const fence: LeaseFence = {
        orgId: claim.orgId,
        companionId: claim.companionId,
        claimToken: claim.claimToken,
        claimEpoch: BigInt(claim.claimEpoch),
        gateEpoch: BigInt(claim.gateEpoch),
        executorId,
        workKind: "attempt",
        workId: claim.workId,
      };
      const wrapped = await storeSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${runtimeRole}`);
        return { result: await new PostgresRuntimeStore(
          tx as unknown as RuntimeSqlClient,
        ).projectEventBatch(fence, {
          expectedSequence: BigInt(claim.checkpointSequence),
          piInvocationId: `pi-${fixture.attemptId}`,
          events: [{
            sequence: 1n,
            type: "assistant",
            entry_key: "assistant:1",
            content: "Stored through the production serializer",
          }],
          throughCursor: 1n,
          unknownEventCount: 0,
          malformedEventCount: 0,
          oversizedEventCount: 0,
        }) };
      });
      const result = wrapped.result;
      expect(result).toEqual({
        checkpointSequence: 1n,
        eventCursor: 1n,
        hasVisibleOutput: true,
      });
      const [durable] = await sql<Array<{ cursor: string; content: string }>>`
        select attempt.event_cursor::text as cursor, entry.content
        from companion_turn_attempts attempt
        join companion_transcript_entries entry
          on entry.org_id = attempt.org_id and entry.companion_id = attempt.companion_id
        where attempt.id = ${fixture.attemptId}::uuid
          and entry.event_id = ${`v2:${fixture.attemptId}:1`}
      `;
      expect(durable).toEqual({
        cursor: "1",
        content: "Stored through the production serializer",
      });
    } finally {
      await storeSql.end({ timeout: 1 });
      await removeCompanion(fixture.companionId);
    }
  });

  it("returns exact encrypted material, fences OAuth CAS, and refuses forged or revoked authority", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      actorId: ids.revokedA,
      workspaceRole: "editor",
      selectedSkillIds: [ids.orgSkill],
      selectedMcpAccountIds: [ids.revokedMcpAccount],
    });
    try {
      const claim = await claimWork();
      expect(claim.workKind).toBe("attempt");
      const material = await asRuntime((tx) => tx<Array<{
        promptText: string;
        providerMaterial: Array<Record<string, unknown>>;
        skillMaterial: Array<Record<string, unknown>>;
        mcpMaterial: Array<Record<string, unknown>>;
      }>>`
        select prompt_text as "promptText", provider_material as "providerMaterial",
          skill_material as "skillMaterial", mcp_material as "mcpMaterial"
        from public.companion_runtime_get_material(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(material).toHaveLength(1);
      expect(material[0]?.promptText).toBe(fixture.prompt);
      expect(material[0]?.providerMaterial).toMatchObject([{
        provider_id: providerId,
        credential_generation: providerGeneration,
        ciphertext: "ciphertext-provider",
      }]);
      expect(material[0]?.skillMaterial).toMatchObject([{
        skill_id: ids.orgSkill,
        version_id: ids.orgSkillVersion,
        checksum: `sha256:${"b".repeat(64)}`,
      }]);
      expect(material[0]?.mcpMaterial).toMatchObject([{
        account_id: ids.revokedMcpAccount,
        credential_generation: ids.revokedMcpGeneration,
        ciphertext: "ciphertext-revoked-mcp",
      }]);

      const forged = await asRuntime((tx) => tx`
        select * from public.companion_runtime_get_material(
          ${ids.orgB}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(forged).toEqual([]);

      const nextGeneration = randomUUID();
      await expect(asRuntime((tx) => tx`
        select updated, credential_generation::text as generation
        from public.companion_runtime_cas_mcp_oauth(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, ${ids.revokedMcpAccount}::uuid,
          ${ids.revokedMcpGeneration}::uuid, ${nextGeneration}::uuid,
          'ciphertext-mcp-next', 'iv-mcp-next', 'tag-mcp-next', 'wrapped-mcp-next',
          'wrap-iv-mcp-next', 'wrap-tag-mcp-next', 'key-mcp-next'
        )
      `)).rejects.toMatchObject({ code: "22023" });

      // Rotation after the prompt material was pinned is detected before a takeover can project
      // output with only the new credential in its redaction dictionary.
      await sql`
        update companion_mcp_accounts
        set credential_generation = ${nextGeneration}::uuid, updated_at = now()
        where id = ${ids.revokedMcpAccount}::uuid
      `;
      const changed = await asRuntime((tx) => tx<Array<{ matches: boolean }>>`
        select credential_snapshot_matches as matches
        from public.companion_runtime_get_material(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(changed).toEqual([{ matches: false }]);

      await sql`
        delete from memberships where org_id = ${ids.orgA}::uuid and user_id = ${ids.revokedA}
      `;
      const revoked = await asRuntime((tx) => tx`
        select * from public.companion_runtime_get_material(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          ${claim.workKind}, ${claim.workId}::uuid, 30
        )
      `);
      expect(revoked).toEqual([]);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("projects a typed batch atomically, retries idempotently, and builds a decision response", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      const decision = {
        request_id: "request-1",
        kind: "question",
        name: "ask_user",
        title: "Choose a direction",
        detail: "A bounded question",
        status: "pending",
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: expiresAt,
      };
      const events = [
        {
          sequence: "1", type: "assistant", entry_key: "assistant:1",
          content: "A durable answer", reasoning: "bounded reasoning",
        },
        {
          sequence: "2", type: "tool", entry_key: "tool:call-1", content: "Run check",
          tool: {
            call_id: "call-1", kind: "shell", name: "exec", title: "Run check",
            status: "running", detail: "input", screenshot: null,
          },
        },
        {
          sequence: "3", type: "tool", entry_key: "tool:call-1", content: "Run check",
          tool: {
            call_id: "call-1", kind: "shell", name: "exec", title: "Run check",
            status: "ok", detail: "input\n\noutput", screenshot: null,
          },
        },
        {
          sequence: "4", type: "decision", entry_key: "decision:request-1",
          request_key: "request-1", request_kind: "question",
          content: decision.title, decision, expires_at: expiresAt,
        },
        { sequence: "5", type: "activity", event_type: "message_end" },
      ];
      const invalidEvents = [{ ...events[0], raw_event: { credential: "must-not-persist" } }];
      await expect(asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(invalidEvents)}, 1, now(), 0, 0, 0
        )
      `)).rejects.toMatchObject({ code: "22023" });
      const [before] = await sql<Array<{ cursor: string; projections: number }>>`
        select attempt.event_cursor::text as cursor,
          (select count(*)::int from companion_runtime_event_projections projection
            where projection.attempt_id = attempt.id) as projections
        from companion_turn_attempts attempt where attempt.id = ${fixture.attemptId}::uuid
      `;
      expect(before).toEqual({ cursor: "0", projections: 0 });

      const projected = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor,
          has_visible_output as visible
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 5, now(), 2, 1, 0
        )
      `);
      expect(projected).toEqual([{ sequence: "1", cursor: "5", visible: true }]);
      const replayed = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor,
          has_visible_output as visible
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 5, now(), 2, 1, 0
        )
      `);
      expect(replayed).toEqual(projected);
      await expect(asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json([
            { ...events[0], content: "tampered" }, ...events.slice(1),
          ])}, 5, now(), 2, 1, 0
        )
      `)).rejects.toMatchObject({ code: "40001" });
      const stale = await asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          (${claim.claimEpoch}::bigint + 1), ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, 1, ${`pi-${fixture.attemptId}`},
          ${tx.json([])}, 6, now(), 3, 1, 0
        )
      `);
      expect(stale).toEqual([]);

      const transcript = await sql<Array<{
        role: string;
        content: string;
        toolStatus: string | null;
        decisionExpiresAt: string | null;
      }>>`
        select role::text as role, content, tool ->> 'status' as "toolStatus",
          decision ->> 'expires_at' as "decisionExpiresAt"
        from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid and role <> 'user'
        order by ordinal
      `;
      expect(transcript).toEqual([
        {
          role: "assistant",
          content: "A durable answer",
          toolStatus: null,
          decisionExpiresAt: null,
        },
        {
          role: "tool",
          content: "Run check",
          toolStatus: "ok",
          decisionExpiresAt: null,
        },
        {
          role: "decision",
          content: "Choose a direction",
          toolStatus: null,
          decisionExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/),
        },
      ]);
      expect(Number.isNaN(Date.parse(transcript[2]!.decisionExpiresAt!))).toBe(false);
      const [attempt] = await sql<Array<{
        cursor: string;
        sequence: string;
        status: string;
        unknownCount: number;
        malformedCount: number;
      }>>`
        select event_cursor::text as cursor, checkpoint_sequence::text as sequence,
          status::text as status, unknown_event_count as "unknownCount",
          malformed_event_count as "malformedCount"
        from companion_turn_attempts where id = ${fixture.attemptId}::uuid
      `;
      expect(attempt).toEqual({
        cursor: "5", sequence: "1", status: "needs_input", unknownCount: 2, malformedCount: 1,
      });
      const [delivery] = await sql<Array<{ id: string; kind: string }>>`
        select id::text as id, request_kind::text as kind
        from companion_decision_deliveries
        where attempt_id = ${fixture.attemptId}::uuid and request_key = 'request-1'
      `;
      expect(delivery?.kind).toBe("question");
      if (!delivery) throw new Error("expected projected decision delivery");

      const siblingDeliveryId = randomUUID();
      await sql`
        insert into companion_decision_deliveries(
          id, org_id, companion_id, turn_id, attempt_id, request_key, expires_at
        ) values (
          ${siblingDeliveryId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${fixture.turnId}::uuid, ${fixture.attemptId}::uuid, 'request-2', ${expiresAt}
        )
      `;

      await release(claim);
      await sql`
        update companion_decision_deliveries
        set decision_status = 'answered', actor_id = ${ids.ownerA},
          response_text = 'Use the safe path', responded_at = now(), updated_at = now()
        where id = ${delivery.id}::uuid
      `;
      const decisionClaim = await claimWork();
      expect(decisionClaim.workKind).toBe("decision");
      const response = await asRuntime((tx) => tx<Array<{
        attemptId: string;
        kind: string;
        payload: Record<string, unknown>;
        visible: boolean;
      }>>`
        select attempt_id::text as "attemptId", decision_request_kind::text as kind,
          decision_response_payload as payload, has_visible_output as visible
        from public.companion_runtime_get_material(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, 30
        )
      `);
      expect(response).toEqual([{
        attemptId: fixture.attemptId,
        kind: "question",
        payload: { type: "extension_ui_response", id: "request-1", value: "Use the safe path" },
        visible: true,
      }]);
      const commandId = randomUUID();
      const [intent] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, ${decisionClaim.checkpointSequence}::bigint,
          'write_intent', null, ${commandId}::uuid, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(intent?.sequence).toBe("1");
      const [settled] = await asRuntime((tx) => tx<Array<{ settled: boolean }>>`
        select public.companion_runtime_settle(
          ${decisionClaim.orgId}::uuid, ${decisionClaim.companionId}::uuid,
          ${decisionClaim.claimToken}::uuid, ${decisionClaim.claimEpoch}::bigint,
          ${decisionClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${decisionClaim.workId}::uuid, 'succeeded', null, null, null
        ) as settled
      `);
      expect(settled?.settled).toBe(true);
      const [stillWaiting] = await sql<Array<{
        delivery: string;
        attempt: string;
        turn: string;
      }>>`
        select delivery.delivery_state::text as delivery,
          attempt.status::text as attempt, turn_row.status::text as turn
        from companion_decision_deliveries delivery
        join companion_turn_attempts attempt on attempt.id = delivery.attempt_id
        join companion_turns turn_row on turn_row.id = delivery.turn_id
        where delivery.id = ${delivery.id}::uuid
      `;
      expect(stillWaiting).toEqual({
        delivery: "delivered",
        attempt: "needs_input",
        turn: "needs_input",
      });

      await sql`
        update companion_decision_deliveries
        set decision_status = 'answered', actor_id = ${ids.ownerA},
          response_text = 'Continue', responded_at = now(), updated_at = now()
        where id = ${siblingDeliveryId}::uuid
      `;
      const siblingClaim = await claimWork();
      expect(siblingClaim).toMatchObject({ workKind: "decision", workId: siblingDeliveryId });
      const siblingCommandId = randomUUID();
      const [siblingIntent] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${siblingClaim.orgId}::uuid, ${siblingClaim.companionId}::uuid,
          ${siblingClaim.claimToken}::uuid, ${siblingClaim.claimEpoch}::bigint,
          ${siblingClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${siblingClaim.workId}::uuid, ${siblingClaim.checkpointSequence}::bigint,
          'write_intent', null, ${siblingCommandId}::uuid, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(siblingIntent?.sequence).toBe("1");
      const [siblingSettled] = await asRuntime((tx) => tx<Array<{ settled: boolean }>>`
        select public.companion_runtime_settle(
          ${siblingClaim.orgId}::uuid, ${siblingClaim.companionId}::uuid,
          ${siblingClaim.claimToken}::uuid, ${siblingClaim.claimEpoch}::bigint,
          ${siblingClaim.gateEpoch}::bigint, ${executorId}, 'decision',
          ${siblingClaim.workId}::uuid, 'succeeded', null, null, null
        ) as settled
      `);
      expect(siblingSettled?.settled).toBe(true);
      const [resumedParent] = await sql<Array<{
        delivery: string;
        attempt: string;
        turn: string;
      }>>`
        select delivery.delivery_state::text as delivery,
          attempt.status::text as attempt, turn_row.status::text as turn
        from companion_decision_deliveries delivery
        join companion_turn_attempts attempt on attempt.id = delivery.attempt_id
        join companion_turns turn_row on turn_row.id = delivery.turn_id
        where delivery.id = ${siblingDeliveryId}::uuid
      `;
      expect(resumedParent).toEqual({
        delivery: "delivered",
        attempt: "running",
        turn: "running",
      });
      const resumedClaim = await claimWork();
      expect(resumedClaim).toMatchObject({ workKind: "attempt", workId: fixture.attemptId });
      await release(resumedClaim);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("merges a delegated subagent run into one card and still refuses an unknown kind", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    const headline = "researcher: read the changelog";
    const callId = `sha256:${"a".repeat(32)}`;
    try {
      const claim = await claimWork();
      const delegated = (
        sequence: string,
        content: string,
        tool: Record<string, unknown>,
      ) => ({
        sequence,
        type: "tool",
        entry_key: `tool:${sequence}`,
        content,
        tool: {
          call_id: callId,
          kind: "subagent",
          name: "subagent",
          title: "",
          status: "running",
          detail: null,
          screenshot: null,
          ...tool,
        },
      });
      const events = [
        delegated("1", headline, { title: headline, detail: "read the changelog" }),
        delegated("2", "", { detail: "reading CHANGELOG.md" }),
        delegated("3", "", { status: "error" }),
      ];

      // An unrecognized kind is still refused before anything is written, so widening the list is
      // an addition and not an opening.
      await expect(asRuntime((tx) => tx`
        select * from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json([
            delegated("1", "x", { kind: "telepathy" }),
          ])}, 1, now(), 0, 0, 0
        )
      `)).rejects.toMatchObject({ code: "22023" });

      const projected = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 3, now(), 0, 0, 0
        )
      `);
      expect(projected).toEqual([{ sequence: "1", cursor: "3" }]);

      // Three events, one card: the headline survived the progress that carried none, and the
      // settlement kept the last progress it followed. A failure is the case that matters most —
      // it is where a reader needs to see what the child agent was doing when it stopped.
      const cards = await sql<Array<{
        content: string;
        title: string;
        detail: string | null;
        status: string;
      }>>`
        select content, tool ->> 'title' as title, tool ->> 'detail' as detail,
          tool ->> 'status' as status
        from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid and role = 'tool'
        order by ordinal
      `;
      expect(cards).toEqual([{
        content: headline,
        title: headline,
        detail: "reading CHANGELOG.md",
        status: "error",
      }]);

      // Replaying the committed page is still a digest check, not a second projection.
      const replayed = await asRuntime((tx) => tx<Array<{ cursor: string }>>`
        select event_cursor::text as cursor
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json(events)}, 3, now(), 0, 0, 0
        )
      `);
      expect(replayed).toEqual([{ cursor: "3" }]);

      // A progress line whose start never landed -- an oversized start line is dropped by the
      // broker and never projected -- still becomes a card that names the tool.
      const orphan = await asRuntime((tx) => tx<Array<{ cursor: string }>>`
        select event_cursor::text as cursor
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${projected[0]!.sequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json([{
            ...delegated("4", "", { detail: "still working" }),
            tool: {
              call_id: `sha256:${"b".repeat(32)}`,
              kind: "subagent",
              name: "subagent",
              title: "",
              status: "running",
              detail: "still working",
              screenshot: null,
            },
          }])}, 4, now(), 0, 0, 0
        )
      `);
      expect(orphan).toEqual([{ cursor: "4" }]);
      const [started] = await sql<Array<{ content: string; title: string }>>`
        select content, tool ->> 'title' as title
        from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid and role = 'tool'
        order by ordinal desc limit 1
      `;
      expect(started).toEqual({ content: "subagent", title: "subagent" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("returns a takeover-safe negative proof when settlement has no visible output", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const controlOnly = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor,
          has_visible_output as visible
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`}, ${tx.json([])}, 1, null, 0, 0, 0
        )
      `);
      expect(controlOnly).toEqual([{ sequence: "1", cursor: "1", visible: false }]);
      const result = await asRuntime((tx) => tx<Array<{
        sequence: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint_sequence::text as sequence, event_cursor::text as cursor,
          has_visible_output as visible
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, 1,
          ${`pi-${fixture.attemptId}`}, ${tx.json([{ sequence: "2", type: "settled" }])},
          2, null, 0, 0, 0
        )
      `);
      expect(result).toEqual([{ sequence: "2", cursor: "2", visible: false }]);
      const [terminal] = await sql<Array<{ checkpoint: string }>>`
        select checkpoint from companion_turn_attempts
        where id = ${fixture.attemptId}::uuid
      `;
      expect(terminal).toEqual({ checkpoint: "agent_settled" });
      const material = await asRuntime((tx) => tx<Array<{ visible: boolean }>>`
        select has_visible_output as visible
        from public.companion_runtime_get_material(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, 30
        )
      `);
      expect(material).toEqual([{ visible: false }]);
      const terminalProjection = await asRuntime((tx) => tx<Array<{
        checkpoint: string;
        cursor: string;
        visible: boolean;
      }>>`
        select checkpoint, event_cursor::text as cursor, has_visible_output as visible
        from public.companion_runtime_get_attempt_terminal_projection(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid
        )
      `);
      expect(terminalProjection).toEqual([{
        checkpoint: "agent_settled",
        cursor: "2",
        visible: false,
      }]);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("persists a projected Pi exit as takeover-safe terminal proof", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const claim = await claimWork();
      const projected = await asRuntime((tx) => tx<Array<{ cursor: string }>>`
        select event_cursor::text as cursor
        from public.companion_runtime_project_event_batch(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'attempt', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          ${`pi-${fixture.attemptId}`},
          ${tx.json([{ sequence: "1", type: "process_exit", code: 137, signal: "SIGKILL" }])},
          1, null, 0, 0, 0
        )
      `);
      expect(projected).toEqual([{ cursor: "1" }]);
      const [terminal] = await sql<Array<{ checkpoint: string; status: string }>>`
        select checkpoint, status::text as status from companion_turn_attempts
        where id = ${fixture.attemptId}::uuid
      `;
      expect(terminal).toEqual({ checkpoint: "process_exited", status: "running" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("resumes duplicate Box cleanup and blocks canonical progression until every child is deleted", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion();
    try {
      const operationId = randomUUID();
      await sql`
        insert into companion_operations(
          id, org_id, companion_id, request_id, kind, trigger, actor_id, runtime_generation
        ) values (
          ${operationId}::uuid, ${ids.orgA}::uuid, ${fixture.companionId}::uuid,
          ${randomUUID()}::uuid, 'start', 'user', ${ids.ownerA}, 1
        )
      `;
      // The active attempt has higher precedence than Start; remove it from this operation fixture.
      await sql`delete from companion_turn_attempts where id = ${fixture.attemptId}::uuid`;
      await sql`
        update companion_turns set status = 'cancelled', settled_at = now(),
          inactivity_deadline_at = null, absolute_deadline_at = null
        where id = ${fixture.turnId}::uuid
      `;
      const claim = await claimWork();
      expect(claim.workKind).toBe("operation");
      const [resolving] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, ${claim.checkpointSequence}::bigint,
          'resolving_box', null, null, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(resolving?.sequence).toBe("1");
      const [absence] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_observe_instance(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 1, 1, null, 'absent',
          null, null, null, null, null, now()
        )::text as sequence
      `);
      expect(absence?.sequence).toBe("2");
      const [creating] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 2, 'creating_box',
          null, null, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(creating?.sequence).toBe("3");
      const duplicateIds = ["bx_2345678a", "bx_2345678b"];
      const registered = await asRuntime((tx) => tx<Array<{ boxId: string; status: string }>>`
        select box_id as "boxId", status::text as status
        from public.companion_runtime_register_duplicate_cleanups(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, ${duplicateIds}::text[]
        )
      `);
      expect(registered).toEqual(duplicateIds.map((boxId) => ({ boxId, status: "pending" })));

      await expect(asRuntime((tx) => tx`
        select public.companion_runtime_observe_instance(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 1, 3, 'bx_23456789', 'initializing',
          null, null, null, null, null, now()
        )
      `)).rejects.toMatchObject({ code: "22023" });
      const stale = await asRuntime((tx) => tx`
        select * from public.companion_runtime_checkpoint_duplicate_cleanup(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          (${claim.claimEpoch}::bigint + 1), ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, ${duplicateIds[0]!}, 0,
          'already_deleted', null
        )
      `);
      expect(stale).toEqual([]);

      const checkpointCleanup = async (
        boxId: string,
        sequence: number,
        status: "delete_requested" | "waiting_deleted" | "deleted" | "already_deleted",
        operation: string | null,
      ) => asRuntime((tx) => tx`
        select * from public.companion_runtime_checkpoint_duplicate_cleanup(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, ${boxId}, ${sequence}, ${status}, ${operation}
        )
      `);
      await checkpointCleanup(duplicateIds[0]!, 0, "delete_requested", "delete-operation-1");
      await checkpointCleanup(duplicateIds[0]!, 1, "waiting_deleted", null);
      await checkpointCleanup(duplicateIds[0]!, 2, "deleted", null);
      await checkpointCleanup(duplicateIds[1]!, 0, "already_deleted", null);
      const resumed = await asRuntime((tx) => tx<Array<{ boxId: string; status: string }>>`
        select box_id as "boxId", status::text as status
        from public.companion_runtime_register_duplicate_cleanups(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, array[]::text[]
        )
      `);
      expect(resumed).toEqual([
        { boxId: duplicateIds[0], status: "deleted" },
        { boxId: duplicateIds[1], status: "already_deleted" },
      ]);
      const [observed] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_observe_instance(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 1, 3, 'bx_23456789', 'initializing',
          null, null, null, null, null, now()
        )::text as sequence
      `);
      expect(observed?.sequence).toBe("4");

      // A duplicate may appear after the provider accepted the deterministic
      // generation name. Registration and the progression guard must remain
      // active at box_created so a takeover cannot stage the canonical Box
      // before that late child is durably reconciled.
      const lateDuplicateId = "bx_2345678c";
      const lateRegistered = await asRuntime((tx) => tx<Array<{
        boxId: string;
        status: string;
      }>>`
        select box_id as "boxId", status::text as status
        from public.companion_runtime_register_duplicate_cleanups(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, array[${lateDuplicateId}]::text[]
        )
        where box_id = ${lateDuplicateId}
      `);
      expect(lateRegistered).toEqual([{ boxId: lateDuplicateId, status: "pending" }]);

      await expect(asRuntime((tx) => tx`
        select public.companion_runtime_checkpoint(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 4, 'waiting_ready',
          null, null, null, null, null, null, null, null
        )
      `)).rejects.toMatchObject({ code: "22023" });

      await checkpointCleanup(lateDuplicateId, 0, "already_deleted", null);
      const [waitingReady] = await asRuntime((tx) => tx<Array<{ sequence: string | null }>>`
        select public.companion_runtime_checkpoint(
          ${claim.orgId}::uuid, ${claim.companionId}::uuid, ${claim.claimToken}::uuid,
          ${claim.claimEpoch}::bigint, ${claim.gateEpoch}::bigint, ${executorId},
          'operation', ${claim.workId}::uuid, 4, 'waiting_ready',
          null, null, null, null, null, null, null, null
        )::text as sequence
      `);
      expect(waitingReady?.sequence).toBe("5");
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("keeps Viewer, nonmember, and cross-tenant desktop requests opaque", async () => {
    const fixture = await createCompanion({ boxReady: true, workspaceRole: "viewer" });
    const denied = [{
      authorized: false,
      denialCode: "not_authorized",
      boxId: null,
      boxState: null,
      generation: null,
    }];
    try {
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.ownerA,
      })).toEqual([{
        authorized: true,
        denialCode: null,
        boxId: "bx_23456789",
        boxState: "ready",
        generation: "1",
      }]);
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.viewerA,
      })).toEqual(denied);
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.ownerB,
      })).toEqual(denied);
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        orgId: ids.orgB,
        actorId: ids.ownerB,
      })).toEqual(denied);
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("requires the desktop actor to own every personal Skill and MCP pin", async () => {
    const privateCases = [
      {
        name: "Editor on Owner personal Skill",
        actorId: ids.editorA,
        selectedSkillIds: [ids.skill],
        selectedMcpAccountIds: [],
      },
      {
        name: "Editor on Owner MCP account",
        actorId: ids.editorA,
        selectedSkillIds: [ids.orgSkill],
        selectedMcpAccountIds: [ids.mcpAccount],
      },
      {
        name: "Owner on Editor personal Skill",
        actorId: ids.ownerA,
        selectedSkillIds: [ids.editorSkill],
        selectedMcpAccountIds: [],
      },
      {
        name: "Owner on Editor MCP account",
        actorId: ids.ownerA,
        selectedSkillIds: [ids.orgSkill],
        selectedMcpAccountIds: [ids.editorMcpAccount],
      },
    ];
    for (const privacyCase of privateCases) {
      const fixture = await createCompanion({
        boxReady: true,
        workspaceRole: "editor",
        selectedSkillIds: privacyCase.selectedSkillIds,
        selectedMcpAccountIds: privacyCase.selectedMcpAccountIds,
      });
      try {
        expect(
          await authorizeDesktop({
            companionId: fixture.companionId,
            actorId: privacyCase.actorId,
          }),
          privacyCase.name,
        ).toEqual([{
          authorized: false,
          denialCode: "resource_access_revoked",
          boxId: null,
          boxState: null,
          generation: null,
        }]);
      } finally {
        await removeCompanion(fixture.companionId);
      }
    }

    const editorFixture = await createCompanion({
      boxReady: true,
      workspaceRole: "editor",
      selectedSkillIds: [ids.editorSkill],
      selectedMcpAccountIds: [ids.editorMcpAccount],
    });
    try {
      expect(await authorizeDesktop({
        companionId: editorFixture.companionId,
        actorId: ids.editorA,
      })).toMatchObject([{ authorized: true, denialCode: null, boxId: "bx_23456789" }]);
    } finally {
      await removeCompanion(editorFixture.companionId);
    }

    const orgFixture = await createCompanion({
      boxReady: true,
      workspaceRole: "editor",
      selectedSkillIds: [ids.orgSkill],
      selectedMcpAccountIds: [],
    });
    try {
      expect(await authorizeDesktop({
        companionId: orgFixture.companionId,
        actorId: ids.editorA,
      })).toMatchObject([{ authorized: true, denialCode: null, boxId: "bx_23456789" }]);
    } finally {
      await removeCompanion(orgFixture.companionId);
    }
  });

  it("denies desktop until both current settings and Skills revisions are applied", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      workspaceRole: "editor",
      selectedSkillIds: [ids.orgSkill],
      selectedMcpAccountIds: [],
    });
    const settingsNotApplied = [{
      authorized: false,
      denialCode: "settings_not_applied",
      boxId: null,
      boxState: null,
      generation: null,
    }];
    try {
      await sql`
        update companion_runtime_instances
        set desired_settings_revision = 2
        where companion_id = ${fixture.companionId}::uuid
      `;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toEqual(settingsNotApplied);

      await sql`
        update companion_runtime_instances
        set applied_settings_revision = 2
        where companion_id = ${fixture.companionId}::uuid
      `;
      await sql`
        update companions
        set skills_revision = 2
        where id = ${fixture.companionId}::uuid
      `;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toEqual(settingsNotApplied);

      await sql`
        update companion_runtime_instances
        set applied_skills_revision = 2, generation = 2147483647
        where companion_id = ${fixture.companionId}::uuid
      `;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toMatchObject([{
        authorized: true,
        denialCode: null,
        boxId: "bx_23456789",
        generation: "2147483647",
      }]);
      await expect(sql`
        update companion_runtime_instances set generation = 2147483648
        where companion_id = ${fixture.companionId}::uuid
      `).rejects.toMatchObject({ code: "23514" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });

  it("locks staged revisions and resource ownership through desktop authorization", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({
      boxReady: true,
      workspaceRole: "editor",
      selectedSkillIds: [ids.orgSkill],
      selectedMcpAccountIds: [],
    });
    // The final rollout deliberately exercises the application pool at max=1. Use a distinct
    // writer connection for lock races so the authorization call tests PostgreSQL contention,
    // rather than waiting forever for the only client-side pool slot.
    const writer = postgres(runtimeUrl.toString(), { max: 1 });
    let transactionOpen = false;
    const authorizeWithLockTimeout = () => asRuntime(async (tx) => {
      await tx.unsafe("set local lock_timeout = '150ms'");
      return await tx`
        select * from public.companion_runtime_authorize_desktop(
          ${ids.orgA}::uuid, ${fixture.companionId}::uuid, ${ids.editorA}
        )
      `;
    });
    try {
      await writer`begin`;
      transactionOpen = true;
      await writer`
        select 1 from skills where id = ${ids.orgSkill}::uuid for update
      `;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toEqual([{
        authorized: false,
        denialCode: "settings_not_applied",
        boxId: null,
        boxState: null,
        generation: null,
      }]);
      await writer`rollback`;
      transactionOpen = false;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toMatchObject([{ authorized: true, denialCode: null }]);

      await writer`begin`;
      transactionOpen = true;
      // Match the Runtime/API hierarchy: instance before Companion. Authorization must wait and
      // then evaluate the committed pair, never mix either side of this restage boundary.
      await writer`
        update companion_runtime_instances
        set applied_skills_revision = 2
        where companion_id = ${fixture.companionId}::uuid
      `;
      await writer`
        update companions
        set selected_skill_ids = ${sql.json([ids.skill])}, skills_revision = 2
        where id = ${fixture.companionId}::uuid
      `;
      await expect(authorizeWithLockTimeout()).rejects.toMatchObject({ code: "55P03" });
      await writer`commit`;
      transactionOpen = false;
      expect(await authorizeDesktop({
        companionId: fixture.companionId,
        actorId: ids.editorA,
      })).toEqual([{
        authorized: false,
        denialCode: "resource_access_revoked",
        boxId: null,
        boxState: null,
        generation: null,
      }]);
    } finally {
      if (transactionOpen) await writer`rollback`;
      await writer.end({ timeout: 1 });
      await removeCompanion(fixture.companionId);
    }
  });
});
