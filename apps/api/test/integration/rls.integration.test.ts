import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { schema, sql as applicationSql, withTenantContext, type Db } from "@companion/db";
import {
  completeGitHubSync,
  beginProjectActivationAdmission,
  claimProjectPromptJobs,
  claimProjectWorkspaceJobs,
  commitProjectFileUploads,
  completeProjectDeletion,
  createProject,
  createProjectSession,
  enqueueProjectPrompt,
  createGitHubDestination,
  deleteProjectAttachmentOrphanIfReserved,
  deleteGitHubConnection,
  failGitHubSync,
  getGitHubSyncPlan,
  getGitHubSkillSyncOverview,
  getGitHubUserCredential,
  GitHubSkillSyncConflictError,
  GitHubSkillSyncNotFoundError,
  isGitHubSyncFenceLive,
  getProjectSession,
  listProjectSessions,
  listProjects,
  listProjectAttachmentOrphanReservations,
  listProjectStorageKeys,
  lockGitHubSyncPublishFence,
  markProjectPromptSendAttempted,
  refreshGitHubConnectionCredential,
  requestGitHubDestinationSync,
  saveGitHubConnection,
  setGitHubDestinationSkillSelection,
  updateGitHubDestination,
  updateProject,
  updateProjectSession,
  refreshProjectsForSkillPublication,
  prepareProjectActivationInputs,
  revalidateProjectWorkspaceAuthority,
  reserveProjectAttachmentUploads,
  reserveProjectFileUploads,
  reserveProjectFileStorageObject,
  recordProjectFileVersion,
  requestProjectDeletion,
  requestProjectSessionStop,
  setProjectSkills,
  signalProjectProviderChange,
  signalProjectSecretChange,
  validateProjectActivationEnvironment,
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
  let mirrorSkillA2: SeededSkill;
  let mirrorSkillA3: SeededSkill;
  const githubDestinationA = randomUUID();
  const githubDestinationB = randomUUID();
  const projectA = randomUUID();
  const projectB = randomUUID();
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
    mirrorSkillA2 = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `mirror-a-second-${fixture.suffix}`,
      scope: "org",
    });
    mirrorSkillA3 = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `mirror-a-third-${fixture.suffix}`,
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
    await integrationSql`
      insert into projects
        (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
      values
        (${projectA}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id}, 'Owner project',
         'anthropic/claude-sonnet-4', ${projectA}, ${projectA}),
        (${projectB}::uuid, ${fixture.orgB}::uuid, ${fixture.outsider.id}, 'Other project',
         'openai/gpt-5', ${projectB}, ${projectB})
    `;
    await integrationSql`
      insert into project_workspaces (org_id, project_id, creator_id, sandbox_name)
      values
        (${fixture.orgA}::uuid, ${projectA}::uuid, ${fixture.owner.id}, ${`project-${projectA}`}),
        (${fixture.orgB}::uuid, ${projectB}::uuid, ${fixture.outsider.id}, ${`project-${projectB}`})
    `;
    await integrationSql`
      insert into project_skills (org_id, project_id, creator_id, skill_id, desired_version_id)
      values (
        ${fixture.orgA}::uuid,
        ${projectA}::uuid,
        ${fixture.owner.id},
        ${mirrorSkillA.id}::uuid,
        ${mirrorSkillA.versionId}::uuid
      )
    `;
    await integrationSql.unsafe(`create role ${role} nologin`);
    await integrationSql.unsafe(`grant ${role} to current_user with inherit true, set true`);
    await integrationSql.unsafe(`grant usage on schema public to ${role}`);
    await integrationSql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${role}`);
    await integrationSql.unsafe(`grant usage, select on all sequences in schema public to ${role}`);
    await integrationSql.unsafe(
      `grant execute on function
        companion_project_policy_definer(),
        companion_project_exact_lease_visible(uuid, uuid, text),
        companion_project_row_visible(uuid, uuid, text),
        companion_project_skill_refresh_targets(uuid, uuid),
        companion_claim_project_workspaces(text, integer, integer),
        companion_enter_project_worker_lease(uuid, uuid, text, text, integer),
        companion_signal_project_secret_change(uuid, uuid, text, text, text, secret_audience, text[]),
        companion_signal_project_provider_change(uuid, text, uuid, model_provider_connection_scope, text, text),
        companion_sandbox_usage_totals(uuid, timestamp with time zone, timestamp with time zone, timestamp with time zone)
       to ${role}`,
    );
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

  it("keeps projects and their attached skills private from same-org admins", async () => {
    const readAs = (orgId: string, userId: string) =>
      integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`;
        const projects = await tx<Array<{ id: string }>>`select id from projects order by id`;
        const skills = await tx<Array<{ project_id: string }>>`select project_id from project_skills order by project_id`;
        return { projects, skills };
      });

    await expect(readAs(fixture.orgA, fixture.owner.id)).resolves.toEqual({
      projects: [{ id: projectA }],
      skills: [{ project_id: projectA }],
    });
    await expect(readAs(fixture.orgA, fixture.admin.id)).resolves.toEqual({
      projects: [],
      skills: [],
    });
    await expect(readAs(fixture.orgB, fixture.outsider.id)).resolves.toEqual({
      projects: [{ id: projectB }],
      skills: [],
    });
  });

  it("does not treat caller-controlled Project worker GUCs as authority", async () => {
    const visible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${role}`);
      await tx`
        select set_config('app.org_id', ${fixture.orgA}, true),
               set_config('app.user_id', ${fixture.admin.id}, true),
               set_config('app.project_worker', 'exact_lease', true),
               set_config('app.project_worker_org_id', ${fixture.orgA}, true),
               set_config('app.project_worker_project_id', ${projectA}, true),
               set_config('app.project_worker_creator_id', ${fixture.owner.id}, true),
               set_config('app.project_worker_id', 'spoofed-worker', true),
               set_config('app.project_worker_lease_generation', '1', true),
               set_config('app.project_worker_context_token', ${randomUUID()}, true)
      `;
      const exact = await tx`select id from projects where id = ${projectA}::uuid`;
      await tx`select set_config('app.project_worker', 'claim', true)`;
      const broad = await tx`select id from projects where id = ${projectA}::uuid`;
      return { exact, broad };
    });
    expect(visible).toEqual({ exact: [], broad: [] });
  });

  /**
   * Product promise: provider outages retry without operator intervention, while a previously
   * activated Project whose named sandbox and checkpoint are both gone remains fail-closed.
   * This exercises the real SECURITY DEFINER claim predicate; replacing either status predicate
   * with the old max-attempt terminal gate makes the assertions fail.
   */
  it("reclaims transient Project errors but leaves unrecoverable workspaces in needs-attention", async () => {
    const transientProjectId = randomUUID();
    const skillRefreshProjectId = randomUUID();
    const promptProjectId = randomUUID();
    const unrecoverableProjectId = randomUUID();
    const promptSessionId = randomUUID();
    const workerId = `project-retry-${randomUUID()}`;
    const projectIds = [
      transientProjectId,
      skillRefreshProjectId,
      promptProjectId,
      unrecoverableProjectId,
    ];
    try {
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values
          (${transientProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Transient retry', 'openai/gpt-5', ${transientProjectId}, ${transientProjectId}),
          (${skillRefreshProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Skill refresh retry', 'openai/gpt-5',
           ${skillRefreshProjectId}, ${skillRefreshProjectId}),
          (${promptProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Prompt retry', 'openai/gpt-5', ${promptProjectId}, ${promptProjectId}),
          (${unrecoverableProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Unrecoverable workspace', 'openai/gpt-5',
           ${unrecoverableProjectId}, ${unrecoverableProjectId})
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, status,
           desired_generation, applied_generation, attempt, max_attempts,
           last_error_code, last_error_message)
        values
          (${fixture.orgA}::uuid, ${transientProjectId}::uuid, ${fixture.owner.id},
           ${`project-${transientProjectId}`}, 'error', 1, 1, 5, 5,
           'project_runtime_failed', 'Temporary provider outage'),
          (${fixture.orgA}::uuid, ${skillRefreshProjectId}::uuid, ${fixture.owner.id},
           ${`project-${skillRefreshProjectId}`}, 'error', 2, 1, 5, 5,
           'project_skill_sync_failed', 'Previous closure retained'),
          (${fixture.orgA}::uuid, ${promptProjectId}::uuid, ${fixture.owner.id},
           ${`project-${promptProjectId}`}, 'error', 1, 1, 5, 5,
           'project_skill_sync_failed', 'Previous closure retained'),
          (${fixture.orgA}::uuid, ${unrecoverableProjectId}::uuid, ${fixture.owner.id},
           ${`project-${unrecoverableProjectId}`}, 'needs_attention', 2, 1, 1, 5,
           'project_workspace_unrecoverable', 'Workspace and checkpoint are missing')
      `;
      await integrationSql`
        insert into project_sessions
          (id, org_id, project_id, creator_id, title, model, model_provider,
           model_credential_env_keys)
        values
          (${promptSessionId}::uuid, ${fixture.orgA}::uuid, ${promptProjectId}::uuid,
           ${fixture.owner.id}, 'Retry with prompt', 'openai/gpt-5', 'openai',
           array['OPENAI_API_KEY']::text[])
      `;
      await integrationSql`
        insert into project_prompts
          (org_id, project_id, session_id, creator_id, sequence, text,
           idempotency_key, payload_hash, usage_activation_revision,
           usage_reservation_ms, opencode_message_id)
        values
          (${fixture.orgA}::uuid, ${promptProjectId}::uuid, ${promptSessionId}::uuid,
           ${fixture.owner.id}, 1, 'Continue with the retained projection',
           ${`retry-${randomUUID()}`}, ${"a".repeat(64)}, 1, 600000,
           ${`msg_${randomUUID()}`})
      `;

      const claims = await integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        return tx<Array<{ project_id: string }>>`
          select project_id
          from companion_claim_project_workspaces(${workerId}, 32, 30)
        `;
      });
      const claimedIds = claims.map((claim) => claim.project_id);
      expect(claimedIds).toEqual(expect.arrayContaining([
        transientProjectId,
        skillRefreshProjectId,
        promptProjectId,
      ]));
      expect(claimedIds).not.toContain(unrecoverableProjectId);

      await expect(integrationSql<Array<{ attempt: number }>>`
        select attempt from project_workspaces
        where project_id = ${transientProjectId}::uuid
      `).resolves.toEqual([{ attempt: 5 }]);
    } finally {
      await integrationSql`
        update project_workspaces
        set lease_owner = null, lease_expires_at = null, heartbeat_at = null
        where lease_owner = ${workerId}
      `;
      await integrationSql`delete from projects where id = any(${projectIds}::uuid[])`;
    }
  });

  /**
   * Product promise: a worker crash cannot strand a warm Project after its final prompt has already
   * reached durable terminal state. The expired workspace lease is sufficient recovery authority;
   * an unexpired lease remains exclusive even when no prompt or idle deadline exists.
   *
   * Failure proof: removing `running` from the workspace claim lifecycle leaves the expired row
   * unclaimed, while ignoring the outer lease predicate claims the live row or claims the recovered
   * row twice.
   */
  it("reclaims an expired running Project without a prompt exactly once", async () => {
    const staleProjectId = randomUUID();
    const liveProjectId = randomUUID();
    const firstWorkerId = `project-running-recovery-${randomUUID()}`;
    const secondWorkerId = `project-running-contender-${randomUUID()}`;
    const projectIds = [staleProjectId, liveProjectId];
    try {
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values
          (${staleProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Expired running recovery', 'openai/gpt-5', ${staleProjectId}, ${staleProjectId}),
          (${liveProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Live running lease', 'openai/gpt-5', ${liveProjectId}, ${liveProjectId})
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, status, available_at,
           idle_deadline_at, lease_owner, lease_expires_at, heartbeat_at)
        values
          (${fixture.orgA}::uuid, ${staleProjectId}::uuid, ${fixture.owner.id},
           ${`project-${staleProjectId}`}, 'running', now() - interval '1 minute',
           null, 'crashed-worker', now() - interval '1 minute', now() - interval '2 minutes'),
          (${fixture.orgA}::uuid, ${liveProjectId}::uuid, ${fixture.owner.id},
           ${`project-${liveProjectId}`}, 'running', now() - interval '1 minute',
           null, 'live-worker', now() + interval '10 minutes', now())
      `;

      const claimAsWorkerRole = (workerId: string) =>
        integrationSql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          return tx<Array<{ project_id: string }>>`
            select project_id
            from companion_claim_project_workspaces(${workerId}, 32, 30)
          `;
        });

      const firstClaims = await claimAsWorkerRole(firstWorkerId);
      expect(firstClaims.map((claim) => claim.project_id)).toContain(staleProjectId);
      expect(firstClaims.map((claim) => claim.project_id)).not.toContain(liveProjectId);

      const secondClaims = await claimAsWorkerRole(secondWorkerId);
      expect(secondClaims.map((claim) => claim.project_id)).not.toContain(staleProjectId);
      expect(secondClaims.map((claim) => claim.project_id)).not.toContain(liveProjectId);
    } finally {
      await integrationSql`
        update project_workspaces
        set lease_owner = null, lease_expires_at = null, heartbeat_at = null
        where lease_owner in (${firstWorkerId}, ${secondWorkerId})
      `;
      await integrationSql`delete from projects where id = any(${projectIds}::uuid[])`;
    }
  });

  it("reserves Project uploads before S3 and commits or age-sweeps them without retry races", async () => {
    const uploadProjectId = randomUUID();
    const consumedKey = `${fixture.orgA}/projects/${uploadProjectId}/attachments/${randomUUID()}`;
    const orphanKey = `${fixture.orgA}/projects/${uploadProjectId}/attachments/${randomUUID()}`;
    await integrationSql`
      insert into projects
        (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
      values (${uploadProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
              'Attachment reservation project', 'openai/gpt-5',
              ${uploadProjectId}, ${uploadProjectId})
    `;
    await integrationSql`
      insert into project_workspaces (org_id, project_id, creator_id, sandbox_name)
      values (${fixture.orgA}::uuid, ${uploadProjectId}::uuid, ${fixture.owner.id},
              ${`project-${uploadProjectId}`})
    `;
    try {
      const reserve = (storageKey: string) =>
        withTenantContext(
          { orgId: fixture.orgA, userId: fixture.owner.id },
          (database) =>
            reserveProjectAttachmentUploads({
              actor: fixture.owner,
              orgId: fixture.orgA,
              projectId: uploadProjectId,
              storageKeys: [storageKey],
              database,
            }),
        );
      // Idempotent concurrent retries converge on one reservation row.
      await Promise.all([reserve(consumedKey), reserve(consumedKey)]);
      await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          createProjectSession({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: uploadProjectId,
            prompt: "Use the attachment",
            model: "openai/gpt-5",
            modelProvider: "openai",
            modelCredentialEnvKeys: ["OPENAI_API_KEY"],
            idempotencyKey: `project-attachment-${randomUUID()}`,
            attachments: [{
              id: randomUUID(),
              fileName: "brief.txt",
              contentType: "text/plain",
              byteSize: 5,
              checksum: `sha256:${"a".repeat(64)}`,
              storageKey: consumedKey,
              workspacePath: "files/brief.txt",
            }],
            database,
          }),
      );
      const [consumed] = await integrationSql<
        Array<{ reservations: number; attachments: number; committed: boolean }>
      >`
        select
          (select count(*)::int from project_attachment_uploads where storage_key = ${consumedKey}) as reservations,
          (select count(*)::int from project_attachments where storage_key = ${consumedKey}) as attachments,
          (select committed_at is not null from project_attachment_uploads
           where storage_key = ${consumedKey}) as committed
      `;
      expect(consumed).toEqual({ reservations: 1, attachments: 1, committed: true });

      await reserve(orphanKey);
      await expect(
        withTenantContext(
          { orgId: fixture.orgA, userId: fixture.owner.id },
          (database) =>
            createProjectSession({
              actor: fixture.owner,
              orgId: fixture.orgA,
              projectId: uploadProjectId,
              prompt: "Invalid path must not consume the reservation",
              model: "openai/gpt-5",
              modelProvider: "openai",
              modelCredentialEnvKeys: ["OPENAI_API_KEY"],
              idempotencyKey: `project-attachment-${randomUUID()}`,
              attachments: [{
                id: randomUUID(),
                fileName: "bad.txt",
                contentType: "text/plain",
                byteSize: 3,
                checksum: `sha256:${"b".repeat(64)}`,
                storageKey: orphanKey,
                workspacePath: "files/../bad.txt",
              }],
              database,
            }),
        ),
      ).rejects.toMatchObject({ code: "invalid_attachment_path" });
      const before = new Date("2026-07-23T00:00:00.000Z");
      await integrationSql`
        update project_attachment_uploads
        set touched_at = ${new Date("2026-07-22T00:00:00.000Z").toISOString()}
        where storage_key = ${orphanKey}
      `;
      const orphanCandidates = await listProjectAttachmentOrphanReservations({
        before,
        database: integrationDb,
      });
      expect(orphanCandidates).toContain(orphanKey);
      expect(orphanCandidates).not.toContain(consumedKey);
      let deletedKey: string | null = null;
      await expect(
        deleteProjectAttachmentOrphanIfReserved({
          storageKey: orphanKey,
          before,
          deleteObject: async () => {
            deletedKey = orphanKey;
          },
          database: integrationDb,
        }),
      ).resolves.toBe(true);
      expect(deletedKey).toBe(orphanKey);
      const [remaining] = await integrationSql<Array<{ count: number }>>`
        select count(*)::int as count
        from project_attachment_uploads
        where storage_key = ${orphanKey}
      `;
      expect(remaining?.count).toBe(0);
    } finally {
      await integrationSql`delete from projects where id = ${uploadProjectId}::uuid`;
      await integrationSql`
        delete from project_attachment_uploads
        where project_id = ${uploadProjectId}::uuid
      `;
    }
  });

  it("keeps generated-file and in-flight upload ownership after Project deletion", async () => {
    const storageProjectId = randomUUID();
    const workerId = `project-storage-${randomUUID()}`;
    const generatedKey =
      `${fixture.orgA}/project-files/${storageProjectId}/sha256/${"c".repeat(64)}`;
    const generatedOrphanKey =
      `${fixture.orgA}/project-files/${storageProjectId}/sha256/${"d".repeat(64)}`;
    const lateUploadKey =
      `${fixture.orgA}/projects/${storageProjectId}/attachments/${randomUUID()}`;
    try {
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values (${storageProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
                'Storage deletion fence', 'openai/gpt-5',
                ${storageProjectId}, ${storageProjectId})
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, status, available_at)
        values
          (${fixture.orgA}::uuid, ${storageProjectId}::uuid, ${fixture.owner.id},
           ${`project-${storageProjectId}`}, 'queued', now() - interval '1 minute')
      `;
      const jobs = await claimProjectWorkspaceJobs({
        workerId,
        limit: 32,
        leaseSeconds: 30,
        database: integrationDb,
      });
      const job = jobs.find((candidate) => candidate.projectId === storageProjectId);
      expect(job).toBeDefined();

      // Generated bytes are reserved before their external PUT and committed only with metadata.
      await reserveProjectFileStorageObject({
        job: job!,
        workerId,
        storageKey: generatedKey,
        database: integrationDb,
      });
      await recordProjectFileVersion({
        job: job!,
        workerId,
        path: "files/generated.txt",
        contentType: "text/plain",
        byteSize: 9,
        checksum: `sha256:${"c".repeat(64)}`,
        storageKey: generatedKey,
        database: integrationDb,
      });
      // Simulate a worker crash after a second generated-file PUT but before its metadata commit.
      await reserveProjectFileStorageObject({
        job: job!,
        workerId,
        storageKey: generatedOrphanKey,
        database: integrationDb,
      });

      // This models the API boundary after durable reservation but before its S3 PUT/metadata.
      await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          reserveProjectAttachmentUploads({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: storageProjectId,
            storageKeys: [lateUploadKey],
            database,
          }),
      );
      await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          requestProjectDeletion({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: storageProjectId,
            database,
          }),
      );
      await expect(
        listProjectStorageKeys({ job: job!, workerId, database: integrationDb }),
      ).resolves.toEqual(
        expect.arrayContaining([generatedKey, generatedOrphanKey, lateUploadKey]),
      );
      await expect(
        completeProjectDeletion({ job: job!, workerId, database: integrationDb }),
      ).resolves.toBe(true);

      // The ownership proof outlives the Project cascade, so a PUT completing after the eager
      // delete is still discoverable and gets a second, idempotent delete after the grace period.
      const [afterCascade] = await integrationSql<
        Array<{ project_count: number; storage_count: number; deletion_marked: number }>
      >`
        select
          (select count(*)::int from projects where id = ${storageProjectId}::uuid)
            as project_count,
          (select count(*)::int from project_attachment_uploads
           where project_id = ${storageProjectId}::uuid) as storage_count,
          (select count(*)::int from project_attachment_uploads
           where project_id = ${storageProjectId}::uuid
             and delete_requested_at is not null) as deletion_marked
      `;
      expect(afterCascade).toEqual({
        project_count: 0,
        storage_count: 3,
        deletion_marked: 3,
      });
      const before = new Date("2026-07-24T12:00:00.000Z");
      await integrationSql`
        update project_attachment_uploads
        set touched_at = ${new Date("2026-07-23T00:00:00.000Z").toISOString()}
        where storage_key in (${lateUploadKey}, ${generatedOrphanKey})
      `;
      const deletedKeys: string[] = [];
      for (const storageKey of [lateUploadKey, generatedOrphanKey]) {
        await expect(
          deleteProjectAttachmentOrphanIfReserved({
            storageKey,
            before,
            deleteObject: async () => {
              deletedKeys.push(storageKey);
            },
            database: integrationDb,
          }),
        ).resolves.toBe(true);
      }
      expect(deletedKeys).toEqual([lateUploadKey, generatedOrphanKey]);
      await expect(integrationSql`
        select storage_key
        from project_attachment_uploads
        where storage_key in (${lateUploadKey}, ${generatedOrphanKey})
      `).resolves.toHaveLength(0);
    } finally {
      await integrationSql`
        update project_workspaces
        set lease_owner = null, lease_expires_at = null, heartbeat_at = null
        where lease_owner = ${workerId}
      `;
      await integrationSql`delete from projects where id = ${storageProjectId}::uuid`;
      await integrationSql`
        delete from project_attachment_uploads
        where project_id = ${storageProjectId}::uuid
      `;
    }
  });

  it("keeps the complete Project graph and raw Project usage creator-only", async () => {
    const graphProjectId = randomUUID();
    const sessionId = randomUUID();
    const promptId = randomUUID();
    const attachmentId = randomUUID();
    const fileId = randomUUID();
    const secretId = randomUUID();
    const checksum = "a".repeat(64);
    const tables = [
      "projects",
      "project_workspaces",
      "project_skills",
      "project_skill_snapshots",
      "project_sessions",
      "project_prompts",
      "project_session_events",
      "project_attachments",
      "project_files",
      "project_file_versions",
      "project_secret_inputs",
      "project_model_provider_inputs",
      "sandbox_usage_sessions",
      "audit_log",
    ] as const;
    try {
      await integrationSql`
        insert into secrets (id, org_id, owner_id, name, key, audience)
        values (${secretId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id}, 'Project graph secret', 'GRAPH_SECRET', 'personal')
      `;
      await integrationSql`
        insert into secret_versions
          (org_id, secret_id, version, ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id, created_by)
        values
          (${fixture.orgA}::uuid, ${secretId}::uuid, 1, 'cipher', 'iv', 'tag', 'dek', 'wrap-iv', 'wrap-tag', 'key', ${fixture.owner.id})
      `;
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values (${graphProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
                'Private graph', 'anthropic/claude-sonnet-4',
                ${graphProjectId}, ${graphProjectId})
      `;
      await integrationSql`
        insert into audit_log
          (org_id, actor_id, private_to_user_id, action, target_type, target_id, metadata)
        values
          (${fixture.orgA}::uuid, ${fixture.admin.id}, ${fixture.owner.id},
           'project.skills.auto_refresh', 'project', ${graphProjectId}, '{"generation":1}'::jsonb)
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, status, desired_generation, applied_generation, activation_revision)
        values
          (${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${fixture.owner.id}, ${`project-${graphProjectId}`},
           'stopped', 1, 1, 1)
      `;
      await integrationSql`
        insert into project_skills (org_id, project_id, creator_id, skill_id, desired_version_id)
        values
          (${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${fixture.owner.id},
           ${mirrorSkillA.id}::uuid, ${mirrorSkillA.versionId}::uuid)
      `;
      await integrationSql`
        insert into project_skill_snapshots
          (org_id, project_id, creator_id, generation, root_skill_id, skill_id, skill_version_id,
           mount_order, is_root, checksum, storage_path)
        values
          (${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${fixture.owner.id}, 1,
           ${mirrorSkillA.id}::uuid, ${mirrorSkillA.id}::uuid, ${mirrorSkillA.versionId}::uuid,
           0, true, ${checksum}, 'integration/project-graph-skill.tar.gz')
      `;
      await integrationSql`
        insert into project_sessions
          (id, org_id, project_id, creator_id, title, model, model_provider,
           model_credential_env_keys, status)
        values
          (${sessionId}::uuid, ${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${fixture.owner.id},
           'Private session', 'anthropic/claude-sonnet-4', 'anthropic',
           array['ANTHROPIC_API_KEY']::text[], 'completed')
      `;
      await integrationSql`
        insert into project_prompts
          (id, org_id, project_id, session_id, creator_id, sequence, text, status,
           idempotency_key, payload_hash, usage_activation_revision,
           usage_reservation_ms, opencode_message_id)
        values
          (${promptId}::uuid, ${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${sessionId}::uuid,
           ${fixture.owner.id}, 1, 'Private prompt', 'completed', ${`graph-${promptId}`},
           ${checksum}, 1, 600000, ${`message-${promptId}`})
      `;
      await integrationSql`
        insert into project_session_events (org_id, project_id, session_id, creator_id, sequence, event)
        values
          (${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${sessionId}::uuid, ${fixture.owner.id},
           1, '{"type":"tool","name":"read"}'::jsonb)
      `;
      await integrationSql`
        insert into project_attachments
          (id, org_id, project_id, session_id, prompt_id, creator_id, file_name, content_type,
           byte_size, checksum, storage_key, workspace_path)
        values
          (${attachmentId}::uuid, ${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${sessionId}::uuid,
           ${promptId}::uuid, ${fixture.owner.id}, 'brief.txt', 'text/plain', 5, ${checksum},
           ${`projects/${graphProjectId}/attachments/${attachmentId}`}, 'files/brief.txt')
      `;
      await integrationSql`
        insert into project_files
          (id, org_id, project_id, creator_id, path, content_type, byte_size, checksum, storage_key,
           modified_by_session_id, modified_by_prompt_id)
        values
          (${fileId}::uuid, ${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${fixture.owner.id},
           'files/output.txt', 'text/plain', 5, ${checksum}, ${`projects/${graphProjectId}/files/${fileId}/1`},
           ${sessionId}::uuid, ${promptId}::uuid)
      `;
      await integrationSql`
        insert into project_file_versions
          (org_id, project_id, file_id, creator_id, version, content_type, byte_size, checksum,
           storage_key, modified_by_session_id, modified_by_prompt_id)
        values
          (${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${fileId}::uuid, ${fixture.owner.id},
           1, 'text/plain', 5, ${checksum}, ${`projects/${graphProjectId}/files/${fileId}/1`},
           ${sessionId}::uuid, ${promptId}::uuid)
      `;
      await integrationSql`
        insert into project_secret_inputs
          (org_id, project_id, creator_id, activation_revision, env_key, secret_id, secret_version,
           secret_name_snapshot, injected_at)
        values
          (${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${fixture.owner.id}, 1, 'GRAPH_SECRET',
           ${secretId}::uuid, 1, 'Project graph secret', now())
      `;
      await integrationSql`
        insert into project_model_provider_inputs
          (org_id, project_id, creator_id, activation_revision, provider, env_key, connection_id,
           credential_version, connection_scope, injected_at)
        values
          (${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${fixture.owner.id}, 1, 'anthropic',
           'ANTHROPIC_API_KEY', ${personalProviderId}::uuid, 1, 'personal', now())
      `;
      await integrationSql`
        insert into sandbox_usage_sessions
          (org_id, creator_id, kind, source_id, sandbox_name, activation_revision, period_start,
           reserved_ms, reservation_expires_at)
        values
          (${fixture.orgA}::uuid, ${fixture.owner.id}, 'project', ${graphProjectId}::uuid,
           ${`project-${graphProjectId}`}, 1, date_trunc('month', now()), 60000, now() + interval '15 minutes')
      `;

      const readAs = (orgId: string, userId: string) =>
        integrationSql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`
            select set_config('app.org_id', ${orgId}, true),
                   set_config('app.user_id', ${userId}, true)
          `;
          return tx<Array<{ table_name: string; row_count: number }>>`
            select 'projects' as table_name, count(*)::int as row_count from projects where id = ${graphProjectId}::uuid
            union all select 'project_workspaces', count(*)::int from project_workspaces where project_id = ${graphProjectId}::uuid
            union all select 'project_skills', count(*)::int from project_skills where project_id = ${graphProjectId}::uuid
            union all select 'project_skill_snapshots', count(*)::int from project_skill_snapshots where project_id = ${graphProjectId}::uuid
            union all select 'project_sessions', count(*)::int from project_sessions where project_id = ${graphProjectId}::uuid
            union all select 'project_prompts', count(*)::int from project_prompts where project_id = ${graphProjectId}::uuid
            union all select 'project_session_events', count(*)::int from project_session_events where project_id = ${graphProjectId}::uuid
            union all select 'project_attachments', count(*)::int from project_attachments where project_id = ${graphProjectId}::uuid
            union all select 'project_files', count(*)::int from project_files where project_id = ${graphProjectId}::uuid
            union all select 'project_file_versions', count(*)::int from project_file_versions where project_id = ${graphProjectId}::uuid
            union all select 'project_secret_inputs', count(*)::int from project_secret_inputs where project_id = ${graphProjectId}::uuid
            union all select 'project_model_provider_inputs', count(*)::int from project_model_provider_inputs where project_id = ${graphProjectId}::uuid
            union all select 'sandbox_usage_sessions', count(*)::int from sandbox_usage_sessions
              where kind = 'project' and source_id = ${graphProjectId}::uuid
            union all select 'audit_log', count(*)::int from audit_log
              where target_type = 'project' and target_id = ${graphProjectId}
            order by table_name
          `;
        });

      const creatorRows = await readAs(fixture.orgA, fixture.owner.id);
      expect(creatorRows.map((row) => row.table_name).sort()).toEqual(
        [...tables].sort(),
      );
      expect(creatorRows.every((row) => row.row_count === 1)).toBe(true);
      for (const actor of [fixture.admin, fixture.developer]) {
        const rows = await readAs(fixture.orgA, actor.id);
        expect(rows.every((row) => row.row_count === 0)).toBe(true);
      }
      const outsiderRows = await readAs(fixture.orgB, fixture.outsider.id);
      expect(outsiderRows.every((row) => row.row_count === 0)).toBe(true);

      const blockedWrites = await integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`
          select set_config('app.org_id', ${fixture.orgA}, true),
                 set_config('app.user_id', ${fixture.admin.id}, true)
        `;
        const workspace = await tx`
          update project_workspaces set status = 'deleted'
          where project_id = ${graphProjectId}::uuid returning project_id
        `;
        const usage = await tx`
          update sandbox_usage_sessions set reserved_ms = 120000
          where kind = 'project' and source_id = ${graphProjectId}::uuid returning id
        `;
        return { workspace, usage };
      });
      expect(blockedWrites).toEqual({ workspace: [], usage: [] });

      const aggregate = await integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`
          select set_config('app.org_id', ${fixture.orgA}, true),
                 set_config('app.user_id', ${fixture.admin.id}, true)
        `;
        return tx<Array<{ reserved_ms: string }>>`
          select reserved_ms::text
          from companion_sandbox_usage_totals(
            ${fixture.orgA}::uuid,
            date_trunc('month', now()),
            date_trunc('month', now()) + interval '1 month',
            now()
          )
        `;
      });
      expect(Number(aggregate[0]?.reserved_ms ?? 0)).toBeGreaterThanOrEqual(60_000);

      const stoppedAt = new Date("2026-07-23T12:00:00.000Z");
      await integrationSql`
        update project_workspaces
        set available_at = ${stoppedAt.toISOString()}, updated_at = ${stoppedAt.toISOString()}
        where project_id = ${graphProjectId}::uuid
      `;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(withTenantContext(
          { orgId: fixture.orgA, userId: fixture.owner.id },
          (database) =>
            requestProjectSessionStop({
              actor: fixture.owner,
              orgId: fixture.orgA,
              projectId: graphProjectId,
              sessionId,
              database,
            }),
        )).resolves.toMatchObject({ status: "completed" });
      }
      const [terminalState] = await integrationSql<
        Array<{ status: string; stop_requested_at: Date | null; available_at: string | Date }>
      >`
        select session.status, session.stop_requested_at, workspace.available_at
        from project_sessions session
        join project_workspaces workspace
          on workspace.org_id = session.org_id and workspace.project_id = session.project_id
        where session.id = ${sessionId}::uuid
      `;
      expect(terminalState).toMatchObject({
        status: "completed",
        stop_requested_at: null,
      });
      expect(new Date(terminalState!.available_at).toISOString()).toBe(
        stoppedAt.toISOString(),
      );

      await expect(integrationSql`
        insert into project_files
          (id, org_id, project_id, creator_id, path, content_type, byte_size, checksum, storage_key)
        values
          (${randomUUID()}::uuid, ${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${fixture.owner.id},
           'files/.OpenCode/auth.json', 'application/json', 2, ${checksum}, ${`blocked/${randomUUID()}`})
      `).rejects.toMatchObject({ constraint_name: "project_files_path_check" });
      await expect(integrationSql`
        insert into project_attachments
          (id, org_id, project_id, session_id, prompt_id, creator_id, file_name, content_type,
           byte_size, checksum, storage_key, workspace_path)
        values
          (${randomUUID()}::uuid, ${fixture.orgA}::uuid, ${graphProjectId}::uuid, ${sessionId}::uuid,
           ${promptId}::uuid, ${fixture.owner.id}, 'auth.json', 'application/json', 2, ${checksum},
           ${`blocked/${randomUUID()}`}, 'files/.CLAUDE/auth.json')
      `).rejects.toMatchObject({ constraint_name: "project_attachments_workspace_path_check" });
    } finally {
      await integrationSql`delete from sandbox_usage_sessions where kind = 'project' and source_id = ${graphProjectId}::uuid`;
      await integrationSql`delete from projects where id = ${graphProjectId}::uuid`;
      await integrationSql`delete from secrets where id = ${secretId}::uuid`;
    }
  });

  it("removes Project and Project-usage visibility as soon as creator membership is removed", async () => {
    const memberId = `project-removed-${randomUUID()}`;
    const memberEmail = `${memberId}@example.test`;
    const removedProjectId = randomUUID();
    try {
      await integrationSql`
        insert into "user" (id, name, email) values (${memberId}, 'Removed Project member', ${memberEmail})
      `;
      await integrationSql`
        insert into memberships (org_id, user_id, org_role)
        values (${fixture.orgA}::uuid, ${memberId}, 'developer')
      `;
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values (${removedProjectId}::uuid, ${fixture.orgA}::uuid, ${memberId},
                'Removed private project', 'openai/gpt-5',
                ${removedProjectId}, ${removedProjectId})
      `;
      await integrationSql`
        insert into project_workspaces (org_id, project_id, creator_id, sandbox_name, status)
        values (${fixture.orgA}::uuid, ${removedProjectId}::uuid, ${memberId}, ${`project-${removedProjectId}`}, 'stopped')
      `;
      await integrationSql`
        insert into sandbox_usage_sessions
          (org_id, creator_id, kind, source_id, sandbox_name, activation_revision, period_start,
           reserved_ms, reservation_expires_at)
        values
          (${fixture.orgA}::uuid, ${memberId}, 'project', ${removedProjectId}::uuid,
           ${`project-${removedProjectId}`}, 1, date_trunc('month', now()), 60000, now() + interval '15 minutes')
      `;
      const readPrivateRows = () =>
        integrationSql.begin(async (tx) => {
          await tx.unsafe(`set local role ${role}`);
          await tx`
            select set_config('app.org_id', ${fixture.orgA}, true),
                   set_config('app.user_id', ${memberId}, true)
          `;
          return tx<Array<{ projects: number; usage: number }>>`
            select
              (select count(*)::int from projects where id = ${removedProjectId}::uuid) as projects,
              (
                select count(*)::int from sandbox_usage_sessions
                where kind = 'project' and source_id = ${removedProjectId}::uuid
              ) as usage
          `;
        });
      await expect(readPrivateRows()).resolves.toEqual([{ projects: 1, usage: 1 }]);
      await integrationSql`
        delete from memberships
        where org_id = ${fixture.orgA}::uuid and user_id = ${memberId}
      `;
      await expect(readPrivateRows()).resolves.toEqual([{ projects: 0, usage: 0 }]);
      const cleanupWorker = `removed-member-cleanup-${randomUUID()}`;
      await integrationSql`
        update project_workspaces
        set status = 'deleting', lease_owner = ${cleanupWorker},
            lease_expires_at = now() + interval '30 seconds', lease_generation = 1
        where project_id = ${removedProjectId}::uuid
      `;
      const settled = await integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        const [entered] = await tx<Array<{ entered: boolean }>>`
          select companion_enter_project_worker_lease(
            ${fixture.orgA}::uuid,
            ${removedProjectId}::uuid,
            ${memberId},
            ${cleanupWorker},
            1
          ) as entered
        `;
        const rows = await tx<Array<{ id: string }>>`
          update sandbox_usage_sessions
          set ended_at = now(), settled_ms = 0
          where kind = 'project' and source_id = ${removedProjectId}::uuid
          returning id
        `;
        return { entered: entered?.entered ?? false, settled: rows.length };
      });
      expect(settled).toEqual({ entered: true, settled: 1 });
      await expect(integrationSql`
        select ended_at is not null as settled
        from sandbox_usage_sessions
        where kind = 'project' and source_id = ${removedProjectId}::uuid
      `).resolves.toEqual([{ settled: true }]);
    } finally {
      await integrationSql`delete from "user" where id = ${memberId}`;
    }
  });

  it("signals and claims exposed immediate revocations through needs-attention and retry caps", async () => {
    const secretId = randomUUID();
    const boundaryProjectId = randomUUID();
    const needsAttentionProjectId = randomUUID();
    const exhaustedProjectId = randomUUID();
    const stoppedProjectId = randomUUID();
    const projectIds = [
      boundaryProjectId,
      needsAttentionProjectId,
      exhaustedProjectId,
      stoppedProjectId,
    ];
    const checksum = "b".repeat(64);
    const workerId = `project-security-recycle-${randomUUID()}`;
    try {
      await integrationSql`
        insert into secrets (id, org_id, owner_id, name, key, audience)
        values (${secretId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id}, 'Revocation secret', 'REVOCATION_SECRET', 'personal')
      `;
      await integrationSql`
        insert into secret_versions
          (org_id, secret_id, version, ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id, created_by)
        values
          (${fixture.orgA}::uuid, ${secretId}::uuid, 1, 'cipher', 'iv', 'tag', 'dek', 'wrap-iv', 'wrap-tag', 'key', ${fixture.owner.id})
      `;
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values
          (${boundaryProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Boundary Project', 'anthropic/claude-sonnet-4',
           ${boundaryProjectId}, ${boundaryProjectId}),
          (${needsAttentionProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Needs attention Project', 'anthropic/claude-sonnet-4',
           ${needsAttentionProjectId}, ${needsAttentionProjectId}),
          (${exhaustedProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Exhausted Project', 'anthropic/claude-sonnet-4',
           ${exhaustedProjectId}, ${exhaustedProjectId}),
          (${stoppedProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Stopped Project', 'anthropic/claude-sonnet-4',
           ${stoppedProjectId}, ${stoppedProjectId})
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, sandbox_id, status,
           desired_generation, applied_generation, activation_revision,
           environment_exposure_attempted_at, environment_injected_at,
           attempt, max_attempts)
        values
          (${fixture.orgA}::uuid, ${boundaryProjectId}::uuid, ${fixture.owner.id},
           ${`project-${boundaryProjectId}`}, 'sandbox-boundary', 'ready', 1, 1, 1, now(), now(), 0, 5),
          (${fixture.orgA}::uuid, ${needsAttentionProjectId}::uuid, ${fixture.owner.id},
           ${`project-${needsAttentionProjectId}`}, 'sandbox-needs', 'needs_attention', 1, 1, 1, now(), now(), 2, 5),
          (${fixture.orgA}::uuid, ${exhaustedProjectId}::uuid, ${fixture.owner.id},
           ${`project-${exhaustedProjectId}`}, 'sandbox-exhausted', 'error', 1, 1, 1, now(), now(), 5, 5),
          (${fixture.orgA}::uuid, ${stoppedProjectId}::uuid, ${fixture.owner.id},
           ${`project-${stoppedProjectId}`}, 'sandbox-stopped', 'stopped', 1, 1, 1, null, null, 0, 5)
      `;
      await integrationSql`
        insert into project_secret_inputs
          (org_id, project_id, creator_id, activation_revision, env_key, secret_id, secret_version,
           secret_name_snapshot, injected_at)
        select ${fixture.orgA}::uuid, project_id, ${fixture.owner.id}, 1, 'REVOCATION_SECRET',
               ${secretId}::uuid, 1, 'Revocation secret', now()
        from unnest(${projectIds}::uuid[]) project_id
      `;
      await integrationSql`
        insert into project_model_provider_inputs
          (org_id, project_id, creator_id, activation_revision, provider, env_key, connection_id,
           credential_version, connection_scope, injected_at)
        select ${fixture.orgA}::uuid, project_id, ${fixture.owner.id}, 1, 'anthropic',
               'ANTHROPIC_API_KEY', ${personalProviderId}::uuid, 1, 'personal', now()
        from unnest(${projectIds}::uuid[]) project_id
      `;

      const boundaryChanged = await integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`
          select set_config('app.org_id', ${fixture.orgA}, true),
                 set_config('app.user_id', ${fixture.owner.id}, true)
        `;
        return tx<Array<{ changed: number }>>`
          select companion_signal_project_secret_change(
            ${fixture.orgA}::uuid,
            ${secretId}::uuid,
            'boundary'
          ) as changed
        `;
      });
      expect(boundaryChanged).toEqual([{ changed: 3 }]);
      const boundaryStates = await integrationSql<
        Array<{ project_id: string; recycle_reason: string | null }>
      >`
        select project_id, recycle_reason from project_workspaces
        where project_id = any(${projectIds}::uuid[])
        order by project_id
      `;
      expect(boundaryStates.find((row) => row.project_id === boundaryProjectId)?.recycle_reason)
        .toBe("boundary:secrets_changed");
      expect(
        boundaryStates.find((row) => row.project_id === needsAttentionProjectId)?.recycle_reason,
      ).toBe("boundary:secrets_changed");
      expect(
        boundaryStates.find((row) => row.project_id === exhaustedProjectId)?.recycle_reason,
      ).toBe("boundary:secrets_changed");
      expect(boundaryStates.find((row) => row.project_id === stoppedProjectId)?.recycle_reason)
        .toBeNull();

      await integrationSql`
        update project_workspaces
        set recycle_requested_at = null, recycle_reason = null
        where project_id = any(${projectIds}::uuid[])
      `;
      await integrationSql`
        update secrets set disabled_at = now()
        where org_id = ${fixture.orgA}::uuid and id = ${secretId}::uuid
      `;
      const immediateChanged = await integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`
          select set_config('app.org_id', ${fixture.orgA}, true),
                 set_config('app.user_id', ${fixture.owner.id}, true)
        `;
        return tx<Array<{ changed: number }>>`
          select companion_signal_project_secret_change(
            ${fixture.orgA}::uuid,
            ${secretId}::uuid,
            'immediate'
          ) as changed
        `;
      });
      expect(immediateChanged).toEqual([{ changed: 3 }]);

      const claims = await integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        return tx<Array<{ project_id: string; lease_generation: number }>>`
          select project_id, lease_generation
          from companion_claim_project_workspaces(${workerId}, 32, 30)
        `;
      });
      expect(claims.map((claim) => claim.project_id)).toEqual(
        expect.arrayContaining([
          boundaryProjectId,
          needsAttentionProjectId,
          exhaustedProjectId,
        ]),
      );
      expect(claims.map((claim) => claim.project_id)).not.toContain(stoppedProjectId);

      const needsClaim = claims.find((claim) => claim.project_id === needsAttentionProjectId)!;
      const exactLeaseVisibility = await integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        const [entered] = await tx<Array<{ entered: boolean }>>`
          select companion_enter_project_worker_lease(
            ${fixture.orgA}::uuid,
            ${needsAttentionProjectId}::uuid,
            ${fixture.owner.id},
            ${workerId},
            ${needsClaim.lease_generation}
          ) as entered
        `;
        const rows = await tx<Array<{ project_id: string }>>`
          select project_id from project_workspaces
          where project_id = any(${projectIds}::uuid[])
        `;
        return { entered: entered?.entered ?? false, rows };
      });
      expect(exactLeaseVisibility).toEqual({
        entered: true,
        rows: [{ project_id: needsAttentionProjectId }],
      });

      await integrationSql`
        update project_workspaces
        set lease_owner = null, lease_expires_at = null, heartbeat_at = null,
            recycle_requested_at = null, recycle_reason = null
        where lease_owner = ${workerId}
      `;
      const providerChanged = await integrationSql.begin(async (tx) => {
        await tx.unsafe(`set local role ${role}`);
        await tx`
          select set_config('app.org_id', ${fixture.orgA}, true),
                 set_config('app.user_id', ${fixture.owner.id}, true)
        `;
        return tx<Array<{ changed: number }>>`
          select companion_signal_project_provider_change(
            ${fixture.orgA}::uuid,
            'anthropic',
            ${personalProviderId}::uuid,
            'personal',
            ${fixture.owner.id},
            'immediate'
          ) as changed
        `;
      });
      expect(providerChanged).toEqual([{ changed: 3 }]);
      const providerReasons = await integrationSql<
        Array<{ project_id: string; recycle_reason: string | null }>
      >`
        select project_id, recycle_reason from project_workspaces
        where project_id = any(${projectIds}::uuid[])
      `;
      expect(
        providerReasons
          .filter((row) => row.project_id !== stoppedProjectId)
          .every((row) => row.recycle_reason === "immediate:model_connections_changed"),
      ).toBe(true);
      expect(providerReasons.find((row) => row.project_id === stoppedProjectId)?.recycle_reason)
        .toBeNull();
      expect(checksum).toHaveLength(64);
    } finally {
      await integrationSql`
        update project_workspaces
        set lease_owner = null, lease_expires_at = null, heartbeat_at = null
        where lease_owner = ${workerId}
      `;
      await integrationSql`delete from projects where id = any(${projectIds}::uuid[])`;
      await integrationSql`delete from secrets where id = ${secretId}::uuid`;
    }
  });

  it("blocks invalid Project environments without claim churn and wakes on a relevant secret change", async () => {
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const promptId = randomUUID();
    const secretIds = [randomUUID(), randomUUID()] as const;
    const excludedSecretId = randomUUID();
    const unrelatedSecretId = randomUUID();
    const workerId = `project-invalid-env-${randomUUID()}`;
    try {
      await integrationSql`
        insert into secrets (id, org_id, owner_id, name, key, audience)
        values
          (${secretIds[0]}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Duplicate one', 'DUPLICATE_PROJECT_KEY', 'personal'),
          (${secretIds[1]}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Duplicate two', 'DUPLICATE_PROJECT_KEY', 'personal'),
          (${excludedSecretId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Control plane only', 'VERCEL_TOKEN', 'personal'),
          (${unrelatedSecretId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Unrelated generic', 'UNRELATED_PROJECT_KEY', 'personal')
      `;
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values (${projectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
                'Invalid environment', 'anthropic/claude-sonnet-4',
                ${projectId}, ${projectId})
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, status, desired_generation,
           applied_generation, available_at)
        values
          (${fixture.orgA}::uuid, ${projectId}::uuid, ${fixture.owner.id},
           ${`project-${projectId}`}, 'queued', 1, 1, now() - interval '1 minute')
      `;
      const initialClaims = await claimProjectWorkspaceJobs({
        workerId,
        limit: 32,
        leaseSeconds: 30,
        database: integrationDb,
      });
      const job = initialClaims.find((candidate) => candidate.projectId === projectId);
      expect(job).toBeDefined();
      await expect(validateProjectActivationEnvironment({
        job: job!,
        workerId,
        database: integrationDb,
      })).rejects.toMatchObject({
        name: "ProjectEnvironmentInvalidError",
        code: "project_environment_invalid",
      });
      await integrationSql`
        update project_workspaces
        set status = 'error', last_error_code = 'project_environment_invalid',
            last_error_message = 'Project environment configuration is invalid.',
            lease_owner = null, lease_expires_at = null, heartbeat_at = null,
            available_at = now() - interval '1 minute'
        where project_id = ${projectId}::uuid
      `;
      await integrationSql`
        insert into project_sessions
          (id, org_id, project_id, creator_id, title, model, model_provider,
           model_credential_env_keys, status)
        values (${sessionId}::uuid, ${fixture.orgA}::uuid, ${projectId}::uuid,
                ${fixture.owner.id}, 'Queued while blocked', 'anthropic/claude-sonnet-4',
                'anthropic', array['ANTHROPIC_API_KEY']::text[], 'queued')
      `;
      await integrationSql`
        insert into project_prompts
          (id, org_id, project_id, session_id, creator_id, sequence, text, status,
           idempotency_key, payload_hash, usage_activation_revision,
           usage_reservation_ms, opencode_message_id)
        values (${promptId}::uuid, ${fixture.orgA}::uuid, ${projectId}::uuid,
                ${sessionId}::uuid, ${fixture.owner.id}, 1, 'Wait for repair', 'queued',
                ${`invalid-${promptId}`}, ${"d".repeat(64)}, 1, 600000,
                ${`message-${promptId}`})
      `;
      const blockedClaims = await claimProjectWorkspaceJobs({
        workerId: `${workerId}-blocked`,
        limit: 32,
        leaseSeconds: 30,
        database: integrationDb,
      });
      expect(blockedClaims.map((claim) => claim.projectId)).not.toContain(projectId);

      expect(await signalProjectSecretChange({
        orgId: fixture.orgA,
        secretId: excludedSecretId,
        mode: "boundary",
        changeKind: "projection",
        actorId: fixture.owner.id,
        database: integrationDb,
      })).toBe(0);
      await signalProjectSecretChange({
        orgId: fixture.orgA,
        secretId: unrelatedSecretId,
        mode: "boundary",
        changeKind: "projection",
        actorId: fixture.owner.id,
        database: integrationDb,
      });
      await expect(integrationSql`
        select status, last_error_code as error_code
        from project_workspaces where project_id = ${projectId}::uuid
      `).resolves.toEqual([{ status: "error", error_code: "project_environment_invalid" }]);

      await integrationSql`
        update secrets
        set key = 'REPAIRED_PROJECT_KEY'
        where org_id = ${fixture.orgA}::uuid and id = ${secretIds[0]}::uuid
      `;
      await signalProjectSecretChange({
        orgId: fixture.orgA,
        secretId: secretIds[0]!,
        mode: "boundary",
        changeKind: "key_acl",
        previous: {
          key: "DUPLICATE_PROJECT_KEY",
          audience: "personal",
          recipientIds: [],
        },
        actorId: fixture.owner.id,
        database: integrationDb,
      });
      const [woken] = await integrationSql<
        Array<{ status: string; error_code: string | null; recycle_at: Date | null }>
      >`
        select status, last_error_code as error_code, recycle_requested_at as recycle_at
        from project_workspaces where project_id = ${projectId}::uuid
      `;
      expect(woken).toEqual({ status: "queued", error_code: null, recycle_at: null });
      const repairedClaims = await claimProjectWorkspaceJobs({
        workerId: `${workerId}-repaired`,
        limit: 32,
        leaseSeconds: 30,
        database: integrationDb,
      });
      expect(repairedClaims.map((claim) => claim.projectId)).toContain(projectId);
    } finally {
      await integrationSql`
        update project_workspaces
        set lease_owner = null, lease_expires_at = null, heartbeat_at = null
        where project_id = ${projectId}::uuid
      `;
      await integrationSql`delete from projects where id = ${projectId}::uuid`;
      await integrationSql`
        delete from secrets
        where id = any(
          ${[...secretIds, excludedSecretId, unrelatedSecretId]}::uuid[]
        )
      `;
    }
  });

  it("never wakes a healthy Project for an excluded control-plane secret", async () => {
    const projectId = randomUUID();
    const controlPlaneSecrets = [
      { id: randomUUID(), key: "VERCEL_TOKEN" },
      { id: randomUUID(), key: "PAT_GITHUB" },
      { id: randomUUID(), key: "OAUTH_REFRESH_TOKEN" },
    ];
    try {
      await integrationSql`
        insert into secrets (id, org_id, owner_id, name, key, audience)
        values
          (${controlPlaneSecrets[0]!.id}::uuid, ${fixture.orgA}::uuid,
           ${fixture.owner.id}, 'Vercel control plane', 'VERCEL_TOKEN', 'personal'),
          (${controlPlaneSecrets[1]!.id}::uuid, ${fixture.orgA}::uuid,
           ${fixture.owner.id}, 'PAT control plane', 'PAT_GITHUB', 'personal'),
          (${controlPlaneSecrets[2]!.id}::uuid, ${fixture.orgA}::uuid,
           ${fixture.owner.id}, 'OAuth control plane', 'OAUTH_REFRESH_TOKEN', 'personal')
      `;
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values (
          ${projectId}::uuid,
          ${fixture.orgA}::uuid,
          ${fixture.owner.id},
          'Healthy excluded-secret Project',
          'anthropic/claude-sonnet-4',
          ${projectId},
          ${projectId}
        )
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, sandbox_id, status,
           activation_revision, environment_exposure_attempted_at, environment_injected_at)
        values (
          ${fixture.orgA}::uuid,
          ${projectId}::uuid,
          ${fixture.owner.id},
          ${`project-${projectId}`},
          'sandbox-control-plane',
          'ready',
          1,
          now(),
          now()
        )
      `;

      for (const secret of controlPlaneSecrets) {
        expect(await signalProjectSecretChange({
          orgId: fixture.orgA,
          secretId: secret.id,
          mode: "boundary",
          changeKind: "rotate",
          actorId: fixture.owner.id,
          database: integrationDb,
        })).toBe(0);
      }
      await expect(integrationSql`
        select recycle_requested_at as recycle_at, recycle_reason
        from project_workspaces where project_id = ${projectId}::uuid
      `).resolves.toEqual([{ recycle_at: null, recycle_reason: null }]);
    } finally {
      await integrationSql`delete from projects where id = ${projectId}::uuid`;
      await integrationSql`
        delete from secrets
        where id = any(${controlPlaneSecrets.map((secret) => secret.id)}::uuid[])
      `;
    }
  });

  it("recycles only healthy Projects whose creator can actually project the changed secret", async () => {
    const ownerProjectId = randomUUID();
    const adminProjectId = randomUUID();
    const secretId = randomUUID();
    try {
      await integrationSql`
        insert into secrets (id, org_id, owner_id, name, key, audience)
        values (
          ${secretId}::uuid,
          ${fixture.orgA}::uuid,
          ${fixture.admin.id},
          'Admin private Project secret',
          'ADMIN_PRIVATE_PROJECT_KEY',
          'personal'
        )
      `;
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values
          (${ownerProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Unrelated owner Project', 'anthropic/claude-sonnet-4',
           ${ownerProjectId}, ${ownerProjectId}),
          (${adminProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.admin.id},
           'Applicable admin Project', 'openai/gpt-5',
           ${adminProjectId}, ${adminProjectId})
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, sandbox_id, status,
           activation_revision, environment_exposure_attempted_at, environment_injected_at)
        values
          (${fixture.orgA}::uuid, ${ownerProjectId}::uuid, ${fixture.owner.id},
           ${`project-${ownerProjectId}`}, 'sandbox-unrelated-owner', 'ready', 1, now(), now()),
          (${fixture.orgA}::uuid, ${adminProjectId}::uuid, ${fixture.admin.id},
           ${`project-${adminProjectId}`}, 'sandbox-applicable-admin', 'ready', 1, now(), now())
      `;

      expect(await signalProjectSecretChange({
        orgId: fixture.orgA,
        secretId,
        mode: "boundary",
        changeKind: "rotate",
        actorId: fixture.admin.id,
        database: integrationDb,
      })).toBe(1);
      const states = await integrationSql<
        Array<{ project_id: string; recycle_reason: string | null }>
      >`
        select project_id, recycle_reason
        from project_workspaces
        where project_id = any(${[ownerProjectId, adminProjectId]}::uuid[])
      `;
      expect(states.find((row) => row.project_id === ownerProjectId)?.recycle_reason)
        .toBeNull();
      expect(states.find((row) => row.project_id === adminProjectId)?.recycle_reason)
        .toBe("boundary:secrets_changed");
    } finally {
      await integrationSql`
        delete from projects
        where id = any(${[ownerProjectId, adminProjectId]}::uuid[])
      `;
      await integrationSql`delete from secrets where id = ${secretId}::uuid`;
    }
  });

  it("reopens an invalid Project when an ACL removal repairs its exact projection", async () => {
    const projectId = randomUUID();
    const retainedSecretId = randomUUID();
    const removedSecretId = randomUUID();
    try {
      await integrationSql`
        insert into secrets (id, org_id, owner_id, name, key, audience)
        values
          (${retainedSecretId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Retained restricted', 'ACL_DUPLICATE_PROJECT_KEY', 'restricted'),
          (${removedSecretId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
           'Removed restricted', 'ACL_DUPLICATE_PROJECT_KEY', 'restricted')
      `;
      await integrationSql`
        insert into secret_recipients (org_id, secret_id, owner_id, user_id)
        values
          (${fixture.orgA}::uuid, ${retainedSecretId}::uuid, ${fixture.owner.id},
           ${fixture.admin.id}),
          (${fixture.orgA}::uuid, ${removedSecretId}::uuid, ${fixture.owner.id},
           ${fixture.admin.id})
      `;
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values (
          ${projectId}::uuid,
          ${fixture.orgA}::uuid,
          ${fixture.admin.id},
          'ACL repair Project',
          'openai/gpt-5',
          ${projectId},
          ${projectId}
        )
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, status, last_error_code,
           last_error_message, available_at)
        values (
          ${fixture.orgA}::uuid,
          ${projectId}::uuid,
          ${fixture.admin.id},
          ${`project-${projectId}`},
          'error',
          'project_environment_invalid',
          'Project environment configuration is invalid.',
          now() - interval '1 minute'
        )
      `;

      await integrationSql`
        delete from secret_recipients
        where org_id = ${fixture.orgA}::uuid
          and secret_id = ${removedSecretId}::uuid
          and user_id = ${fixture.admin.id}
      `;
      expect(await signalProjectSecretChange({
        orgId: fixture.orgA,
        secretId: removedSecretId,
        mode: "immediate",
        changeKind: "key_acl",
        previous: {
          key: "ACL_DUPLICATE_PROJECT_KEY",
          audience: "restricted",
          recipientIds: [fixture.admin.id],
        },
        actorId: fixture.owner.id,
        database: integrationDb,
      })).toBe(1);
      await expect(integrationSql`
        select status, last_error_code as error_code
        from project_workspaces where project_id = ${projectId}::uuid
      `).resolves.toEqual([{ status: "queued", error_code: null }]);
    } finally {
      await integrationSql`delete from projects where id = ${projectId}::uuid`;
      await integrationSql`
        delete from secrets
        where id = any(${[retainedSecretId, removedSecretId]}::uuid[])
      `;
    }
  });

  it("fences a pending activation admission when its projected secret changes", async () => {
    const projectId = randomUUID();
    const secretId = randomUUID();
    const admissionToken = randomUUID();
    try {
      await integrationSql`
        insert into secrets (id, org_id, owner_id, name, key, audience)
        values (
          ${secretId}::uuid,
          ${fixture.orgA}::uuid,
          ${fixture.owner.id},
          'Pending admission secret',
          'PENDING_ADMISSION_PROJECT_KEY',
          'personal'
        )
      `;
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values (
          ${projectId}::uuid,
          ${fixture.orgA}::uuid,
          ${fixture.owner.id},
          'Pending admission Project',
          'anthropic/claude-sonnet-4',
          ${projectId},
          ${projectId}
        )
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, status,
           activation_admission_token, activation_admission_revision,
           activation_admission_authority_revision, activation_admitted_at)
        values (
          ${fixture.orgA}::uuid,
          ${projectId}::uuid,
          ${fixture.owner.id},
          ${`project-${projectId}`},
          'provisioning',
          ${admissionToken}::uuid,
          1,
          ${"a".repeat(64)},
          now()
        )
      `;

      expect(await signalProjectSecretChange({
        orgId: fixture.orgA,
        secretId,
        mode: "boundary",
        changeKind: "rotate",
        actorId: fixture.owner.id,
        database: integrationDb,
      })).toBe(1);
      await expect(integrationSql`
        select recycle_requested_at is not null as recycled, recycle_reason
        from project_workspaces where project_id = ${projectId}::uuid
      `).resolves.toEqual([{
        recycled: true,
        recycle_reason: "boundary:secrets_changed",
      }]);
    } finally {
      await integrationSql`delete from projects where id = ${projectId}::uuid`;
      await integrationSql`delete from secrets where id = ${secretId}::uuid`;
    }
  });

  it("keeps provider-blocked prompts dormant and reopens a cold gate for an admitted prompt", async () => {
    const projectId = randomUUID();
    const sessionId = randomUUID();
    const promptId = randomUUID();
    const personalConnectionId = randomUUID();
    const orgConnectionId = randomUUID();
    const unrelatedConnectionId = randomUUID();
    const provider = `blocked-${randomUUID().slice(0, 8)}`;
    const unrelatedProvider = `unrelated-${randomUUID().slice(0, 8)}`;
    const workerId = `project-provider-block-${randomUUID()}`;
    try {
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values (${projectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
                'Provider blocked', ${`${provider}/model`}, ${projectId}, ${projectId})
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, status, desired_generation,
           applied_generation, last_error_code, last_error_message, available_at,
           idle_deadline_at)
        values
          (${fixture.orgA}::uuid, ${projectId}::uuid, ${fixture.owner.id},
           ${`project-${projectId}`}, 'ready', 1, 1, 'project_provider_unavailable',
           'Reconnect provider', now() - interval '1 minute', now() + interval '10 minutes')
      `;
      await integrationSql`
        insert into project_sessions
          (id, org_id, project_id, creator_id, title, model, model_provider,
           model_credential_env_keys, status)
        values
          (${sessionId}::uuid, ${fixture.orgA}::uuid, ${projectId}::uuid,
           ${fixture.owner.id}, 'Blocked prompt', ${`${provider}/model`}, ${provider},
           array['BLOCKED_PROVIDER_API_KEY']::text[], 'queued')
      `;
      await integrationSql`
        insert into project_prompts
          (id, org_id, project_id, session_id, creator_id, sequence, text, status,
           idempotency_key, payload_hash, usage_activation_revision,
           usage_reservation_ms, opencode_message_id)
        values
          (${promptId}::uuid, ${fixture.orgA}::uuid, ${projectId}::uuid,
           ${sessionId}::uuid, ${fixture.owner.id}, 1, 'Wait for provider', 'queued',
           ${`provider-${promptId}`}, ${"e".repeat(64)}, 1, 600000,
           ${`message-${promptId}`})
      `;

      const blocked = await claimProjectWorkspaceJobs({
        workerId,
        limit: 32,
        leaseSeconds: 30,
        database: integrationDb,
      });
      expect(blocked.map((claim) => claim.projectId)).not.toContain(projectId);
      // Availability alone must not reopen admission while the provider is still unavailable.
      await integrationSql`
        update project_workspaces set available_at = now() - interval '1 minute'
        where project_id = ${projectId}::uuid
      `;
      const stillBlocked = await claimProjectWorkspaceJobs({
        workerId: `${workerId}-prompt`,
        limit: 32,
        leaseSeconds: 30,
        database: integrationDb,
      });
      expect(stillBlocked.map((claim) => claim.projectId)).not.toContain(projectId);

      await integrationSql`
        insert into model_provider_connections
          (id, org_id, scope, user_id, provider, key_name, created_by)
        values
          (${unrelatedConnectionId}::uuid, ${fixture.orgA}::uuid, 'personal',
           ${fixture.owner.id}, ${unrelatedProvider}, 'UNRELATED_PROVIDER_API_KEY',
           ${fixture.owner.id})
      `;
      expect(await signalProjectProviderChange({
        orgId: fixture.orgA,
        provider: unrelatedProvider,
        connectionId: unrelatedConnectionId,
        scope: "personal",
        userId: fixture.owner.id,
        mode: "boundary",
        actorId: fixture.owner.id,
        database: integrationDb,
      })).toBe(0);
      await expect(integrationSql`
        select status, last_error_code as error_code
        from project_workspaces where project_id = ${projectId}::uuid
      `).resolves.toEqual([{
        status: "ready",
        error_code: "project_provider_unavailable",
      }]);

      await integrationSql`
        insert into model_provider_connections
          (id, org_id, scope, user_id, provider, key_name, created_by)
        values
          (${personalConnectionId}::uuid, ${fixture.orgA}::uuid, 'personal',
           ${fixture.owner.id}, ${provider}, 'BLOCKED_PROVIDER_API_KEY', ${fixture.owner.id})
      `;
      // Simulate a missed/raced connect signal: accepting a prompt with the now-effective immutable
      // credential snapshot must repair this cold, pre-exposure gate without a manual retry.
      await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          enqueueProjectPrompt({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId,
            sessionId,
            text: "Continue with the connected provider",
            idempotencyKey: `provider-recovery-${promptId}`,
            attachments: [],
            database,
          }),
      );
      const [woken] = await integrationSql<
        Array<{ status: string; error_code: string | null }>
      >`
        select status, last_error_code as error_code
        from project_workspaces where project_id = ${projectId}::uuid
      `;
      expect(woken).toEqual({ status: "queued", error_code: null });
      const admitted = await claimProjectWorkspaceJobs({
        workerId: `${workerId}-connected`,
        limit: 32,
        leaseSeconds: 30,
        database: integrationDb,
      });
      expect(admitted.map((claim) => claim.projectId)).toContain(projectId);

      await integrationSql`
        update project_workspaces
        set status = 'error', last_error_code = 'project_provider_unavailable',
            last_error_message = 'Reconnect provider',
            lease_owner = null, lease_expires_at = null, heartbeat_at = null
        where project_id = ${projectId}::uuid
      `;
      await integrationSql`
        update model_provider_connections
        set key_name = 'BLOCKED_INCOMPATIBLE_KEY'
        where id = ${personalConnectionId}::uuid
      `;
      await integrationSql`
        insert into model_provider_connections
          (id, org_id, scope, user_id, provider, key_name, created_by)
        values
          (${orgConnectionId}::uuid, ${fixture.orgA}::uuid, 'organization',
           null, ${provider}, 'BLOCKED_PROVIDER_API_KEY', ${fixture.owner.id})
      `;
      // removeConnection emits this immediate signal before deleting the personal row. The
      // compatible organization fallback must be evaluated while ignoring that soon-deleted row.
      await signalProjectProviderChange({
        orgId: fixture.orgA,
        provider,
        connectionId: personalConnectionId,
        scope: "personal",
        userId: fixture.owner.id,
        mode: "immediate",
        actorId: fixture.owner.id,
        database: integrationDb,
      });
      const [fallbackWake] = await integrationSql<
        Array<{ status: string; error_code: string | null }>
      >`
        select status, last_error_code as error_code
        from project_workspaces where project_id = ${projectId}::uuid
      `;
      expect(fallbackWake).toEqual({ status: "queued", error_code: null });
    } finally {
      await integrationSql`
        update project_workspaces
        set lease_owner = null, lease_expires_at = null, heartbeat_at = null
        where project_id = ${projectId}::uuid
      `;
      await integrationSql`delete from projects where id = ${projectId}::uuid`;
      await integrationSql`
        delete from model_provider_connections
        where id in (
          ${personalConnectionId}::uuid,
          ${orgConnectionId}::uuid,
          ${unrelatedConnectionId}::uuid
        )
      `;
    }
  });

  it("admits the first prompt with prepared but not-yet-exposed secret and provider pins", async () => {
    const firstPromptProjectId = randomUUID();
    const sessionId = randomUUID();
    const promptId = randomUUID();
    const secretId = randomUUID();
    const workerId = `project-first-prompt-${randomUUID()}`;
    const checksum = "c".repeat(64);
    try {
      await integrationSql`
        insert into secrets (id, org_id, owner_id, name, key, audience)
        values (${secretId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id}, 'First prompt secret', 'FIRST_PROMPT_SECRET', 'personal')
      `;
      await integrationSql`
        insert into secret_versions
          (org_id, secret_id, version, ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id, created_by)
        values
          (${fixture.orgA}::uuid, ${secretId}::uuid, 1, 'cipher', 'iv', 'tag', 'dek', 'wrap-iv', 'wrap-tag', 'key', ${fixture.owner.id})
      `;
      await integrationSql`
        insert into projects
          (id, org_id, creator_id, name, default_model, idempotency_key, payload_hash)
        values (${firstPromptProjectId}::uuid, ${fixture.orgA}::uuid, ${fixture.owner.id},
                'First prompt', 'anthropic/claude-sonnet-4',
                ${firstPromptProjectId}, ${firstPromptProjectId})
      `;
      await integrationSql`
        insert into project_workspaces
          (org_id, project_id, creator_id, sandbox_name, status, desired_generation,
           applied_generation, available_at)
        values
          (${fixture.orgA}::uuid, ${firstPromptProjectId}::uuid, ${fixture.owner.id},
           ${`project-${firstPromptProjectId}`}, 'provisioning', 1, 1, now() - interval '1 hour')
      `;
      await integrationSql`
        insert into project_sessions
          (id, org_id, project_id, creator_id, title, model, model_provider,
           model_credential_env_keys, status)
        values
          (${sessionId}::uuid, ${fixture.orgA}::uuid, ${firstPromptProjectId}::uuid,
           ${fixture.owner.id}, 'First prompt', 'anthropic/claude-sonnet-4', 'anthropic',
           array['ANTHROPIC_API_KEY']::text[], 'queued')
      `;
      await integrationSql`
        insert into project_prompts
          (id, org_id, project_id, session_id, creator_id, sequence, text, status,
           idempotency_key, payload_hash, usage_activation_revision,
           usage_reservation_ms, opencode_message_id)
        values
          (${promptId}::uuid, ${fixture.orgA}::uuid, ${firstPromptProjectId}::uuid,
           ${sessionId}::uuid, ${fixture.owner.id}, 1, 'Use my configured capabilities', 'queued',
           ${`first-${promptId}`}, ${checksum}, 1, 600000, ${`message-${promptId}`})
      `;
      const jobs = await claimProjectWorkspaceJobs({
        workerId,
        limit: 32,
        leaseSeconds: 30,
        database: integrationDb,
      });
      const job = jobs.find((candidate) => candidate.projectId === firstPromptProjectId);
      expect(job).toBeDefined();
      const admission = await beginProjectActivationAdmission({
        job: job!,
        workerId,
        activationRevision: 1,
        database: integrationDb,
      });
      const prepared = await prepareProjectActivationInputs({
        job: job!,
        workerId,
        activationRevision: 1,
        admissionToken: admission.token,
        database: integrationDb,
      });
      expect(prepared.secrets).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ secretId, envKey: "FIRST_PROMPT_SECRET" }),
        ]),
      );
      expect(prepared.modelProviders).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            connectionId: personalProviderId,
            envKey: "ANTHROPIC_API_KEY",
          }),
        ]),
      );
      const [preparedState] = await integrationSql<
        Array<{
          exposure: Date | null;
          secret_injected: Date | null;
          model_injected: Date | null;
        }>
      >`
        select
          workspace.environment_exposure_attempted_at as exposure,
          secret_pin.injected_at as secret_injected,
          model_pin.injected_at as model_injected
        from project_workspaces workspace
        join project_secret_inputs secret_pin
          on secret_pin.org_id = workspace.org_id
          and secret_pin.project_id = workspace.project_id
          and secret_pin.activation_revision = workspace.activation_revision
          and secret_pin.secret_id = ${secretId}::uuid
        join project_model_provider_inputs model_pin
          on model_pin.org_id = workspace.org_id
          and model_pin.project_id = workspace.project_id
          and model_pin.activation_revision = workspace.activation_revision
          and model_pin.connection_id = ${personalProviderId}::uuid
        where workspace.project_id = ${firstPromptProjectId}::uuid
      `;
      expect(preparedState).toEqual({
        exposure: null,
        secret_injected: null,
        model_injected: null,
      });
      await expect(revalidateProjectWorkspaceAuthority({
        job: job!,
        workerId,
        activationRevision: 1,
        authorityRevision: prepared.authorityRevision,
        database: integrationDb,
      })).resolves.toMatchObject({ mode: "current", recycleRequired: false });

      for (const blockedState of [
        {
          status: "queued",
          archivedAt: new Date(),
          stopRequestedAt: null,
        },
        {
          status: "queued",
          archivedAt: null,
          stopRequestedAt: new Date(),
        },
        {
          status: "stopping",
          archivedAt: null,
          stopRequestedAt: null,
        },
      ] as const) {
        await integrationDb
          .update(schema.projectSessions)
          .set(blockedState)
          .where(eq(schema.projectSessions.id, sessionId));
        await expect(
          claimProjectPromptJobs({
            job: job!,
            workerId,
            limit: 8,
            leaseSeconds: 30,
            excludeSessionIds: [],
            database: integrationDb,
          }),
        ).resolves.toEqual([]);
        const [unclaimed] = await integrationSql<
          Array<{ status: string; attempt: number }>
        >`
          select status, attempt
          from project_prompts
          where id = ${promptId}::uuid
        `;
        expect(unclaimed).toEqual({ status: "queued", attempt: 0 });
      }
      await integrationDb
        .update(schema.projectSessions)
        .set({
          status: "queued",
          archivedAt: null,
          stopRequestedAt: null,
        })
        .where(eq(schema.projectSessions.id, sessionId));

      const promptJobs = await claimProjectPromptJobs({
        job: job!,
        workerId,
        limit: 8,
        leaseSeconds: 30,
        excludeSessionIds: [],
        database: integrationDb,
      });
      expect(promptJobs).toEqual([
        expect.objectContaining({ id: promptId, sessionId, model: "anthropic/claude-sonnet-4" }),
      ]);
      expect(await signalProjectSecretChange({
        orgId: fixture.orgA,
        secretId,
        mode: "boundary",
        changeKind: "rotate",
        actorId: fixture.owner.id,
        database: integrationDb,
      })).toBe(1);
      await expect(markProjectPromptSendAttempted({
        job: job!,
        prompt: promptJobs[0]!,
        workerId,
        activationRevision: 1,
        authorityRevision: prepared.authorityRevision,
        database: integrationDb,
      })).resolves.toBe("recycle");
      const [sendFence] = await integrationSql<
        Array<{ send_attempted_at: Date | null }>
      >`
        select send_attempted_at
        from project_prompts
        where id = ${promptId}::uuid
      `;
      expect(sendFence?.send_attempted_at).toBeNull();
      await expect(prepareProjectActivationInputs({
        job: job!,
        workerId,
        activationRevision: 2,
        admissionToken: randomUUID(),
        database: integrationDb,
      })).rejects.toMatchObject({ name: "ProjectAuthorityRevokedError" });
      const [fence] = await integrationSql<
        Array<{ recycle_reason: string | null; prepared_rows: number }>
      >`
        select workspace.recycle_reason,
          (
            select count(*)::int from project_secret_inputs pin
            where pin.project_id = workspace.project_id and pin.activation_revision = 2
          ) as prepared_rows
        from project_workspaces workspace
        where workspace.project_id = ${firstPromptProjectId}::uuid
      `;
      expect(fence).toEqual({
        recycle_reason: "boundary:secrets_changed",
        prepared_rows: 0,
      });
    } finally {
      await integrationSql`
        update project_workspaces
        set lease_owner = null, lease_expires_at = null, heartbeat_at = null
        where lease_owner = ${workerId}
      `;
      await integrationSql`delete from projects where id = ${firstPromptProjectId}::uuid`;
      await integrationSql`delete from secrets where id = ${secretId}::uuid`;
    }
  });

  it("persists the private sandbox project lifecycle with optimistic revisions", async () => {
    let createdId: string | null = null;
    try {
      const created = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          createProject({
            actor: fixture.owner,
            orgId: fixture.orgA,
            value: {
              name: "Prepare the launch review",
              default_model: "anthropic/claude-sonnet-4",
              skill_slugs: [],
            },
            idempotencyKey: "project-lifecycle-create",
            database,
          }),
      );
      createdId = created.id;
      expect(created.name).toBe("Prepare the launch review");
      expect(created.revision).toBe(1);

      const renamed = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          updateProject({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: created.id,
            value: { revision: 1, name: "Launch review" },
            database,
          }),
      );
      expect(renamed).toMatchObject({ name: "Launch review", revision: 2 });

      const attached = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          setProjectSkills({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: created.id,
            value: { revision: 2, skill_slugs: [mirrorSkillA.slug] },
            database,
          }),
      );
      expect(attached.skill_count).toBe(1);
      expect(attached.skills[0]?.skill_id).toBe(mirrorSkillA.id);

      const listed = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) => listProjects({ actor: fixture.owner, orgId: fixture.orgA, database }),
      );
      expect(listed.find((project) => project.id === created.id)).toMatchObject({
        name: "Launch review",
        skill_count: 1,
      });

      const detached = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          setProjectSkills({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: created.id,
            value: { revision: 3, skill_slugs: [] },
            database,
          }),
      );
      expect(detached.skill_count).toBe(0);
    } finally {
      if (createdId) {
        await integrationSql`delete from projects where id = ${createdId}::uuid`;
      }
    }
  });

  it("reopens a completed Project conversation only after an explicit follow-up", async () => {
    let projectId: string | null = null;
    try {
      const created = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          createProject({
            actor: fixture.owner,
            orgId: fixture.orgA,
            value: {
              name: "Durable follow-up",
              default_model: "openai/gpt-5",
              skill_slugs: [],
            },
            idempotencyKey: `project-follow-up-${fixture.suffix}`,
            database,
          }),
      );
      projectId = created.id;
      const initial = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          createProjectSession({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: created.id,
            prompt: "Prepare the durable brief",
            model: "openai/gpt-5",
            modelProvider: "openai",
            modelCredentialEnvKeys: ["OPENAI_API_KEY"],
            idempotencyKey: `project-initial-${fixture.suffix}`,
            attachments: [],
            database,
          }),
      );
      await integrationDb.transaction(async (database) => {
        await database
          .update(schema.projectPrompts)
          .set({ status: "completed", completedAt: new Date() })
          .where(
            and(
              eq(schema.projectPrompts.orgId, fixture.orgA),
              eq(schema.projectPrompts.sessionId, initial.id),
            ),
          );
        await database
          .update(schema.projectSessions)
          .set({
            status: "completed",
            errorCode: "stale_error",
            userMessage: "Stale terminal copy",
          })
          .where(
            and(
              eq(schema.projectSessions.orgId, fixture.orgA),
              eq(schema.projectSessions.id, initial.id),
            ),
          );
      });

      const followUp = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          enqueueProjectPrompt({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: created.id,
            sessionId: initial.id,
            text: "Add the final sources",
            model: "openai/gpt-5",
            idempotencyKey: `project-follow-up-prompt-${fixture.suffix}`,
            attachments: [],
            database,
          }),
      );
      const reopened = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          getProjectSession({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: created.id,
            sessionId: initial.id,
            database,
          }),
      );

      expect(followUp).toMatchObject({
        sequence: 2,
        text: "Add the final sources",
        status: "queued",
      });
      expect(reopened).toMatchObject({
        status: "queued",
        stop_requested_at: null,
        error_code: null,
        message: null,
      });
    } finally {
      if (projectId) {
        await integrationSql`delete from projects where id = ${projectId}::uuid`;
      }
    }
  });

  it("versions creator uploads without invalidating Project settings revisions", async () => {
    let projectId: string | null = null;
    try {
      const created = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          createProject({
            actor: fixture.owner,
            orgId: fixture.orgA,
            value: {
              name: "Direct file upload",
              default_model: "anthropic/claude-sonnet-4",
              skill_slugs: [],
            },
            idempotencyKey: `project-file-upload-${fixture.suffix}`,
            database,
          }),
      );
      projectId = created.id;
      const checksum = `sha256:${"a".repeat(64)}`;
      const storageKey =
        `${fixture.orgA}/project-files/${created.id}/sha256/${"a".repeat(64)}`;
      const uploaded = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        async (database) => {
          await reserveProjectFileUploads({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: created.id,
            storageKeys: [storageKey],
            database,
          });
          return commitProjectFileUploads({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: created.id,
            files: [{
              path: "files/brief.txt",
              contentType: "text/plain",
              byteSize: 12,
              checksum,
              storageKey,
            }],
            database,
          });
        },
      );
      expect(uploaded).toEqual([
        expect.objectContaining({
          path: "files/brief.txt",
          version: 1,
          modified_by_session_id: null,
          modified_by_prompt_id: null,
        }),
      ]);
      const [state] = await integrationSql<Array<{
        revision: number;
        desired_file_revision: number;
        applied_file_revision: number;
      }>>`
        select project.revision,
               workspace.desired_file_revision,
               workspace.applied_file_revision
        from projects project
        join project_workspaces workspace
          on workspace.org_id = project.org_id and workspace.project_id = project.id
        where project.id = ${created.id}::uuid
      `;
      expect(state).toEqual({
        revision: 1,
        desired_file_revision: 1,
        applied_file_revision: 0,
      });

      await expect(
        withTenantContext(
          { orgId: fixture.orgA, userId: fixture.admin.id },
          (database) =>
            commitProjectFileUploads({
              actor: fixture.admin,
              orgId: fixture.orgA,
              projectId: created.id,
              files: [{
                path: "files/other.txt",
                contentType: "text/plain",
                byteSize: 1,
                checksum,
                storageKey,
              }],
              database,
            }),
        ),
      ).rejects.toMatchObject({ name: "ProjectNotFoundError" });

      await expect(
        withTenantContext(
          { orgId: fixture.orgA, userId: fixture.owner.id },
          (database) =>
            updateProject({
              actor: fixture.owner,
              orgId: fixture.orgA,
              projectId: created.id,
              value: { revision: 1, name: "Direct file upload renamed" },
              database,
            }),
        ),
      ).resolves.toMatchObject({ revision: 2, name: "Direct file upload renamed" });
    } finally {
      if (projectId) {
        await integrationSql`delete from projects where id = ${projectId}::uuid`;
      }
    }
  });

  it("keeps the conversation library ordered, searchable, archivable and creator-private", async () => {
    let projectId: string | null = null;
    const firstId = "00000000-0000-4000-8000-000000000101";
    const secondId = "00000000-0000-4000-8000-000000000102";
    const olderId = "00000000-0000-4000-8000-000000000103";
    const archivedId = "00000000-0000-4000-8000-000000000104";
    try {
      const created = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          createProject({
            actor: fixture.owner,
            orgId: fixture.orgA,
            value: {
              name: "Conversation library",
              default_model: "anthropic/claude-sonnet-4",
              skill_slugs: [],
            },
            idempotencyKey: `project-library-${fixture.suffix}`,
            database,
          }),
      );
      projectId = created.id;
      const sameCreatedAt = new Date("2026-07-23T12:00:00.000Z");
      const olderCreatedAt = new Date("2026-07-22T12:00:00.000Z");
      const viewedAt = new Date("2026-07-23T11:00:00.000Z");
      const resultAt = new Date("2026-07-23T13:00:00.000Z");
      await integrationDb.insert(schema.projectSessions).values([
        {
          id: firstId,
          orgId: fixture.orgA,
          projectId,
          creatorId: fixture.owner.id,
          title: "Launch review alpha",
          model: "anthropic/claude-sonnet-4",
          modelProvider: "anthropic",
          status: "idle",
          lastViewedAt: viewedAt,
          lastActiveAt: resultAt,
          createdAt: sameCreatedAt,
          updatedAt: resultAt,
        },
        {
          id: secondId,
          orgId: fixture.orgA,
          projectId,
          creatorId: fixture.owner.id,
          title: "Launch review beta",
          model: "anthropic/claude-sonnet-4",
          modelProvider: "anthropic",
          status: "error",
          lastViewedAt: viewedAt,
          lastActiveAt: resultAt,
          createdAt: sameCreatedAt,
          updatedAt: resultAt,
        },
        {
          id: olderId,
          orgId: fixture.orgA,
          projectId,
          creatorId: fixture.owner.id,
          title: "Older notes",
          model: "anthropic/claude-sonnet-4",
          modelProvider: "anthropic",
          status: "working",
          createdAt: olderCreatedAt,
          updatedAt: olderCreatedAt,
        },
        {
          id: archivedId,
          orgId: fixture.orgA,
          projectId,
          creatorId: fixture.owner.id,
          title: "Archived notes",
          model: "anthropic/claude-sonnet-4",
          modelProvider: "anthropic",
          status: "idle",
          archivedAt: resultAt,
          createdAt: olderCreatedAt,
          updatedAt: resultAt,
        },
      ]);

      const firstPage = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          listProjectSessions({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: projectId!,
            query: { q: "launch review", view: "active", limit: 1 },
            database,
          }),
      );
      expect(firstPage.sessions.map((session) => session.id)).toEqual([secondId]);
      expect(firstPage.next_cursor).toBeTruthy();
      const secondPage = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          listProjectSessions({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: projectId!,
            query: {
              q: "launch review",
              view: "active",
              cursor: firstPage.next_cursor!,
              limit: 1,
            },
            database,
          }),
      );
      expect(secondPage.sessions.map((session) => session.id)).toEqual([firstId]);
      expect(secondPage.sessions[0]?.is_unread).toBe(true);

      const archived = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          listProjectSessions({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: projectId!,
            query: { q: "", view: "archived", limit: 50 },
            database,
          }),
      );
      expect(archived.sessions.map((session) => session.id)).toEqual([archivedId]);

      const read = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          updateProjectSession({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: projectId!,
            sessionId: secondId,
            value: { title: "Board review", viewed: true },
            database,
          }),
      );
      expect(read).toMatchObject({ title: "Board review", is_unread: false });

      await expect(
        withTenantContext(
          { orgId: fixture.orgA, userId: fixture.owner.id },
          (database) =>
            updateProjectSession({
              actor: fixture.owner,
              orgId: fixture.orgA,
              projectId: projectId!,
              sessionId: olderId,
              value: { archived: true },
              database,
            }),
        ),
      ).rejects.toMatchObject({ name: "ProjectConflictError" });
      const stoppedAndArchived = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          updateProjectSession({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: projectId!,
            sessionId: olderId,
            value: { archived: true, stop_active: true },
            database,
          }),
      );
      expect(stoppedAndArchived).toMatchObject({
        status: "stopping",
        archived_at: expect.any(String),
      });

      for (const actor of [fixture.admin, fixture.developer]) {
        await expect(
          withTenantContext(
            { orgId: fixture.orgA, userId: actor.id },
            (database) =>
              getProjectSession({
                actor,
                orgId: fixture.orgA,
                projectId: projectId!,
                sessionId: firstId,
                database,
              }),
          ),
        ).rejects.toMatchObject({ name: "ProjectNotFoundError" });
      }
      await expect(
        withTenantContext(
          { orgId: fixture.orgB, userId: fixture.outsider.id },
          (database) =>
            listProjectSessions({
              actor: fixture.outsider,
              orgId: fixture.orgB,
              projectId: projectId!,
              query: { q: "", view: "active", limit: 50 },
              database,
            }),
        ),
      ).rejects.toMatchObject({ name: "ProjectNotFoundError" });

      const rows = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          listProjects({
            actor: fixture.owner,
            orgId: fixture.orgA,
            database,
          }),
      );
      expect(rows.find((project) => project.id === projectId)).toMatchObject({
        session_count: 2,
        active_session_count: 0,
        archived_session_count: 2,
        unread_session_count: 1,
      });

      const archivedProject = await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          updateProject({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: projectId!,
            value: { revision: 1, archived: true },
            database,
          }),
      );
      expect(archivedProject.archived_at).toEqual(expect.any(String));
      const [activeProjects, archivedProjects] = await Promise.all([
        withTenantContext(
          { orgId: fixture.orgA, userId: fixture.owner.id },
          (database) =>
            listProjects({
              actor: fixture.owner,
              orgId: fixture.orgA,
              view: "active",
              database,
            }),
        ),
        withTenantContext(
          { orgId: fixture.orgA, userId: fixture.owner.id },
          (database) =>
            listProjects({
              actor: fixture.owner,
              orgId: fixture.orgA,
              view: "archived",
              database,
            }),
        ),
      ]);
      expect(activeProjects.map((project) => project.id)).not.toContain(projectId);
      expect(archivedProjects.map((project) => project.id)).toContain(projectId);
      await withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          updateProject({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: projectId!,
            value: { revision: 2, archived: false },
            database,
          }),
      );
    } finally {
      if (projectId) {
        await integrationSql`delete from projects where id = ${projectId}::uuid`;
      }
    }
  });

  it("atomically refreshes root and transitive Project skill closures across creator RLS contexts", async () => {
    const root = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `project-refresh-root-${fixture.suffix}`,
      scope: "org",
    });
    const dependency = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `project-refresh-dependency-${fixture.suffix}`,
      scope: "org",
    });
    const leaf = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.admin,
      slug: `project-refresh-leaf-${fixture.suffix}`,
      scope: "org",
    });
    await integrationDb.insert(schema.skillVersionDependencies).values([
      {
        orgId: fixture.orgA,
        skillVersionId: root.versionId,
        skillId: root.id,
        dependsOnSlug: dependency.slug,
        dependsOnSkillId: dependency.id,
      },
      {
        orgId: fixture.orgA,
        skillVersionId: dependency.versionId,
        skillId: dependency.id,
        dependsOnSlug: leaf.slug,
        dependsOnSkillId: leaf.id,
      },
    ]);
    const projects: string[] = [];
    const publishRefreshAs = (actor: typeof fixture.owner, skillId: string) =>
      integrationDb.transaction(async (transaction) => {
        const tx = transaction as unknown as Db;
        await tx.execute(drizzleSql.raw(`set local role ${role}`));
        await tx.execute(
          drizzleSql`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${actor.id}, true)`,
        );
        return refreshProjectsForSkillPublication({
          actor,
          orgId: fixture.orgA,
          skillId,
          database: tx,
        });
      });
    const addVersion = async (input: {
      skill: SeededSkill;
      version: string;
      dependency?: SeededSkill;
    }): Promise<string> => {
      const id = randomUUID();
      await integrationDb.insert(schema.skillVersions).values({
        id,
        orgId: fixture.orgA,
        skillId: input.skill.id,
        version: input.version,
        frontmatter: JSON.stringify({
          name: input.skill.slug,
          description: `Version ${input.version}`,
          metadata: {},
        }),
        body: `# ${input.skill.slug}\n\nVersion ${input.version}`,
        sizeBytes: 160,
        checksum: `sha256:${input.version.replaceAll(".", "").padEnd(64, "b")}`,
        storagePath: `integration/${fixture.orgA}/${input.skill.slug}/${input.version}.tar.gz`,
        createdBy: fixture.owner.id,
      });
      if (input.dependency) {
        await integrationDb.insert(schema.skillVersionDependencies).values({
          orgId: fixture.orgA,
          skillVersionId: id,
          skillId: input.skill.id,
          dependsOnSlug: input.dependency.slug,
          dependsOnSkillId: input.dependency.id,
        });
      }
      await integrationDb
        .update(schema.skills)
        .set({ currentVersionId: id, updatedAt: new Date() })
        .where(drizzleSql`${schema.skills.orgId} = ${fixture.orgA}::uuid and ${schema.skills.id} = ${input.skill.id}::uuid`);
      return id;
    };

    try {
      for (const actor of [fixture.admin, fixture.developer]) {
        const project = await withTenantContext(
          { orgId: fixture.orgA, userId: actor.id },
          (database) =>
            createProject({
              actor,
              orgId: fixture.orgA,
              value: {
                name: `Refresh ${actor.name}`,
                default_model: "anthropic/claude-sonnet-4",
                skill_slugs: [root.slug],
              },
              idempotencyKey: `project-refresh-${actor.id}`,
              database,
            }),
        );
        projects.push(project.id);
      }

      const rootV2 = await addVersion({
        skill: root,
        version: "2.0.0",
        dependency,
      });
      await expect(publishRefreshAs(fixture.owner, root.id)).resolves.toEqual({
        refreshed: 2,
        failed: 0,
      });
      for (const projectId of projects) {
        const [workspace] = await integrationSql<Array<{ desired_generation: number }>>`
          select desired_generation from project_workspaces
          where org_id = ${fixture.orgA}::uuid and project_id = ${projectId}::uuid
        `;
        const snapshots = await integrationSql<
          Array<{ skill_id: string; skill_version_id: string }>
        >`
          select skill_id, skill_version_id
          from project_skill_snapshots
          where org_id = ${fixture.orgA}::uuid
            and project_id = ${projectId}::uuid
            and generation = 2
          order by mount_order
        `;
        expect(workspace?.desired_generation).toBe(2);
        expect(snapshots).toEqual(
          expect.arrayContaining([
            { skill_id: root.id, skill_version_id: rootV2 },
            { skill_id: dependency.id, skill_version_id: dependency.versionId },
            { skill_id: leaf.id, skill_version_id: leaf.versionId },
          ]),
        );
      }

      const leafV2 = await addVersion({ skill: leaf, version: "2.0.0" });
      await expect(publishRefreshAs(fixture.owner, leaf.id)).resolves.toEqual({
        refreshed: 2,
        failed: 0,
      });
      const transitive = await integrationSql<
        Array<{ project_id: string; skill_version_id: string }>
      >`
        select project_id, skill_version_id
        from project_skill_snapshots
        where org_id = ${fixture.orgA}::uuid
          and generation = 3
          and skill_id = ${leaf.id}::uuid
        order by project_id
      `;
      expect(transitive).toEqual(
        projects
          .map((projectId) => ({ project_id: projectId, skill_version_id: leafV2 }))
          .sort((left, right) => left.project_id.localeCompare(right.project_id)),
      );

      // Make the leaf private to Admin, then publish again. Admin's Project can rebuild, while
      // Developer's existing generation must remain exact and untouched.
      await integrationDb
        .update(schema.skills)
        .set({ scope: "personal", creatorId: fixture.admin.id })
        .where(drizzleSql`${schema.skills.orgId} = ${fixture.orgA}::uuid and ${schema.skills.id} = ${leaf.id}::uuid`);
      const leafV3 = await addVersion({ skill: leaf, version: "3.0.0" });
      await expect(publishRefreshAs(fixture.admin, leaf.id)).resolves.toEqual({
        refreshed: 1,
        failed: 1,
      });
      const [adminProjectId, developerProjectId] = projects as [string, string];
      const states = await integrationDb
        .select({
          projectId: schema.projectWorkspaces.projectId,
          creatorId: schema.projectWorkspaces.creatorId,
          desiredGeneration: schema.projectWorkspaces.desiredGeneration,
          status: schema.projectWorkspaces.status,
          lastErrorCode: schema.projectWorkspaces.lastErrorCode,
          skillSyncErrorAt: schema.projectWorkspaces.skillSyncErrorAt,
          skillSyncErrorCode: schema.projectWorkspaces.skillSyncErrorCode,
        })
        .from(schema.projectWorkspaces)
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, fixture.orgA),
            inArray(schema.projectWorkspaces.projectId, [
              adminProjectId,
              developerProjectId,
            ]),
          ),
        );
      expect(states.find((state) => state.creatorId === fixture.admin.id)).toMatchObject({
        desiredGeneration: 4,
      });
      expect(states.find((state) => state.creatorId === fixture.developer.id)).toMatchObject({
        desiredGeneration: 3,
        skillSyncErrorAt: expect.any(Date),
        skillSyncErrorCode: "project_skill_sync_failed",
      });
      const adminLeaf = await integrationDb
        .select({ skillVersionId: schema.projectSkillSnapshots.skillVersionId })
        .from(schema.projectSkillSnapshots)
        .where(
          and(
            eq(schema.projectSkillSnapshots.orgId, fixture.orgA),
            eq(schema.projectSkillSnapshots.projectId, adminProjectId),
            eq(schema.projectSkillSnapshots.generation, 4),
            eq(schema.projectSkillSnapshots.skillId, leaf.id),
          ),
        );
      const failedGeneration = await integrationDb
        .select({ count: drizzleSql<number>`count(*)::int` })
        .from(schema.projectSkillSnapshots)
        .where(
          and(
            eq(schema.projectSkillSnapshots.orgId, fixture.orgA),
            eq(schema.projectSkillSnapshots.projectId, developerProjectId),
            eq(schema.projectSkillSnapshots.generation, 4),
          ),
        );
      expect(adminLeaf).toEqual([{ skillVersionId: leafV3 }]);
      expect(failedGeneration[0]?.count).toBe(0);
      await integrationDb
        .update(schema.projectWorkspaces)
        .set({
          status: "ready",
          lastErrorCode: null,
          lastErrorMessage: null,
        })
        .where(
          and(
            eq(schema.projectWorkspaces.orgId, fixture.orgA),
            eq(schema.projectWorkspaces.projectId, developerProjectId),
          ),
        );
      await expect(
        integrationDb.query.projectWorkspaces.findFirst({
          where: and(
            eq(schema.projectWorkspaces.orgId, fixture.orgA),
            eq(schema.projectWorkspaces.projectId, developerProjectId),
          ),
        }),
      ).resolves.toMatchObject({
        desiredGeneration: 3,
        skillSyncErrorCode: "project_skill_sync_failed",
      });
    } finally {
      await integrationSql`delete from projects where id = any(${projects}::uuid[])`;
    }
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

  it("keeps the skill matrix tenant-scoped and mutates selected roots atomically", async () => {
    const ownerOverview = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) =>
      getGitHubSkillSyncOverview({ actor: fixture.owner, orgId: fixture.orgA, database }),
    );
    expect(ownerOverview.skills.map((skill) => skill.skill_id)).toEqual(expect.arrayContaining([
      mirrorSkillA.id,
      mirrorSkillA2.id,
      mirrorSkillA3.id,
    ]));
    expect(ownerOverview.skills.map((skill) => skill.skill_id)).not.toContain(skillA.id);
    expect(ownerOverview.skills.map((skill) => skill.skill_id)).not.toContain(skillB.id);
    expect(ownerOverview.skills.find((skill) => skill.skill_id === mirrorSkillA.id)?.destinations).toEqual([
      { destination_id: githubDestinationA, inclusion: "selected" },
    ]);

    const allDestination = randomUUID();
    const [originalVersion] = await integrationSql<Array<{ frontmatter: string }>>`
      select frontmatter from skill_versions where id = ${mirrorSkillA.versionId}::uuid
    `;
    try {
      await integrationSql`
        update skill_versions
        set frontmatter = ${JSON.stringify({ companion: { title: "Canonical mirror skill" } })}
        where id = ${mirrorSkillA.versionId}::uuid
      `;
      await integrationSql`
        insert into skill_version_dependencies
          (org_id, skill_version_id, skill_id, depends_on_slug, depends_on_skill_id)
        values
          (${fixture.orgA}::uuid, ${mirrorSkillA.versionId}::uuid, ${mirrorSkillA.id}::uuid,
           ${mirrorSkillA2.slug}, ${mirrorSkillA2.id}::uuid),
          (${fixture.orgA}::uuid, ${mirrorSkillA2.versionId}::uuid, ${mirrorSkillA2.id}::uuid,
           ${mirrorSkillA3.slug}, ${mirrorSkillA3.id}::uuid)
      `;
      await integrationSql`
        insert into github_sync_destinations
          (id, org_id, installation_id, repository_id, owner, name, html_url, default_branch, mode, created_by)
        values
          (${allDestination}::uuid, ${fixture.orgA}::uuid, 'installation-all', ${`repository-all-${allDestination}`},
           'acme-a', 'all-skills', 'https://github.com/acme-a/all-skills', 'main', 'all', ${fixture.owner.id})
      `;
      const matrix = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) =>
        getGitHubSkillSyncOverview({ actor: fixture.owner, orgId: fixture.orgA, database }),
      );
      expect(matrix.skills.find((skill) => skill.skill_id === mirrorSkillA.id)).toMatchObject({
        display_name: "Canonical mirror skill",
        destinations: expect.arrayContaining([
          { destination_id: githubDestinationA, inclusion: "selected" },
          { destination_id: allDestination, inclusion: "all" },
        ]),
      });
      for (const dependency of [mirrorSkillA2, mirrorSkillA3]) {
        expect(matrix.skills.find((skill) => skill.skill_id === dependency.id)?.destinations).toEqual(expect.arrayContaining([
          { destination_id: githubDestinationA, inclusion: "dependency" },
          { destination_id: allDestination, inclusion: "all" },
        ]));
      }
    } finally {
      await integrationSql`delete from github_sync_destinations where id = ${allDestination}::uuid`;
      await integrationSql`
        delete from skill_version_dependencies
        where skill_version_id in (${mirrorSkillA.versionId}::uuid, ${mirrorSkillA2.versionId}::uuid)
      `;
      await integrationSql`
        update skill_versions set frontmatter = ${originalVersion!.frontmatter}
        where id = ${mirrorSkillA.versionId}::uuid
      `;
    }

    await expect(withTenantContext({ orgId: fixture.orgA, userId: fixture.outsider.id }, (database) =>
      getGitHubSkillSyncOverview({ actor: fixture.outsider, orgId: fixture.orgA, database }),
    )).rejects.toThrow("not allowed to manage GitHub synchronization");

    for (const permission of [
      { actor: fixture.owner, allowed: true },
      { actor: fixture.admin, allowed: true },
      { actor: fixture.developer, allowed: false },
      { actor: fixture.outsider, allowed: false },
    ]) {
      const mutation = withTenantContext({ orgId: fixture.orgA, userId: permission.actor.id }, (database) =>
        setGitHubDestinationSkillSelection({
          actor: permission.actor,
          orgId: fixture.orgA,
          destinationId: githubDestinationA,
          skillId: mirrorSkillA.id,
          selected: true,
          database,
        }),
      );
      if (permission.allowed) await expect(mutation).resolves.toBe(false);
      else await expect(mutation).rejects.toThrow("not allowed to manage GitHub synchronization");
    }

    await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      for (const invalid of [
        { destinationId: githubDestinationB, skillId: mirrorSkillA2.id },
        { destinationId: githubDestinationA, skillId: skillB.id },
        { destinationId: githubDestinationA, skillId: skillA.id },
      ]) {
        await expect(setGitHubDestinationSkillSelection({
          actor: fixture.owner, orgId: fixture.orgA, ...invalid, selected: true, database,
        })).rejects.toBeInstanceOf(GitHubSkillSyncNotFoundError);
      }

      await database.update(schema.skills).set({ archivedAt: new Date() })
        .where(drizzleSql`${schema.skills.id} = ${mirrorSkillA2.id}::uuid`);
      await expect(setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA2.id, selected: true, database,
      })).rejects.toBeInstanceOf(GitHubSkillSyncNotFoundError);
      await database.update(schema.skills).set({ archivedAt: null })
        .where(drizzleSql`${schema.skills.id} = ${mirrorSkillA2.id}::uuid`);

      await database.update(schema.githubSyncDestinations).set({ mode: "all" })
        .where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
      await expect(setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA2.id, selected: true, database,
      })).rejects.toBeInstanceOf(GitHubSkillSyncConflictError);
      await database.update(schema.githubSyncDestinations).set({ mode: "selected", status: "disconnected" })
        .where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
      await expect(setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA2.id, selected: true, database,
      })).rejects.toBeInstanceOf(GitHubSkillSyncConflictError);
    });

    const beforeSyncing = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      await database.update(schema.githubSyncDestinations).set({
        status: "syncing",
        lastError: "stale failure",
        nextRetryAt: new Date(Date.now() + 60_000),
      }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
      return database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      });
    });
    await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      await expect(setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA2.id, selected: true, database,
      })).resolves.toBe(true);
      await expect(database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      })).resolves.toMatchObject({
        desiredRevision: (beforeSyncing?.desiredRevision ?? 0) + 1,
        status: "syncing",
        lastError: null,
        nextRetryAt: null,
      });
      await database.update(schema.githubSyncDestinations).set({
        status: "error",
        lastError: "another stale failure",
        nextRetryAt: new Date(Date.now() + 60_000),
      }).where(drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`);
      await expect(setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA2.id, selected: true, database,
      })).resolves.toBe(false);
      await expect(setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA.id, selected: false, database,
      })).resolves.toBe(true);
      await expect(setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA2.id, selected: false, database,
      })).rejects.toBeInstanceOf(GitHubSkillSyncConflictError);
      await setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA.id, selected: true, database,
      });
      await setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA2.id, selected: false, database,
      });
    });
    const after = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => ({
      destination: await database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      }),
      selections: await database.select({ skillId: schema.githubSyncDestinationSkills.skillId })
        .from(schema.githubSyncDestinationSkills)
        .where(drizzleSql`${schema.githubSyncDestinationSkills.orgId} = ${fixture.orgA}::uuid and ${schema.githubSyncDestinationSkills.destinationId} = ${githubDestinationA}::uuid`),
      audits: await database.select({ action: schema.auditLog.action }).from(schema.auditLog).where(
        drizzleSql`${schema.auditLog.orgId} = ${fixture.orgA}::uuid and ${schema.auditLog.targetId} = ${githubDestinationA} and ${schema.auditLog.action} in ('github.destination.skill_added', 'github.destination.skill_removed')`,
      ),
    }));
    expect(after.destination).toMatchObject({
      desiredRevision: (beforeSyncing?.desiredRevision ?? 0) + 4,
      status: "pending",
      lastError: null,
      nextRetryAt: null,
    });
    expect(after.selections).toEqual([{ skillId: mirrorSkillA.id }]);
    expect(after.audits).toHaveLength(4);
  });

  it("serializes concurrent selected-root mutations without losing either update", async () => {
    const before = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, (database) =>
      database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      }),
    );
    const mutateOnIndependentSession = (actor: typeof fixture.owner, skillId: string) =>
      integrationDb.transaction(async (tx) => {
        await tx.execute(drizzleSql`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${actor.id}, true)`);
        return setGitHubDestinationSkillSelection({
          actor, orgId: fixture.orgA, destinationId: githubDestinationA,
          skillId, selected: true, database: tx as unknown as Db,
        });
      });
    let releaseLifecycleLock!: () => void;
    let lifecycleLockHeld!: () => void;
    const lifecycleLockWasHeld = new Promise<void>((resolve) => { lifecycleLockHeld = resolve; });
    const lifecycleLockBarrier = new Promise<void>((resolve) => { releaseLifecycleLock = resolve; });
    const blocker = integrationDb.transaction(async (tx) => {
      await tx.execute(drizzleSql`select pg_advisory_xact_lock(hashtext(${`companion:github:${fixture.orgA}`}))`);
      lifecycleLockHeld();
      await lifecycleLockBarrier;
    });
    let mutations: Promise<[boolean, boolean]> | undefined;
    try {
      await lifecycleLockWasHeld;
      mutations = Promise.all([
        mutateOnIndependentSession(fixture.owner, mirrorSkillA2.id),
        mutateOnIndependentSession(fixture.admin, mirrorSkillA3.id),
      ]);
      let waitingOnLifecycleLock = 0;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const [locks] = await integrationSql<Array<{ waiting: number }>>`
          select count(*)::int as waiting
          from pg_locks
          where locktype = 'advisory'
            and database = (select oid from pg_database where datname = current_database())
            and not granted
        `;
        waitingOnLifecycleLock = locks?.waiting ?? 0;
        if (waitingOnLifecycleLock >= 2) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waitingOnLifecycleLock).toBeGreaterThanOrEqual(2);
      releaseLifecycleLock();
      await expect(mutations).resolves.toEqual([true, true]);
    } finally {
      releaseLifecycleLock();
      await blocker;
      await mutations?.catch(() => undefined);
    }

    const after = await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => ({
      destination: await database.query.githubSyncDestinations.findFirst({
        where: drizzleSql`${schema.githubSyncDestinations.id} = ${githubDestinationA}::uuid`,
      }),
      selections: await database.select({ skillId: schema.githubSyncDestinationSkills.skillId })
        .from(schema.githubSyncDestinationSkills)
        .where(drizzleSql`${schema.githubSyncDestinationSkills.destinationId} = ${githubDestinationA}::uuid`),
    }));
    expect(after.destination?.desiredRevision).toBe((before?.desiredRevision ?? 0) + 2);
    expect(after.selections.map((selection) => selection.skillId)).toEqual(expect.arrayContaining([
      mirrorSkillA.id,
      mirrorSkillA2.id,
      mirrorSkillA3.id,
    ]));

    await withTenantContext({ orgId: fixture.orgA, userId: fixture.owner.id }, async (database) => {
      await setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA2.id, selected: false, database,
      });
      await setGitHubDestinationSkillSelection({
        actor: fixture.owner, orgId: fixture.orgA, destinationId: githubDestinationA,
        skillId: mirrorSkillA3.id, selected: false, database,
      });
    });
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
