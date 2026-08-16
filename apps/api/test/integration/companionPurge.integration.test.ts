/**
 * Product promise:
 * The Runtime v2 cutover removes every legacy Companion ownership row only after durable proof that
 * every database-owned Box is gone, while preserving the Skills Hub, credentials, identity,
 * billing, and audit records that belong to the workspace.
 *
 * Regression caught:
 * A table-owner query can appear green while FORCE RLS silently hides rows, a missing Box ledger
 * entry can strand a paid Box, or a broad Companion cleanup can erase provider/MCP credentials and
 * write-on-behalf provenance that the next runtime generation still needs.
 *
 * Why integrated:
 * The guarantee depends on PostgreSQL locks, SECURITY DEFINER identity, FORCE RLS, grants, foreign
 * keys, transactional rollback, and the exact `api_tokens.source_type` predicate.
 *
 * Failure proof:
 * Removing a maintenance policy, one explicit DELETE, the Box-ledger guard, or the companion-token
 * predicate makes one of the refusal, drain, preservation, or role-boundary assertions fail.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  extractRuntimeRoleGrantBlock,
  resolveRuntimeRoleGrantsFile,
} from "../../src/migrate";
import { integrationSql } from "./testDatabase";

const FINALIZER_TABLES = [
  "companion_legacy_purge_runs",
  "companion_legacy_purge_targets",
  "companion_transcript_entries",
  "companion_threads",
  "companion_workspace_access",
  "companion_member_state",
  "companion_reconcile_leases",
  "companions",
  "companion_runtime_pools",
  "api_tokens",
] as const;

const FORCED_RLS_TABLES = [
  "companion_legacy_purge_runs",
  "companion_legacy_purge_targets",
  "companions",
  "companion_runtime_pools",
  "companion_workspace_access",
  "companion_member_state",
  "companion_threads",
  "companion_transcript_entries",
  "companion_reconcile_leases",
  "companion_provider_connections",
  "companion_mcp_accounts",
] as const;

const ROLLBACK = new Error("rollback companion purge integration fixture");

interface FixtureIds {
  orgId: string;
  ownerId: string;
  companionId: string;
  poolId: string;
  skillId: string;
  skillVersionId: string;
  secretId: string;
  mcpAccountId: string;
  auditId: string;
  companionBoxId: string;
  poolBoxId: string;
  orphanCompanionId: string;
  tokenHashes: {
    companion: string;
    orphanCompanion: string;
    human: string;
    agentAuth: string;
  };
}

interface LegacyCounts {
  companions: number;
  runtimePools: number;
  workspaceAccess: number;
  memberState: number;
  threads: number;
  transcriptEntries: number;
  reconcileLeases: number;
  companionTokens: number;
}

interface FinalizeResult {
  already_complete: boolean;
  companions: number;
  runtime_pools: number;
  workspace_access: number;
  member_state: number;
  threads: number;
  transcript_entries: number;
  reconcile_leases: number;
  companion_tokens: number;
}

function fixtureIds(companionBoxId: string, poolBoxId: string): FixtureIds {
  const suffix = randomUUID();
  return {
    orgId: randomUUID(),
    ownerId: `purge-owner-${suffix}`,
    companionId: randomUUID(),
    poolId: randomUUID(),
    skillId: randomUUID(),
    skillVersionId: randomUUID(),
    secretId: randomUUID(),
    mcpAccountId: randomUUID(),
    auditId: randomUUID(),
    companionBoxId,
    poolBoxId,
    orphanCompanionId: randomUUID(),
    tokenHashes: {
      companion: `purge-companion-${suffix}`,
      orphanCompanion: `purge-orphan-companion-${suffix}`,
      human: `purge-human-${suffix}`,
      agentAuth: `purge-agent-auth-${suffix}`,
    },
  };
}

async function withRolledBackTransaction(
  run: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<void> {
  try {
    await integrationSql.begin(async (tx) => {
      await run(tx);
      throw ROLLBACK;
    });
  } catch (error) {
    if (error !== ROLLBACK) throw error;
  }
}

async function clearLegacyState(tx: postgres.TransactionSql): Promise<void> {
  await tx`delete from companion_legacy_purge_targets`;
  await tx`delete from companion_legacy_purge_runs`;
  await tx`delete from companions`;
  await tx`delete from companion_runtime_pools`;
  await tx`delete from api_tokens where source_type = 'companion'`;
}

async function seedFixture(tx: postgres.TransactionSql, ids: FixtureIds): Promise<void> {
  const slug = `purge-${ids.orgId}`;
  await tx`
    insert into "user" (id, name, email, email_verified)
    values (${ids.ownerId}, 'Purge Owner', ${`${ids.ownerId}@example.test`}, true)
  `;
  await tx`
    insert into profiles (id, name, email, initials)
    values (${ids.ownerId}, 'Purge Owner', ${`${ids.ownerId}@example.test`}, 'PO')
  `;
  await tx`
    insert into organizations (id, name, slug, default_companion_provider_id)
    values (${ids.orgId}::uuid, 'Purge workspace', ${slug}, 'openai')
  `;
  await tx`
    insert into memberships (org_id, user_id, org_role)
    values (${ids.orgId}::uuid, ${ids.ownerId}, 'owner')
  `;

  await tx`
    insert into companions (id, org_id, owner_id, name, box_id)
    values (
      ${ids.companionId}::uuid,
      ${ids.orgId}::uuid,
      ${ids.ownerId},
      'Legacy Companion',
      ${ids.companionBoxId}
    )
  `;
  await tx`
    insert into companion_runtime_pools (id, org_id, scope, box_id)
    values (${ids.poolId}::uuid, ${ids.orgId}::uuid, 'org', ${ids.poolBoxId})
  `;
  await tx`
    insert into companion_workspace_access (org_id, companion_id, owner_id, role, granted_by)
    values (
      ${ids.orgId}::uuid,
      ${ids.companionId}::uuid,
      ${ids.ownerId},
      'editor',
      ${ids.ownerId}
    )
  `;
  await tx`
    insert into companion_member_state (org_id, companion_id, user_id, hidden, last_read_ordinal)
    values (${ids.orgId}::uuid, ${ids.companionId}::uuid, ${ids.ownerId}, false, 0)
  `;
  await tx`
    insert into companion_threads (org_id, companion_id, next_ordinal, last_message_at)
    values (${ids.orgId}::uuid, ${ids.companionId}::uuid, 1, clock_timestamp())
  `;
  await tx`
    insert into companion_transcript_entries (
      org_id, companion_id, event_id, ordinal, role, content, author_id
    ) values (
      ${ids.orgId}::uuid,
      ${ids.companionId}::uuid,
      'purge-message',
      0,
      'user',
      'Delete this legacy transcript only after its Box is gone.',
      ${ids.ownerId}
    )
  `;
  await tx`
    insert into companion_reconcile_leases (org_id, companion_id, reason)
    values (${ids.orgId}::uuid, ${ids.companionId}::uuid, 'stale_start')
  `;

  await tx`
    insert into companion_provider_connections (
      org_id, provider_id, auth_method, ciphertext, iv, auth_tag,
      wrapped_dek, wrap_iv, wrap_auth_tag, key_id, connected_by
    ) values (
      ${ids.orgId}::uuid, 'openai', 'api_key', 'provider-ciphertext', 'provider-iv',
      'provider-auth-tag', 'provider-wrapped-dek', 'provider-wrap-iv',
      'provider-wrap-auth-tag', 'provider-key', ${ids.ownerId}
    )
  `;
  await tx`
    insert into companion_mcp_accounts (
      id, org_id, owner_id, provider, label, transport, account_config,
      ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id
    ) values (
      ${ids.mcpAccountId}::uuid, ${ids.orgId}::uuid, ${ids.ownerId}, 'github', 'work',
      'http', ${JSON.stringify({ url: "https://mcp.example.test" })}::jsonb, 'mcp-ciphertext', 'mcp-iv',
      'mcp-auth-tag', 'mcp-wrapped-dek', 'mcp-wrap-iv', 'mcp-wrap-auth-tag', 'mcp-key'
    )
  `;
  await tx`
    insert into skills (id, org_id, slug, description, creator_id, scope)
    values (
      ${ids.skillId}::uuid,
      ${ids.orgId}::uuid,
      'preserved-skill',
      'Must survive the legacy purge.',
      ${ids.ownerId},
      'personal'
    )
  `;
  await tx`
    insert into skill_versions (
      id, org_id, skill_id, version, frontmatter, body, size_bytes,
      checksum, storage_path, created_by
    ) values (
      ${ids.skillVersionId}::uuid,
      ${ids.orgId}::uuid,
      ${ids.skillId}::uuid,
      '1.0.0',
      'name: preserved-skill',
      '# Preserved skill',
      64,
      ${`sha256:${"b".repeat(64)}`},
      ${`purge-test/${ids.skillId}/1.0.0.tar.gz`},
      ${ids.ownerId}
    )
  `;
  await tx`
    insert into secrets (id, org_id, owner_id, name, key, audience)
    values (
      ${ids.secretId}::uuid,
      ${ids.orgId}::uuid,
      ${ids.ownerId},
      'Preserved secret',
      'PURGE_TEST_SECRET',
      'personal'
    )
  `;
  await tx`
    insert into secret_versions (
      org_id, secret_id, version, ciphertext, iv, auth_tag,
      wrapped_dek, wrap_iv, wrap_auth_tag, key_id, created_by
    ) values (
      ${ids.orgId}::uuid, ${ids.secretId}::uuid, 1, 'secret-ciphertext', 'secret-iv',
      'secret-auth-tag', 'secret-wrapped-dek', 'secret-wrap-iv', 'secret-wrap-auth-tag',
      'secret-key', ${ids.ownerId}
    )
  `;
  await tx`
    insert into billing_subscriptions (org_id, stripe_customer_id, stripe_status)
    values (${ids.orgId}::uuid, ${`cus_${ids.orgId.replaceAll("-", "")}`}, 'active')
  `;
  await tx`
    insert into audit_log (id, org_id, actor_id, action, target_type, target_id, metadata)
    values (
      ${ids.auditId}::uuid,
      ${ids.orgId}::uuid,
      ${ids.ownerId},
      'companion.legacy_created',
      'companion',
      ${ids.companionId},
      ${JSON.stringify({ preserved: true })}::jsonb
    )
  `;

  await tx`
    insert into api_tokens (
      org_id, user_id, name, token_prefix, token_hash, scopes,
      source_type, source_agent_id, target_workspace_id, expires_at
    ) values
      (
        ${ids.orgId}::uuid, ${ids.ownerId}, 'Companion token', 'cmp_cmp_01',
        ${ids.tokenHashes.companion}, '["skills:write"]'::jsonb, 'companion',
        ${ids.companionId}, ${ids.orgId}, clock_timestamp() + interval '1 day'
      ),
      (
        ${ids.orgId}::uuid, ${ids.ownerId}, 'Orphaned revoked Companion token', 'cmp_cmp_02',
        ${ids.tokenHashes.orphanCompanion}, '["skills:write"]'::jsonb, 'companion',
        ${ids.orphanCompanionId}, ${ids.orgId}, clock_timestamp() - interval '1 day'
      ),
      (
        ${ids.orgId}::uuid, ${ids.ownerId}, 'Human token', 'cmp_hum_01',
        ${ids.tokenHashes.human}, '["skills:read"]'::jsonb, 'human',
        null, null, clock_timestamp() + interval '1 day'
      ),
      (
        ${ids.orgId}::uuid, ${ids.ownerId}, 'Agent Auth token', 'cmp_agt_01',
        ${ids.tokenHashes.agentAuth}, '["skills:read"]'::jsonb, 'agent_auth',
        ${`agent-${ids.orgId}`}, ${ids.orgId}, clock_timestamp() + interval '1 day'
      )
  `;
  await tx`
    update api_tokens
    set revoked_at = clock_timestamp()
    where token_hash = ${ids.tokenHashes.orphanCompanion}
  `;
}

async function insertRun(tx: postgres.TransactionSql, ids: FixtureIds): Promise<void> {
  await tx`
    insert into companion_legacy_purge_runs (id, inventory_hash, inventory)
    values (
      'legacy-companion-purge',
      ${"a".repeat(64)},
      ${JSON.stringify({ boxIds: [ids.companionBoxId, ids.poolBoxId] })}::jsonb
    )
  `;
}

async function insertTarget(
  tx: postgres.TransactionSql,
  input: {
    boxId: string;
    observedName: string;
    evidence: string;
    state: "pending" | "completed" | "absent";
    operationId?: string;
  },
): Promise<void> {
  await tx`
    insert into companion_legacy_purge_targets (
      box_id, observed_name, evidence, state, operation_id, requested_at, completed_at
    ) values (
      ${input.boxId},
      ${input.observedName},
      ${JSON.stringify([input.evidence])}::jsonb,
      ${input.state},
      ${input.operationId ?? null},
      clock_timestamp(),
      ${input.state === "completed" || input.state === "absent" ? new Date().toISOString() : null}::timestamptz
    )
  `;
}

async function legacyCounts(
  tx: postgres.TransactionSql,
  ids: FixtureIds,
): Promise<LegacyCounts> {
  const [row] = await tx<[LegacyCounts]>`
    select
      (select count(*)::int from companions where id = ${ids.companionId}::uuid) as companions,
      (select count(*)::int from companion_runtime_pools where id = ${ids.poolId}::uuid) as "runtimePools",
      (select count(*)::int from companion_workspace_access where companion_id = ${ids.companionId}::uuid) as "workspaceAccess",
      (select count(*)::int from companion_member_state where companion_id = ${ids.companionId}::uuid) as "memberState",
      (select count(*)::int from companion_threads where companion_id = ${ids.companionId}::uuid) as threads,
      (select count(*)::int from companion_transcript_entries where companion_id = ${ids.companionId}::uuid) as "transcriptEntries",
      (select count(*)::int from companion_reconcile_leases where companion_id = ${ids.companionId}::uuid) as "reconcileLeases",
      (
        select count(*)::int from api_tokens
        where token_hash in (${ids.tokenHashes.companion}, ${ids.tokenHashes.orphanCompanion})
      ) as "companionTokens"
  `;
  return row!;
}

async function preservationSnapshot(
  tx: postgres.TransactionSql,
  ids: FixtureIds,
): Promise<Record<string, unknown>> {
  const [row] = await tx<Array<{ snapshot: Record<string, unknown> }>>`
    select jsonb_build_object(
      'users', coalesce((
        select jsonb_agg(to_jsonb(u) order by u.id) from "user" u where u.id = ${ids.ownerId}
      ), '[]'::jsonb),
      'profiles', coalesce((
        select jsonb_agg(to_jsonb(p) order by p.id) from profiles p where p.id = ${ids.ownerId}
      ), '[]'::jsonb),
      'organizations', coalesce((
        select jsonb_agg(to_jsonb(o) order by o.id) from organizations o where o.id = ${ids.orgId}::uuid
      ), '[]'::jsonb),
      'memberships', coalesce((
        select jsonb_agg(to_jsonb(m) order by m.user_id)
        from memberships m where m.org_id = ${ids.orgId}::uuid and m.user_id = ${ids.ownerId}
      ), '[]'::jsonb),
      'provider_connections', coalesce((
        select jsonb_agg(to_jsonb(pc) order by pc.provider_id)
        from companion_provider_connections pc where pc.org_id = ${ids.orgId}::uuid
      ), '[]'::jsonb),
      'mcp_accounts', coalesce((
        select jsonb_agg(to_jsonb(ma) order by ma.id)
        from companion_mcp_accounts ma where ma.id = ${ids.mcpAccountId}::uuid
      ), '[]'::jsonb),
      'skills', coalesce((
        select jsonb_agg(to_jsonb(s) order by s.id) from skills s where s.id = ${ids.skillId}::uuid
      ), '[]'::jsonb),
      'skill_versions', coalesce((
        select jsonb_agg(to_jsonb(sv) order by sv.id)
        from skill_versions sv where sv.id = ${ids.skillVersionId}::uuid
      ), '[]'::jsonb),
      'secrets', coalesce((
        select jsonb_agg(to_jsonb(s) order by s.id) from secrets s where s.id = ${ids.secretId}::uuid
      ), '[]'::jsonb),
      'secret_versions', coalesce((
        select jsonb_agg(to_jsonb(sv) order by sv.version)
        from secret_versions sv where sv.secret_id = ${ids.secretId}::uuid
      ), '[]'::jsonb),
      'billing', coalesce((
        select jsonb_agg(to_jsonb(b) order by b.org_id)
        from billing_subscriptions b where b.org_id = ${ids.orgId}::uuid
      ), '[]'::jsonb),
      'audit', coalesce((
        select jsonb_agg(to_jsonb(a) order by a.id) from audit_log a where a.id = ${ids.auditId}::uuid
      ), '[]'::jsonb),
      'non_companion_tokens', coalesce((
        select jsonb_agg(to_jsonb(t) order by t.source_type)
        from api_tokens t
        where t.token_hash in (${ids.tokenHashes.human}, ${ids.tokenHashes.agentAuth})
      ), '[]'::jsonb)
    ) as snapshot
  `;
  return row!.snapshot;
}

async function callFinalizer(tx: postgres.TransactionSql): Promise<FinalizeResult> {
  const [row] = await tx<Array<{ result: FinalizeResult }>>`
    select public.companion_finalize_legacy_purge() as result
  `;
  return row!.result;
}

async function callFinalizerAs(
  tx: postgres.TransactionSql,
  role: string,
): Promise<FinalizeResult> {
  await tx.unsafe(`set local role ${role}`);
  try {
    return await callFinalizer(tx);
  } finally {
    await tx.unsafe("reset role");
  }
}

describe("0089 legacy Companion database purge", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const migrationRole = `companion_purge_owner_${suffix}`;
  const apiRole = `companion_purge_api_${suffix}`;
  const workerRole = `companion_purge_worker_${suffix}`;
  const publicRole = `companion_purge_public_${suffix}`;
  let originalFunctionOwner = "";
  const originalTableOwners = new Map<string, string>();
  let rolesCreated = false;

  beforeAll(async () => {
    const [functionRow] = await integrationSql<Array<{ owner: string }>>`
      select pg_get_userbyid(p.proowner) as owner
      from pg_proc p
      where p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
    `;
    if (!functionRow) throw new Error("migration 0089 finalizer is not installed");
    originalFunctionOwner = functionRow.owner;

    const tableRows = await integrationSql<Array<{ tableName: string; owner: string }>>`
      select c.relname as "tableName", pg_get_userbyid(c.relowner) as owner
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'companion_legacy_purge_runs',
          'companion_legacy_purge_targets',
          'companion_transcript_entries',
          'companion_threads',
          'companion_workspace_access',
          'companion_member_state',
          'companion_reconcile_leases',
          'companions',
          'companion_runtime_pools',
          'api_tokens'
        )
    `;
    for (const row of tableRows) originalTableOwners.set(row.tableName, row.owner);
    expect(originalTableOwners.size).toBe(FINALIZER_TABLES.length);

    await integrationSql.unsafe(`
      create role ${migrationRole} login nosuperuser nobypassrls noinherit;
      create role ${apiRole} login nosuperuser nobypassrls noinherit;
      create role ${workerRole} login nosuperuser nobypassrls noinherit;
      create role ${publicRole} login nosuperuser nobypassrls noinherit;
    `);
    rolesCreated = true;
    await integrationSql`
      grant usage, create on schema public to ${integrationSql(migrationRole)}
    `;
    await integrationSql`
      grant usage on schema public to ${integrationSql(publicRole)}
    `;
    // The real migration owner owns every migrated relation. Our deliberately synthetic owner only
    // takes ownership of the finalizer's write set, so grant the read dependency used by the
    // pre-existing product RLS policies that PostgreSQL may evaluate alongside the purge policy.
    await integrationSql`
      grant select on table public.memberships to ${integrationSql(migrationRole)}
    `;
    await integrationSql`
      grant execute on function public.companion_delivery_read_fence(uuid, uuid, text)
      to ${integrationSql(migrationRole)}
    `;

    for (const table of FINALIZER_TABLES) {
      await integrationSql`
        alter table ${integrationSql(table)} owner to ${integrationSql(migrationRole)}
      `;
    }
    await integrationSql`
      alter function public.companion_finalize_legacy_purge()
      owner to ${integrationSql(migrationRole)}
    `;

    const grants = extractRuntimeRoleGrantBlock(
      await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"),
    );
    await integrationSql.begin(async (tx) => {
      await tx`select set_config('companion.api_role', ${apiRole}, true)`;
      await tx`select set_config('companion.worker_role', ${workerRole}, true)`;
      await tx.unsafe(grants);
    });
  });

  afterAll(async () => {
    if (!rolesCreated) return;
    await integrationSql`
      alter function public.companion_finalize_legacy_purge()
      owner to ${integrationSql(originalFunctionOwner)}
    `;
    for (const table of FINALIZER_TABLES) {
      const owner = originalTableOwners.get(table);
      if (!owner) continue;
      await integrationSql`
        alter table ${integrationSql(table)} owner to ${integrationSql(owner)}
      `;
    }
    for (const role of [apiRole, workerRole, publicRole, migrationRole]) {
      await integrationSql`drop owned by ${integrationSql(role)}`;
      await integrationSql`drop role ${integrationSql(role)}`;
    }
  });

  it("keeps the finalizer and ledger behind a forced-RLS maintenance boundary", async () => {
    const rlsRows = await integrationSql<Array<{
      tableName: string;
      rowSecurity: boolean;
      forceRowSecurity: boolean;
    }>>`
      select
        c.relname as "tableName",
        c.relrowsecurity as "rowSecurity",
        c.relforcerowsecurity as "forceRowSecurity"
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relname in (
          'companion_legacy_purge_runs',
          'companion_legacy_purge_targets',
          'companions',
          'companion_runtime_pools',
          'companion_workspace_access',
          'companion_member_state',
          'companion_threads',
          'companion_transcript_entries',
          'companion_reconcile_leases',
          'companion_provider_connections',
          'companion_mcp_accounts',
          'api_tokens'
        )
    `;
    const rls = new Map(rlsRows.map((row) => [row.tableName, row]));
    for (const table of FORCED_RLS_TABLES) {
      expect(rls.get(table)).toMatchObject({ rowSecurity: true, forceRowSecurity: true });
    }
    expect(rls.get("api_tokens")).toMatchObject({
      rowSecurity: true,
      forceRowSecurity: false,
    });

    const [functionSecurity] = await integrationSql<Array<{
      owner: string;
      securityDefiner: boolean;
      config: string[] | null;
      migrationCanExecute: boolean;
      apiCanExecute: boolean;
      workerCanExecute: boolean;
      publicCanExecute: boolean;
      apiCanSelectLedger: boolean;
      workerCanSelectLedger: boolean;
      publicCanSelectLedger: boolean;
    }>>`
      select
        pg_get_userbyid(p.proowner) as owner,
        p.prosecdef as "securityDefiner",
        p.proconfig as config,
        has_function_privilege(
          ${migrationRole}, 'public.companion_finalize_legacy_purge()', 'EXECUTE'
        ) as "migrationCanExecute",
        has_function_privilege(
          ${apiRole}, 'public.companion_finalize_legacy_purge()', 'EXECUTE'
        ) as "apiCanExecute",
        has_function_privilege(
          ${workerRole}, 'public.companion_finalize_legacy_purge()', 'EXECUTE'
        ) as "workerCanExecute",
        has_function_privilege(
          ${publicRole}, 'public.companion_finalize_legacy_purge()', 'EXECUTE'
        ) as "publicCanExecute",
        has_table_privilege(
          ${apiRole}, 'public.companion_legacy_purge_runs', 'SELECT'
        ) as "apiCanSelectLedger",
        has_table_privilege(
          ${workerRole}, 'public.companion_legacy_purge_runs', 'SELECT'
        ) as "workerCanSelectLedger",
        has_table_privilege(
          ${publicRole}, 'public.companion_legacy_purge_runs', 'SELECT'
        ) as "publicCanSelectLedger"
      from pg_proc p
      where p.oid = 'public.companion_finalize_legacy_purge()'::regprocedure
    `;
    expect(functionSecurity).toMatchObject({
      owner: migrationRole,
      securityDefiner: true,
      migrationCanExecute: true,
      apiCanExecute: false,
      workerCanExecute: false,
      publicCanExecute: false,
      apiCanSelectLedger: true,
      workerCanSelectLedger: true,
      publicCanSelectLedger: false,
    });
    expect(functionSecurity!.config).toContain("search_path=pg_catalog, public");

    const roleRows = await integrationSql<Array<{
      role: string;
      login: boolean;
      superuser: boolean;
      bypassRls: boolean;
      inherit: boolean;
    }>>`
      select
        rolname as role,
        rolcanlogin as login,
        rolsuper as superuser,
        rolbypassrls as "bypassRls",
        rolinherit as inherit
      from pg_roles
      where rolname in (${migrationRole}, ${apiRole}, ${workerRole}, ${publicRole})
    `;
    expect(roleRows).toHaveLength(4);
    for (const role of roleRows) {
      expect(role).toMatchObject({
        login: true,
        superuser: false,
        bypassRls: false,
        inherit: false,
      });
    }

    await withRolledBackTransaction(async (tx) => {
      await clearLegacyState(tx);
      const ids = fixtureIds("bx_23456789", "bx_abcdefgh");
      await insertRun(tx, ids);
      await insertTarget(tx, {
        boxId: ids.companionBoxId,
        observedName: `Companion ${ids.companionId}`,
        evidence: "companions.box_id",
        state: "absent",
      });

      for (const role of [apiRole, workerRole]) {
        await tx.unsafe(`set local role ${role}`);
        const hidden = await tx`select id from companion_legacy_purge_runs`;
        expect(hidden).toEqual([]);
        await tx.unsafe("reset role");

        await expect(tx.savepoint(async (savepoint) => {
          await savepoint.unsafe(`set local role ${role}`);
          await callFinalizer(savepoint);
        })).rejects.toThrow(/permission denied/i);
      }

      await tx.unsafe(`set local role ${migrationRole}`);
      const ownerVisible = await tx`select id from companion_legacy_purge_runs`;
      expect(ownerVisible).toEqual([{ id: "legacy-companion-purge" }]);
      await tx.unsafe("reset role");

      await expect(tx.savepoint(async (savepoint) => {
        await savepoint.unsafe(`set local role ${publicRole}`);
        await savepoint`select id from companion_legacy_purge_runs`;
      })).rejects.toThrow(/permission denied/i);
      await expect(tx.savepoint(async (savepoint) => {
        await savepoint.unsafe(`set local role ${publicRole}`);
        await callFinalizer(savepoint);
      })).rejects.toThrow(/permission denied/i);
    });
  });

  it("refuses a non-terminal provider target without deleting ownership", async () => {
    await withRolledBackTransaction(async (tx) => {
      await clearLegacyState(tx);
      const ids = fixtureIds("bx_23456789", "bx_abcdefgh");
      await seedFixture(tx, ids);
      await insertRun(tx, ids);
      await insertTarget(tx, {
        boxId: ids.companionBoxId,
        observedName: `Companion ${ids.companionId}`,
        evidence: "companions.box_id",
        state: "pending",
        operationId: `bdop_${"1".repeat(32)}`,
      });
      await insertTarget(tx, {
        boxId: ids.poolBoxId,
        observedName: `Companion org ${ids.orgId}`,
        evidence: "companion_runtime_pools.box_id",
        state: "completed",
        operationId: `bdop_${"2".repeat(32)}`,
      });

      await expect(tx.savepoint(async (savepoint) => {
        await savepoint.unsafe(`set local role ${migrationRole}`);
        await callFinalizer(savepoint);
      })).rejects.toThrow("legacy Companion provider deletions are not all confirmed");

      expect(await legacyCounts(tx, ids)).toEqual({
        companions: 1,
        runtimePools: 1,
        workspaceAccess: 1,
        memberState: 1,
        threads: 1,
        transcriptEntries: 1,
        reconcileLeases: 1,
        companionTokens: 2,
      });
      const [run] = await tx`select phase, completed_at from companion_legacy_purge_runs`;
      expect(run).toEqual({ phase: "deleting_external", completed_at: null });
    });
  });

  it("refuses a database Box id absent from the terminal ledger", async () => {
    await withRolledBackTransaction(async (tx) => {
      await clearLegacyState(tx);
      const ids = fixtureIds("bx_23456789", "bx_abcdefgh");
      await seedFixture(tx, ids);
      await insertRun(tx, ids);
      await insertTarget(tx, {
        boxId: ids.companionBoxId,
        observedName: `Companion ${ids.companionId}`,
        evidence: "companions.box_id",
        state: "completed",
        operationId: `bdop_${"3".repeat(32)}`,
      });

      await expect(tx.savepoint(async (savepoint) => {
        await savepoint.unsafe(`set local role ${migrationRole}`);
        await callFinalizer(savepoint);
      })).rejects.toThrow("a legacy Companion database Box id lacks confirmed provider deletion");

      expect(await legacyCounts(tx, ids)).toEqual({
        companions: 1,
        runtimePools: 1,
        workspaceAccess: 1,
        memberState: 1,
        threads: 1,
        transcriptEntries: 1,
        reconcileLeases: 1,
        companionTokens: 2,
      });
      const [run] = await tx`select phase, completed_at from companion_legacy_purge_runs`;
      expect(run).toEqual({ phase: "deleting_external", completed_at: null });
    });
  });

  it("drains every legacy family and Companion token while preserving the Skills Hub", async () => {
    await withRolledBackTransaction(async (tx) => {
      await clearLegacyState(tx);
      const ids = fixtureIds("bx_23456789", "bx_abcdefgh");
      await seedFixture(tx, ids);
      await insertRun(tx, ids);
      await insertTarget(tx, {
        boxId: ids.companionBoxId,
        observedName: `Companion ${ids.companionId}`,
        evidence: "companions.box_id",
        state: "completed",
        operationId: `bdop_${"4".repeat(32)}`,
      });
      await insertTarget(tx, {
        boxId: ids.poolBoxId,
        observedName: `Companion org ${ids.orgId}`,
        evidence: "companion_runtime_pools.box_id",
        state: "absent",
      });
      const preservedBefore = await preservationSnapshot(tx, ids);

      expect(await callFinalizerAs(tx, migrationRole)).toEqual({
        already_complete: false,
        companions: 1,
        runtime_pools: 1,
        workspace_access: 1,
        member_state: 1,
        threads: 1,
        transcript_entries: 1,
        reconcile_leases: 1,
        companion_tokens: 2,
      });
      expect(await legacyCounts(tx, ids)).toEqual({
        companions: 0,
        runtimePools: 0,
        workspaceAccess: 0,
        memberState: 0,
        threads: 0,
        transcriptEntries: 0,
        reconcileLeases: 0,
        companionTokens: 0,
      });
      expect(await preservationSnapshot(tx, ids)).toEqual(preservedBefore);

      const [ledger] = await tx<Array<{
        phase: string;
        completed: boolean;
        targets: number;
      }>>`
        select
          r.phase,
          r.completed_at is not null as completed,
          (select count(*)::int from companion_legacy_purge_targets) as targets
        from companion_legacy_purge_runs r
        where r.id = 'legacy-companion-purge'
      `;
      expect(ledger).toEqual({ phase: "database_complete", completed: true, targets: 2 });

      expect(await callFinalizerAs(tx, migrationRole)).toEqual({
        already_complete: true,
        companions: 0,
        runtime_pools: 0,
        workspace_access: 0,
        member_state: 0,
        threads: 0,
        transcript_entries: 0,
        reconcile_leases: 0,
        companion_tokens: 0,
      });
      expect(await preservationSnapshot(tx, ids)).toEqual(preservedBefore);
    });
  });
});
