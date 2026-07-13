import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { schema, sql as applicationSql, withTenantContext } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  seedPersonalLabel,
  seedSkill,
  type IntegrationFixture,
  type SeededSkill,
} from "./testDatabase";

/**
 * Product promise:
 * Migrated Postgres policies isolate tenants when evaluated through a non-owner, non-bypass role,
 * and transaction-local tenant identifiers never leak into later work on the application pool.
 *
 * Regression caught:
 * A migration that forgets to enable RLS/add a policy, an application query missing org_id, or a
 * leaked app.org_id setting could expose or corrupt another organization's data.
 *
 * Why this test is integrated:
 * Superusers and table owners bypass ordinary RLS. A real non-superuser role proves policy behavior;
 * the deployment must separately configure its runtime credential as a non-bypass identity.
 *
 * Failure proof:
 * Disabling the skills policy or making the tenant GUC session-scoped must make this suite fail.
 */
describe("Postgres tenant isolation", () => {
  let fixture: IntegrationFixture;
  let skillA: SeededSkill;
  let skillB: SeededSkill;
  const role = `companion_rls_${randomUUID().replaceAll("-", "").slice(0, 20)}`;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    skillA = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `tenant-a-${fixture.suffix}`,
      scope: "personal",
    });
    skillB = await seedSkill({
      orgId: fixture.orgB,
      creator: fixture.outsider,
      slug: `tenant-b-${fixture.suffix}`,
      scope: "org",
    });
    await seedPersonalLabel({ orgId: fixture.orgA, owner: fixture.owner, skillId: skillA.id, path: "private/rls" });
    await integrationSql.unsafe(`create role ${role} nologin`);
    await integrationSql.unsafe(`grant usage on schema public to ${role}`);
    await integrationSql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await integrationSql.unsafe(`grant usage, select on all sequences in schema public to ${role}`);
  });

  afterAll(async () => {
    await integrationSql.unsafe(`drop owned by ${role}`);
    await integrationSql.unsafe(`drop role ${role}`);
    await fixture.cleanup();
  });

  it("keeps every current tenant table behind at least one enabled RLS policy", async () => {
    const rows = await integrationSql<
      Array<{ table_name: string; rls_enabled: boolean; policy_count: number }>
    >`
      select
        c.relname as table_name,
        c.relrowsecurity as rls_enabled,
        count(distinct p.polname)::int as policy_count
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      left join pg_policy p on p.polrelid = c.oid
      where n.nspname = 'public'
        and c.relkind = 'r'
        and (
          c.relname = 'organizations'
          or exists (
            select 1 from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
          )
        )
      group by c.relname, c.relrowsecurity
      order by c.relname
    `;

    expect(rows.length).toBeGreaterThan(10);
    expect(rows.filter((row) => !row.rls_enabled || row.policy_count === 0)).toEqual([]);
  });

  it("prevents an Org A database role from reading or updating Org B rows", async () => {
    const result = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      const [identity] = await tx<Array<{ role_name: string; is_superuser: boolean; bypasses_rls: boolean }>>`
        select current_user as role_name, rolsuper as is_superuser, rolbypassrls as bypasses_rls
        from pg_roles where rolname = current_user
      `;
      const visible = await tx<Array<{ id: string }>>`select id from skills order by id`;
      const changed = await tx<Array<{ id: string }>>`
        update skills set description = 'cross-tenant-write' where id = ${skillB.id}::uuid returning id
      `;
      return { identity, visible: visible.map((row) => row.id), changed };
    });

    expect(result.identity).toEqual({ role_name: role, is_superuser: false, bypasses_rls: false });
    expect(result.visible).toContain(skillA.id);
    expect(result.visible).not.toContain(skillB.id);
    expect(result.changed).toEqual([]);
    await expect(
      integrationDb.query.skills.findFirst({ where: drizzleSql`${schema.skills.id} = ${skillB.id}::uuid` }),
    ).resolves.not.toMatchObject({ description: "cross-tenant-write" });
  });

  it("keeps owner-scoped personal folders private even inside the same organization", async () => {
    const paths = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ path: string }>>`select path from personal_labels order by path`;
    });
    expect(paths).toEqual([]);
  });

  it("uses transaction-local tenant identifiers that are cleared after withTenantContext returns", async () => {
    expect(process.env.COMPANION_DATABASE_POOL_MAX).toBe("1");
    const inside = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      async (database) => {
        const [settings] = await database.execute(
          drizzleSql`select current_setting('app.org_id', true) as org_id, current_setting('app.user_id', true) as user_id`,
        );
        return settings as { org_id: string; user_id: string };
      },
    );
    expect(inside).toEqual({ org_id: fixture.orgA, user_id: fixture.owner.id });

    // The integration command pins the application pool to one physical connection. Querying that
    // same pool is what makes a session-scoped set_config mutation observable after the transaction.
    const [outside] = await applicationSql<Array<{ org_id: string | null; user_id: string | null }>>`
      select nullif(current_setting('app.org_id', true), '') as org_id,
             nullif(current_setting('app.user_id', true), '') as user_id
    `;
    expect(outside).toEqual({ org_id: null, user_id: null });
  });
});
