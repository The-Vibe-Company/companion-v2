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
  cancelOutstandingRunPromptsByWorker,
  cancelRunPromptByWorker,
  adoptRunPrewarm,
  cancelRunPrewarm,
  createRunPrewarm,
  claimNextRunPrompt,
  claimRunPromptStopRecovery,
  completeRunPrompt,
  deferRunAttachmentOrphanReservation,
  deleteRunAttachmentOrphanIfReserved,
  deleteRunConfiguration,
  deterministicRunMessageId,
  enqueueRunPrompt,
  freezeRunAfterRuntimeLossByWorker,
  heartbeatRunJob,
  heartbeatRunWorker,
  getRun,
  getRunAttachment,
  isRunWorkerReady,
  markRunPromptSendAttempted,
  removeRunWorkerHeartbeat,
  reconcileRunArtifactPaths,
  requestRunPromptCancellation,
  reserveRunAttachmentUploads,
  resolveRunDependencyClosure,
  updateClaimedRunPrewarm,
} from "@companion/core/services";
import { db, withTenantContext } from "@companion/db";
import {
  getSandboxUsageOverview,
  getSandboxRuntimeBudget,
  refreshSandboxUsageReservation,
  reserveSandboxUsage,
  settleSandboxUsage,
  startSandboxUsage,
  type BillingRuntimeConfig,
} from "@companion/core";

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
  const prewarmId = randomUUID();
  const adoptedCleanupPrewarmId = randomUUID();
  const adoptedCleanupRunId = randomUUID();
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
  const runtimeReconcileRunId = randomUUID();
  const attachmentId = randomUUID();
  const artifactId = randomUUID();
  const followupAttachmentId = randomUUID();
  const incompatibleWorkerAttachmentId = randomUUID();
  const reactivationAttachmentId = randomUUID();
  const reservationAttachmentId = randomUUID();
  const deferredAttachmentId = randomUUID();
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
        "skill_run_prewarms",
        "skill_run_prewarm_skills",
        "skill_run_skills",
        "skill_run_secret_inputs",
        "skill_run_model_provider_inputs",
        "skill_run_variable_inputs",
        "skill_run_jobs",
        "skill_run_prompts",
        "skill_run_events",
        "skill_run_attachments",
        "skill_run_attachment_uploads",
        "skill_run_artifacts",
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

  async function claimRuntimeReconciliation(workerId: string): Promise<Array<{
    runId: string;
    activationRevision: number;
    reconcileGeneration: number;
  }>> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ runId: string; activationRevision: number; reconcileGeneration: number }[]>`
        select run_id::text as "runId", activation_revision as "activationRevision",
               reconcile_generation as "reconcileGeneration"
        from companion_claim_skill_run_runtime_reconciliations(${workerId}, 1, 30, ${orgA})
      `;
    });
  }

  async function completeRuntimeReconciliation(input: {
    workerId: string;
    activationRevision: number;
    reconcileGeneration: number;
    providerState: "running" | "stopped" | "missing";
  }): Promise<boolean> {
    return sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      const rows = await tx<{ completed: boolean }[]>`
        select companion_complete_skill_run_runtime_reconciliation(
          ${orgA}::uuid,
          ${runtimeReconcileRunId}::uuid,
          ${input.workerId},
          ${input.activationRevision},
          ${input.reconcileGeneration},
          ${input.providerState}::sandbox_provider_state,
          ${new Date(Date.now() + 60_000)}
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
      insert into skill_run_prewarms
        (id, org_id, skill_id, creator_id, skill_version_id, sandbox_name, golden_snapshot_id,
         client_lease_expires_at, absolute_expires_at)
      values
        (${prewarmId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id}, ${versionId}::uuid,
         ${`prewarm-${prewarmId}`}, 'golden-integration', now() + interval '30 seconds', now() + interval '5 minutes')
    `;
    await sql`
      insert into skill_run_prewarm_skills
        (org_id, prewarm_id, skill_id, skill_version_id, is_root, mount_order)
      values (${orgA}::uuid, ${prewarmId}::uuid, ${skillId}::uuid, ${versionId}::uuid, true, 0)
    `;
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
    await sql`
      insert into skill_run_artifacts
        (id, org_id, run_id, path, file_name, content_type, byte_size, previewable, storage_key, ready, expires_at)
      values
        (${artifactId}::uuid, ${orgA}::uuid, ${runId}::uuid, 'artifacts/result.txt', 'result.txt',
         'text/plain; charset=utf-8', 6, false, ${`${orgA}/run-artifacts/${runId}/${artifactId}`}, true,
         now() + interval '24 hours')
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
    await sql.unsafe(`grant execute on function companion_claim_skill_run_runtime_reconciliations(text, integer, integer, text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_complete_skill_run_runtime_reconciliation(uuid, uuid, text, integer, integer, sandbox_provider_state, timestamp with time zone) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_settle_terminal_skill_run_usage(integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_cleanup_skill_run_events(integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_heartbeat_skill_run_worker(text, integer, integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_heartbeat_skill_run_worker(text, integer, integer, integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_remove_skill_run_worker(text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_skill_run_worker_ready() to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_skill_run_attachment_worker_ready() to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_skill_run_attachment_worker_ready(uuid, uuid, text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_skill_run_turn_stop_worker_ready() to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_skill_run_turn_stop_worker_ready(uuid, uuid, text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_secret_usage_count(uuid, uuid) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_claim_skill_run_prewarms(text, integer, integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_claim_skill_run_prewarm_cleanups(text, integer, integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_complete_skill_run_prewarm_cleanup(uuid, uuid, text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_purge_skill_run_prewarms(integer) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_put_skill_run_artifact_metadata(uuid, uuid, text, text, uuid, text, text, text, integer, boolean, text, boolean, timestamp with time zone) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_put_skill_run_artifact_metadata_v2(uuid, uuid, text, text, uuid, text, text, text, integer, boolean, text, boolean, timestamp with time zone, text) to ${rlsRole}`);
    await sql.unsafe(`grant execute on function companion_reconcile_skill_run_artifact_paths(uuid, uuid, text, text, text[]) to ${rlsRole}`);
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

  it("allows artifact writes only for the exact unexpired worker lease", async () => {
    const write = (workerId: string, id: string, artifactPath: string) => sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ stored: boolean }[]>`
        select companion_put_skill_run_artifact_metadata_v2(
          ${orgA}::uuid, ${freezeRunId}::uuid, ${owner.id}, ${workerId}, ${id}::uuid,
          ${artifactPath}, 'lease.txt', 'text/plain; charset=utf-8', 5, true,
          ${`${orgA}/run-artifacts/${freezeRunId}/${id}`}, true, now() + interval '24 hours', 'text'
        ) as stored
      `;
    });
    await expect(write("wrong-worker", randomUUID(), "artifacts/wrong.txt")).resolves.toEqual([{ stored: false }]);
    await expect(write("freeze-worker", randomUUID(), "artifacts/lease.txt")).resolves.toEqual([{ stored: true }]);
    const legacyWrite = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ stored: boolean }[]>`
        select companion_put_skill_run_artifact_metadata(
          ${orgA}::uuid, ${freezeRunId}::uuid, ${owner.id}, 'freeze-worker', ${randomUUID()}::uuid,
          'artifacts/lease.txt', 'lease.txt', 'application/octet-stream', 5, false,
          ${`${orgA}/run-artifacts/${freezeRunId}/legacy`}, true, now() + interval '24 hours'
        ) as stored
      `;
    });
    expect(legacyWrite).toEqual([{ stored: true }]);
    const [legacyRow] = await sql<{ preview_kind: string | null }[]>`
      select preview_kind from skill_run_artifacts
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid and path = 'artifacts/lease.txt'
    `;
    expect(legacyRow?.preview_kind).toBeNull();
    await expect(write("freeze-worker", randomUUID(), "plans/images/read-result.png"))
      .resolves.toEqual([{ stored: true }]);
    for (let index = 0; index < 18; index += 1) {
      await expect(write("freeze-worker", randomUUID(), `artifacts/quota-${index}.txt`))
        .resolves.toEqual([{ stored: true }]);
    }
    await expect(write("freeze-worker", randomUUID(), "artifacts/quota-overflow.txt"))
      .resolves.toEqual([{ stored: false }]);
    const reconciled = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ reconciled: boolean }[]>`
        select companion_reconcile_skill_run_artifact_paths(
          ${orgA}::uuid, ${freezeRunId}::uuid, ${owner.id}, 'freeze-worker',
          ARRAY['artifacts/lease.txt']::text[]
        ) as reconciled
      `;
    });
    expect(reconciled).toEqual([{ reconciled: true }]);
    await expect(reconcileRunArtifactPaths({
      orgId: orgA,
      runId: freezeRunId,
      creatorId: owner.id,
      workerId: "freeze-worker",
      paths: ["artifacts/lease.txt"],
      database: db,
    })).resolves.toBe(true);
    const [readImage] = await sql<{ ready: boolean }[]>`
      select ready from skill_run_artifacts
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
        and path = 'plans/images/read-result.png'
    `;
    expect(readImage?.ready).toBe(true);
    await expect(write("freeze-worker", randomUUID(), "artifacts/after-delete.txt"))
      .resolves.toEqual([{ stored: true }]);
  });

  it("claims a secretless prewarm once while preserving creator-only visibility", async () => {
    const first = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ id: string; status: string }[]>`
        select id::text, status::text
        from companion_claim_skill_run_prewarms('prewarm-worker', 1, 30)
      `;
    });
    expect(first).toEqual([{ id: prewarmId, status: "warming" }]);

    const second = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ id: string }[]>`
        select id::text from companion_claim_skill_run_prewarms('other-worker', 1, 30)
      `;
    });
    expect(second).toEqual([]);
    expect((await countsFor(orgA, admin.id)).skill_run_prewarms).toBe(0);

    await withTenantContext({ orgId: orgA, userId: owner.id }, (database) => cancelRunPrewarm({
      actor: { ...owner, name: "Run Owner" },
      orgId: orgA,
      prewarmId,
      database,
    }));
    const cleanupDuringFork = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ id: string }[]>`
        select id::text from companion_claim_skill_run_prewarm_cleanups('cleanup-worker', 1, 30)
      `;
    });
    expect(cleanupDuringFork).toEqual([]);
    const promotedAfterCancel = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      updateClaimedRunPrewarm({
        actor: { ...owner, name: "Run Owner" },
        orgId: orgA,
        prewarmId,
        workerId: "prewarm-worker",
        status: "ready",
        phase: "ready",
        complete: true,
        database,
      }),
    );
    expect(promotedAfterCancel).toBe(false);
    expect((await sql<{ status: string }[]>`select status::text from skill_run_prewarms where id = ${prewarmId}::uuid`)[0]?.status).toBe("canceled");
  });

  it("reconciles an adopted sandbox that appears after early run cleanup", async () => {
    await sql`
      insert into skill_run_prewarms
        (id, org_id, skill_id, creator_id, skill_version_id, status, phase, sandbox_name,
         golden_snapshot_id, client_lease_expires_at, absolute_expires_at, adopted_run_id,
         lease_owner, lease_expires_at)
      values
        (${adoptedCleanupPrewarmId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id},
         ${versionId}::uuid, 'warming', 'fork', ${`prewarm-${adoptedCleanupPrewarmId}`},
         'golden-integration', now() + interval '30 seconds', now() + interval '5 minutes',
         ${adoptedCleanupRunId}::uuid, 'prewarm-race-worker', now() + interval '5 minutes')
    `;
    await sql`
      insert into skill_runs
        (id, org_id, skill_id, creator_id, prewarm_id, skill_version_id, skill_version,
         idempotency_key, payload_hash, model, prompt, status, phase, sandbox_name, sandbox_cleaned_at)
      values
        (${adoptedCleanupRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id},
         ${adoptedCleanupPrewarmId}::uuid, ${versionId}::uuid, '1.0.0',
         'integration-adopted-cleanup', ${"7".repeat(64)}, 'openai/gpt-5', 'canceled during fork',
         'canceled', 'complete', ${`prewarm-${adoptedCleanupPrewarmId}`}, now())
    `;

    const whileForking = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ id: string }[]>`
        select id::text from companion_claim_skill_run_prewarm_cleanups('race-cleanup-worker', 32, 30)
      `;
    });
    expect(whileForking.map((row) => row.id)).not.toContain(adoptedCleanupPrewarmId);

    await sql`
      update skill_run_prewarms
      set lease_owner = null, lease_expires_at = null
      where id = ${adoptedCleanupPrewarmId}::uuid
    `;
    const afterFork = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ id: string }[]>`
        select id::text from companion_claim_skill_run_prewarm_cleanups('race-cleanup-worker', 32, 30)
      `;
    });
    expect(afterFork.map((row) => row.id)).toContain(adoptedCleanupPrewarmId);

    const completed = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ completed: boolean }[]>`
        select companion_complete_skill_run_prewarm_cleanup(
          ${orgA}::uuid,
          ${adoptedCleanupPrewarmId}::uuid,
          'race-cleanup-worker'
        ) as completed
      `;
    });
    expect(completed[0]?.completed).toBe(true);
    expect((await sql<{ cleaned: boolean }[]>`
      select sandbox_cleaned_at is not null as cleaned
      from skill_run_prewarms where id = ${adoptedCleanupPrewarmId}::uuid
    `)[0]?.cleaned).toBe(true);
  });

  it("limits each creator to two live five-minute warm-ups", async () => {
    const ctx = {
      masterKey: Buffer.alloc(32),
      goldenSnapshotId: "golden-integration",
      opencodeVersion: null,
      region: "iad1",
      timeoutMs: 300_000,
      resolveModelKeys: async () => null,
      runtimeAvailable: true,
      runtimeMessage: null,
    };
    const create = () => withTenantContext({ orgId: orgA, userId: owner.id }, (database) => createRunPrewarm({
      actor: { ...owner, name: "Run Owner" },
      orgId: orgA,
      slug: `run-test-${suffix}`,
      ctx,
      database,
    }));
    const first = await create();
    const second = await create();
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(await create()).toBeNull();
    expect(new Date(first!.expires_at).getTime() - Date.now()).toBeGreaterThan(299_000);
    for (const id of [first!.id, second!.id]) {
      await withTenantContext({ orgId: orgA, userId: owner.id }, (database) => cancelRunPrewarm({
        actor: { ...owner, name: "Run Owner" }, orgId: orgA, prewarmId: id, database,
      }));
    }
  });

  it("lets adoption win cleanup exactly once", async () => {
    const actor = { ...owner, name: "Run Owner" };
    const ctx = {
      masterKey: Buffer.alloc(32),
      goldenSnapshotId: "golden-integration",
      opencodeVersion: null,
      region: "iad1",
      timeoutMs: 300_000,
      resolveModelKeys: async () => null,
      runtimeAvailable: true,
      runtimeMessage: null,
    };
    const warmup = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      createRunPrewarm({ actor, orgId: orgA, slug: `run-test-${suffix}`, ctx, database }),
    );
    expect(warmup).not.toBeNull();
    const adoptedRunId = randomUUID();
    const adopted = await withTenantContext({ orgId: orgA, userId: owner.id }, async (database) => {
      const closure = await resolveRunDependencyClosure({
        actor, orgId: orgA, slug: `run-test-${suffix}`, skillVersionId: versionId, database,
      });
      const incompatible = await adoptRunPrewarm({
        database,
        actor,
        orgId: orgA,
        runId: randomUUID(),
        prewarmId: warmup!.id,
        closure,
        goldenSnapshotId: "replacement-golden",
        timeoutMs: 300_000,
      });
      expect(incompatible).toBeNull();
      return adoptRunPrewarm({
        database,
        actor,
        orgId: orgA,
        runId: adoptedRunId,
        prewarmId: warmup!.id,
        closure,
        goldenSnapshotId: "golden-integration",
        timeoutMs: 300_000,
      });
    });
    expect(adopted?.id).toBe(warmup!.id);

    await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      cancelRunPrewarm({ actor, orgId: orgA, prewarmId: warmup!.id, database }),
    );
    const secondAdoption = await withTenantContext({ orgId: orgA, userId: owner.id }, async (database) => {
      const closure = await resolveRunDependencyClosure({
        actor, orgId: orgA, slug: `run-test-${suffix}`, skillVersionId: versionId, database,
      });
      return adoptRunPrewarm({
        database,
        actor,
        orgId: orgA,
        runId: randomUUID(),
        prewarmId: warmup!.id,
        closure,
        goldenSnapshotId: "golden-integration",
        timeoutMs: 300_000,
      });
    });
    expect(secondAdoption).toBeNull();
    expect((await sql<{ adoptedRunId: string; status: string }[]>`
      select adopted_run_id::text as "adoptedRunId", status::text from skill_run_prewarms where id = ${warmup!.id}::uuid
    `)[0]).toEqual({ adoptedRunId, status: "queued" });
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
      await tx`select set_config('app.run_prewarm_worker', 'internal', true)`;
      const prewarms = await tx<{ count: number }[]>`select count(*)::int as count from skill_run_prewarms`;
      return {
        runs: runs[0]?.count ?? -1,
        jobs: jobs[0]?.count ?? -1,
        prewarms: prewarms[0]?.count ?? -1,
        deleted: deleted.length,
      };
    });
    expect(result).toEqual({ runs: 0, jobs: 0, prewarms: 0, deleted: 0 });
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
    for (const workerId of ["worker-a", "worker-b", "worker-c", "worker-d"]) {
      await sql`select companion_heartbeat_skill_run_worker(${workerId}, 30, 1, 2)`;
    }
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
      await sql`select companion_heartbeat_skill_run_worker('readiness-v1-worker', 15, 1, 1)`;
      expect(await isRunWorkerReady({ database })).toBe(false);
      await sql`select companion_remove_skill_run_worker('readiness-v1-worker')`;
      await heartbeatRunWorker({ workerId: "readiness-worker", ttlSeconds: 15, database });
      expect(await isRunWorkerReady({ database })).toBe(true);
      await removeRunWorkerHeartbeat({ workerId: "readiness-worker", database });
      expect(await isRunWorkerReady({ database })).toBe(false);
    });
  });

  it("rejects prompt rows whose send marker lacks protocol-2 provenance", async () => {
    await expect(sql`
      insert into skill_run_prompts
        (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status, dispatch_protocol, send_attempted_at)
      values
        (${orgA}::uuid, ${runId}::uuid, 99991, 'follow_up', ${`bad-marker-${suffix}`},
         ${"a".repeat(64)}, ${deterministicRunMessageId(runId, 99991, Date.now())},
         'bad marker', 'bad marker', 'completed', 0, now())
    `).rejects.toMatchObject({ code: "23514" });
    await expect(sql`
      insert into skill_run_prompts
        (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status, dispatch_protocol, attachments_retained)
      values
        (${orgA}::uuid, ${runId}::uuid, 99994, 'follow_up', ${`bad-disposition-${suffix}`},
         ${"d".repeat(64)}, ${deterministicRunMessageId(runId, 99994, Date.now() + 1)},
         'bad disposition', 'bad disposition', 'canceled', 2, false)
    `).rejects.toMatchObject({ code: "55000" });
  });

  it("fails closed when a rolling API directly terminalizes an ambiguous queued prompt", async () => {
    const promptId = randomUUID();
    await sql`
      insert into skill_run_prompts
        (id, org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status, attempt, dispatch_protocol)
      values
        (${promptId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 99992, 'follow_up',
         ${`legacy-direct-cancel-${suffix}`}, ${"b".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 99992, Date.now())},
         'ambiguous', 'ambiguous', 'queued', 1, 0)
    `;
    await expect(sql`
      update skill_run_prompts set status = 'canceled', cancel_requested_at = now()
      where id = ${promptId}::uuid
    `).rejects.toMatchObject({ code: "55000" });
    const rows = await sql<{ status: string; retained: boolean }[]>`
      select status::text, attachments_retained as retained
      from skill_run_prompts where id = ${promptId}::uuid
    `;
    expect(rows).toEqual([{ status: "queued", retained: true }]);
    await sql`delete from skill_run_prompts where id = ${promptId}::uuid`;
  });

  it("commits the send marker once under exact leases and lets whole-run cancellation win the lock", async () => {
    const promptId = randomUUID();
    await sql`
      update skill_runs set status = 'running', phase = 'record', cancel_requested_at = null
      where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid
    `;
    await sql`
      update skill_run_jobs
      set status = 'leased', lease_owner = 'freeze-worker', lease_expires_at = now() + interval '5 minutes'
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
    `;
    await sql`select companion_heartbeat_skill_run_worker('freeze-worker', 30, 1, 2)`;
    await sql`
      insert into skill_run_prompts
        (id, org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status)
      values
        (${promptId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 99993, 'follow_up',
         ${`send-marker-${suffix}`}, ${"c".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 99993, Date.now())},
         'mark me', 'mark me', 'queued')
    `;
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    const claimed = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      claimNextRunPrompt({
        actor: runActor,
        orgId: orgA,
        runId: freezeRunId,
        workerId: "freeze-worker",
        database,
      }),
    );
    expect(claimed).toMatchObject({ id: promptId, dispatchProtocol: 2, sendAttemptedAt: null });
    const markerInput = {
      actor: runActor,
      orgId: orgA,
      runId: freezeRunId,
      promptId,
      workerId: "freeze-worker",
    };
    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      markRunPromptSendAttempted({ ...markerInput, database }),
    )).resolves.toBe("marked");
    const firstMarker = await sql<{ attemptedAt: Date }[]>`
      select send_attempted_at as "attemptedAt" from skill_run_prompts where id = ${promptId}::uuid
    `;
    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      markRunPromptSendAttempted({ ...markerInput, database }),
    )).resolves.toBe("marked");
    const replayedMarker = await sql<{ attemptedAt: Date }[]>`
      select send_attempted_at as "attemptedAt" from skill_run_prompts where id = ${promptId}::uuid
    `;
    expect(replayedMarker).toEqual(firstMarker);

    await sql`update skill_run_prompts set cancel_requested_at = now() where id = ${promptId}::uuid`;
    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      markRunPromptSendAttempted({ ...markerInput, database }),
    )).resolves.toBe("prompt_cancel_requested");
    await sql`update skill_run_prompts set cancel_requested_at = null where id = ${promptId}::uuid`;

    await sql`
      update skill_runs set cancel_requested_at = now(), phase = 'cancel'
      where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid
    `;
    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      markRunPromptSendAttempted({ ...markerInput, database }),
    )).resolves.toBe("run_cancel_requested");
    await sql`delete from skill_run_prompts where id = ${promptId}::uuid`;
    await sql`
      update skill_runs set cancel_requested_at = null, phase = 'record'
      where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid
    `;
  });

  it("terminalizes and leaves cleanup owed when a leased run owner loses membership", async () => {
    const revokedAttachmentKey = `${orgA}/run-attachments/revoked-${suffix}`;
    await sql`
      insert into skill_run_attachments
        (id, org_id, run_id, prompt_id, file_name, content_type, byte_size, storage_key)
      select ${randomUUID()}::uuid, p.org_id, p.run_id, p.id,
             'revoked-input.txt', 'text/plain', 1, ${revokedAttachmentKey}
      from skill_run_prompts p
      where p.org_id = ${orgA}::uuid and p.run_id = ${revokedRunId}::uuid
      limit 1
    `;
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
      order by e.sequence
    `;
    expect(rows).toEqual([
      {
        status: "error",
        phase: "record",
        errorCode: "membership_revoked",
        cleaned: false,
        jobStatus: "failed",
        promptStatus: "error",
        eventType: "run.error",
        eventSequence: 43,
      },
      {
        status: "error",
        phase: "record",
        errorCode: "membership_revoked",
        cleaned: false,
        jobStatus: "failed",
        promptStatus: "error",
        eventType: "prompt.status",
        eventSequence: 44,
      },
    ]);
    const disposition = await sql<{ retained: boolean; reservations: number }[]>`
      select p.attachments_retained as retained,
             (select count(*)::int from skill_run_attachment_uploads
              where storage_key = ${revokedAttachmentKey}) as reservations
      from skill_run_prompts p
      where p.org_id = ${orgA}::uuid and p.run_id = ${revokedRunId}::uuid
    `;
    // Failure terminalization is diagnostic, not a user cancellation: retain its submitted input.
    expect(disposition).toEqual([{ retained: true, reservations: 0 }]);
    // Keep the following cleanup-lease test isolated after proving the failed destroy remains owed.
    await sql`
      update skill_runs set sandbox_cleaned_at = now()
      where org_id = ${orgA}::uuid and id = ${revokedRunId}::uuid
    `;
  });

  it("atomically links an attachment-only follow-up to its visible and runtime prompt", async () => {
    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', attachment_prompt_protocol = 1,
          turn_stop_protocol = 2
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

  it("sweeps canceled queued retry files while charging them until deletion succeeds", async () => {
    const canceledPromptId = randomUUID();
    const completedPromptId = randomUUID();
    const canceledKeys = Array.from({ length: 5 }, (_, index) =>
      `${orgA}/run-attachments/canceled-budget-${index}-${suffix}`);
    const retainedKeys = Array.from({ length: 5 }, (_, index) =>
      `${orgA}/run-attachments/retained-budget-${index}-${suffix}`);
    const attachmentIds = Array.from({ length: 10 }, () => randomUUID());
    const canceledAttachmentIds = new Set<string>(attachmentIds.slice(0, 5));
    await sql`
      update skill_run_jobs
      set status = 'leased', lease_owner = 'freeze-worker', lease_expires_at = now() + interval '5 minutes'
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
    `;
    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', attachment_prompt_protocol = 1, turn_stop_protocol = 2
      where worker_id = 'freeze-worker'
    `;
    await sql`
      insert into skill_run_prompts
        (id, org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status, attempt, dispatch_protocol, completed_at)
      values
        (${canceledPromptId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 900, 'follow_up',
         'canceled-budget-prompt', ${"7".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 900, Date.now())}, 'cancel files', 'cancel files', 'queued', 2, 2, null),
        (${completedPromptId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 901, 'follow_up',
         'retained-budget-prompt', ${"8".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 901, Date.now() + 1)}, 'kept files', 'kept files', 'completed', 0, 0, now())
    `;
    for (const [index, storageKey] of [...canceledKeys, ...retainedKeys].entries()) {
      await sql`
        insert into skill_run_attachments
          (id, org_id, run_id, prompt_id, file_name, content_type, byte_size, storage_key)
        values
          (${attachmentIds[index]!}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid,
           ${index < canceledKeys.length ? canceledPromptId : completedPromptId}::uuid,
           ${`budget-${index}.bin`}, 'application/octet-stream', 10485760, ${storageKey})
      `;
    }

    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      requestRunPromptCancellation({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        runId: freezeRunId,
        promptId: canceledPromptId,
        database,
      }),
    )).resolves.toMatchObject({ status: "canceled", requested: true });
    const visible = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      getRun({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        runId: freezeRunId,
        database,
      }));
    expect(visible.pending_prompts.some((prompt) => prompt.id === canceledPromptId)).toBe(false);
    expect(visible.attachments.filter((attachment) => canceledAttachmentIds.has(attachment.id)))
      .toEqual([]);
    const canceledAttempt = await sql<{ attempt: number; retained: boolean }[]>`
      select attempt, attachments_retained as retained
      from skill_run_prompts where id = ${canceledPromptId}::uuid
    `;
    expect(canceledAttempt).toEqual([{ attempt: 2, retained: false }]);
    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      getRunAttachment({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        runId: freezeRunId,
        attachmentId: attachmentIds[0]!,
        database,
      })),
    ).rejects.toMatchObject({ code: "attachment_not_found" });
    const retained = await sql<{ bytes: number; files: number; reservations: number }[]>`
      select coalesce(sum(a.byte_size), 0)::int as bytes,
             count(a.id)::int as files,
             (select count(*)::int from skill_run_attachment_uploads u
              where u.storage_key = any(${canceledKeys}::text[])) as reservations
      from skill_run_attachments a
      where a.org_id = ${orgA}::uuid and a.run_id = ${freezeRunId}::uuid
        and a.prompt_id in (${canceledPromptId}::uuid, ${completedPromptId}::uuid)
    `;
    expect(retained).toEqual([{ bytes: 104857600, files: 10, reservations: 5 }]);
    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      enqueueRunPrompt({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        runId: freezeRunId,
        text: "Do not reuse canceled bytes",
        idempotencyKey: "canceled-budget-reuse",
        attachments: [{
          id: randomUUID(),
          fileName: "one-more-byte.bin",
          contentType: "application/octet-stream",
          byteSize: 1,
          storageKey: `${orgA}/run-attachments/one-more-byte-${suffix}`,
        }],
        database,
      }),
    )).rejects.toMatchObject({ code: "attachment_total_too_large" });

    await sql`
      update skill_run_attachment_uploads
      set touched_at = now() - interval '2 days'
      where storage_key = ${canceledKeys[0]!}
    `;
    await expect(deleteRunAttachmentOrphanIfReserved({
      storageKey: canceledKeys[0]!,
      before: new Date(Date.now() - 24 * 60 * 60 * 1_000),
      deleteObject: async () => undefined,
      database: db,
    })).resolves.toBe(true);
    const swept = await sql<{ files: number; reservations: number }[]>`
      select (select count(*)::int from skill_run_attachments where storage_key = ${canceledKeys[0]!}) as files,
             (select count(*)::int from skill_run_attachment_uploads where storage_key = ${canceledKeys[0]!}) as reservations
    `;
    expect(swept).toEqual([{ files: 0, reservations: 0 }]);
    await sql`delete from skill_run_attachment_uploads where storage_key = any(${canceledKeys}::text[])`;
    await sql`delete from skill_run_prompts where id in (${canceledPromptId}::uuid, ${completedPromptId}::uuid)`;
  });

  it("whole-run cancellation reserves only proven-unsent queued follow-up objects", async () => {
    const promptIds = Array.from({ length: 4 }, () => randomUUID());
    const storageKeys = promptIds.map((id) => `${orgA}/run-attachments/whole-cancel-${id}`);
    await sql`
      update skill_runs
      set status = 'running', phase = 'cancel', cancel_requested_at = now()
      where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid
    `;
    await sql`
      update skill_run_jobs
      set status = 'leased', lease_owner = 'freeze-worker', lease_expires_at = now() + interval '5 minutes'
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
    `;
    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', turn_stop_protocol = 2
      where worker_id = 'freeze-worker'
    `;
    await sql`
      insert into skill_run_prompts
        (id, org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status, attempt, dispatch_protocol, send_attempted_at,
         lease_owner, lease_expires_at)
      values
        (${promptIds[0]!}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 902, 'follow_up',
         ${`whole-safe-${suffix}`}, ${"1".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 902, Date.now())}, 'safe', 'safe',
         'queued', 2, 2, null, null, null),
        (${promptIds[1]!}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 903, 'follow_up',
         ${`whole-ambiguous-${suffix}`}, ${"2".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 903, Date.now() + 1)}, 'ambiguous', 'ambiguous',
         'queued', 2, 2, now(), null, null),
        (${promptIds[2]!}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 904, 'initial',
         ${`whole-initial-${suffix}`}, ${"3".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 904, Date.now() + 2)}, 'initial', 'initial',
         'queued', 0, 0, null, null, null),
        (${promptIds[3]!}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 905, 'follow_up',
         ${`whole-processing-${suffix}`}, ${"4".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 905, Date.now() + 3)}, 'processing', 'processing',
         'processing', 1, 2, now(), 'freeze-worker', now() + interval '5 minutes')
    `;
    for (const [index, promptId] of promptIds.entries()) {
      await sql`
        insert into skill_run_attachments
          (id, org_id, run_id, prompt_id, file_name, content_type, byte_size, storage_key)
        values
          (${randomUUID()}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, ${promptId}::uuid,
           ${`whole-${index}.txt`}, 'text/plain', 1, ${storageKeys[index]!})
      `;
    }

    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      cancelOutstandingRunPromptsByWorker({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        runId: freezeRunId,
        workerId: "freeze-worker",
        database,
      }),
    )).resolves.toBe(true);
    const dispositions = await sql<{ id: string; status: string; retained: boolean }[]>`
      select id::text, status::text, attachments_retained as retained
      from skill_run_prompts where id = any(${promptIds}::uuid[]) order by ordinal
    `;
    expect(dispositions).toEqual([
      { id: promptIds[0]!, status: "canceled", retained: false },
      { id: promptIds[1]!, status: "canceled", retained: true },
      { id: promptIds[2]!, status: "canceled", retained: true },
      { id: promptIds[3]!, status: "canceled", retained: true },
    ]);
    const reservations = await sql<{ storageKey: string }[]>`
      select storage_key as "storageKey" from skill_run_attachment_uploads
      where storage_key = any(${storageKeys}::text[]) order by storage_key
    `;
    expect(reservations.map((row) => row.storageKey)).toEqual([storageKeys[0]!]);

    await sql`delete from skill_run_prompts where id = any(${promptIds}::uuid[])`;
    await sql`delete from skill_run_attachment_uploads where storage_key = any(${storageKeys}::text[])`;
    await sql`
      update skill_runs set status = 'running', phase = 'record', cancel_requested_at = null
      where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid
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
      set expires_at = now() + interval '5 minutes', attachment_prompt_protocol = 1,
          turn_stop_protocol = 2
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

    // A retry can reserve an already durable attachment and die before enqueue replay. The sweep
    // must retain its referenced object while removing the stale reservation so later rows are not
    // permanently starved behind it.
    await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      reserveRunAttachmentUploads({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        storageKeys: [storageKey],
        database,
      }),
    );
    await sql`update skill_run_attachment_uploads set touched_at = now() - interval '2 days' where storage_key = ${storageKey}`;
    let referencedObjectDeleted = false;
    await expect(deleteRunAttachmentOrphanIfReserved({
      storageKey,
      before: new Date(Date.now() - 24 * 60 * 60 * 1_000),
      database: db,
      deleteObject: async () => { referencedObjectDeleted = true; },
    })).resolves.toBe(false);
    expect(referencedObjectDeleted).toBe(false);
    const staleReservations = await sql<{ count: number }[]>`
      select count(*)::int as count from skill_run_attachment_uploads where storage_key = ${storageKey}
    `;
    expect(staleReservations).toEqual([{ count: 0 }]);

    const deferredStorageKey = `${orgA}/run-attachments/${deferredAttachmentId}`;
    await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      reserveRunAttachmentUploads({
        actor: { id: owner.id, email: owner.email, name: "Run Owner" },
        orgId: orgA,
        storageKeys: [deferredStorageKey],
        database,
      }),
    );
    await sql`update skill_run_attachment_uploads set touched_at = now() - interval '2 days' where storage_key = ${deferredStorageKey}`;
    await expect(deferRunAttachmentOrphanReservation({
      storageKey: deferredStorageKey,
      before: new Date(Date.now() - 24 * 60 * 60 * 1_000),
      database: db,
    })).resolves.toBe(true);
    const deferredRows = await sql<{ fresh: boolean }[]>`
      select touched_at > now() - interval '1 minute' as fresh
      from skill_run_attachment_uploads where storage_key = ${deferredStorageKey}
    `;
    expect(deferredRows).toEqual([{ fresh: true }]);
    await sql`delete from skill_run_prompts where id = ${accepted.id}::uuid`;
  });

  it("persists five FIFO follow-ups behind one processing prompt and rejects the sixth", async () => {
    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', turn_stop_protocol = 2
      where worker_id = 'freeze-worker'
    `;
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    const enqueue = (index: number) =>
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        enqueueRunPrompt({
          actor: runActor,
          orgId: orgA,
          runId: freezeRunId,
          text: `FIFO follow-up ${index}`,
          idempotencyKey: `fifo-follow-up-${index}`,
          database,
        }),
      );
    const active = await enqueue(0);
    await sql`
      update skill_run_prompts
      set status = 'processing', lease_owner = 'freeze-worker',
          lease_expires_at = now() + interval '5 minutes'
      where id = ${active.id}::uuid
    `;
    const queued = [];
    for (let index = 1; index <= 5; index += 1) queued.push(await enqueue(index));
    await expect(enqueue(6)).rejects.toMatchObject({ code: "prompt_queue_full" });
    const promptIds = [active.id, ...queued.map((prompt) => prompt.id)];

    const rows = await sql<{ id: string; ordinal: number; status: string }[]>`
      select id::text, ordinal, status::text
      from skill_run_prompts
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
        and id = any(${promptIds}::uuid[])
      order by ordinal
    `;
    expect(rows.map((row) => row.id)).toEqual([active.id, ...queued.map((prompt) => prompt.id)]);
    expect(rows.map((row) => row.status)).toEqual(["processing", "queued", "queued", "queued", "queued", "queued"]);
    await sql`
      delete from skill_run_prompts
      where id = any(${promptIds}::uuid[])
    `;
  });

  it("recovers a stop committed before worker crash, then advances to the next FIFO prompt", async () => {
    const stoppedPromptId = randomUUID();
    const nextPromptId = randomUUID();
    const stoppedAttachmentId = randomUUID();
    const stoppedStorageKey = `${orgA}/run-attachments/stopped-${stoppedAttachmentId}`;
    const stoppedMessageId = deterministicRunMessageId(freezeRunId, 1000, Date.now());
    await sql`
      update skill_run_jobs
      set status = 'leased', lease_owner = 'freeze-worker',
          lease_expires_at = now() + interval '5 minutes'
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
    `;
    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', turn_stop_protocol = 2
      where worker_id = 'freeze-worker'
    `;
    await sql`
      insert into skill_run_prompts
        (id, org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status, attempt, lease_owner, lease_expires_at, cancel_requested_at)
      values
        (${stoppedPromptId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 1000, 'follow_up',
         'crashed-stop-prompt', ${"3".repeat(64)},
         ${stoppedMessageId}, 'stop me', 'stop me',
         'processing', 1, 'crashed-worker', now() - interval '1 second', now()),
        (${nextPromptId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 1001, 'follow_up',
         'after-crashed-stop', ${"4".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 1001, Date.now() + 1)}, 'continue', 'continue',
         'queued', 0, null, null, null)
    `;
    await sql`
      insert into skill_run_attachments
        (id, org_id, run_id, prompt_id, file_name, content_type, byte_size, storage_key)
      values
        (${stoppedAttachmentId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, ${stoppedPromptId}::uuid,
         'stopped-input.txt', 'text/plain', 12, ${stoppedStorageKey})
    `;
    await sql`
      insert into skill_run_attachment_uploads (storage_key, org_id, creator_id, touched_at)
      values (${stoppedStorageKey}, ${orgA}::uuid, ${owner.id}, now() - interval '2 days')
    `;
    await sql`
      update skill_runs
      set transcript = jsonb_build_array(
        jsonb_build_object('kind', 'user', 'message_id', ${stoppedMessageId}::text, 'text', 'stop me'),
        jsonb_build_object('kind', 'assistant', 'text', 'partial answer')
      )
      where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid
    `;
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    const recovered = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      claimRunPromptStopRecovery({
        actor: runActor,
        orgId: orgA,
        runId: freezeRunId,
        workerId: "freeze-worker",
        database,
      }),
    );
    expect(recovered).toMatchObject({ id: stoppedPromptId, cancelRequestedAt: expect.any(Date) });
    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      cancelRunPromptByWorker({
        actor: runActor,
        orgId: orgA,
        runId: freezeRunId,
        promptId: stoppedPromptId,
        workerId: "freeze-worker",
        database,
      }),
    )).resolves.toBe(true);
    const stoppedRun = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      getRun({
        actor: runActor,
        orgId: orgA,
        runId: freezeRunId,
        database,
      }),
    );
    expect(stoppedRun.transcript).toEqual([
      { kind: "user", message_id: stoppedMessageId, text: "stop me" },
      { kind: "assistant", text: "partial answer" },
    ]);
    expect(stoppedRun.attachments).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: stoppedAttachmentId, message_id: stoppedMessageId }),
    ]));
    await expect(withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      getRunAttachment({
        actor: runActor,
        orgId: orgA,
        runId: freezeRunId,
        attachmentId: stoppedAttachmentId,
        database,
      }),
    )).resolves.toMatchObject({ storageKey: stoppedStorageKey });
    let stoppedObjectDeleted = false;
    await expect(deleteRunAttachmentOrphanIfReserved({
      storageKey: stoppedStorageKey,
      before: new Date(Date.now() - 24 * 60 * 60 * 1_000),
      deleteObject: async () => { stoppedObjectDeleted = true; },
      database: db,
    })).resolves.toBe(false);
    expect(stoppedObjectDeleted).toBe(false);
    const next = await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
      claimNextRunPrompt({
        actor: runActor,
        orgId: orgA,
        runId: freezeRunId,
        workerId: "freeze-worker",
        database,
      }),
    );
    expect(next).toMatchObject({ id: nextPromptId, status: "processing" });
    await sql`update skill_runs set transcript = '[]'::jsonb where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid`;
    await sql`delete from skill_run_prompts where id = any(${[stoppedPromptId, nextPromptId]}::uuid[])`;
  });

  it("serializes stop against natural completion without overwriting the winner", async () => {
    const racingPromptId = randomUUID();
    await sql`
      update skill_run_jobs
      set status = 'leased', lease_owner = 'freeze-worker', lease_expires_at = now() + interval '5 minutes'
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
    `;
    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', turn_stop_protocol = 2
      where worker_id = 'freeze-worker'
    `;
    await sql`
      insert into skill_run_prompts
        (id, org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status, lease_owner, lease_expires_at)
      values
        (${racingPromptId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 1100, 'follow_up',
         'stop-completion-race', ${"9".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 1100, Date.now())}, 'race', 'race',
         'processing', 'freeze-worker', now() + interval '5 minutes')
    `;
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    const [stop, completion] = await Promise.all([
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        requestRunPromptCancellation({
          actor: runActor,
          orgId: orgA,
          runId: freezeRunId,
          promptId: racingPromptId,
          database,
        })),
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        completeRunPrompt({
          actor: runActor,
          orgId: orgA,
          runId: freezeRunId,
          promptId: racingPromptId,
          workerId: "freeze-worker",
          database,
        })),
    ]);
    const winner = await sql<{ status: string; canceled: boolean }[]>`
      select status::text, cancel_requested_at is not null as canceled
      from skill_run_prompts where id = ${racingPromptId}::uuid
    `;
    if (completion === "completed") {
      expect(stop).toMatchObject({ status: "completed", requested: false });
      expect(winner).toEqual([{ status: "completed", canceled: false }]);
    } else {
      expect(completion).toBe("cancel_requested");
      expect(stop).toMatchObject({ status: "cancel_requested" });
      expect(winner).toEqual([{ status: "processing", canceled: true }]);
      await withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        cancelRunPromptByWorker({
          actor: runActor,
          orgId: orgA,
          runId: freezeRunId,
          promptId: racingPromptId,
          workerId: "freeze-worker",
          database,
        }));
    }
    await sql`delete from skill_run_prompts where id = ${racingPromptId}::uuid`;
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
      insert into skill_run_worker_heartbeats
        (worker_id, expires_at, attachment_prompt_protocol, turn_stop_protocol)
      values ('legacy-reclaimer', now() + interval '5 minutes', 0, 0),
             ('modern-reclaimer', now() + interval '5 minutes', 1, 2)
      on conflict (worker_id) do update set expires_at = excluded.expires_at,
        attachment_prompt_protocol = excluded.attachment_prompt_protocol,
        turn_stop_protocol = excluded.turn_stop_protocol
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

  it("prevents a protocol-0 worker from reclaiming an initial prompt with a committed stop", async () => {
    const pendingPromptId = randomUUID();
    await sql`
      insert into skill_run_prompts
        (id, org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status, lease_owner, lease_expires_at, cancel_requested_at)
      values
        (${pendingPromptId}::uuid, ${orgA}::uuid, ${freezeRunId}::uuid, 2000, 'initial',
         'initial-stop-reclaim', ${"5".repeat(64)},
         ${deterministicRunMessageId(freezeRunId, 2000, Date.now())}, 'initial', 'initial',
         'processing', 'expired-stop-worker', now() - interval '1 second', now())
    `;
    await sql`
      update skill_run_jobs
      set status = 'leased', lease_owner = 'expired-stop-worker',
          lease_expires_at = now() - interval '1 second'
      where org_id = ${orgA}::uuid and run_id = ${freezeRunId}::uuid
    `;
    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', turn_stop_protocol = 0
      where worker_id = 'legacy-reclaimer'
    `;
    await sql`
      update skill_run_worker_heartbeats
      set expires_at = now() + interval '5 minutes', turn_stop_protocol = 2
      where worker_id = 'modern-reclaimer'
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

  it("freezes an idle provider loss and cancels follow-ups without replay", async () => {
    const runActor = { id: owner.id, email: owner.email, name: "Run Owner" };
    await expect(
      withTenantContext({ orgId: orgA, userId: owner.id }, (database) =>
        freezeRunAfterRuntimeLossByWorker({
          actor: runActor,
          orgId: orgA,
          runId: freezeRunId,
          workerId: "freeze-worker",
          sandboxState: "missing",
          database,
        }),
      ),
    ).resolves.toBe("frozen");
    const [run] = await sql<{
      status: string;
      sandbox_cleaned_at: Date | null;
      reactivatable_until: Date | null;
    }[]>`
      select status::text, sandbox_cleaned_at, reactivatable_until
      from skill_runs
      where org_id = ${orgA}::uuid and id = ${freezeRunId}::uuid
    `;
    expect(run).toMatchObject({
      status: "frozen",
      reactivatable_until: null,
    });
    expect(run?.sandbox_cleaned_at).toBeInstanceOf(Date);
    const prompts = await sql<{ status: string }[]>`
      select status::text
      from skill_run_prompts
      where org_id = ${orgA}::uuid
        and run_id = ${freezeRunId}::uuid
        and idempotency_key = 'freeze-pending-prompt'
    `;
    expect(prompts).toEqual([{ status: "canceled" }]);
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

  it("fences concurrent runtime reconciliation and interrupts an active turn exactly once", async () => {
    await sql`
      insert into skill_runs
        (id, org_id, skill_id, creator_id, skill_version_id, skill_version, idempotency_key,
         payload_hash, model, prompt, status, phase, sandbox_name, sandbox_id, runtime_state,
         runtime_degraded_at, runtime_deadline_at, activation_revision)
      values
        (${runtimeReconcileRunId}::uuid, ${orgA}::uuid, ${skillId}::uuid, ${owner.id},
         ${versionId}::uuid, '1.0.0', 'runtime-reconcile-run', ${"9".repeat(64)},
         'openai/gpt-5', 'runtime reconciliation', 'running', 'record',
         ${`run-${runtimeReconcileRunId}`}, 'sandbox-runtime-reconcile', 'degraded',
         now() - interval '2 minutes', now() + interval '2 minutes', 3)
    `;
    await sql`
      insert into skill_run_jobs
        (org_id, run_id, creator_id, status, phase, lease_owner, lease_expires_at, heartbeat_at)
      values
        (${orgA}::uuid, ${runtimeReconcileRunId}::uuid, ${owner.id}, 'leased', 'record',
         'degraded-supervisor', now() + interval '5 minutes', now())
    `;
    await sql`
      insert into skill_run_prompts
        (org_id, run_id, ordinal, kind, idempotency_key, payload_hash, message_id,
         user_text, prompt, status, attempt, dispatch_protocol, send_attempted_at)
      values
        (${orgA}::uuid, ${runtimeReconcileRunId}::uuid, 0, 'initial', 'runtime-active-prompt',
         ${"8".repeat(64)}, ${deterministicRunMessageId(runtimeReconcileRunId, 0, Date.now())},
         'active turn', 'active turn', 'processing', 1, 2, now()),
        (${orgA}::uuid, ${runtimeReconcileRunId}::uuid, 1, 'follow_up', 'runtime-ambiguous-followup',
         ${"7".repeat(64)}, ${deterministicRunMessageId(runtimeReconcileRunId, 1, Date.now() + 1)},
         'ambiguous follow-up', 'ambiguous follow-up', 'queued', 1, 2, now()),
        (${orgA}::uuid, ${runtimeReconcileRunId}::uuid, 2, 'follow_up', 'runtime-queued-followup',
         ${"6".repeat(64)}, ${deterministicRunMessageId(runtimeReconcileRunId, 2, Date.now() + 2)},
         'queued follow-up', 'queued follow-up', 'queued', 0, 2, null)
    `;
    await sql`
      insert into sandbox_usage_sessions
        (org_id, creator_id, kind, source_id, sandbox_name, activation_revision, period_start,
         reserved_ms, started_at, runtime_policy, runtime_deadline_at, reservation_expires_at)
      values
        (${orgA}::uuid, ${owner.id}, 'run', ${runtimeReconcileRunId}::uuid,
         ${`run-${runtimeReconcileRunId}`}, 3, date_trunc('month', now()), 3600000,
         now() - interval '10 seconds', 'safety_capped', now() + interval '2 minutes',
         now() + interval '1 hour')
    `;

    const claims = await Promise.all([
      claimRuntimeReconciliation("runtime-reconciler-a"),
      claimRuntimeReconciliation("runtime-reconciler-b"),
    ]);
    expect(claims.flat()).toEqual([
      { runId: runtimeReconcileRunId, activationRevision: 3, reconcileGeneration: 1 },
    ]);
    const ownerClaim = claims.find((claim) => claim.length === 1);
    const ownerWorker = ownerClaim === claims[0] ? "runtime-reconciler-a" : "runtime-reconciler-b";

    expect(await completeRuntimeReconciliation({
      workerId: ownerWorker,
      activationRevision: 2,
      reconcileGeneration: 1,
      providerState: "stopped",
    })).toBe(false);
    expect(await completeRuntimeReconciliation({
      workerId: ownerWorker,
      activationRevision: 3,
      reconcileGeneration: 1,
      providerState: "stopped",
    })).toBe(true);
    expect(await completeRuntimeReconciliation({
      workerId: ownerWorker,
      activationRevision: 3,
      reconcileGeneration: 1,
      providerState: "stopped",
    })).toBe(false);

    const runs = await sql<{
      status: string;
      errorCode: string | null;
      runtimeState: string;
      reactivatable: boolean;
      leaseOwner: string | null;
    }[]>`
      select status, error_code as "errorCode", runtime_state as "runtimeState",
             reactivatable_until > now() as reactivatable,
             runtime_reconcile_lease_owner as "leaseOwner"
      from skill_runs
      where org_id = ${orgA}::uuid and id = ${runtimeReconcileRunId}::uuid
    `;
    expect(runs).toEqual([{
      status: "interrupted",
      errorCode: "sandbox_expired_during_turn",
      runtimeState: "healthy",
      reactivatable: true,
      leaseOwner: null,
    }]);

    const prompts = await sql<{ ordinal: number; status: string; errorCode: string | null }[]>`
      select ordinal, status, error_code as "errorCode"
      from skill_run_prompts
      where org_id = ${orgA}::uuid and run_id = ${runtimeReconcileRunId}::uuid
      order by ordinal
    `;
    expect(prompts).toEqual([
      { ordinal: 0, status: "error", errorCode: "sandbox_expired_during_turn" },
      { ordinal: 1, status: "error", errorCode: "sandbox_expired_during_turn" },
      { ordinal: 2, status: "canceled", errorCode: null },
    ]);
    await sql`
      update sandbox_usage_sessions
      set ended_at = null, settled_ms = null,
          started_at = now() - interval '2 hours',
          runtime_deadline_at = now() - interval '1 hour'
      where org_id = ${orgA}::uuid and kind = 'run'
        and source_id = ${runtimeReconcileRunId}::uuid and activation_revision = 3
    `;
    const settled = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ count: number }[]>`
        select companion_settle_terminal_skill_run_usage(32) as count
      `;
    });
    expect(settled).toEqual([{ count: 1 }]);
    const usageRows = await sql<{ ended: boolean; settledMs: number }[]>`
      select ended_at is not null as ended, settled_ms as "settledMs"
      from sandbox_usage_sessions
      where org_id = ${orgA}::uuid and kind = 'run'
        and source_id = ${runtimeReconcileRunId}::uuid and activation_revision = 3
    `;
    expect(usageRows).toEqual([{ ended: true, settledMs: 3_600_000 }]);
    await sql`
      update skill_runs
      set status = 'queued', phase = 'queued', activation_revision = 4
      where org_id = ${orgA}::uuid and id = ${runtimeReconcileRunId}::uuid
    `;
    await sql`
      update sandbox_usage_sessions
      set ended_at = null, settled_ms = null,
          started_at = now() - interval '3 hours',
          runtime_deadline_at = null
      where org_id = ${orgA}::uuid and kind = 'run'
        and source_id = ${runtimeReconcileRunId}::uuid and activation_revision = 3
    `;
    const staleActivationSettled = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${rlsRole}`);
      return tx<{ count: number }[]>`
        select companion_settle_terminal_skill_run_usage(32) as count
      `;
    });
    expect(staleActivationSettled).toEqual([{ count: 1 }]);
    const staleUsageRows = await sql<{ settledMs: number }[]>`
      select settled_ms as "settledMs"
      from sandbox_usage_sessions
      where org_id = ${orgA}::uuid and kind = 'run'
        and source_id = ${runtimeReconcileRunId}::uuid and activation_revision = 3
    `;
    expect(staleUsageRows).toEqual([{ settledMs: 3_600_000 }]);
    const terminalEvents = await sql<{ type: string; code: string | null }[]>`
      select type, payload->>'code' as code
      from skill_run_events
      where org_id = ${orgA}::uuid and run_id = ${runtimeReconcileRunId}::uuid
      order by sequence
    `;
    expect(terminalEvents).toContainEqual({
      type: "run.error",
      code: "sandbox_expired_during_turn",
    });

    const usage = await sql<{ ended: boolean; settledMs: number; deadlineMs: number }[]>`
      select ended_at is not null as ended, settled_ms::int as "settledMs",
             greatest(
               0,
               extract(epoch from (
                 coalesce(runtime_deadline_at, started_at + interval '1 hour') - started_at
               )) * 1000
             )::int as "deadlineMs"
      from sandbox_usage_sessions
      where org_id = ${orgA}::uuid and source_id = ${runtimeReconcileRunId}::uuid
    `;
    expect(usage[0]?.ended).toBe(true);
    expect(usage[0]?.settledMs).toBeGreaterThan(0);
    expect(usage[0]!.settledMs).toBeLessThanOrEqual(usage[0]!.deadlineMs);
    await sql`
      delete from sandbox_usage_sessions
      where org_id = ${orgA}::uuid and source_id = ${runtimeReconcileRunId}::uuid
    `;
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
      where org_id = ${orgA}::uuid
        and run_id in (${runId}::uuid, ${terminalRunId}::uuid, ${revokedRunId}::uuid)
      order by run_id
    `;
    expect(events.map((event) => event.runId)).toEqual(expect.arrayContaining([runId, revokedRunId]));
    expect(events).toHaveLength(3);
  });

  it("atomically blocks concurrent sandbox reservations at the shared monthly limit", async () => {
    const sourceA = randomUUID();
    const sourceB = randomUUID();
    const now = new Date();
    const config: BillingRuntimeConfig = {
      billingMode: "stripe",
      entitlementMode: "enforce",
      pilotOrgIds: new Set(),
      proOrgAllowlist: new Set([orgA]),
      checkoutEnabled: false,
      webhooksEnabled: false,
      sandboxMinutesPerSeat: 1,
    };
    const reserve = (sourceId: string) => withTenantContext(
      { orgId: orgA, userId: owner.id },
      (database) => reserveSandboxUsage({
        orgId: orgA,
        creatorId: owner.id,
        kind: "run",
        sourceId,
        sandboxName: `quota-${sourceId}`,
        activationRevision: 0,
        reservationMs: 2 * 60_000,
        database,
        now,
        config,
      }),
    );

    const attempts = await Promise.allSettled([reserve(sourceA), reserve(sourceB)]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    expect(attempts.find((attempt) => attempt.status === "rejected")).toMatchObject({
      reason: { body: { code: "sandbox_quota_exhausted", feature: "sandbox_runs" } },
    });

    const acceptedSource = attempts[0]?.status === "fulfilled" ? sourceA : sourceB;
    await withTenantContext({ orgId: orgA, userId: owner.id }, async (database) => {
      await startSandboxUsage({
        orgId: orgA,
        sandboxName: `quota-${acceptedSource}`,
        activationRevision: 0,
        database,
        now,
        config,
      });
      await settleSandboxUsage({
        orgId: orgA,
        sandboxName: `quota-${acceptedSource}`,
        activationRevision: 0,
        database,
        now: new Date(now.getTime() + 61_000),
        config,
      });
      const usage = await getSandboxUsageOverview({
        orgId: orgA,
        database,
        now: new Date(now.getTime() + 61_000),
        config,
      });
      expect(usage).toMatchObject({ used_minutes: 2, reserved_minutes: 0, remaining_minutes: 0 });
    });
  });

  it("rejects Free sandbox work before a usage row can be created", async () => {
    const config: BillingRuntimeConfig = {
      billingMode: "stripe",
      entitlementMode: "enforce",
      pilotOrgIds: new Set(),
      proOrgAllowlist: new Set(),
      checkoutEnabled: false,
      webhooksEnabled: false,
      sandboxMinutesPerSeat: 250,
    };
    await expect(withTenantContext({ orgId: orgB, userId: outsider.id }, (database) =>
      reserveSandboxUsage({
        orgId: orgB,
        creatorId: outsider.id,
        kind: "prewarm",
        sourceId: randomUUID(),
        sandboxName: `free-${randomUUID()}`,
        activationRevision: 0,
        reservationMs: 60_000,
        database,
        config,
      }),
    )).rejects.toMatchObject({ body: { code: "sandbox_plan_required", limit: 0 } });
  });

  it("caps a managed provider session at the UTC month boundary", async () => {
    const sourceId = randomUUID();
    const sandboxName = `rollover-${sourceId}`;
    const startsAt = new Date("2026-07-31T23:58:00.000Z");
    const config: BillingRuntimeConfig = {
      billingMode: "stripe",
      entitlementMode: "enforce",
      pilotOrgIds: new Set(),
      proOrgAllowlist: new Set([orgA]),
      checkoutEnabled: false,
      webhooksEnabled: false,
      sandboxMinutesPerSeat: 250,
    };
    await withTenantContext({ orgId: orgA, userId: owner.id }, async (database) => {
      await reserveSandboxUsage({
        orgId: orgA,
        creatorId: owner.id,
        kind: "run",
        sourceId,
        sandboxName,
        activationRevision: 0,
        reservationMs: 10 * 60_000,
        database,
        now: startsAt,
        config,
      });
      await expect(refreshSandboxUsageReservation({
        orgId: orgA,
        sandboxName,
        activationRevision: 0,
        database,
        now: startsAt,
        config,
      })).resolves.toEqual({ limitMs: 2 * 60_000 });
      await startSandboxUsage({ orgId: orgA, sandboxName, activationRevision: 0, database, now: startsAt, config });
      await expect(getSandboxRuntimeBudget({
        orgId: orgA,
        sandboxName,
        activationRevision: 0,
        database,
        now: new Date("2026-08-01T00:00:00.000Z"),
        config,
      })).rejects.toMatchObject({ body: { code: "sandbox_quota_exhausted" } });
    });
  });
});
