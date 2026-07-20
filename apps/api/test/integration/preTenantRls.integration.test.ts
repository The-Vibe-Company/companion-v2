/**
 * Product promise:
 * Companion runs with a NOBYPASSRLS login and exposes only narrow identity-discovery operations
 * before an organization is selected.
 *
 * Regression caught:
 * Deployments previously needed an owner/superuser connection for login, PAT, invite, share, avatar,
 * billing, and domain discovery paths.
 *
 * Why this test is integrated:
 * The boundary depends on real PostgreSQL role attributes, grants, forced RLS, and definer functions.
 *
 * Failure proof:
 * Removing a required narrow grant or allowing direct tenant-table visibility must fail this suite.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";

const databaseUrl = process.env.DATABASE_MIGRATION_URL
  ?? process.env.DATABASE_URL;
if (!databaseUrl?.trim()) {
  throw new Error("pre-tenant RLS integration tests require an explicit disposable DATABASE_URL");
}

describe("pre-tenant PostgreSQL RLS boundary", () => {
  const sql = postgres(databaseUrl, { max: 4 });
  const suffix = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const skillId = randomUUID();
  const versionId = randomUUID();
  const owner = {
    id: `pre-tenant-owner-${suffix}`,
    email: `owner-${suffix}@acme.test`,
  };
  const colleague = {
    id: `pre-tenant-colleague-${suffix}`,
    email: `colleague-${suffix}@acme.test`,
  };
  const outsider = {
    id: `pre-tenant-outsider-${suffix}`,
    email: `outsider-${suffix}@other.test`,
  };
  const rlsRole = `companion_pretenant_${suffix.replaceAll("-", "").slice(0, 20)}`;
  const invitationToken = `invite-${suffix}`;
  const apiTokenHash = `hash-${suffix}`;
  const shareToken = `share-${suffix}`;

  async function withRuntimeRole<T>(fn: (tx: postgres.TransactionSql) => Promise<T>): Promise<T> {
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return fn(tx);
    });
    return result as T;
  }

  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, email_verified)
      values
        (${owner.id}, 'Pre-tenant Owner', ${owner.email}, true),
        (${colleague.id}, 'Pre-tenant Colleague', ${colleague.email}, true),
        (${outsider.id}, 'Pre-tenant Outsider', ${outsider.email}, true)
    `;
    await sql`
      insert into profiles (id, email, name, initials, avatar_url)
      values
        (${owner.id}, ${owner.email}, 'Pre-tenant Owner', 'PO', '/v1/users/owner/avatar'),
        (${colleague.id}, ${colleague.email}, 'Pre-tenant Colleague', 'PC', '/v1/users/colleague/avatar'),
        (${outsider.id}, ${outsider.email}, 'Pre-tenant Outsider', 'PX', '/v1/users/outsider/avatar')
    `;
    await sql`
      insert into organizations (id, name, slug, kind)
      values
        (${orgA}::uuid, 'Pre-tenant A', ${`pre-tenant-a-${suffix}`}, 'team'),
        (${orgB}::uuid, 'Pre-tenant B', ${`pre-tenant-b-${suffix}`}, 'team')
    `;
    await sql`
      insert into memberships (org_id, user_id, org_role)
      values
        (${orgA}::uuid, ${owner.id}, 'owner'),
        (${orgA}::uuid, ${colleague.id}, 'developer'),
        (${orgB}::uuid, ${outsider.id}, 'owner')
    `;
    await sql`
      insert into organization_domains (org_id, domain, created_by)
      values (${orgB}::uuid, 'acme.test', ${outsider.id})
    `;
    await sql`
      insert into billing_subscriptions
        (org_id, stripe_customer_id, stripe_subscription_id, stripe_subscription_item_id,
         stripe_status, synced_quantity, seat_sync_status, seat_sync_requested_at, next_retry_at, last_reconciled_at)
      values
        (${orgA}::uuid, ${`cus-a-${suffix}`}, ${`sub-a-${suffix}`}, ${`item-a-${suffix}`},
         'active', 1, 'pending', clock_timestamp() - interval '1 minute', clock_timestamp() - interval '1 second', null),
        (${orgB}::uuid, ${`cus-b-${suffix}`}, ${`sub-b-${suffix}`}, ${`item-b-${suffix}`},
         'active', 1, 'synced', null, null, clock_timestamp())
    `;
    await sql`
      insert into invitations (org_id, email, org_role, token, created_by, expires_at)
      values (
        ${orgB}::uuid,
        ${owner.email},
        'developer',
        ${invitationToken},
        ${outsider.id},
        clock_timestamp() + interval '1 day'
      )
    `;
    await sql`
      insert into api_tokens (org_id, user_id, name, token_prefix, token_hash, scopes, expires_at)
      values (
        ${orgA}::uuid,
        ${owner.id},
        'Pre-tenant API token',
        'cmp_pat_test',
        ${apiTokenHash},
        '["skills:read"]'::jsonb,
        clock_timestamp() + interval '1 day'
      )
    `;
    await sql`
      insert into skills (id, org_id, slug, display_name, description, creator_id, scope, share_token)
      values (
        ${skillId}::uuid,
        ${orgA}::uuid,
        ${`pre-tenant-skill-${suffix}`},
        'Public SQL preview',
        'Public metadata only',
        ${owner.id},
        'org',
        ${shareToken}
      )
    `;
    await sql`
      insert into skill_versions
        (id, org_id, skill_id, version, frontmatter, body, size_bytes, checksum, storage_path, created_by)
      values (
        ${versionId}::uuid,
        ${orgA}::uuid,
        ${skillId}::uuid,
        '1.0.0',
        '{}',
        '',
        1,
        ${`sha256:${"a".repeat(64)}`},
        ${`${orgA}/pre-tenant/1.0.0.tar.gz`},
        ${owner.id}
      )
    `;
    await sql`
      update skills
      set current_version_id = ${versionId}::uuid
      where org_id = ${orgA}::uuid and id = ${skillId}::uuid
    `;
    await sql.unsafe(`create role ${rlsRole} login nosuperuser nobypassrls noinherit`);
    await sql.unsafe(`grant ${rlsRole} to current_user with inherit true, set true`);
    const grantsFile = await resolveRuntimeRoleGrantsFile();
    const grantBlock = extractRuntimeRoleGrantBlock(await readFile(grantsFile, "utf8"));
    await sql.begin(async (tx) => {
      await tx`select set_config('companion.runtime_role', ${rlsRole}, true)`;
      await tx.unsafe(grantBlock);
    });
  });

  afterAll(async () => {
    await sql`delete from organizations where id in (${orgA}::uuid, ${orgB}::uuid)`;
    await sql`delete from "user" where id in (${owner.id}, ${colleague.id}, ${outsider.id})`;
    await sql.unsafe(`drop owned by ${rlsRole}`);
    await sql.unsafe(`revoke ${rlsRole} from current_user`);
    await sql.unsafe(`drop role ${rlsRole}`);
    await sql.end();
  });

  it("uses a non-privileged role and keeps tenant tables invisible without GUCs", async () => {
    const attributes = await sql<{
      superuser: boolean;
      bypassRls: boolean;
      inherit: boolean;
      canLogin: boolean;
    }[]>`
      select
        rolsuper as superuser,
        rolbypassrls as "bypassRls",
        rolinherit as inherit,
        rolcanlogin as "canLogin"
      from pg_roles
      where rolname = ${rlsRole}
    `;
    expect(attributes).toEqual([{ superuser: false, bypassRls: false, inherit: false, canLogin: true }]);

    const result = await withRuntimeRole(async (tx) => {
      const context = await tx<{ orgId: string | null; userId: string | null }[]>`
        select
          current_setting('app.org_id', true) as "orgId",
          current_setting('app.user_id', true) as "userId"
      `;
      const counts = await tx<{
        organizations: number;
        memberships: number;
        invitations: number;
        apiTokens: number;
        skills: number;
        billing: number;
      }[]>`
        select
          (select count(*)::int from organizations) as organizations,
          (select count(*)::int from memberships) as memberships,
          (select count(*)::int from invitations) as invitations,
          (select count(*)::int from api_tokens) as "apiTokens",
          (select count(*)::int from skills) as skills,
          (select count(*)::int from billing_subscriptions) as billing
      `;
      return { context: context[0], counts: counts[0] };
    });

    expect(result).toEqual({
      context: { orgId: null, userId: null },
      counts: { organizations: 0, memberships: 0, invitations: 0, apiTokens: 0, skills: 0, billing: 0 },
    });
  });

  it("discovers only the actor's organizations and matching joinable domain", async () => {
    const result = await withRuntimeRole(async (tx) => {
      const organizations = await tx<{ orgId: string; name: string; role: string; memberCount: number }[]>`
        select
          org_id::text as "orgId",
          name,
          org_role::text as role,
          member_count::int as "memberCount"
        from companion_list_user_orgs(${owner.id})
      `;
      const joinable = await tx<{ orgId: string; name: string; domain: string; memberCount: number }[]>`
        select
          org_id::text as "orgId",
          name,
          domain,
          member_count::int as "memberCount"
        from companion_list_joinable_orgs(${owner.id})
      `;
      return { organizations, joinable };
    });

    expect(result.organizations).toEqual([
      { orgId: orgA, name: "Pre-tenant A", role: "owner", memberCount: 2 },
    ]);
    expect(result.joinable).toEqual([
      { orgId: orgB, name: "Pre-tenant B", domain: "acme.test", memberCount: 1 },
    ]);
  });

  it("locks a valid invitation while hiding wrong actors and unknown tokens identically", async () => {
    const result = await withRuntimeRole(async (tx) => {
      const valid = await tx<{ orgId: string; role: string }[]>`
        select org_id::text as "orgId", org_role::text as role
        from companion_lock_invitation_for_actor(${owner.id}, ${invitationToken})
      `;
      const wrongActor = await tx<{ orgId: string }[]>`
        select org_id::text as "orgId"
        from companion_lock_invitation_for_actor(${colleague.id}, ${invitationToken})
      `;
      const unknownToken = await tx<{ orgId: string }[]>`
        select org_id::text as "orgId"
        from companion_lock_invitation_for_actor(${owner.id}, ${`missing-${suffix}`})
      `;
      return { valid, wrongActor, unknownToken };
    });

    expect(result.valid).toEqual([{ orgId: orgB, role: "developer" }]);
    expect(result.wrongActor).toEqual([]);
    expect(result.unknownToken).toEqual(result.wrongActor);
  });

  it("resolves an active PAT and updates last_used_at without exposing the hash", async () => {
    const before = await sql<{ used: boolean }[]>`
      select last_used_at is not null as used from api_tokens where token_hash = ${apiTokenHash}
    `;
    expect(before).toEqual([{ used: false }]);

    const resolved = await withRuntimeRole((tx) => tx<{
      orgId: string;
      userId: string;
      email: string;
      name: string;
      scopes: string[];
    }[]>`
      select
        org_id::text as "orgId",
        user_id as "userId",
        email,
        name,
        scopes
      from companion_resolve_api_token(${apiTokenHash})
    `);

    expect(resolved).toEqual([{
      orgId: orgA,
      userId: owner.id,
      email: owner.email,
      name: "Pre-tenant Owner",
      scopes: ["skills:read"],
    }]);
    expect(JSON.stringify(resolved)).not.toContain(apiTokenHash);
    const after = await sql<{ used: boolean }[]>`
      select last_used_at is not null as used from api_tokens where token_hash = ${apiTokenHash}
    `;
    expect(after).toEqual([{ used: true }]);
  });

  it("serves the narrow public preview and resolves a share target only for members", async () => {
    const result = await withRuntimeRole(async (tx) => {
      const preview = await tx<{
        slug: string;
        displayName: string | null;
        description: string;
        creatorName: string;
        creatorInitials: string;
        version: string;
      }[]>`
        select
          slug,
          display_name as "displayName",
          description,
          creator_name as "creatorName",
          creator_initials as "creatorInitials",
          current_version as version
        from companion_public_skill_preview(${shareToken})
      `;
      const memberTarget = await tx<{ orgId: string; slug: string }[]>`
        select org_id::text as "orgId", slug
        from companion_skill_share_target(${shareToken}, ${owner.id})
      `;
      const outsiderTarget = await tx<{ orgId: string; slug: string }[]>`
        select org_id::text as "orgId", slug
        from companion_skill_share_target(${shareToken}, ${outsider.id})
      `;
      return { preview, memberTarget, outsiderTarget };
    });

    expect(result.preview).toEqual([{
      slug: `pre-tenant-skill-${suffix}`,
      displayName: "Public SQL preview",
      description: "Public metadata only",
      creatorName: "Pre-tenant Owner",
      creatorInitials: "PO",
      version: "1.0.0",
    }]);
    expect(result.memberTarget).toEqual([{ orgId: orgA, slug: `pre-tenant-skill-${suffix}` }]);
    expect(result.outsiderTarget).toEqual([]);
  });

  it("removes the retired skill star storage", async () => {
    const [row] = await sql<{ tableName: string | null }[]>`
      select to_regclass('public.skill_stars')::text as "tableName"
    `;
    expect(row).toEqual({ tableName: null });
  });

  it("reveals only whether two users share an organization for avatar authorization", async () => {
    const result = await withRuntimeRole(async (tx) => tx<{
      shared: boolean;
      isolated: boolean;
      self: boolean;
    }[]>`
      select
        companion_users_share_org(${owner.id}, ${colleague.id}) as shared,
        companion_users_share_org(${owner.id}, ${outsider.id}) as isolated,
        companion_users_share_org(${owner.id}, ${owner.id}) as self
    `);

    expect(result).toEqual([{ shared: true, isolated: false, self: true }]);
  });

  it("resolves Stripe tenant correlation and scans due billing work without a tenant GUC", async () => {
    const result = await withRuntimeRole(async (tx) => {
      const bySubscription = await tx<{ orgId: string | null }[]>`
        select companion_billing_org_for_stripe_event(${`sub-a-${suffix}`}, null)::text as "orgId"
      `;
      const byCustomer = await tx<{ orgId: string | null }[]>`
        select companion_billing_org_for_stripe_event(null, ${`cus-b-${suffix}`})::text as "orgId"
      `;
      const unknown = await tx<{ orgId: string | null }[]>`
        select companion_billing_org_for_stripe_event(${`missing-${suffix}`}, null)::text as "orgId"
      `;
      const candidates = await tx<{ orgId: string }[]>`
        select org_id::text as "orgId"
        from companion_list_billing_sync_candidates(clock_timestamp(), false, 10)
      `;
      return { bySubscription, byCustomer, unknown, candidates };
    });

    expect(result).toEqual({
      bySubscription: [{ orgId: orgA }],
      byCustomer: [{ orgId: orgB }],
      unknown: [{ orgId: null }],
      candidates: [{ orgId: orgA }],
    });
  });
});
