/**
 * Product promise:
 * Skill runs and saved configurations are creator-only, while durable queue leases remain unique
 * and recoverable across worker failure.
 *
 * Regression caught:
 * A same-tenant admin could read private run state, or two workers could claim the same command.
 *
 * Why this test is integrated:
 * Mocked builders cannot prove forced child-table RLS or PostgreSQL locking and lease semantics.
 *
 * Failure proof:
 * Relaxing a creator policy or a claim/heartbeat owner predicate must fail this suite.
 */
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  beginRunFreeze,
  claimNextRunPrompt,
  deleteRunAttachmentOrphanIfReserved,
  deleteRunConfiguration,
  deterministicRunMessageId,
  enqueueRunPrompt,
  heartbeatRunJob,
  heartbeatRunWorker,
  isRunWorkerReady,
  removeRunWorkerHeartbeat,
  reserveRunAttachmentUploads,
} from "@companion/core/services";
import { db, withTenantContext } from "@companion/db";

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) throw new Error("RunSkill integration tests require an explicit disposable DATABASE_URL");

describe("RunSkill PostgreSQL security and queue boundary", () => {
  const sql = postgres(databaseUrl, { max: 8 });
  const suffix = randomUUID();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const skillId = randomUUID();
  const versionId = randomUUID();
  const configId = randomUUID();
  const sharedSecretId = randomUUID();
  const configSecretSlotId = randomUUID();
  const providerConnectionId = randomUUID();
  const runId = randomUUID();
  const terminalRunId = randomUUID();
  const cleanupRunId = randomUUID();
  const revokedRunId = randomUUID();
  const freezeRunId = randomUUID();
  const reactivationRunId = randomUUID();
  const canceledReactivationRunId = randomUUID();
  const expiredReactivationRunId = randomUUID();
  const errorReactivationRunId = randomUUID();
  const cleanupRetentionRunId = randomUUID();
  const attachmentId = randomUUID();
  const followupAttachmentId = randomUUID();
  const incompatibleWorkerAttachmentId = randomUUID();
  const reactivationAttachmentId = randomUUID();
  const reservationAttachmentId = randomUUID();
  const legacyReplicaRunId = randomUUID();
  const legacyReplicaAttachmentId = randomUUID();
  const owner = { id: `run-owner-${suffix}`, email: `run-owner-${suffix}@example.test` };
  const admin = { id: `run-admin-${suffix}`, email: `run-admin-${suffix}@example.test` };
  const outsider = { id: `run-outsider-${suffix}`, email: `run-outsider-${suffix}@example.test` };
  const departed = { id: `run-departed-${suffix}`, email: `run-departed-${suffix}@example.test` };
  const rlsRole = `companion_run_rls_${suffix.replaceAll("-", "").slice(0, 20)}`;

  async function countsFor(orgId: string, userId: string): Promise<Record<string, number>> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`;
      const tables = [
        "skill_run_configs",
        "skill_run_config_secrets",
        "skill_run_config_variables",
        "skill_runs",
        "skill_run_skills",
        "skill_run_secret_inputs",
        "skill_run_model_provider_inputs",
        "skill_run_variable_inputs",
        "skill_run_jobs",
        "skill_run_prompts",
        "skill_run_events",
        "skill_run_attachments",
        "skill_run_attachment_uploads",
      ] as const;
      const result: Record<string, number> = {};
      for (const table of tables) {
        const rows = await tx.unsafe<{ count: number }[]>(`select count(*)::int as count from "${table}"`);
        result[table] = rows[0]?.count ?? 0;
      }
      return result;
    });
  }

  async function claim(workerId: string, leaseSeconds = 30): Promise<Array<{
    id: string;
    attempt: number;
    leaseReclaimCount: number;
  }>> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ id: string; attempt: number; leaseReclaimCount: number }[]>`
        select id, attempt, lease_reclaim_count as "leaseReclaimCount"
        from companion_claim_skill_run_jobs(${workerId}, 1, ${leaseSeconds})
      `;
    });
  }

  async function claimCleanup(workerId: string, leaseSeconds = 30): Promise<Array<{
    runId: string;
    cleanupAttempt: number;
  }>> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ runId: string; cleanupAttempt: number }[]>`
        select run_id::text as "runId", cleanup_attempt as "cleanupAttempt"
        from companion_claim_skill_run_cleanups(${workerId}, 1, ${leaseSeconds})
      `;
    });
  }

  async function completeCleanup(workerId: string): Promise<boolean> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      const rows = await tx<{ completed: boolean }[]>`
        select companion_complete_skill_run_cleanup(
          ${orgA}::uuid,
          ${cleanupRunId}::uuid,
          ${workerId}
        ) as completed
      `;
      return rows[0]?.completed ?? false;
    });
  }

  beforeAll(async () => {
    await sql`
      insert into "user" (id, name, email, email_verified)
      values
        (${owner.id}, 'Run Owner', ${owner.email}, true),
        (${admin.id}, 'Run Admin', ${admin.email}, true),
        (${outsider.id}, 'Run Outsider', ${outsider.email}, true),
        (${departed.id}, 'Run Departed', ${departed.email}, true)
    `;
    await sql`
      insert into organizations (id, name, slug)
      values
        (${orgA}::uuid, 'Run integration A', ${`run-integration-a-${suffix}`}),
        (${orgB}::uuid, 'Run integration B', ${`run-integration-b-${suffix}`})
    `;
    await sql`
      insert into memberships (org_id, user_id, org_role)
      values
        (${orgA}::uuid, ${owner.id}, 'owner'),
        (${orgA}::uuid, ${admin.id}, 'admin'),
        (${orgA}::uuid, ${departed.id}, 'developer'),
        (${orgB}::uuid, ${outsider.id}, 'owner')
    `;
    await sql`
      insert into skills (id, org_id, slug, description, creator_id, scope)
      values (${skillId}::uuid, ${orgA}::uuid, ${`run-test-${suffix}`}, 'Run test skill', ${owner.id}, 'org')
    `;
    await sql`
      insert into skill_versions
        (id, org_id, skill_id, version, frontmatter, body, size_bytes, checksum, storage_path, created_by)
      values
        (${versionId}::uuid, ${orgA}::uuid, ${skillId}::uuid, '1.0.0', '{}', '', 1,
         ${`sha256:${"a".repeat(64)}`}, ${`${orgA}/run-test/1.0.0.tar.gz`}, ${owner.id})
    `;
    await sql`update skills set current_version_id = ${versionId}::uuid where id = ${skillId}::uuid`;
    await sql`
      insert into skill_run_configs (id, org_id, skill_id, creator_id, name, model)
      values (${configId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, 'Private config', 'openai/gpt-5')
    `;
    await sql`
      insert into secrets (id, org_id, owner_id, name, key, audience)
      values (${sharedSecretId}::uuid, ${orgA}::uuid, ${owner.id}, 'Saved config key', 'SUMMARY_API_KEY', 'organization')
    `;
    await sql`
      insert into skill_secret_slots (org_id, skill_id, slot_id)
      values (${orgA}::uuid, ${skillId}::uuid, ${configSecretSlotId}::uuid)
    `;
    await sql`
      insert into skill_run_config_secrets (org_id, config_id, skill_id, slot_id, secret_id)
      values (${orgA}::uuid, ${configId}::uuid, ${skillId}::uuid, ${configSecretSlotId}::uuid, ${sharedSecretId}::uuid)
    `;
    await sql`
      insert into model_provider_connections
        (id, org_id, scope, user_id, provider, key_name, current_version, created_by)
      values
        (${providerConnectionId}::uuid, ${orgA}::uuid, 'personal', ${owner.id}, 'openai', 'OPENAI_API_KEY', 1, ${owner.id})
    `;
    await sql`
      insert into model_provider_credential_versions
        (org_id, connection_id, version, key_name, ciphertext, iv, auth_tag, wrapped_dek, wrap_iv, wrap_auth_tag, key_id)
      values
        (${orgA}::uuid, ${providerConnectionId}::uuid, 1, 'OPENAI_API_KEY', 'cipher', 'iv', 'tag', 'dek', 'wrap-iv', 'wrap-tag', 'key-id')
    `;
    await sql`
      insert into skill_run_config_variables (org_id, config_id, skill_id, env_key, value)
      values (${orgA}::uuid, ${configId}::uuid, ${skillId}::uuid, 'OUTPUT_FORMAT', 'json')
    `;
    for (const [id, idempotency, status, age] of [
      [runId, "integration-active", "queued", "0 hours"],
      [terminalRunId, "integration-terminal", "frozen", "25 hours"],
    ] as const) {
      await sql`
        insert into skill_runs
          (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
           payload_hash, model, prompt, status, phase, frozen_at, sandbox_cleaned_at, updated_at)
        values
          (${id}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid, '1.0.0',
           ${idempotency}, ${"b".repeat(64)}, 'openai/gpt-5', 'integration prompt', ${status}::skill_run_status,
           ${status === "frozen" ? "complete" : "queued"}::skill_run_phase,
           ${status === "frozen" ? sql`now() - interval '25 hours'` : null},
           ${status === "frozen" ? sql`now() - interval '25 hours'` : null},
           now() - ${age}::interval)
      `;
      await sql`
        insert into skill_run_events (org_id, run_id, sequence, type, payload, created_at)
        values (${orgA}::uuid, ${id}::uuid, 1, 'status', '{"state":"idle"}'::jsonb, now() - ${age}::interval)
      `;
    }
    await sql`
      insert into skill_runs
        (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
         payload_hash, model, prompt, status, phase, sandbox_name)
      values
        (${cleanupRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
         '1.0.0', 'integration-cleanup', ${"d".repeat(64)}, 'openai/gpt-5', 'cleanup prompt',
         'error', 'complete', ${`run-${cleanupRunId.slice(0, 8)}`})
    `;
    await sql`
      insert into skill_runs
        (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
         payload_hash, model, prompt, status, phase, sandbox_name, sandbox_id, sandbox_domain,
         opencode_session_id, reactivatable_until, frozen_at)
      values
        (${reactivationRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
         '1.0.0', 'integration-reactivate', ${"e".repeat(64)}, 'openai/gpt-5', 'resume prompt',
         'frozen', 'complete', ${`run-${reactivationRunId.slice(0, 8)}`},
         ${`run-${reactivationRunId.slice(0, 8)}`}, 'https://reactivate.example.test',
         'session-reactivate', now() + interval '7 days', now())
    `;
    await sql`
      insert into skill_run_jobs (org_id, run_id, creator_id, status, phase, attempt)
      values (${orgA}::uuid, ${reactivationRunId}::uuid, ${owner.id}, 'completed', 'complete', 1)
    `;
    await sql`
      insert into skill_run_prompts
        (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id, prompt, status, completed_at)
      values
        (${orgA}::uuid, ${reactivationRunId}::uuid, 0, 'initial', 'initial:integration-reactivate',
         ${"f".repeat(64)}, ${deterministicRunMessageId(reactivationRunId, 0, Date.now())},
         'resume prompt', 'completed', now())
    `;
    await sql`
      insert into skill_runs
        (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
         payload_hash, model, prompt, status, phase, sandbox_name, reactivatable_until, frozen_at,
         sandbox_cleaned_at)
      values
        (${canceledReactivationRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
         '1.0.0', 'integration-reactivate-canceled', ${"2".repeat(64)}, 'openai/gpt-5',
         'initial prompt before session creation', 'canceled', 'complete',
         ${`run-${canceledReactivationRunId.slice(0, 8)}`}, now() + interval '7 days', now(), null),
        (${expiredReactivationRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
         '1.0.0', 'integration-reactivate-expired', ${"3".repeat(64)}, 'openai/gpt-5',
         'expired prompt', 'canceled', 'complete', ${`run-${expiredReactivationRunId.slice(0, 8)}`},
         now() - interval '1 second', now() - interval '7 days', now()),
        (${errorReactivationRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
         '1.0.0', 'integration-reactivate-error', ${"4".repeat(64)}, 'openai/gpt-5',
         'failed prompt', 'error', 'complete', ${`run-${errorReactivationRunId.slice(0, 8)}`},
         null, null, now()),
        (${cleanupRetentionRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
         '1.0.0', 'integration-retention-cleanup', ${"5".repeat(64)}, 'openai/gpt-5',
         'retained cleanup prompt', 'frozen', 'complete', ${`run-${cleanupRetentionRunId.slice(0, 8)}`},
         now() + interval '7 days', now(), null)
    `;
    await sql`
      insert into skill_run_jobs (org_id, run_id, creator_id, status, phase)
      values
        (${orgA}::uuid, ${canceledReactivationRunId}::uuid, ${owner.id}, 'canceled', 'complete'),
        (${orgA}::uuid, ${expiredReactivationRunId}::uuid, ${owner.id}, 'canceled', 'complete'),
        (${orgA}::uuid, ${errorReactivationRunId}::uuid, ${owner.id}, 'failed', 'complete'),
        (${orgA}::uuid, ${cleanupRetentionRunId}::uuid, ${owner.id}, 'completed', 'complete')
    `;
    await sql`
      insert into skill_run_prompts
        (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id, prompt, status,
         completed_at)
      values
        (${orgA}::uuid, ${canceledReactivationRunId}::uuid, 0, 'initial',
         'initial:integration-reactivate-canceled', ${"6".repeat(64)},
         ${deterministicRunMessageId(canceledReactivationRunId, 0, Date.now())},
         'initial prompt before session creation', 'canceled', null)
    `;
    await sql`
      insert into skill_runs
        (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
         payload_hash, model, prompt, status, phase, sandbox_name)
      values
        (${freezeRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
         '1.0.0', 'integration-freeze', ${"1".repeat(64)}, 'openai/gpt-5', 'freeze prompt',
         'running', 'record', ${`run-${freezeRunId.slice(0, 8)}`})
    `;
    await sql`
      insert into skill_runs
        (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
         payload_hash, model, prompt, status, phase, sandbox_name, sandbox_id)
      values
        (${revokedRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${departed.id}, ${versionId}::uuid,
         '1.0.0', 'integration-revoked', ${"e".repeat(64)}, 'openai/gpt-5', 'revoked prompt',
         'running', 'record', ${`run-${revokedRunId.slice(0, 8)}`}, 'sandbox-revoked')
    `;
    await sql`
      insert into skill_run_skills (org_id, run_id, skill_id, skill_version_id, is_root, mount_order)
      values (${orgA}::uuid, ${runId}::uuid, ${skillId}::uuid, ${versionId}::uuid, true, 0)
    `;
    await sql`
      insert into skill_run_secret_inputs
        (org_id, run_id, source_key, env_key, provenance, required)
      values (${orgA}::uuid, ${runId}::uuid, 'opencode-server-password', 'OPENCODE_SERVER_PASSWORD', 'runtime', true)
    `;
    await sql`
      insert into skill_run_model_provider_inputs
        (org_id, run_id, provider, env_key, connection_id, credential_version, connection_scope)
      values
        (${orgA}::uuid, ${runId}::uuid, 'openai', 'OPENAI_API_KEY', ${providerConnectionId}::uuid, 1, 'personal')
    `;
    await sql`
      insert into skill_run_variable_inputs (org_id, run_id, skill_id, env_key, value)
      values (${orgA}::uuid, ${runId}::uuid, ${skillId}::uuid, 'OUTPUT_FORMAT', 'json')
    `;
    await sql`
      insert into skill_run_jobs (org_id, run_id, creator_id)
      values (${orgA}::uuid, ${runId}::uuid, ${owner.id})
    `;
    await sql`
      insert into skill_run_jobs
        (org_id, run_id, creator_id, status, phase, attempt, lease_owner, lease_expires_at)
      values
        (${orgA}::uuid, ${revokedRunId}::uuid, ${departed.id}, 'leased', 'record', 1,
         'revoked-worker', now() + interval '5 minutes')
    `;
    await sql`
      insert into skill_run_jobs
        (org_id, run_id, creator_id, status, phase, attempt, lease_owner, lease_expires_at)
      values
        (${orgA}::uuid, ${freezeRunId}::uuid, ${owner.id}, 'leased', 'record', 1,
         'freeze-worker', now() + interval '5 minutes')
    `;
    await sql`
      insert into skill_run_worker_heartbeats
        (worker_id, expires_at, attachment_prompt_protocol)
      values ('freeze-worker', now() - interval '1 minute', 1)
      on conflict (worker_id) do update
      set expires_at = excluded.expires_at,
          attachment_prompt_protocol = excluded.attachment_prompt_protocol
    `;
    const initialPromptRows = await sql<{ id: string }[]>`
      insert into skill_run_prompts
        (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id, user_text, prompt)
      values
        (${orgA}::uuid, ${runId}::uuid, 0, 'initial', 'integration-prompt', ${"c".repeat(64)},
         ${deterministicRunMessageId(runId, 0, Date.now())}, 'prompt', 'prompt')
      returning id
    `;
    await sql`
      insert into skill_run_prompts
        (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id, user_text, prompt)
      values
        (${orgA}::uuid, ${revokedRunId}::uuid, 1, 'follow_up', 'revoked-prompt',
         ${"f".repeat(64)}, ${deterministicRunMessageId(revokedRunId, 1, Date.now())},
         'pending after departure', 'pending after departure')
    `;
    await sql`
      insert into skill_run_attachments (id, org_id, run_id, prompt_id, file_name, content_type, byte_size, storage_key)
      values
        (${attachmentId}::uuid, ${orgA}::uuid, ${runId}::uuid, ${initialPromptRows[0]!.id}::uuid,
         'input.txt', 'text/plain', 1, ${`${orgA}/run-attachments/${attachmentId}`})
    `;
    await sql`
      insert into skill_run_attachment_uploads (storage_key, org_id, creator_id)
      values (${`${orgA}/run-attachments/reserved-${suffix}`} , ${orgA}::uuid, ${owner.id})
    `;
    await sql.unsafe(`create role ${rlsRole} nologin nosuperuser nobypassrls`);
    await sql.unsafe(`grant ${rlsRole} to current_user with inherit true, set true`);
    await sql.unsafe(`grant usage on schema public to ${rlsRole}`);
    await sql.unsafe(`grant select, insert, update, delete on all tables in schema public to ${rlsRole}`);
    await sql.unsafe(`grant usage, select on all sequences in schema public to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_claim_skill_run_jobs(text, integer, integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_get_skill_run_worker_control(uuid, uuid, text, text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_terminalize_revoked_skill_run(uuid, uuid, text, text, boolean) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_claim_skill_run_cleanups(text, integer, integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_complete_skill_run_cleanup(uuid, uuid, text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_cleanup_skill_run_events(integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_heartbeat_skill_run_worker(text, integer, integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_remove_skill_run_worker(text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_skill_run_worker_ready() to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_skill_run_attachment_worker_ready() to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_skill_run_attachment_worker_ready(uuid, uuid, text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_secret_usage_count(uuid, uuid) to ${rlsRole}`);
  });

  afterAll(async () => {
    await sql`delete from organizations where id in (${orgA}::uuid, ${orgB}::uuid)`;
    await sql`delete from "user" where id in (${owner.id}, ${admin.id}, ${outsider.id}, ${departed.id})`;
    await sql.unsafe(`drop owned by ${rlsRole}`);
    await sql.unsafe(`revoke ${rlsRole} from current_user`);
    await sql.unsafe(`drop role ${rlsRole}`);
    await sql.end();
  });

  it("keeps runs, configurations, and every child creator-only", async () => {
    const creator = await countsFor(orgA, owner.id);
    expect(Object.values(creator).every((count) => count >= 1)).toBe(true);
    expect(Object.values(await countsFor(orgA, admin.id)).every((count) => count === 0)).toBe(true);
    expect(Object.values(await countsFor(orgB, outsider.id)).every((count) => count === 0)).toBe(true);
  });

  it("does not treat caller-controlled worker GUCs as an RLS authority", async () => {
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      await tx`select set_config('app.run_worker', 'cleanup', true)`;
      const runs = await tx<{ count: number }[]>`select count(*)::int as count from skill_runs`;
      const deleted = await tx<{ runId: string }[]>`
        delete from skill_run_events where org_id = ${orgA}::uuid returning run_id::text as "runId"
      `;
      await tx`select set_config('app.run_worker', 'claim', true)`;
      const jobs = await tx<{ count: number }[]>`select count(*)::int as count from skill_run_jobs`;
      return { runs: runs[0]?.count ?? -1, jobs: jobs[0]?.count ?? -1, deleted: deleted.length };
    });
    expect(result).toEqual({ runs: 0, jobs: 0, deleted: 0 });
  });

  it("keeps model-provider credentials outside Secrets while counting saved-configuration usage", async () => {
    const genericProviderSecrets = await sql<{ count: number }[]>`
      select count(*)::int as count
      from secrets
      where org_id = ${orgA}::uuid and key = 'OPENAI_API_KEY'
    `;
    expect(genericProviderSecrets).toEqual([{ count: 0 }]);

    const usageFor = (userId: string) => sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      await tx`select set_config('app.org_id', ${orgA}, true), set_config('app.user_id', ${userId}, true)`;
      const rows = await tx<{ count: number }[]>`
        select companion_secret_usage_count(${orgA}::uuid, ${sharedSecretId}::uuid)::int as count
      `;
      return rows[0]?.count ?? -1;
    });
    await expect(usageFor(owner.id)).resolves.toBe(1);
    await expect(usageFor(admin.id)).resolves.toBe(0);
  });

  it("deletes a used configuration while preserving the run name snapshot", async () => {
    await sql`
      update skill_runs
      set run_config_id = ${configId}::uuid, run_config_name_snapshot = 'Private config'
      where org_id = ${orgA}::uuid and id = ${runId}::uuid
    `;
    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        deleteRunConfiguration({
          actor: { id: owner.id, email: owner.email, name: "Run Owner" },
          orgId: orgA,
          configId,
          value: { revision: 1 },
          database,
        }),
      ),
    ).resolves.toBeUndefined();
    const rows = await sql<{ configId: string | null; name: string | null }[]>`
      select run_config_id::text as "configId", run_config_name_snapshot as name
      from skill_runs where org_id = ${orgA}::uuid and id = ${runId}::uuid
    `;
    expect(rows).toEqual([{ configId: null, name: "Private config" }]);
  });

  it("claims a job once across workers and reclaims it only after lease expiry", async () => {
    const firstClaims = await Promise.all([claim("worker-a"), claim("worker-b")]);
    expect(firstClaims.flat()).toHaveLength(1);
    expect(firstClaims.flat()[0]).toMatchObject({ attempt: 1, leaseReclaimCount: 0 });
    expect(await claim("worker-c")).toHaveLength(0);

    await sql`
      update skill_run_jobs
      set lease_expires_at = now() - interval '1 second', heartbeat_at = now() - interval '1 second'
      where org_id = ${orgA}::uuid and run_id = ${runId}::uuid
    `;
    const reclaimed = await claim("worker-c");
    expect(reclaimed).toHaveLength(1);
    expect(reclaimed[0]).toMatchObject({ attempt: 1, leaseReclaimCount: 1 });

    // Only an explicit transient-failure requeue consumes the next execution attempt.
    await sql`
      update skill_run_jobs
      set status = 'queued', lease_owner = null, lease_expires_at = null, available_at = now()
      where org_id = ${orgA}::uuid and run_id = ${runId}::uuid
    `;
    const retried = await claim("worker-d");
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ attempt: 2, leaseReclaimCount: 1 });
  });

  it("rejects stale lease heartbeats and exposes only live worker readiness", async () => {
    await sql`update skill_run_worker_heartbeats set expires_at = now() - interval '1 second'`;
    await sql`
      update skill_run_jobs
      set lease_expires_at = now() - interval '1 second'
      where org_id = ${orgA}::uuid and run_id = ${runId}::uuid
    `;
    const actor = { id: owner.id, email: owner.email, name: "Run Owner" };
    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        heartbeatRunJob({
          actor,
          orgId: orgA,
          runId,
          workerId: "worker-d",
          leaseSeconds: 30,
          database,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        claimNextRunPrompt({
          actor,
          orgId: orgA,
          runId,
          workerId: "worker-d",
          leaseSeconds: 30,
          database,
        }),
      ),
    ).rejects.toMatchObject({ name: "LostRunLeaseError" });

    await withTenantContext({ orgId: orgA, userId: owner.id }, async (database) => {
      expect(await isRunWorkerReady({ database })).toBe(false);
      await heartbeatRunWorker({ workerId: "readiness-worker", ttlSeconds: 15, database });
      expect(await isRunWorkerReady({ database })).toBe(true);
      await removeRunWorkerHeartbeat({ workerId: "readiness-worker", database });
      expect(await isRunWorkerReady({ database })).toBe(false);
    });
  });

  it("terminalizes and leaves cleanup owed when a leased run owner loses membership", async () => {
    await sql`
      delete from skill_run_events
      where org_id = ${orgA}::uuid and run_id = ${revokedRunId}::uuid
    `;
    await sql`
      update skill_runs set transcript_event_sequence = 42
      where org_id = ${orgA}::uuid and id = ${revokedRunId}::uuid
    `;
    await sql`delete from memberships where org_id = ${orgA}::uuid and user_id = ${departed.id}`;
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      await tx`select set_config('app.org_id', ${orgA}, true), set_config('app.user_id', ${departed.id}, true)`;
      const hidden = await tx<{ count: number }[]>`
        select count(*)::int as count from skill_runs where id = ${revokedRunId}::uuid
      `;
      const wrong = await tx`
        select * from companion_get_skill_run_worker_control(
          ${orgA}::uuid, ${revokedRunId}::uuid, ${departed.id}, 'wrong-worker'
        )
      `;
      const control = await tx<{
        membershipActive: boolean;
        sandboxName: string;
        sandboxId: string;
      }[]>`
        select membership_active as "membershipActive", sandbox_name as "sandboxName", sandbox_id as "sandboxId"
        from companion_get_skill_run_worker_control(
          ${orgA}::uuid, ${revokedRunId}::uuid, ${departed.id}, 'revoked-worker'
        )
      `;
      const terminalized = await tx<{ completed: boolean }[]>`
        select companion_terminalize_revoked_skill_run(
          ${orgA}::uuid, ${revokedRunId}::uuid, ${departed.id}, 'revoked-worker', false
        ) as completed
      `;
      const context = await tx<{ worker: string; org: string }[]>`
        select current_setting('app.run_worker', true) as worker,
               current_setting('app.run_worker_org_id', true) as org
      `;
      return {
        hidden: hidden[0]?.count,
        wrong: wrong.length,
        control,
        terminalized: terminalized[0]?.completed,
        context: context[0],
      };
    });
    expect(result).toEqual({
      hidden: 0,
      wrong: 0,
      control: [{
        membershipActive: false,
        sandboxName: `run-${revokedRunId.slice(0, 8)}`,
        sandboxId: "sandbox-revoked",
      }],
      terminalized: true,
      context: { worker: "", org: "" },
    });
    const rows = await sql<{
      status: string;
      phase: string;
      errorCode: string | null;
      cleaned: boolean;
      jobStatus: string;
      promptStatus: string;
      eventType: string;
      eventSequence: number;
    }[]>`
      select r.status::text, r.phase::text, r.error_code as "errorCode",
             r.sandbox_cleaned_at is not null as cleaned, j.status::text as "jobStatus",
             p.status::text as "promptStatus", e.type as "eventType", e.sequence as "eventSequence"
      from skill_runs r
      join skill_run_jobs j on j.org_id = r.org_id and j.run_id = r.id
      join skill_run_prompts p on p.org_id = r.org_id and p.run_id = r.id
      join skill_run_events e on e.org_id = r.org_id and e.run_id = r.id
      where r.org_id = ${orgA}::uuid and r.id = ${revokedRunId}::uuid
    `;
    expect(rows).toEqual([{
      status: "error",
      phase: "record",
      errorCode: "membership_revoked",
      cleaned: false,
      jobStatus: "failed",
      promptStatus: "canceled",
      eventType: "run.error",
      eventSequence: 43,
    }]);
    // Keep the following cleanup-lease test isolated after proving the failed destroy remains owed.
    await sql`
      update skill_runs set sandbox_cleaned_at = now()
      where org_id = ${orgA}::uuid and id = ${revokedRunId}::uuid
    `;
  });

  it("atomically links an attachment-only follow-up to its visible and runtime prompt", async () => {
    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', attachment_prompt_protocol = 1
      where worker_id = 'freeze-worker'
    `;
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    const request = {
      actor: runActor,
      orgId: orgA,
      runId: freezeRunId,
      text: "",
      idempotencyKey: "attachment-follow-up-request",
      attachments: [{
        id: followupAttachmentId,
        fileName: "brief.pdf",
        contentType: "application/pdf",
        byteSize: 42,
        storageKey: `${orgA}/run-attachments/${followupAttachmentId}`,
      }],
    };
    await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      reserveRunAttachmentUploads({
        actor: runActor,
        orgId: orgA,
        storageKeys: request.attachments.map((attachment) => attachment.storageKey),
        database,
      }),
    );
    const first = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      enqueueRunPrompt({ ...request, database }),
    );
    const replay = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      enqueueRunPrompt({ ...request, database }),
    );
    expect(replay).toEqual(first);
    expect(first.attachments).toMatchObject([{
      id: followupAttachmentId,
      prompt_id: first.id,
      message_id: first.messageId,
      file_name: "brief.pdf",
    }]);
    const rows = await sql<{ userText: string; prompt: string; promptId: string }[]>`
      select p.user_text as "userText", p.prompt, a.prompt_id as "promptId"
      from skill_run_prompts p
      join skill_run_attachments a
        on a.org_id = p.org_id and a.run_id = p.run_id and a.prompt_id = p.id
      where p.org_id = ${orgA}::uuid and p.run_id = ${freezeRunId}::uuid and p.id = ${first.id}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userText).toBe("");
    expect(rows[0]?.prompt).toContain(`./attachments/${followupAttachmentId}-brief.pdf`);
    expect(rows[0]?.promptId).toBe(first.id);

    // Keep the subsequent freeze-race scenario isolated; deleting the prompt cascades its file row.
    await sql`
      delete from skill_run_prompts
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid and id = ${first.id}::uuid
    `;
  });

  it("serializes orphan deletion with a retry reservation and prompt consumption", async () => {
    const storageKey = `${orgA}/run-attachments/${reservationAttachmentId}`;
    await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      reserveRunAttachmentUploads({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        storageKeys: [storageKey],
        database,
      }),
    );
    await sql`update skill_run_attachment_uploads set touched_at = now() - interval '2 days' where storage_key = ${storageKey}`;

    let releaseDelete!: () => void;
    const deleteGate = new Promise<void>((resolve) => { releaseDelete = resolve; });
    let enteredDelete!: () => void;
    const deleteEntered = new Promise<void>((resolve) => { enteredDelete = resolve; });
    const cleanup = deleteRunAttachmentOrphanIfReserved({
      storageKey,
      before: new Date(Date.now() - 24 * 60 * 60 * 1_000),
      database: db,
      deleteObject: async () => {
        enteredDelete();
        await deleteGate;
      },
    });
    await deleteEntered;
    let retrySettled = false;
    const retry = withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      reserveRunAttachmentUploads({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        storageKeys: [storageKey],
        database,
      }),
    ).then(() => { retrySettled = true; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(retrySettled).toBe(false);
    releaseDelete();
    await expect(cleanup).resolves.toBe(true);
    await retry;

    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', attachment_prompt_protocol = 1
      where worker_id = 'freeze-worker'
    `;
    const accepted = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      enqueueRunPrompt({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        runId: freezeRunId,
        text: "consume retry",
        idempotencyKey: "reservation-race-consume",
        attachments: [{
          id: reservationAttachmentId,
          fileName: "race.txt",
          contentType: "text/plain",
          byteSize: 1,
          storageKey,
        }],
        database,
      }),
    );
    const reservations = await sql<{ count: number }[]>`
      select count(*)::int as count from skill_run_attachment_uploads where storage_key = ${storageKey}
    `;
    expect(reservations).toEqual([{ count: 0 }]);
    await sql`delete from skill_run_prompts where id = ${accepted.id}::uuid`;
  });

  it("keeps pre-0037 API inserts compatible during a rolling deployment", async () => {
    await sql.begin(async (tx) => {
      await tx`
        insert into skill_runs
          (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
           payload_hash, model, prompt, status, phase, sandbox_name)
        values
          (${legacyReplicaRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
           '1.0.0', 'legacy-replica-run', ${"9".repeat(64)}, 'openai/gpt-5', 'legacy visible prompt',
           'queued', 'queued', ${`run-${legacyReplicaRunId.slice(0, 8)}`})
      `;
      // The old API inserted launch attachment metadata before its initial prompt and omitted both
      // columns introduced by 0037.
      await tx`
        insert into skill_run_attachments
          (id, org_id, run_id, file_name, content_type, byte_size, storage_key)
        values
          (${legacyReplicaAttachmentId}::uuid, ${orgA}::uuid, ${legacyReplicaRunId}::uuid,
           'legacy.txt', 'text/plain', 1, ${`${orgA}/run-attachments/${legacyReplicaAttachmentId}`})
      `;
      await tx`
        insert into skill_run_prompts
          (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id, prompt)
        values
          (${orgA}::uuid, ${legacyReplicaRunId}::uuid, 0, 'initial', 'legacy-initial',
           ${"8".repeat(64)}, ${deterministicRunMessageId(legacyReplicaRunId, 0, Date.now())},
           'legacy composed runtime prompt with internal instructions')
      `;
    });
    const rows = await sql<{ promptId: string; userText: string }[]>`
      select a.prompt_id as "promptId", p.user_text as "userText"
      from skill_run_attachments a
      join skill_run_prompts p
        on p.org_id = a.org_id and p.run_id = a.run_id and p.id = a.prompt_id
      where a.id = ${legacyReplicaAttachmentId}::uuid
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.promptId).toBeTruthy();
    expect(rows[0]?.userText).toBe("legacy visible prompt");
    await sql`delete from skill_runs where org_id = ${orgA}::uuid and id = ${legacyReplicaRunId}::uuid`;
  });

  it("rejects follow-up files while the active worker lacks the mounting protocol", async () => {
    await sql`
      update skill_run_worker_heartbeats
      set attachment_prompt_protocol = 0
      where worker_id = 'freeze-worker'
    `;
    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        enqueueRunPrompt({
          actor: { id: owner.id, email: owner.email, name: "Run Owner" },
          orgId: orgA,
          runId: freezeRunId,
          text: "",
          idempotencyKey: "unsupported-worker-attachment",
          attachments: [{
            id: incompatibleWorkerAttachmentId,
            fileName: "unsupported.txt",
            contentType: "text/plain",
            byteSize: 1,
            storageKey: `${orgA}/run-attachments/${incompatibleWorkerAttachmentId}`,
          }],
          database,
        }),
      ),
    ).rejects.toMatchObject({ code: "attachment_worker_unavailable" });
    await sql`
      update skill_run_worker_heartbeats
      set attachment_prompt_protocol = 1
      where worker_id = 'freeze-worker'
    `;
  });

  it("prevents a protocol-0 worker from reclaiming a lease with pending attachments", async () => {
    const pendingPromptId = randomUUID();
    const pendingAttachmentId = randomUUID();
    await sql`
      insert into skill_run_prompts
        (id, org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id, user_text, prompt, status)
      values
        (${pendingPromptId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 1, 'follow_up', 'reclaim-guard',
         ${"7".repeat(64)}, ${deterministicRunMessageId(freezeRunId, 1, Date.now())}, '', 'runtime', 'queued')
    `;
    await sql`
      insert into skill_run_attachments
        (id, org_id, run_id, prompt_id, file_name, content_type, byte_size, storage_key)
      values
        (${pendingAttachmentId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, ${pendingPromptId}::uuid,
         'reclaim.txt', 'text/plain', 1, ${`${orgA}/run-attachments/${pendingAttachmentId}`})
    `;
    await sql`
      update skill_run_jobs
      set status = 'leased', lease_owner = 'expired-protocol-1', lease_expires_at = now() - interval '1 second'
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
    `;
    await sql`
      update skill_run_jobs
      set available_at = now() + interval '1 hour'
      where run_id <> ${freezeRunId}::uuid
        and (status = 'queued' or (status = 'leased' and lease_expires_at <= now()))
    `;
    await sql`
      insert into skill_run_worker_heartbeats (worker_id, expires_at, attachment_prompt_protocol)
      values ('legacy-reclaimer', now() + interval '5 minutes', 0),
             ('modern-reclaimer', now() + interval '5 minutes', 1)
      on conflict (worker_id) do update set expires_at = excluded.expires_at,
        attachment_prompt_protocol = excluded.attachment_prompt_protocol
    `;
    expect(await claim("legacy-reclaimer")).toEqual([]);
    expect(await claim("modern-reclaimer")).toHaveLength(1);
    await sql`delete from skill_run_prompts where id = ${pendingPromptId}::uuid`;
    await sql`
      update skill_run_jobs
      set status = 'leased', lease_owner = 'freeze-worker', lease_expires_at = now() + interval '5 minutes'
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
    `;
  });

  it("closes prompt admission atomically before inactivity teardown", async () => {
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        beginRunFreeze({
          actor: runActor,
          orgId: orgA,
          runId: freezeRunId,
          workerId: "freeze-worker",
          database,
        }),
      ),
    ).resolves.toBe("ready");
    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        enqueueRunPrompt({
          actor: runActor,
          orgId: orgA,
          runId: freezeRunId,
          text: "too late",
          idempotencyKey: "freeze-rejected-prompt",
          database,
        }),
      ),
    ).rejects.toMatchObject({ code: "run_not_running" });

    await sql`
      update skill_runs set phase = 'record'
      where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid
    `;
    await sql`
      insert into skill_run_prompts
        (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id, user_text, prompt)
      values
        (${orgA}::uuid, ${freezeRunId}::uuid, 1, 'follow_up', 'freeze-pending-prompt',
         ${"2".repeat(64)}, ${deterministicRunMessageId(freezeRunId, 1, Date.now())},
         'won the run lock first', 'won the run lock first')
    `;
    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        beginRunFreeze({
          actor: runActor,
          orgId: orgA,
          runId: freezeRunId,
          workerId: "freeze-worker",
          database,
        }),
      ),
    ).resolves.toBe("prompt_pending");
    const phases = await sql<{ phase: string }[]>`
      select phase::text from skill_runs where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid
    `;
    expect(phases).toEqual([{ phase: "record" }]);
  });

  it("reactivates a retained creator-only conversation and requeues its durable job", async () => {
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    const reactivationStorageKey = `${orgA}/run-attachments/${reactivationAttachmentId}`;
    await heartbeatRunWorker({ workerId: "reactivation-protocol-worker", ttlSeconds: 30, database: db });
    await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      reserveRunAttachmentUploads({
        actor: runActor,
        orgId: orgA,
        storageKeys: [reactivationStorageKey],
        database,
      }),
    );
    const result = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      enqueueRunPrompt({
        actor: runActor,
        orgId: orgA,
        runId: reactivationRunId,
        text: "Continue from the retained context",
        idempotencyKey: "reactivation-follow-up",
        reactivationAvailable: true,
        attachments: [{
          id: reactivationAttachmentId,
          fileName: "reactivate.txt",
          contentType: "text/plain",
          byteSize: 1,
          storageKey: reactivationStorageKey,
        }],
        database,
      }),
    );
    expect(result).toMatchObject({
      status: "queued",
      reactivated: true,
      attachments: [{ id: reactivationAttachmentId, message_id: result.messageId }],
    });

    const replay = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      enqueueRunPrompt({
        actor: runActor,
        orgId: orgA,
        runId: reactivationRunId,
        text: "Continue from the retained context",
        idempotencyKey: "reactivation-follow-up",
        reactivationAvailable: false,
        attachments: [{
          id: reactivationAttachmentId,
          fileName: "reactivate.txt",
          contentType: "text/plain",
          byteSize: 1,
          storageKey: reactivationStorageKey,
        }],
        database,
      }),
    );
    expect(replay).toMatchObject({ id: result.id, status: "queued", reactivated: false });

    const rows = await sql<{
      status: string;
      phase: string;
      activationRevision: number;
      reactivatableUntil: Date | null;
      jobStatus: string;
      prompts: number;
    }[]>`
      select r.status::text, r.phase::text,
             r.activation_revision as "activationRevision",
             r.reactivatable_until as "reactivatableUntil",
             j.status::text as "jobStatus",
             count(p.id)::int as prompts
      from skill_runs r
      join skill_run_jobs j on j.org_id = r.org_id and j.run_id = r.id
      join skill_run_prompts p on p.org_id = r.org_id and p.run_id = r.id
      where r.org_id = ${orgA}::uuid and r.id = ${reactivationRunId}::uuid
      group by r.id, j.status
    `;
    expect(rows).toEqual([{
      status: "queued",
      phase: "queued",
      activationRevision: 1,
      reactivatableUntil: null,
      jobStatus: "queued",
      prompts: 2,
    }]);

    await expect(
      withTenantContext({ orgId: orgA, userId: admin.id }, (database) =>
        enqueueRunPrompt({
          actor: { id: admin.id, email: admin.email, name: "Run Admin" },
          orgId: orgA,
          runId: reactivationRunId,
          text: "Admin override",
          idempotencyKey: "reactivation-admin-denied",
          reactivationAvailable: true,
          database,
        }),
      ),
    ).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("replays a canceled pre-session initial prompt before the new follow-up", async () => {
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        enqueueRunPrompt({
          actor: runActor,
          orgId: orgA,
          runId: canceledReactivationRunId,
          text: "New message after cancellation",
          idempotencyKey: "reactivation-after-pre-session-cancel",
          reactivationAvailable: true,
          database,
        }),
      ),
    ).resolves.toMatchObject({ status: "queued", reactivated: true });

    const prompts = await sql<{ ordinal: number; kind: string; status: string; prompt: string; userText: string }[]>`
      select ordinal, kind::text, status::text, prompt, user_text as "userText"
      from skill_run_prompts
      where org_id = ${orgA}::uuid and run_id = ${canceledReactivationRunId}::uuid
      order by ordinal
    `;
    expect(prompts[0]).toEqual({
      ordinal: 0,
      kind: "initial",
      status: "queued",
      prompt: "initial prompt before session creation",
      userText: "initial prompt before session creation",
    });
    expect(prompts[1]).toMatchObject({
      ordinal: 1,
      kind: "follow_up",
      status: "queued",
      userText: "New message after cancellation",
    });
    expect(prompts[1]?.prompt).toContain("New message after cancellation");
    expect(prompts[1]?.prompt).toContain("Use your installed");
  });

  it("rejects unavailable, expired, failed, and cross-tenant reactivation attempts", async () => {
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    const enqueue = (runId: string, key: string, reactivationAvailable: boolean) =>
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        enqueueRunPrompt({
          actor: runActor,
          orgId: orgA,
          runId,
          text: "Attempt reactivation",
          idempotencyKey: key,
          reactivationAvailable,
          database,
        }),
      );

    await expect(enqueue(expiredReactivationRunId, "reactivation-runtime-unavailable", false))
      .rejects.toMatchObject({ code: "runtime_unavailable" });
    await expect(enqueue(expiredReactivationRunId, "reactivation-expired", true))
      .rejects.toMatchObject({ code: "run_reactivation_expired" });
    await expect(enqueue(errorReactivationRunId, "reactivation-error-run", true))
      .rejects.toMatchObject({ code: "run_not_running" });
    await expect(
      withTenantContext({ orgId: orgB, userId: outsider.id }, (database) =>
        enqueueRunPrompt({
          actor: { id: outsider.id, email: outsider.email, name: "Run Outsider" },
          orgId: orgB,
          runId: canceledReactivationRunId,
          text: "Cross-tenant attempt",
          idempotencyKey: "reactivation-cross-tenant",
          reactivationAvailable: true,
          database,
        }),
      ),
    ).rejects.toMatchObject({ code: "run_not_found" });
  });

  it("leases terminal cleanup once and retries after a failed provider attempt", async () => {
    const firstClaims = await Promise.all([claimCleanup("cleanup-a"), claimCleanup("cleanup-b")]);
    expect(firstClaims.flat()).toEqual([{ runId: cleanupRunId, cleanupAttempt: 1 }]);
    expect(await completeCleanup("wrong-worker")).toBe(false);

    await sql`
      update skill_runs
      set cleanup_lease_expires_at = now() - interval '1 second'
      where org_id = ${orgA}::uuid and id = ${cleanupRunId}::uuid
    `;
    expect(await claimCleanup("cleanup-c")).toEqual([{ runId: cleanupRunId, cleanupAttempt: 2 }]);
    expect(await completeCleanup("cleanup-c")).toBe(true);

    const rows = await sql<{ cleaned: boolean; owner: string | null; attempt: number }[]>`
      select sandbox_cleaned_at is not null as cleaned,
             cleanup_lease_owner as owner,
             cleanup_attempt as attempt
      from skill_runs
      where org_id = ${orgA}::uuid and id = ${cleanupRunId}::uuid
    `;
    expect(rows).toEqual([{ cleaned: true, owner: null, attempt: 2 }]);
  });

  it("makes retained cleanup and reactivation mutually exclusive at the deadline", async () => {
    expect(await claimCleanup("retention-before-deadline")).toEqual([]);
    await sql`
      update skill_runs
      set reactivatable_until = now() - interval '1 millisecond'
      where org_id = ${orgA}::uuid and id = ${cleanupRetentionRunId}::uuid
    `;
    const claims = await Promise.all([
      claimCleanup("retention-cleanup-a"),
      claimCleanup("retention-cleanup-b"),
    ]);
    expect(claims.flat()).toEqual([{ runId: cleanupRetentionRunId, cleanupAttempt: 1 }]);

    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        enqueueRunPrompt({
          actor: { id: owner.id, email: owner.email, name: "Run Owner" },
          orgId: orgA,
          runId: cleanupRetentionRunId,
          text: "Too late after cleanup won the row lock",
          idempotencyKey: "reactivation-after-cleanup-claim",
          reactivationAvailable: true,
          database,
        }),
      ),
    ).rejects.toMatchObject({ code: "run_reactivation_expired" });
  });

  it("globally removes only terminal events older than 24 hours", async () => {
    const result = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      const rows = await tx<{ count: number }[]>`select companion_cleanup_skill_run_events(1000)::int as count`;
      const context = await tx<{ value: string }[]>`select current_setting('app.run_worker', true) as value`;
      return { count: rows[0]?.count ?? 0, context: context[0]?.value ?? "" };
    });
    expect(result).toEqual({ count: 1, context: "" });
    const events = await sql<{ runId: string }[]>`
      select run_id::text as "runId" from skill_run_events
      where org_id = ${orgA}::uuid order by run_id
    `;
    expect(events.map((event) => event.runId)).toEqual(expect.arrayContaining([runId, revokedRunId]));
    expect(events).toHaveLength(2);
  });
});
