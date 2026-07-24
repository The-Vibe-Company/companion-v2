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
 * Project workspace, enter its exact lease, or forge worker heartbeats.
 *
 * Why this test is integrated:
 * PostgreSQL's effective EXECUTE privileges include role attributes, PUBLIC grants and function
 * signatures. Only a migrated database and real login roles prove the separation.
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

  it("keeps both runtime logins non-privileged and able to use RLS-protected tables", async () => {
    const attributes = await sql<{
      name: string;
      canLogin: boolean;
      superuser: boolean;
      bypassRls: boolean;
      inherit: boolean;
      projectsTable: boolean;
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
        tableDefaults: true,
        sequenceDefaults: true,
      },
      {
        name: workerRole,
        canLogin: true,
        superuser: false,
        bypassRls: false,
        inherit: false,
        projectsTable: true,
        tableDefaults: true,
        sequenceDefaults: true,
      },
    ]);
  });

  it("grants Project claim and lease mutation functions only to the worker", async () => {
    const functions = [
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

  it("preserves the legacy union contract for simple installs", async () => {
    const [privileges] = await sql<{
      projectTable: boolean;
      workerClaim: boolean;
      apiDiscovery: boolean;
    }[]>`
      select
        has_table_privilege(
          ${simpleRole},
          'public.projects',
          'SELECT,INSERT,UPDATE,DELETE'
        ) as "projectTable",
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
      await sql.unsafe(`drop owned by ${crossApiRole}`);
      await sql.unsafe(`drop owned by ${crossWorkerRole}`);
      await sql.unsafe(`drop role ${crossApiRole}`);
      await sql.unsafe(`drop role ${crossWorkerRole}`);
    }
  });

  it("keeps API service functions away from the worker while sharing RLS predicates and readiness", async () => {
    const apiFunctions = [
      "public.companion_list_user_orgs(text)",
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
