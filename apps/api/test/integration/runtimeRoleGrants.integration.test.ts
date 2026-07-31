import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("runtime-role grant integration tests require an explicit disposable DATABASE_URL");
}

/**
 * Product promise:
 * The API can serve creator-scoped requests without holding Project worker lease capabilities, while
 * the worker can discover and fence Project jobs through a separate NOBYPASSRLS login.
 *
 * Regression caught:
 * Applying one unioned grant set to both production logins would let an API compromise claim a
 * Project workspace, enter its exact lease, or forge worker heartbeats, while a worker compromise
 * could read or mutate Better Auth identities and sessions. It also proves that creator request
 * GUCs alone are not process identity: a split worker cannot spoof them to enter Project RLS.
 *
 * Why this test is integrated:
 * PostgreSQL's effective function and table privileges include role attributes, PUBLIC grants,
 * defaults and exact signatures. Only a migrated database and real login roles prove separation.
 *
 * Failure proof:
 * Granting companion_claim_project_workspaces to the API role or removing the creator/pre-tenant
 * functions from that role makes this suite fail.
 */
describe("separated API and worker database grants", () => {
  const sql = postgres(databaseUrl, { max: 1 });
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const apiRole = `companion_api_${suffix}`;
  const workerRole = `companion_worker_${suffix}`;
  const retiredRole = `companion_retired_${suffix}`;
  const simpleRole = `companion_simple_${suffix}`;
  const orgId = randomUUID();
  const projectId = randomUUID();
  const privateProjectId = randomUUID();
  const privateUsageId = randomUUID();
  const databaseMaintenanceSkillId = randomUUID();
  const databaseMaintenanceRealmId = randomUUID();
  const databaseMaintenanceGranteeId = `runtime-grants-grantee-${suffix}`;
  const userId = `runtime-grants-user-${suffix}`;
  let grantBlock = "";

  async function applyGrantBlock(input:
    | { runtimeRole: string }
    | {
        apiRole: string;
        workerRole: string;
        retiredRuntimeRole?: string;
      }): Promise<void> {
    await sql.begin(async (tx) => {
      if ("runtimeRole" in input) {
        await tx`select set_config('companion.runtime_role', ${input.runtimeRole}, true)`;
      } else {
        await tx`select set_config('companion.api_role', ${input.apiRole}, true)`;
        await tx`select set_config('companion.worker_role', ${input.workerRole}, true)`;
        if (input.retiredRuntimeRole) {
          await tx`select set_config(
            'companion.retired_runtime_role',
            ${input.retiredRuntimeRole},
            true
          )`;
        }
      }
      await tx.unsafe(grantBlock);
    });
  }

  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, email_verified)
      values (${userId}, 'Runtime grants user', ${`${userId}@example.test`}, true)
    `;
    await sql`
      insert into organizations (id, name, slug, kind)
      values (${orgId}::uuid, 'Runtime grants org', ${`runtime-grants-${suffix}`}, 'team')
    `;
    await sql`
      insert into memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${userId}, 'owner')
    `;
    await sql.unsafe(`create role ${apiRole} login nosuperuser nobypassrls noinherit`);
    await sql.unsafe(`create role ${workerRole} login nosuperuser nobypassrls noinherit`);
    await sql.unsafe(`create role ${retiredRole} login nosuperuser nobypassrls noinherit`);
    await sql.unsafe(`create role ${simpleRole} login nosuperuser nobypassrls noinherit`);

    const grantsFile = await resolveRuntimeRoleGrantsFile();
    grantBlock = extractRuntimeRoleGrantBlock(await readFile(grantsFile, "utf8"));

    // Model a real upgrade: both the eventual API role and the retired login first held the
    // historical union grant set. The split must remove stale worker authority from the reused API
    // name and fully retire the distinct old login without changing simple-install behavior.
    await applyGrantBlock({ runtimeRole: apiRole });
    await applyGrantBlock({ runtimeRole: retiredRole });
    await applyGrantBlock({ runtimeRole: simpleRole });
    await applyGrantBlock({ apiRole, workerRole, retiredRuntimeRole: retiredRole });
    // An overlap is valid during an in-place rename: broad retirement must not strip the active API
    // role's common/default grants, while the wrong-side worker functions still stay revoked.
    await applyGrantBlock({ apiRole, workerRole, retiredRuntimeRole: apiRole });

    await sql.unsafe(`grant ${apiRole} to current_user with inherit true, set true`);
    await sql.unsafe(`grant ${workerRole} to current_user with inherit true, set true`);
  });

  afterAll(async () => {
    await sql`delete from organizations where id = ${orgId}::uuid`;
    await sql`delete from "user" where id = ${userId}`;
    await sql`delete from "user" where id = ${databaseMaintenanceGranteeId}`;
    await sql.unsafe(`drop owned by ${apiRole}`);
    await sql.unsafe(`drop owned by ${workerRole}`);
    await sql.unsafe(`drop owned by ${retiredRole}`);
    await sql.unsafe(`drop owned by ${simpleRole}`);
    await sql.unsafe(`revoke ${apiRole} from current_user`);
    await sql.unsafe(`revoke ${workerRole} from current_user`);
    await sql.unsafe(`drop role ${apiRole}`);
    await sql.unsafe(`drop role ${workerRole}`);
    await sql.unsafe(`drop role ${retiredRole}`);
    await sql.unsafe(`drop role ${simpleRole}`);
    await sql.end();
  });

  it("keeps both logins non-privileged and limits direct tables to their intended surfaces", async () => {
    const attributes = await sql<{
      name: string;
      canLogin: boolean;
      superuser: boolean;
      bypassRls: boolean;
      inherit: boolean;
      projectsTable: boolean;
      authUserTable: boolean;
      profilesTable: boolean;
      agentsTable: boolean;
      skillDatabaseTable: boolean;
      skillDatabaseShareTable: boolean;
      projectHeartbeatTable: boolean;
      runHeartbeatTable: boolean;
      tableDefaults: boolean;
      sequenceDefaults: boolean;
    }[]>`
      select
        rolname as name,
        rolcanlogin as "canLogin",
        rolsuper as superuser,
        rolbypassrls as "bypassRls",
        rolinherit as inherit,
        has_table_privilege(
          rolname,
          'public.projects',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "projectsTable",
        has_table_privilege(
          rolname,
          'public."user"',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "authUserTable",
        has_table_privilege(
          rolname,
          'public.profiles',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "profilesTable",
        has_table_privilege(
          rolname,
          'public.agent',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "agentsTable",
        has_table_privilege(
          rolname,
          'public.skill_database_realms',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "skillDatabaseTable",
        has_table_privilege(
          rolname,
          'public.skill_database_realm_shares',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "skillDatabaseShareTable",
        has_table_privilege(
          rolname,
          'public.project_worker_heartbeats',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "projectHeartbeatTable",
        has_table_privilege(
          rolname,
          'public.skill_run_worker_heartbeats',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "runHeartbeatTable",
        exists (
          select 1
          from pg_default_acl defaults
          cross join lateral aclexplode(defaults.defaclacl) privilege
          where defaults.defaclnamespace = 'public'::regnamespace
            and defaults.defaclobjtype = 'r'
            and privilege.grantee = pg_roles.oid
        ) as "tableDefaults",
        exists (
          select 1
          from pg_default_acl defaults
          cross join lateral aclexplode(defaults.defaclacl) privilege
          where defaults.defaclnamespace = 'public'::regnamespace
            and defaults.defaclobjtype = 'S'
            and privilege.grantee = pg_roles.oid
        ) as "sequenceDefaults"
      from pg_roles
      where rolname in (${apiRole}, ${workerRole})
      order by rolname
    `;

    expect(attributes).toEqual([
      {
        name: apiRole,
        canLogin: true,
        superuser: false,
        bypassRls: false,
        inherit: false,
        projectsTable: true,
        authUserTable: true,
        profilesTable: true,
        agentsTable: true,
        skillDatabaseTable: true,
        skillDatabaseShareTable: true,
        projectHeartbeatTable: false,
        runHeartbeatTable: false,
        tableDefaults: false,
        sequenceDefaults: false,
      },
      {
        name: workerRole,
        canLogin: true,
        superuser: false,
        bypassRls: false,
        inherit: false,
        projectsTable: true,
        authUserTable: false,
        profilesTable: false,
        agentsTable: false,
        skillDatabaseTable: true,
        skillDatabaseShareTable: true,
        projectHeartbeatTable: false,
        runHeartbeatTable: false,
        tableDefaults: false,
        sequenceDefaults: false,
      },
    ]);
  });

  it("grants every unprotected API table to the API role only", async () => {
    const apiTables = [
      "public.account",
      "public.agent",
      "public.agent_auth_ephemeral",
      "public.agent_capability_grant",
      "public.agent_host",
      "public.approval_request",
      "public.profiles",
      'public."session"',
      'public."user"',
      "public.verification",
    ];

    for (const table of apiTables) {
      const [privileges] = await sql<{ api: boolean; worker: boolean }[]>`
        select
          has_table_privilege(
            ${apiRole},
            ${table},
            'SELECT,INSERT,UPDATE,DELETE'
          ) as api,
          has_table_privilege(
            ${workerRole},
            ${table},
            'SELECT,INSERT,UPDATE,DELETE'
          ) as worker
      `;
      expect(privileges, table).toEqual({ api: true, worker: false });
    }

    for (const table of [
      "public.project_worker_heartbeats",
      "public.skill_run_worker_heartbeats",
    ]) {
      const [privileges] = await sql<{ api: boolean; worker: boolean }[]>`
        select
          has_table_privilege(
            ${apiRole},
            ${table},
            'SELECT,INSERT,UPDATE,DELETE'
          ) as api,
          has_table_privilege(
            ${workerRole},
            ${table},
            'SELECT,INSERT,UPDATE,DELETE'
          ) as worker
      `;
      expect(privileges, table).toEqual({ api: false, worker: false });
    }
  });

  it("prevents heartbeat spoofing by the API and Better Auth access by the worker", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${apiRole}`);
        await tx`
          insert into project_worker_heartbeats (
            worker_id,
            protocol_version,
            expires_at
          )
          values ('spoofed-api-worker', 1, clock_timestamp() + interval '1 minute')
        `;
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${workerRole}`);
        await tx`select id, email from "user" limit 1`;
      }),
    ).rejects.toThrow(/permission denied/i);

    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${workerRole}`);
        await tx`select id, user_id from "session" limit 1`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("grants Project claim and lease mutation functions only to the worker", async () => {
    const functions = [
      "public.companion_claim_skill_database_object_deletions(integer,integer)",
      "public.companion_complete_skill_database_object_deletion(text,uuid)",
      "public.companion_defer_skill_database_object_deletion(text,uuid)",
      "public.companion_claim_project_workspaces(text,integer,integer)",
      "public.companion_enter_project_worker_lease(uuid,uuid,text,text,integer)",
      "public.companion_heartbeat_project_worker(text,integer,integer)",
      "public.companion_remove_project_worker(text)",
    ];

    for (const signature of functions) {
      const [privileges] = await sql<{ api: boolean; worker: boolean }[]>`
        select
          has_function_privilege(${apiRole}, ${signature}, 'EXECUTE') as api,
          has_function_privilege(${workerRole}, ${signature}, 'EXECUTE') as worker
      `;
      expect(privileges, signature).toEqual({ api: false, worker: true });
    }

    await expect(
      sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${apiRole}`);
        await tx`select * from companion_claim_project_workspaces('api-must-not-claim', 1, 30)`;
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it("removes current and default privileges from a retired union role", async () => {
    const [privileges] = await sql<{
      projectTable: boolean;
      workerClaim: boolean;
      apiDiscovery: boolean;
      hasTableDefaults: boolean;
      hasSequenceDefaults: boolean;
    }[]>`
      select
        has_table_privilege(
          ${retiredRole},
          'public.projects',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "projectTable",
        has_function_privilege(
          ${retiredRole},
          'public.companion_claim_project_workspaces(text,integer,integer)',
          'EXECUTE'
        ) as "workerClaim",
        has_function_privilege(
          ${retiredRole},
          'public.companion_list_user_orgs(text)',
          'EXECUTE'
        ) as "apiDiscovery",
        exists (
          select 1
          from pg_default_acl defaults
          cross join lateral aclexplode(defaults.defaclacl) privilege
          join pg_roles grantee on grantee.oid = privilege.grantee
          where defaults.defaclnamespace = 'public'::regnamespace
            and defaults.defaclobjtype = 'r'
            and grantee.rolname = ${retiredRole}
        ) as "hasTableDefaults",
        exists (
          select 1
          from pg_default_acl defaults
          cross join lateral aclexplode(defaults.defaclacl) privilege
          join pg_roles grantee on grantee.oid = privilege.grantee
          where defaults.defaclnamespace = 'public'::regnamespace
            and defaults.defaclobjtype = 'S'
            and grantee.rolname = ${retiredRole}
        ) as "hasSequenceDefaults"
    `;
    expect(privileges).toEqual({
      projectTable: false,
      workerClaim: false,
      apiDiscovery: false,
      hasTableDefaults: false,
      hasSequenceDefaults: false,
    });
  });

  it("makes new tables fail closed until the post-migration grant hook classifies them", async () => {
    const futureTable = `runtime_future_${suffix}`;
    await sql.unsafe(`create table ${futureTable} (id uuid primary key)`);
    try {
      const [beforeClassification] = await sql<{
        api: boolean;
        worker: boolean;
        simple: boolean;
      }[]>`
        select
          has_table_privilege(
            ${apiRole},
            ${`public.${futureTable}`},
            'SELECT,INSERT,UPDATE,DELETE'
          ) as api,
          has_table_privilege(
            ${workerRole},
            ${`public.${futureTable}`},
            'SELECT,INSERT,UPDATE,DELETE'
          ) as worker,
          has_table_privilege(
            ${simpleRole},
            ${`public.${futureTable}`},
            'SELECT,INSERT,UPDATE,DELETE'
          ) as simple
      `;
      expect(beforeClassification).toEqual({
        api: false,
        worker: false,
        simple: true,
      });

      await sql.unsafe(`alter table ${futureTable} enable row level security`);
      await applyGrantBlock({ apiRole, workerRole });

      const [afterClassification] = await sql<{ api: boolean; worker: boolean }[]>`
        select
          has_table_privilege(
            ${apiRole},
            ${`public.${futureTable}`},
            'SELECT,INSERT,UPDATE,DELETE'
          ) as api,
          has_table_privilege(
            ${workerRole},
            ${`public.${futureTable}`},
            'SELECT,INSERT,UPDATE,DELETE'
          ) as worker
      `;
      expect(afterClassification).toEqual({ api: true, worker: true });
    } finally {
      await sql.unsafe(`drop table if exists ${futureTable}`);
    }
  });

  it("preserves the legacy union contract for simple installs", async () => {
    const [privileges] = await sql<{
      projectTable: boolean;
      authUserTable: boolean;
      projectHeartbeatTable: boolean;
      workerClaim: boolean;
      apiDiscovery: boolean;
    }[]>`
      select
        has_table_privilege(
          ${simpleRole},
          'public.projects',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "projectTable",
        has_table_privilege(
          ${simpleRole},
          'public."user"',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "authUserTable",
        has_table_privilege(
          ${simpleRole},
          'public.project_worker_heartbeats',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "projectHeartbeatTable",
        has_function_privilege(
          ${simpleRole},
          'public.companion_claim_project_workspaces(text,integer,integer)',
          'EXECUTE'
        ) as "workerClaim",
        has_function_privilege(
          ${simpleRole},
          'public.companion_list_user_orgs(text)',
          'EXECUTE'
        ) as "apiDiscovery"
    `;
    expect(privileges).toEqual({
      projectTable: true,
      authUserTable: true,
      projectHeartbeatTable: true,
      workerClaim: true,
      apiDiscovery: true,
    });
  });

  it("rejects API and worker roles with cross-role membership", async () => {
    const crossApiRole = `companion_cross_api_${suffix}`;
    const crossWorkerRole = `companion_cross_worker_${suffix}`;
    await sql.unsafe(`create role ${crossApiRole} login nosuperuser nobypassrls noinherit`);
    await sql.unsafe(`create role ${crossWorkerRole} login nosuperuser nobypassrls noinherit`);
    try {
      await sql.unsafe(`grant ${crossWorkerRole} to ${crossApiRole}`);
      await expect(
        applyGrantBlock({ apiRole: crossApiRole, workerRole: crossWorkerRole }),
      ).rejects.toThrow(/must not have cross-role membership/i);
    } finally {
      await sql.unsafe(`revoke ${crossWorkerRole} from ${crossApiRole}`);
      // The grant hook rejects this topology before assigning either role an object privilege.
      // Avoid DROP OWNED, which itself requires superuser or target-role membership and would make
      // this production-like non-superuser migration-owner test depend on a broader test login.
      await sql.unsafe(`drop role ${crossApiRole}`);
      await sql.unsafe(`drop role ${crossWorkerRole}`);
    }
  });

  it("keeps API service functions away from the worker while sharing RLS predicates and readiness", async () => {
    const apiFunctions = [
      "public.companion_list_user_orgs(text)",
      "public.companion_revoke_inactive_skill_database_realm_shares(uuid,uuid)",
      "public.companion_project_skill_refresh_targets(uuid,uuid)",
      "public.companion_signal_project_secret_change(uuid,uuid,text,text,text,secret_audience,text[])",
    ];
    for (const signature of apiFunctions) {
      const [privileges] = await sql<{ api: boolean; worker: boolean }[]>`
        select
          has_function_privilege(${apiRole}, ${signature}, 'EXECUTE') as api,
          has_function_privilege(${workerRole}, ${signature}, 'EXECUTE') as worker
      `;
      expect(privileges, signature).toEqual({ api: true, worker: false });
    }

    const [readiness] = await sql<{ api: boolean; worker: boolean }[]>`
      select
        has_function_privilege(${apiRole}, 'public.companion_project_worker_ready()', 'EXECUTE') as api,
        has_function_privilege(${workerRole}, 'public.companion_project_worker_ready()', 'EXECUTE') as worker
    `;
    expect(readiness).toEqual({ api: true, worker: true });

    const [exactLeasePredicate] = await sql<{ api: boolean; worker: boolean }[]>`
      select
        has_function_privilege(
          ${apiRole},
          'public.companion_project_exact_lease_visible(uuid,uuid,text)',
          'EXECUTE'
        ) as api,
        has_function_privilege(
          ${workerRole},
          'public.companion_project_exact_lease_visible(uuid,uuid,text)',
          'EXECUTE'
        ) as worker
    `;
    expect(exactLeasePredicate).toEqual({ api: true, worker: true });
  });

  it("revokes inactive realm shares with a NOBYPASSRLS function owner", async () => {
    const [originalOwner] = await sql<{ owner: string }[]>`
      select pg_get_userbyid(proowner) as owner
      from pg_proc
      where oid = 'public.companion_revoke_inactive_skill_database_realm_shares(uuid,uuid)'::regprocedure
    `;
    expect(originalOwner?.owner).toBeTruthy();

    await sql`
      insert into "user" (id, name, email, email_verified)
      values (
        ${databaseMaintenanceGranteeId},
        'Runtime grants database grantee',
        ${`${databaseMaintenanceGranteeId}@example.test`},
        true
      )
    `;
    await sql`
      insert into memberships (org_id, user_id, org_role)
      values (${orgId}::uuid, ${databaseMaintenanceGranteeId}, 'developer')
    `;
    await sql`
      insert into skills (id, org_id, slug, description, creator_id, scope)
      values (
        ${databaseMaintenanceSkillId}::uuid,
        ${orgId}::uuid,
        ${`runtime-database-maintenance-${suffix}`},
        'Runtime database maintenance fixture',
        ${userId},
        'org'
      )
    `;
    await sql`
      insert into skill_database_schemas (org_id, skill_id, generation, declarations_checksum)
      values (${orgId}::uuid, ${databaseMaintenanceSkillId}::uuid, 1, ${`sha256:${"a".repeat(64)}`})
    `;
    await sql`
      insert into skill_database_tables (
        org_id, skill_id, table_name, audience, columns, primary_key, unique_constraints, retired_at
      ) values (
        ${orgId}::uuid,
        ${databaseMaintenanceSkillId}::uuid,
        'personal_state',
        'personal',
        ${sql.json({ id: { type: "text", nullable: false } })},
        ${sql.json(["id"])},
        ${sql.json([])},
        now()
      )
    `;
    await sql`
      insert into skill_database_realms (
        id, org_id, skill_id, audience, owner_id, storage_key, schema_generation
      ) values (
        ${databaseMaintenanceRealmId}::uuid,
        ${orgId}::uuid,
        ${databaseMaintenanceSkillId}::uuid,
        'personal',
        ${userId},
        ${`skill-databases/${orgId}/${databaseMaintenanceSkillId}/personal/${userId}.sqlite3`},
        1
      )
    `;
    await sql`
      insert into skill_database_realm_shares (org_id, realm_id, owner_id, grantee_id)
      values (
        ${orgId}::uuid,
        ${databaseMaintenanceRealmId}::uuid,
        ${userId},
        ${databaseMaintenanceGranteeId}
      )
    `;

    await sql`alter function public.companion_revoke_inactive_skill_database_realm_shares(uuid, uuid)
      owner to ${sql(apiRole)}`;
    try {
      const result = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${apiRole}`);
        await tx`select set_config('app.org_id', ${orgId}, true)`;
        await tx`select set_config('app.user_id', ${userId}, true)`;
        return tx<{ revoked: number }[]>`
          select companion_revoke_inactive_skill_database_realm_shares(
            ${orgId}::uuid,
            ${databaseMaintenanceSkillId}::uuid
          ) as revoked
        `;
      });
      expect(result).toEqual([{ revoked: 1 }]);
    } finally {
      await sql`alter function public.companion_revoke_inactive_skill_database_realm_shares(uuid, uuid)
        owner to ${sql(originalOwner!.owner)}`;
    }

    const [remaining] = await sql<{ count: number }[]>`
      select count(*)::int as count
      from skill_database_realm_shares
      where realm_id = ${databaseMaintenanceRealmId}::uuid
    `;
    expect(remaining?.count).toBe(0);
  });

  it("lets Project activation read the creator-scoped secret projection without API authority", async () => {
    const signature = "public.companion_secret_usage_count(uuid,uuid)";
    const [privileges] = await sql<{ api: boolean; worker: boolean }[]>`
      select
        has_function_privilege(${apiRole}, ${signature}, 'EXECUTE') as api,
        has_function_privilege(${workerRole}, ${signature}, 'EXECUTE') as worker
    `;
    expect(privileges).toEqual({ api: true, worker: true });

    const usageCount = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${workerRole}`);
      await tx`
        select
          set_config('app.org_id', ${orgId}, true),
          set_config('app.user_id', ${userId}, true)
      `;
      const [row] = await tx<{ count: string }[]>`
        select companion_secret_usage_count(
          ${orgId}::uuid,
          ${randomUUID()}::uuid
        ) as count
      `;
      return Number(row?.count);
    });
    expect(usageCount).toBe(0);

    const [apiOnly] = await sql<{ worker: boolean }[]>`
      select has_function_privilege(
        ${workerRole},
        'public.companion_list_user_orgs(text)',
        'EXECUTE'
      ) as worker
    `;
    expect(apiOnly).toEqual({ worker: false });
  });

  it("rejects spoofed creator GUCs outside an exact lease while preserving API, legacy, and leased access", async () => {
    const workerId = `project-rls-worker-${suffix}`;
    const sandboxName = `project-rls-sandbox-${suffix}`;

    try {
      const apiCreated = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${apiRole}`);
        await tx`
          select
            set_config('app.org_id', ${orgId}, true),
            set_config('app.user_id', ${userId}, true)
        `;
        await tx`
          insert into projects (
            id, org_id, creator_id, name, default_model, idempotency_key, payload_hash
          )
          values (
            ${privateProjectId}::uuid,
            ${orgId}::uuid,
            ${userId},
            'Process identity project',
            'openai/gpt-5',
            ${`process-identity-${suffix}`},
            ${"b".repeat(64)}
          )
        `;
        await tx`
          insert into project_workspaces (
            org_id,
            project_id,
            creator_id,
            status,
            sandbox_name,
            lease_owner,
            lease_expires_at,
            lease_generation
          )
          values (
            ${orgId}::uuid,
            ${privateProjectId}::uuid,
            ${userId},
            'queued',
            ${sandboxName},
            ${workerId},
            clock_timestamp() + interval '2 minutes',
            1
          )
        `;
        await tx`
          insert into sandbox_usage_sessions (
            id,
            org_id,
            creator_id,
            kind,
            source_id,
            sandbox_name,
            activation_revision,
            period_start,
            reserved_ms,
            reservation_expires_at
          )
          values (
            ${privateUsageId}::uuid,
            ${orgId}::uuid,
            ${userId},
            'project',
            ${privateProjectId}::uuid,
            ${sandboxName},
            1,
            date_trunc('month', clock_timestamp()),
            60000,
            clock_timestamp() + interval '2 minutes'
          )
        `;
        const [visible] = await tx<{ projects: number; usage: number }[]>`
          select
            (
              select count(*)::int
              from projects
              where org_id = ${orgId}::uuid and id = ${privateProjectId}::uuid
            ) as projects,
            (
              select count(*)::int
              from sandbox_usage_sessions
              where org_id = ${orgId}::uuid and id = ${privateUsageId}::uuid
            ) as usage
        `;
        return visible;
      });
      expect(apiCreated).toEqual({ projects: 1, usage: 1 });

      const spoofed = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${workerRole}`);
        await tx`
          select
            set_config('app.org_id', ${orgId}, true),
            set_config('app.user_id', ${userId}, true)
        `;
        const [before] = await tx<{ projects: number; usage: number }[]>`
          select
            (
              select count(*)::int
              from projects
              where org_id = ${orgId}::uuid and id = ${privateProjectId}::uuid
            ) as projects,
            (
              select count(*)::int
              from sandbox_usage_sessions
              where org_id = ${orgId}::uuid and id = ${privateUsageId}::uuid
            ) as usage
        `;
        const projectUpdates = await tx`
          update projects
          set name = 'Spoofed worker update'
          where org_id = ${orgId}::uuid and id = ${privateProjectId}::uuid
          returning id
        `;
        const usageUpdates = await tx`
          update sandbox_usage_sessions
          set reserved_ms = 120000
          where org_id = ${orgId}::uuid and id = ${privateUsageId}::uuid
          returning id
        `;
        const projectDeletes = await tx`
          delete from projects
          where org_id = ${orgId}::uuid and id = ${privateProjectId}::uuid
          returning id
        `;
        const usageDeletes = await tx`
          delete from sandbox_usage_sessions
          where org_id = ${orgId}::uuid and id = ${privateUsageId}::uuid
          returning id
        `;
        return {
          ...before,
          projectUpdates: projectUpdates.length,
          usageUpdates: usageUpdates.length,
          projectDeletes: projectDeletes.length,
          usageDeletes: usageDeletes.length,
        };
      });
      expect(spoofed).toEqual({
        projects: 0,
        usage: 0,
        projectUpdates: 0,
        usageUpdates: 0,
        projectDeletes: 0,
        usageDeletes: 0,
      });

      const legacyVisible = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${simpleRole}`);
        await tx`
          select
            set_config('app.org_id', ${orgId}, true),
            set_config('app.user_id', ${userId}, true)
        `;
        const [visible] = await tx<{ projects: number; usage: number }[]>`
          select
            (
              select count(*)::int
              from projects
              where org_id = ${orgId}::uuid and id = ${privateProjectId}::uuid
            ) as projects,
            (
              select count(*)::int
              from sandbox_usage_sessions
              where org_id = ${orgId}::uuid and id = ${privateUsageId}::uuid
            ) as usage
        `;
        return visible;
      });
      expect(legacyVisible).toEqual({ projects: 1, usage: 1 });

      const exactLeaseVisible = await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${workerRole}`);
        const [lease] = await tx<{ entered: boolean }[]>`
          select companion_enter_project_worker_lease(
            ${orgId}::uuid,
            ${privateProjectId}::uuid,
            ${userId},
            ${workerId},
            1
          ) as entered
        `;
        const [visible] = await tx<{ projects: number; usage: number }[]>`
          select
            (
              select count(*)::int
              from projects
              where org_id = ${orgId}::uuid and id = ${privateProjectId}::uuid
            ) as projects,
            (
              select count(*)::int
              from sandbox_usage_sessions
              where org_id = ${orgId}::uuid and id = ${privateUsageId}::uuid
            ) as usage
        `;
        return { entered: lease?.entered, ...visible };
      });
      expect(exactLeaseVisible).toEqual({ entered: true, projects: 1, usage: 1 });
    } finally {
      await sql`
        delete from projects
        where org_id = ${orgId}::uuid and id = ${privateProjectId}::uuid
      `;
    }
  });

  it("allows creator-scoped Project CRUD through the API role", async () => {
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`
        select
          set_config('app.org_id', ${orgId}, true),
          set_config('app.user_id', ${userId}, true)
      `;
      await tx`
        insert into projects (
          id, org_id, creator_id, name, default_model, idempotency_key, payload_hash
        )
        values (
          ${projectId}::uuid,
          ${orgId}::uuid,
          ${userId},
          'Grant matrix project',
          'openai/gpt-5',
          ${`grant-matrix-${suffix}`},
          ${"a".repeat(64)}
        )
      `;
      const [created] = await tx<{ name: string }[]>`
        select name from projects where org_id = ${orgId}::uuid and id = ${projectId}::uuid
      `;
      await tx`
        update projects
        set name = 'Updated grant matrix project'
        where org_id = ${orgId}::uuid and id = ${projectId}::uuid
      `;
      const [updated] = await tx<{ name: string }[]>`
        select name from projects where org_id = ${orgId}::uuid and id = ${projectId}::uuid
      `;
      const deleted = await tx`
        delete from projects where org_id = ${orgId}::uuid and id = ${projectId}::uuid
        returning id
      `;
      return { created, updated, deleted: deleted.length };
    });

    expect(result).toEqual({
      created: { name: "Grant matrix project" },
      updated: { name: "Updated grant matrix project" },
      deleted: 1,
    });
  });
});
