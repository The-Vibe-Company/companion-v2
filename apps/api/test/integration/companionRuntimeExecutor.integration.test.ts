/**
 * Product promise:
 * the isolated Runtime v2 login can fetch only lease-authorized material and can commit a typed
 * broker projection before ACK without ever receiving direct table privileges.
 *
 * Regression caught:
 * a forged tenant/fence, response-lost projection retry, revoked actor, duplicate generation Box,
 * or Viewer desktop request must not leak credentials, duplicate transcript rows, or cross a stale
 * lease epoch.
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
  RuntimeDatabaseRoleError,
  verifyRuntimeDatabaseRole,
} from "@companion/db/runtime-role";
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
  mcpAccount: randomUUID(),
  mcpGeneration: randomUUID(),
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

async function replayMigrations(client: Sql): Promise<void> {
  const names = (await readdir(migrationsDir))
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  for (const name of names) await applyMigrationFile(client, name);
}

async function applySplitGrants(): Promise<void> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const grants = extractRuntimeRoleGrantBlock(
    await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
  );
  await sql.begin(async (tx) => {
    await tx`select set_config('companion.api_role', ${apiRole}, true)`;
    await tx`select set_config('companion.worker_role', ${workerRole}, true)`;
    await tx`select set_config('companion.companion_runtime_role', ${runtimeRole}, true)`;
    await tx.unsafe(grants);
  });
}

async function asRuntime<T>(action: (tx: Tx) => Promise<T>): Promise<T> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const wrapped = await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${runtimeRole}`);
    return { value: await action(tx) };
  });
  return wrapped.value;
}

async function createCompanion(input: {
  actorId?: string;
  boxReady?: boolean;
  workspaceRole?: "editor" | "viewer";
} = {}): Promise<{ companionId: string; turnId: string; attemptId: string; prompt: string }> {
  if (!sql) throw new Error("runtime executor database is not initialized");
  const companionId = randomUUID();
  const turnId = randomUUID();
  const attemptId = randomUUID();
  const clientMessageId = randomUUID();
  const prompt = `durable prompt ${clientMessageId}`;
  const actorId = input.actorId ?? ids.ownerA;
  await sql`
    insert into companions (
      id, org_id, owner_id, name, model_id, provider_ids,
      selected_skill_ids, selected_mcp_account_ids
    ) values (
      ${companionId}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'Runtime executor fixture',
      'fixture-model', ${sql.json([providerId])}, ${sql.json([ids.skill])},
      ${sql.json([ids.mcpAccount])}
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
      }])}, ${sql.json([ids.skill])}, ${sql.json([ids.mcpAccount])},
      ${sql.json([{
        account_id: ids.mcpAccount,
        credential_generation: ids.mcpGeneration,
      }])},
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

describe("Companion runtime executor PostgreSQL surface", () => {
  beforeAll(async () => {
    await adminSql.unsafe(`create database "${databaseName}"`);
    sql = postgres(runtimeUrl.toString(), { max: 4 });
    await replayMigrations(sql);
    await adminSql.unsafe(`
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${runtimeRole} login nosuperuser nobypassrls noinherit;
    `);
    await applySplitGrants();

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
      values (
        ${ids.skill}::uuid, ${ids.orgA}::uuid, ${`runtime-skill-${suffix}`},
        'Runtime immutable Skill fixture', ${ids.ownerA}, 'personal'
      )
    `;
    await sql`
      insert into skill_versions(
        id, org_id, skill_id, version, frontmatter, tools, size_bytes,
        checksum, storage_path, validation, created_by
      ) values (
        ${ids.skillVersion}::uuid, ${ids.orgA}::uuid, ${ids.skill}::uuid, '1.0.0',
        'name: runtime-fixture', '[]'::jsonb, 42, ${checksum},
        ${`skills/${ids.skillVersion}.tar.gz`}, 'valid', ${ids.ownerA}
      )
    `;
    await sql`
      update skills set current_version_id = ${ids.skillVersion}::uuid
      where id = ${ids.skill}::uuid
    `;
    await sql`
      insert into companion_mcp_accounts(
        id, org_id, owner_id, provider, label, transport, account_config,
        credential_generation, ciphertext, iv, auth_tag, wrapped_dek,
        wrap_iv, wrap_auth_tag, key_id
      ) values (
        ${ids.mcpAccount}::uuid, ${ids.orgA}::uuid, ${ids.ownerA}, 'fixture-mcp',
        'Runtime fixture', 'http', ${sql.json({ endpoint: "fixture" })},
        ${ids.mcpGeneration}::uuid, 'ciphertext-mcp', 'iv-mcp', 'tag-mcp',
        'wrapped-mcp', 'wrap-iv-mcp', 'wrap-tag-mcp', 'key-mcp'
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
            'companion_runtime_event_projections'
          ]) protected(table_name)
          where has_table_privilege(${runtimeRole}, 'public.' || protected.table_name, 'SELECT')
        ) as "privateTableReads",
        (
          select count(*)::int from unnest(array[
            'public.companion_runtime_get_material(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,integer)',
            'public.companion_runtime_get_attempt_terminal_projection(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid)',
            'public.companion_runtime_cas_mcp_oauth(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,uuid,uuid,uuid,text,text,text,text,text,text,text)',
            'public.companion_runtime_register_duplicate_cleanups(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text[])',
            'public.companion_runtime_checkpoint_duplicate_cleanup(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,text,bigint,public.companion_duplicate_cleanup_status,text)',
            'public.companion_runtime_authorize_desktop(uuid,uuid,text)',
            'public.companion_runtime_project_event_batch(uuid,uuid,uuid,bigint,bigint,text,public.companion_runtime_work_kind,uuid,bigint,text,jsonb,bigint,timestamp with time zone,integer,integer,integer)'
          ]) protected(signature)
          where has_function_privilege(${runtimeRole}, protected.signature, 'EXECUTE')
        ) as "callableFunctions",
        has_function_privilege(
          ${runtimeRole}, 'public.companion_runtime_guard_duplicate_cleanup()', 'EXECUTE'
        ) as "helperCallable"
    `;
    expect(acl).toEqual({ privateTableReads: 0, callableFunctions: 7, helperCallable: false });
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
  });

  it("returns exact encrypted material, fences OAuth CAS, and refuses forged or revoked authority", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ actorId: ids.revokedA, workspaceRole: "editor" });
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
        skill_id: ids.skill,
        version_id: ids.skillVersion,
        checksum,
      }]);
      expect(material[0]?.mcpMaterial).toMatchObject([{
        account_id: ids.mcpAccount,
        credential_generation: ids.mcpGeneration,
        ciphertext: "ciphertext-mcp",
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
          ${claim.workKind}, ${claim.workId}::uuid, ${ids.mcpAccount}::uuid,
          ${ids.mcpGeneration}::uuid, ${nextGeneration}::uuid,
          'ciphertext-mcp-next', 'iv-mcp-next', 'tag-mcp-next', 'wrapped-mcp-next',
          'wrap-iv-mcp-next', 'wrap-tag-mcp-next', 'key-mcp-next'
        )
      `)).rejects.toMatchObject({ code: "22023" });

      // Rotation after the prompt material was pinned is detected before a takeover can project
      // output with only the new credential in its redaction dictionary.
      await sql`
        update companion_mcp_accounts
        set credential_generation = ${nextGeneration}::uuid, updated_at = now()
        where id = ${ids.mcpAccount}::uuid
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
      }>>`
        select role::text as role, content, tool ->> 'status' as "toolStatus"
        from companion_transcript_entries
        where companion_id = ${fixture.companionId}::uuid and role <> 'user'
        order by ordinal
      `;
      expect(transcript).toEqual([
        { role: "assistant", content: "A durable answer", toolStatus: null },
        { role: "tool", content: "Run check", toolStatus: "ok" },
        { role: "decision", content: "Choose a direction", toolStatus: null },
      ]);
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

  it("reauthorizes desktop access without waking Box and enforces the JS generation ceiling", async () => {
    if (!sql) throw new Error("runtime executor database is not initialized");
    const fixture = await createCompanion({ boxReady: true, workspaceRole: "viewer" });
    try {
      const authorize = (orgId: string, actorId: string) => asRuntime((tx) => tx<Array<{
        authorized: boolean;
        denialCode: string | null;
        boxId: string | null;
        generation: string | null;
      }>>`
        select authorized, denial_code as "denialCode", box_id as "boxId",
          runtime_generation::text as generation
        from public.companion_runtime_authorize_desktop(
          ${orgId}::uuid, ${fixture.companionId}::uuid, ${actorId}
        )
      `);
      expect(await authorize(ids.orgA, ids.ownerA)).toEqual([{
        authorized: true, denialCode: null, boxId: "bx_23456789", generation: "1",
      }]);
      expect(await authorize(ids.orgA, ids.viewerA)).toEqual([{
        authorized: false, denialCode: "not_authorized", boxId: null, generation: null,
      }]);
      expect(await authorize(ids.orgB, ids.viewerA)).toEqual([{
        authorized: false, denialCode: "not_authorized", boxId: null, generation: null,
      }]);
      await sql`
        update companion_workspace_access set role = 'editor'
        where companion_id = ${fixture.companionId}::uuid
      `;
      expect(await authorize(ids.orgA, ids.viewerA)).toEqual([{
        authorized: true, denialCode: null, boxId: "bx_23456789", generation: "1",
      }]);
      await sql`
        update companion_runtime_instances set generation = 2147483647
        where companion_id = ${fixture.companionId}::uuid
      `;
      await expect(sql`
        update companion_runtime_instances set generation = 2147483648
        where companion_id = ${fixture.companionId}::uuid
      `).rejects.toMatchObject({ code: "23514" });
    } finally {
      await removeCompanion(fixture.companionId);
    }
  });
});
