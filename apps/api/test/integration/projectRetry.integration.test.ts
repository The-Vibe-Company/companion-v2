import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema, withTenantContext } from "@companion/db";
import {
  ProjectNotFoundError,
  claimProjectWorkspaceJobs,
  releaseProjectWorkspaceLease,
  retryProjectWorkspace,
} from "@companion/core/services";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise:
 * An owner can retry a terminal Project without Companion replacing or forgetting the durable
 * sandbox/checkpoint/activation identity, and duplicate browser commands remain harmless.
 *
 * Regression caught:
 * A retry implementation clears the checkpoint or admission fence, resets a live workspace, emits
 * duplicate audits, or lets a same-org admin revive another member's private Project.
 *
 * Why this test is integrated:
 * The invariant spans a creator-scoped service transaction, row locks, RLS context, and the exact
 * persisted workspace columns consumed by the worker.
 *
 * Failure proof:
 * Widening the creator predicate, removing the terminal-state gate, or adding an identity field to
 * the retry update makes the ownership, idempotency, or before/after assertions fail.
 */
describe("Project workspace retry", () => {
  let fixture: IntegrationFixture;
  const projectId = randomUUID();
  const needsAttentionProjectId = randomUUID();
  const admissionToken = randomUUID();
  const sandboxId = `sandbox-${randomUUID()}`;
  const checkpointId = `checkpoint-${randomUUID()}`;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    await integrationDb.insert(schema.projects).values({
      id: projectId,
      orgId: fixture.orgA,
      creatorId: fixture.owner.id,
      name: "Retry identity",
      defaultModel: "openai/gpt-5",
      idempotencyKey: `retry-${projectId}`,
      payloadHash: "a".repeat(64),
    });
    await integrationDb.insert(schema.projects).values({
      id: needsAttentionProjectId,
      orgId: fixture.orgA,
      creatorId: fixture.owner.id,
      name: "Retry missing workspace",
      defaultModel: "openai/gpt-5",
      idempotencyKey: `retry-${needsAttentionProjectId}`,
      payloadHash: "b".repeat(64),
    });
    await integrationDb.insert(schema.projectWorkspaces).values({
      orgId: fixture.orgA,
      projectId,
      creatorId: fixture.owner.id,
      sandboxName: `project-${projectId}`,
      sandboxId,
      sandboxDomain: "retry.example.test",
      checkpointId,
      checkpointCreatedAt: new Date("2026-07-24T04:00:00.000Z"),
      checkpointGeneration: 2,
      desiredGeneration: 2,
      appliedGeneration: 2,
      activationRevision: 3,
      authorityRevision: "authority-applied",
      activationAdmissionToken: admissionToken,
      activationAdmissionRevision: 4,
      activationAdmissionAuthorityRevision: "authority-pending",
      activationAdmittedAt: new Date("2026-07-24T04:01:00.000Z"),
      status: "error",
      availableAt: new Date("2026-07-25T04:00:00.000Z"),
      attempt: 5,
      maxAttempts: 5,
      lastErrorCode: "project_runtime_failed",
      lastErrorMessage: "Temporary runtime failure",
    });
    await integrationDb.insert(schema.projectWorkspaces).values({
      orgId: fixture.orgA,
      projectId: needsAttentionProjectId,
      creatorId: fixture.owner.id,
      sandboxName: `project-${needsAttentionProjectId}`,
      desiredGeneration: 2,
      appliedGeneration: 1,
      activationRevision: 2,
      status: "needs_attention",
      attempt: 2,
      maxAttempts: 5,
      lastErrorCode: "project_workspace_unrecoverable",
      lastErrorMessage: "Workspace and checkpoint are missing",
    });
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  const retryAs = (actor: IntegrationFixture["owner"]) =>
    withTenantContext(
      { orgId: fixture.orgA, userId: actor.id },
      (database) =>
        retryProjectWorkspace({
          actor,
          orgId: fixture.orgA,
          projectId,
          database,
        }),
    );

  it("is creator-only, terminal-only and preserves every runtime identity fence", async () => {
    await expect(retryAs(fixture.admin)).rejects.toBeInstanceOf(ProjectNotFoundError);

    const first = await retryAs(fixture.owner);
    expect(first).toMatchObject({
      id: projectId,
      status: "queued",
      error_code: null,
      message: null,
    });

    const [afterFirst] = await integrationSql<
      Array<{
        status: string;
        sandbox_id: string | null;
        sandbox_domain: string | null;
        checkpoint_id: string | null;
        checkpoint_generation: number;
        desired_generation: number;
        applied_generation: number;
        activation_revision: number;
        authority_revision: string | null;
        activation_admission_token: string | null;
        activation_admission_revision: number | null;
        activation_admission_authority_revision: string | null;
        attempt: number;
        last_error_code: string | null;
        last_error_message: string | null;
      }>
    >`
      select
        status,
        sandbox_id,
        sandbox_domain,
        checkpoint_id,
        checkpoint_generation,
        desired_generation,
        applied_generation,
        activation_revision,
        authority_revision,
        activation_admission_token,
        activation_admission_revision,
        activation_admission_authority_revision,
        attempt,
        last_error_code,
        last_error_message
      from project_workspaces
      where org_id = ${fixture.orgA}::uuid
        and project_id = ${projectId}::uuid
    `;
    expect(afterFirst).toEqual({
      status: "queued",
      sandbox_id: sandboxId,
      sandbox_domain: "retry.example.test",
      checkpoint_id: checkpointId,
      checkpoint_generation: 2,
      desired_generation: 2,
      applied_generation: 2,
      activation_revision: 3,
      authority_revision: "authority-applied",
      activation_admission_token: admissionToken,
      activation_admission_revision: 4,
      activation_admission_authority_revision: "authority-pending",
      attempt: 0,
      last_error_code: null,
      last_error_message: null,
    });

    // A duplicate POST after the first commit is a read-only replay: it neither resets a live
    // worker state nor emits a second user action.
    await expect(retryAs(fixture.owner)).resolves.toMatchObject({
      id: projectId,
      status: "queued",
    });
    const audits = await integrationSql<Array<{ count: number }>>`
      select count(*)::int as count
      from audit_log
      where org_id = ${fixture.orgA}::uuid
        and target_id = ${projectId}
        and action = 'project.workspace.retry_requested'
    `;
    expect(audits).toEqual([{ count: 1 }]);
  });

  it("requeues needs-attention without fabricating missing provider state", async () => {
    const retried = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) =>
        retryProjectWorkspace({
          actor: fixture.owner,
          orgId: fixture.orgA,
          projectId: needsAttentionProjectId,
          database,
        }),
    );
    expect(retried).toMatchObject({
      id: needsAttentionProjectId,
      status: "queued",
      error_code: null,
      message: null,
    });
    const state = await integrationSql`
      select
        sandbox_id,
        checkpoint_id,
        desired_generation,
        applied_generation,
        activation_revision,
        attempt
      from project_workspaces
      where org_id = ${fixture.orgA}::uuid
        and project_id = ${needsAttentionProjectId}::uuid
    `;
    expect(state).toEqual([{
      sandbox_id: null,
      checkpoint_id: null,
      desired_generation: 2,
      applied_generation: 1,
      activation_revision: 2,
      attempt: 0,
    }]);
  });

  /**
   * The worker derives its retry backoff from the claimed `attempt`. The claim function declares an
   * explicit RETURNS TABLE, so a counter that exists on the row but is missing from the projection
   * leaves the worker unable to back off and it retries a failing activation every claim interval.
   */
  it("returns the retry counter it increments, so the worker can back off", async () => {
    const workerId = `retry-backoff-${randomUUID()}`;
    await integrationSql`
      update "project_workspaces"
      set "status" = 'error',
          "last_error_code" = 'project_runtime_failed',
          "available_at" = now() - interval '1 minute',
          "lease_owner" = null,
          "lease_expires_at" = null,
          "attempt" = 0
      where "org_id" = ${fixture.orgA}::uuid and "project_id" = ${needsAttentionProjectId}::uuid
    `;

    const claimOnce = async () => {
      const rows = await integrationSql<Array<{ attempt: number; max_attempts: number }>>`
        select "attempt", "max_attempts"
        from companion_claim_project_workspaces(${workerId}, 10, 30)
        where "project_id" = ${needsAttentionProjectId}::uuid
      `;
      return rows[0];
    };

    const first = await claimOnce();
    expect(first?.attempt).toBe(1);
    expect(first?.max_attempts).toBeGreaterThan(0);

    await integrationSql`
      update "project_workspaces"
      set "lease_owner" = null, "lease_expires_at" = null, "available_at" = now() - interval '1 minute'
      where "org_id" = ${fixture.orgA}::uuid and "project_id" = ${needsAttentionProjectId}::uuid
    `;
    const second = await claimOnce();
    expect(second?.attempt).toBe(2);
  });

  /**
   * The workspace activates before it claims prompts, so an activation failure leaves the prompt
   * that triggered it still `queued`. An earlier fix cancelled backoff whenever a prompt was
   * queued, which nullified it in exactly that dominant case and kept the once-per-second provider
   * storm alive. Backoff must hold; `retryProjectWorkspace` is the member's immediate escape hatch.
   */
  it("holds a failing activation back even while its triggering prompt is still queued", async () => {
    const workerId = `backoff-hold-${randomUUID()}`;
    const holdOffMs = async () => {
      const [row] = await integrationSql<Array<{ hold_off_ms: number }>>`
        select extract(epoch from ("available_at" - now())) * 1000 as "hold_off_ms"
        from "project_workspaces"
        where "org_id" = ${fixture.orgA}::uuid and "project_id" = ${needsAttentionProjectId}::uuid
      `;
      return Number(row!.hold_off_ms);
    };

    const sessionId = randomUUID();
    await integrationSql`
      insert into "project_sessions"
        ("id", "org_id", "project_id", "creator_id", "title", "model", "model_provider", "status")
      values (${sessionId}::uuid, ${fixture.orgA}::uuid, ${needsAttentionProjectId}::uuid,
              ${fixture.owner.id}, 'Waiting work', 'openai/gpt-5', 'openai', 'queued')
    `;
    await integrationSql`
      insert into "project_prompts"
        ("id", "org_id", "project_id", "session_id", "creator_id", "sequence", "text", "status",
         "idempotency_key", "payload_hash", "usage_activation_revision", "usage_reservation_ms",
         "opencode_message_id")
      values (${randomUUID()}::uuid, ${fixture.orgA}::uuid, ${needsAttentionProjectId}::uuid,
              ${sessionId}::uuid, ${fixture.owner.id}, 1, 'Please continue', 'queued',
              ${randomUUID()}, ${randomUUID()}, 1, 0, ${`msg_${randomUUID()}`})
    `;
    await integrationSql`
      update "project_workspaces"
      set "status" = 'error', "last_error_code" = 'project_runtime_failed',
          "available_at" = now() - interval '1 minute',
          "lease_owner" = null, "lease_expires_at" = null
      where "org_id" = ${fixture.orgA}::uuid and "project_id" = ${needsAttentionProjectId}::uuid
    `;

    const jobs = await claimProjectWorkspaceJobs({ workerId, limit: 10, database: integrationDb });
    const claimed = jobs.find((candidate) => candidate.projectId === needsAttentionProjectId)!;
    await releaseProjectWorkspaceLease({
      job: claimed,
      workerId,
      delayMs: 60_000,
      database: integrationDb,
    });
    expect(await holdOffMs()).toBeGreaterThan(30_000);

    // The member is never stuck behind the hold: the needs-attention `Try again` action clears it.
    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) =>
        retryProjectWorkspace({
          actor: fixture.owner,
          orgId: fixture.orgA,
          projectId: needsAttentionProjectId,
          database,
        }),
    );
    expect(await holdOffMs()).toBeLessThan(1_000);
  });
});
