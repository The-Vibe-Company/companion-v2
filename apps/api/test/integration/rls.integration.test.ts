import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql as drizzleSql } from "drizzle-orm";
import { schema, sql as applicationSql, withTenantContext } from "@companion/db";
import {
  completeGitHubSync,
  createGitHubDestination,
  deleteGitHubConnection,
  failGitHubSync,
  getGitHubSyncPlan,
  getGitHubUserCredential,
  isGitHubSyncFenceLive,
  lockGitHubSyncPublishFence,
  refreshGitHubConnectionCredential,
  requestGitHubDestinationSync,
  saveGitHubConnection,
  updateGitHubDestination,
} from "@companion/core/services";
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
  let mirrorSkillA: SeededSkill;
  const githubDestinationA = randomUUID();
  const githubDestinationB = randomUUID();
  const githubTokenSentinel = "github-user-token-MUST-NOT-PERSIST";
  const personalProviderId = randomUUID();
  const orgProviderId = randomUUID();
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
    mirrorSkillA = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `mirror-a-${fixture.suffix}`,
      scope: "org",
    });
    await seedPersonalLabel({ orgId: fixture.orgA, owner: fixture.owner, skillId: skillA.id, path: "private/rls" });
    await integrationSql`
      insert into model_provider_connections
        (id, org_id, scope, user_id, provider, key_name, current_version, created_by)
      values
        (${personalProviderId}::uuid, ${fixture.orgA}::uuid, 'personal', ${fixture.owner.id}, 'anthropic', 'ANTHROPIC_API_KEY', 1, ${fixture.owner.id}),
        (${orgProviderId}::uuid, ${fixture.orgA}::uuid, 'organization', null, 'openai', 'OPENAI_API_KEY', 1, ${fixture.owner.id})
    `;
    await integrationSql`
      insert into model_provider_credential_versions
        (org_id, connection_id, version, key_name, ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id)
      values
        (${fixture.orgA}::uuid, ${personalProviderId}::uuid, 1, 'ANTHROPIC_API_KEY', 'cipher-personal', 'iv', 'tag', 'dek', 'wrap-iv', 'wrap-tag', 'key-id'),
        (${fixture.orgA}::uuid, ${orgProviderId}::uuid, 1, 'OPENAI_API_KEY', 'cipher-org', 'iv', 'tag', 'dek', 'wrap-iv', 'wrap-tag', 'key-id')
    `;
    await saveGitHubConnection({
      actor: fixture.owner,
      orgId: fixture.orgA,
      githubUserId: "github-a",
      githubLogin: "acme-a",
      accessToken: githubTokenSentinel,
      refreshToken: `${githubTokenSentinel}-refresh`,
      masterKey: Buffer.alloc(32, 7),
      database: integrationDb,
    });
    await integrationSql`
      insert into github_connections
        (org_id, github_user_id, github_login, credential_version, access_ciphertext, access_iv,
         access_auth_tag, access_wrapped_dek, access_wrap_iv, access_wrap_auth_tag, access_key_id, connected_by)
      values
        (${fixture.orgB}::uuid, 'github-b', 'acme-b', 1, 'cipher-b', 'iv-b', 'tag-b', 'dek-b', 'wiv-b', 'wtag-b', 'key-b', ${fixture.outsider.id})
    `;
    await integrationSql`
      insert into github_sync_destinations
        (id, org_id, installation_id, repository_id, owner, name, html_url, default_branch, mode, created_by)
      values
        (${githubDestinationA}::uuid, ${fixture.orgA}::uuid, 'installation-a', 'repository-a', 'acme-a', 'skills', 'https://github.com/acme-a/skills', 'main', 'selected', ${fixture.owner.id}),
        (${githubDestinationB}::uuid, ${fixture.orgB}::uuid, 'installation-b', 'repository-b', 'acme-b', 'skills', 'https://github.com/acme-b/skills', 'main', 'selected', ${fixture.outsider.id})
    `;
    await integrationSql`
      insert into github_sync_destination_skills (org_id, destination_id, skill_id)
      values
        (${fixture.orgA}::uuid, ${githubDestinationA}::uuid, ${mirrorSkillA.id}::uuid),
        (${fixture.orgB}::uuid, ${githubDestinationB}::uuid, ${skillB.id}::uuid)
    `;
    await integrationSql.unsafe(`create role ${role} nologin`);
    await integrationSql.unsafe(`grant ${role} to current_user with inherit true, set true`);
    await integrationSql.unsafe(`grant usage on schema public to ${role}`);
    await integrationSql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await integrationSql.unsafe(`grant usage, select on all sequences in schema public to ${role}`);
  });

  afterAll(async () => {
    await integrationSql.unsafe(`drop owned by ${role}`);
    await integrationSql.unsafe(`revoke ${role} from current_user`);
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

  it("isolates GitHub authorization, mirrors, and selections and globally reserves a repository id", async () => {
    const visible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.owner.id}, true)`;
      const connections = await tx<Array<{ github_login: string }>>`select github_login from github_connections`;
      const destinations = await tx<Array<{ id: string }>>`select id from github_sync_destinations`;
      const selections = await tx<Array<{ skill_id: string }>>`select skill_id from github_sync_destination_skills`;
      const crossTenantUpdate = await tx<Array<{ id: string }>>`
        update github_sync_destinations set status = 'synced'
        where id = ${githubDestinationB}::uuid returning id
      `;
      return { connections, destinations, selections, crossTenantUpdate };
    });
    expect(visible.connections).toEqual([{ github_login: "acme-a" }]);
    expect(visible.destinations).toEqual([{ id: githubDestinationA }]);
    expect(visible.selections).toEqual([{ skill_id: mirrorSkillA.id }]);
    expect(visible.crossTenantUpdate).toEqual([]);

    const [storedCredential] = await integrationSql<Array<Record<string, unknown>>>`
      select * from github_connections where org_id = ${fixture.orgA}::uuid
    `;
    const githubAudit = await integrationSql<Array<Record<string, unknown>>>`
      select * from audit_log where org_id = ${fixture.orgA}::uuid and action = 'github.account.connected'
    `;
    expect(JSON.stringify(storedCredential)).not.toContain(githubTokenSentinel);
    expect(JSON.stringify(githubAudit)).not.toContain(githubTokenSentinel);

    await expect(integrationSql`
      insert into github_sync_destinations
        (org_id, installation_id, repository_id, owner, name, html_url, default_branch, created_by)
      values
        (${fixture.orgB}::uuid, 'other-installation', 'repository-a', 'acme-b', 'duplicate', 'https://github.com/acme-b/duplicate', 'main', ${fixture.outsider.id})
    `).rejects.toThrow(/github_sync_destinations_repository_uq/);
  });

  it("serializes destination creation with disconnect and never claims an orphan destination", async () => {
    const racingRepositoryId = `repository-race-${randomUUID()}`;
    const orphanDestinationId = randomUUID();
    let releaseRevocation: (() => void) | undefined;
    let revocationStarted!: () => void;
    const revocationWasStarted = new Promise<void>((resolve) => { revocationStarted = resolve; });
    const revocationBarrier = new Promise<void>((resolve) => { releaseRevocation = resolve; });
    let disconnect: Promise<void> | undefined;
    try {
      disconnect = deleteGitHubConnection({
        actor: fixture.owner,
        orgId: fixture.orgA,
        masterKey: Buffer.alloc(32, 7),
        revokeAccessToken: async () => {
          revocationStarted();
          await revocationBarrier;
        },
        database: integrationDb,
      });
      await revocationWasStarted;

      let createFinished = false;
      const create = createGitHubDestination({
        actor: fixture.owner,
        orgId: fixture.orgA,
        destination: {
          installation_id: "installation-race",
          repository_id: racingRepositoryId,
          owner: "acme-a",
          name: "racing-skills",
          html_url: "https://github.com/acme-a/racing-skills",
          default_branch: "main",
          private: true,
          mode: "all",
          selected_skill_ids: [],
          repository_empty: true,
        },
        database: integrationDb,
      }).then(
        (id) => ({ ok: true as const, id }),
        (error: unknown) => ({ ok: false as const, error }),
      ).finally(() => { createFinished = true; });

      let raceState: { created: boolean; blocked_on_advisory: boolean } | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        [raceState] = await integrationSql<Array<{ created: boolean; blocked_on_advisory: boolean }>>`
          select
            exists(select 1 from github_sync_destinations where repository_id = ${racingRepositoryId}) as created,
            exists(
              select 1 from pg_locks
              where locktype = 'advisory' and database = (select oid from pg_database where datname = current_database())
                and not granted
            ) as blocked_on_advisory
        `;
        if (raceState?.created || raceState?.blocked_on_advisory) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(raceState).toEqual({ created: false, blocked_on_advisory: true });
      expect(createFinished).toBe(false);
      releaseRevocation?.();
      releaseRevocation = undefined;
      await disconnect;
      const createResult = await create;
      expect(createResult.ok).toBe(false);
      if (createResult.ok) throw new Error("destination creation unexpectedly won disconnect");
      expect(createResult.error).toMatchObject({ message: "GitHub is not connected" });

      // Defense in depth: even a legacy/orphan pending row must not be claimable without a live connection.
      await integrationSql`
        insert into github_sync_destinations
          (id, org_id, installation_id, repository_id, owner, name, html_url, default_branch, created_by)
        values
          (${orphanDestinationId}::uuid, ${fixture.orgA}::uuid, 'installation-orphan', ${racingRepositoryId},
           'acme-a', 'orphan-skills', 'https://github.com/acme-a/orphan-skills', 'main', ${fixture.owner.id})
      `;
      const claims = await integrationSql<Array<{ org_id: string; destination_id: string }>>`
        select org_id, destination_id from companion_claim_github_sync_destinations('worker-orphan-check', 50, 300)
      `;
      expect(claims.map((claim) => claim.destination_id)).not.toContain(orphanDestinationId);
      for (const claim of claims) {
        await integrationSql.begin(async (tx) => {
          await tx`select set_config('app.org_id', ${claim.org_id}, true), set_config('app.user_id', 'test-cleanup', true)`;
          await tx`update github_sync_destinations set status = 'pending', lease_owner = null, lease_until = null where id = ${claim.destination_id}::uuid`;
        });
      }
    } finally {
      releaseRevocation?.();
      await disconnect?.catch(() => undefined);
      await integrationSql`delete from github_sync_destinations where id = ${orphanDestinationId}::uuid or repository_id = ${racingRepositoryId}`;
      await saveGitHubConnection({
        actor: fixture.owner,
        orgId: fixture.orgA,
        githubUserId: "github-a",
        githubLogin: "acme-a",
        accessToken: githubTokenSentinel,
        refreshToken: `${githubTokenSentinel}-refresh`,
        masterKey: Buffer.alloc(32, 7),
        database: integrationDb,
      });
      await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
        await database.update(schema.githubSyncDestinations).set({
          status: "pending", leaseOwner: null, leaseUntil: null, nextRetryAt: null,
        }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
      });
    }
  });

  it("rejects an OAuth refresh CAS after disconnect replaces the credential generation", async () => {
    const masterKey = Buffer.alloc(32, 7);
    try {
      await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) =>
        deleteGitHubConnection({
          actor: fixture.owner,
          orgId: fixture.orgA,
          masterKey,
          revokeAccessToken: async () => undefined,
          database,
        }),
      );
      await saveGitHubConnection({
        actor: fixture.owner,
        orgId: fixture.orgA,
        githubUserId: "github-a",
        githubLogin: "acme-a",
        accessToken: "access-before-refresh-race",
        refreshToken: "refresh-before-refresh-race",
        masterKey,
        database: integrationDb,
      });
      const stale = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) =>
        getGitHubUserCredential({ actor: fixture.owner, orgId: fixture.orgA, masterKey, database }),
      );
      expect(stale.credentialVersion).toBe(1);

      await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) =>
        deleteGitHubConnection({
          actor: fixture.owner,
          orgId: fixture.orgA,
          masterKey,
          revokeAccessToken: async () => undefined,
          database,
        }),
      );
      await saveGitHubConnection({
        actor: fixture.owner,
        orgId: fixture.orgA,
        githubUserId: "github-a",
        githubLogin: "replacement-login",
        accessToken: "replacement-access",
        refreshToken: "replacement-refresh",
        masterKey,
        database: integrationDb,
      });

      const updated = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) =>
        refreshGitHubConnectionCredential({
          actor: fixture.owner,
          orgId: fixture.orgA,
          expectedCredentialGeneration: stale.credentialGeneration,
          expectedCredentialVersion: stale.credentialVersion,
          accessToken: "stale-refreshed-access",
          refreshToken: "stale-refreshed-refresh",
          masterKey,
          database,
        }),
      );
      expect(updated).toBe(false);
      const current = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) =>
        getGitHubUserCredential({ actor: fixture.owner, orgId: fixture.orgA, masterKey, database }),
      );
      expect(current).toMatchObject({ accessToken: "replacement-access", credentialVersion: 1 });
      expect(current.credentialGeneration).not.toBe(stale.credentialGeneration);
    } finally {
      await saveGitHubConnection({
        actor: fixture.owner,
        orgId: fixture.orgA,
        githubUserId: "github-a",
        githubLogin: "acme-a",
        accessToken: githubTokenSentinel,
        refreshToken: `${githubTokenSentinel}-refresh`,
        masterKey,
        database: integrationDb,
      });
      await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
        await database.update(schema.githubSyncDestinations).set({
          status: "pending", leaseOwner: null, leaseUntil: null, nextRetryAt: null,
        }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
      });
    }
  });

  it("serializes only the final publication fence with disconnect, then completes before disconnect returns", async () => {
    const masterKey = Buffer.alloc(32, 7);
    const workerId = "worker-publish-fence";
    const claimedRevision = 1;
    const leaseGeneration = 41;
    await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      await database.update(schema.githubSyncDestinations).set({
        desiredRevision: claimedRevision,
        appliedRevision: 0,
        status: "syncing",
        leaseOwner: workerId,
        leaseUntil: new Date(Date.now() + 60_000),
        leaseGeneration,
        nextRetryAt: null,
      }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
    });

    // Planning is a short snapshot and does not retain a row lock while S3/rendering work happens.
    await expect(withTenantContext({ orgId: fixture.orgA, userId: workerId }, (database) => getGitHubSyncPlan({
      orgId: fixture.orgA,
      destinationId: githubDestinationA,
      workerId,
      claimedRevision,
      leaseGeneration,
      database,
    }))).resolves.toMatchObject({ destination: { id: githubDestinationA } });

    let releasePublish!: () => void;
    const publishBarrier = new Promise<void>((resolve) => { releasePublish = resolve; });
    let publishLocked!: () => void;
    const publishWasLocked = new Promise<void>((resolve) => { publishLocked = resolve; });
    const publication = withTenantContext({ orgId: fixture.orgA, userId: workerId }, async (database) => {
      await lockGitHubSyncPublishFence({
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        workerId,
        claimedRevision,
        leaseGeneration,
        database,
      });
      publishLocked();
      await publishBarrier;
      return completeGitHubSync({
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        workerId,
        claimedRevision,
        leaseGeneration,
        commitSha: "commit-fenced",
        branch: "main",
        skillCount: 1,
        database,
      });
    });
    await publishWasLocked;

    let disconnectFinished = false;
    const disconnect = deleteGitHubConnection({
      actor: fixture.owner,
      orgId: fixture.orgA,
      masterKey,
      revokeAccessToken: async () => undefined,
      database: integrationDb,
    }).then(() => { disconnectFinished = true; });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(disconnectFinished).toBe(false);

    releasePublish();
    await expect(publication).resolves.toBe(true);
    await disconnect;
    expect(disconnectFinished).toBe(true);

    const disconnected = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) =>
      database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      }));
    expect(disconnected).toMatchObject({ status: "disconnected", lastCommitSha: "commit-fenced" });

    await saveGitHubConnection({
      actor: fixture.owner,
      orgId: fixture.orgA,
      githubUserId: "github-a",
      githubLogin: "acme-a",
      accessToken: githubTokenSentinel,
      refreshToken: `${githubTokenSentinel}-refresh`,
      masterKey,
      database: integrationDb,
    });
    await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      await database.update(schema.githubSyncDestinations).set({
        status: "pending", leaseOwner: null, leaseUntil: null, nextRetryAt: null,
      }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
    });
  });

  it("rejects an old prepared tree when desired state changes and releases it without retry debt", async () => {
    const workerId = "worker-coalesce";
    const claimedRevision = 2;
    const leaseGeneration = 42;
    await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      await database.update(schema.githubSyncDestinations).set({
        desiredRevision: 3,
        appliedRevision: 1,
        status: "syncing",
        leaseOwner: workerId,
        leaseUntil: new Date(Date.now() + 60_000),
        leaseGeneration,
        attempts: 2,
      }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
      await expect(isGitHubSyncFenceLive({
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        workerId,
        claimedRevision,
        leaseGeneration,
        database,
      })).resolves.toBe(false);
      await expect(lockGitHubSyncPublishFence({
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        workerId,
        claimedRevision,
        leaseGeneration,
        database,
      })).rejects.toThrow("publish fence was lost");
      await expect(completeGitHubSync({
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        workerId,
        claimedRevision,
        leaseGeneration,
        commitSha: "stale-commit",
        branch: "main",
        skillCount: 1,
        database,
      })).resolves.toBe(false);
      await expect(failGitHubSync({
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        workerId,
        claimedRevision,
        leaseGeneration,
        error: "prepared revision superseded",
        database,
      })).resolves.toBe(true);
      const destination = await database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      });
      expect(destination).toMatchObject({
        desiredRevision: 3,
        appliedRevision: 1,
        status: "pending",
        attempts: 2,
        lastError: null,
        nextRetryAt: null,
        leaseOwner: null,
      });
    });
  });

  it("increments the lease generation on reclaim so an ABA worker identity cannot complete an old claim", async () => {
    const workerId = "worker-aba";
    await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      await database.update(schema.githubSyncDestinations).set({
        desiredRevision: 4,
        appliedRevision: 3,
        status: "pending",
        leaseOwner: null,
        leaseUntil: null,
        leaseGeneration: 100,
        attempts: 0,
        nextRetryAt: null,
      }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
    });
    const firstClaims = await integrationSql<Array<{
      org_id: string; destination_id: string; claimed_revision: number; lease_generation: number;
    }>>`select * from companion_claim_github_sync_destinations(${workerId}, 50, 300)`;
    const first = firstClaims.find((claim) => claim.destination_id === githubDestinationA);
    expect(first).toMatchObject({ claimed_revision: 4, lease_generation: 101 });

    await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      await database.update(schema.githubSyncDestinations).set({
        leaseUntil: new Date(Date.now() - 1_000),
      }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
    });
    const secondClaims = await integrationSql<Array<{
      org_id: string; destination_id: string; claimed_revision: number; lease_generation: number;
    }>>`select * from companion_claim_github_sync_destinations(${workerId}, 50, 300)`;
    const second = secondClaims.find((claim) => claim.destination_id === githubDestinationA);
    expect(second).toMatchObject({ claimed_revision: 4, lease_generation: 102 });

    await withTenantContext({ orgId: fixture.orgA, userId: workerId }, async (database) => {
      await expect(completeGitHubSync({
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        workerId,
        claimedRevision: 4,
        leaseGeneration: first!.lease_generation,
        commitSha: "stale-aba-commit",
        branch: "main",
        skillCount: 1,
        database,
      })).resolves.toBe(false);
      await expect(failGitHubSync({
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        workerId,
        claimedRevision: 4,
        leaseGeneration: first!.lease_generation,
        error: "stale claim",
        database,
      })).resolves.toBe(false);
      await expect(completeGitHubSync({
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        workerId,
        claimedRevision: 4,
        leaseGeneration: second!.lease_generation,
        commitSha: "current-commit",
        branch: "main",
        skillCount: 1,
        database,
      })).resolves.toBe(true);
    });

    for (const claim of [...firstClaims, ...secondClaims]) {
      if (claim.destination_id === githubDestinationA) continue;
      await integrationSql.begin(async (tx) => {
        await tx`select set_config('app.org_id', ${claim.org_id}, true), set_config('app.user_id', 'test-cleanup', true)`;
        await tx`update github_sync_destinations set status = 'pending', lease_owner = null, lease_until = null where id = ${claim.destination_id}::uuid`;
      });
    }
  });

  it("keeps preserved mirrors paused after reconnect until an admin explicitly resumes them", async () => {
    await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      await database.update(schema.githubSyncDestinations).set({
        status: "disconnected", leaseOwner: null, leaseUntil: null,
      }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
      await saveGitHubConnection({
        actor: fixture.owner,
        orgId: fixture.orgA,
        githubUserId: "github-a",
        githubLogin: "acme-a",
        accessToken: "reconnected-token",
        masterKey: Buffer.alloc(32, 7),
        database,
      });
      const paused = await database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      });
      expect(paused?.status).toBe("disconnected");
      await expect(requestGitHubDestinationSync({
        actor: fixture.owner,
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        database,
      })).rejects.toThrow("disconnected or unavailable");
      await expect(updateGitHubDestination({
        actor: fixture.owner,
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        patch: { mode: "selected", selected_skill_ids: [mirrorSkillA.id] },
        database,
      })).rejects.toThrow("disconnected or unavailable");
      await requestGitHubDestinationSync({
        actor: fixture.owner,
        orgId: fixture.orgA,
        destinationId: githubDestinationA,
        resumeDisconnected: true,
        database,
      });
      const resumed = await database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      });
      expect(resumed?.status).toBe("pending");
    });
  });

  it("rejects stale updates and sync requests when the GitHub connection is absent", async () => {
    const withoutConnection = async (action: (database: typeof integrationDb) => Promise<void>) => withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      async (database) => {
        await database.delete(schema.githubConnections).where(drizzleSql`${schema.githubConnections.orgId} = ${fixture.orgA}::uuid`);
        return action(database as typeof integrationDb);
      },
    );

    await expect(withoutConnection((database) => updateGitHubDestination({
      actor: fixture.owner,
      orgId: fixture.orgA,
      destinationId: githubDestinationA,
      patch: { mode: "selected", selected_skill_ids: [mirrorSkillA.id] },
      database,
    }))).rejects.toThrow("GitHub is not connected");
    await expect(withoutConnection((database) => requestGitHubDestinationSync({
      actor: fixture.owner,
      orgId: fixture.orgA,
      destinationId: githubDestinationA,
      database,
    }))).rejects.toThrow("GitHub is not connected");
  });

  it("rolls back local disconnect state when GitHub token revocation fails", async () => {
    await expect(withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) => deleteGitHubConnection({
      actor: fixture.owner,
      orgId: fixture.orgA,
      masterKey: Buffer.alloc(32, 7),
      revokeAccessToken: async () => { throw new Error("GitHub revocation unavailable"); },
      database,
    }))).rejects.toThrow("GitHub revocation unavailable");

    const persisted = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => ({
      connection: await database.query.githubConnections.findFirst({
        where: drizzleSql`${schema.githubConnections.orgId} = ${fixture.orgA}::uuid`,
      }),
      destination: await database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      }),
    }));
    expect(persisted.connection?.githubLogin).toBe("acme-a");
    expect(persisted.destination?.status).toBe("pending");
  });

  it("keeps personal provider credentials owner-only and workspace credential mutations manager-only", async () => {
    const adminVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ id: string; scope: string }>>`select id, scope from model_provider_connections order by id`;
    });
    expect(adminVisible).toEqual([{ id: orgProviderId, scope: "organization" }]);

    const developerChanged = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.developer.id}, true)`;
      return tx<Array<{ id: string }>>`
        update model_provider_connections set key_name = 'STOLEN_KEY'
        where id = ${orgProviderId}::uuid returning id
      `;
    });
    expect(developerChanged).toEqual([]);

    await expect(integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.developer.id}, true)`;
      await tx`
        insert into model_provider_connections
          (org_id, scope, provider, key_name, current_version, created_by)
        values (${fixture.orgA}::uuid, 'organization', 'mistral', 'MISTRAL_API_KEY', 1, ${fixture.developer.id})
      `;
    })).rejects.toThrow(/row-level security/);

    await expect(integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.developer.id}, true)`;
      await tx`
        insert into model_provider_credential_versions
          (org_id, connection_id, version, key_name, ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id)
        values (${fixture.orgA}::uuid, ${orgProviderId}::uuid, 2, 'OPENAI_API_KEY', 'cipher', 'iv', 'tag', 'dek', 'wrap-iv', 'wrap-tag', 'key-id')
      `;
    })).rejects.toThrow(/row-level security/);
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
