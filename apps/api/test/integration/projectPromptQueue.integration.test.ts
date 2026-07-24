import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql as drizzleSql } from "drizzle-orm";
import { PROJECT_PROMPT_MAX_QUEUED } from "@companion/contracts";
import { schema, withTenantContext } from "@companion/db";
import {
  admitProjectPromptUsage,
  type BillingRuntimeConfig,
} from "@companion/core";
import {
  cancelQueuedProjectPrompt,
  claimProjectPromptJobs,
  claimProjectWorkspaceJobs,
  createProjectSession,
  enqueueProjectPrompt,
  requestProjectSessionStop,
  setProjectSkills,
} from "@companion/core/services";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise:
 * A busy Project conversation accepts at most five durable "Runs next" messages. Concurrent browser
 * requests cannot overfill that queue, while cancellation, FIFO head completion, and Stop release
 * durable capacity. Claiming the same head must not change the follower count.
 *
 * Regression caught:
 * Counting before the session lock lets two concurrent requests both observe the fifth free slot and
 * persist six follow-ups. Counting active or terminal prompts also leaves a conversation permanently
 * full after work advances.
 *
 * Why this test is integrated:
 * The invariant depends on Postgres row-lock ordering across independent tenant transactions and on
 * the real cancel, claim, and Stop state transitions.
 *
 * Failure proof:
 * Removing the locked queue count admits all six concurrent requests; counting any status besides
 * `queued` prevents the post-cancel or post-completion enqueue; treating a worker claim as capacity
 * leaves an extra slot; failing to terminalize queued prompts on Stop leaves rows behind.
 */
describe("Project prompt queue admission", () => {
  let fixture: IntegrationFixture;
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const activePromptId = randomUUID();

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    await integrationDb.insert(schema.projects).values({
      id: projectId,
      orgId: fixture.orgA,
      creatorId: fixture.owner.id,
      name: "Bounded prompt queue",
      defaultModel: "openai/gpt-5",
      idempotencyKey: `project-queue-${projectId}`,
      payloadHash: "a".repeat(64),
    });
    await integrationDb.insert(schema.projectWorkspaces).values({
      orgId: fixture.orgA,
      projectId,
      creatorId: fixture.owner.id,
      sandboxName: `project-${projectId}`,
      status: "running",
      desiredGeneration: 1,
      appliedGeneration: 1,
      activationRevision: 1,
    });
    await integrationDb.insert(schema.projectSessions).values({
      id: sessionId,
      orgId: fixture.orgA,
      projectId,
      creatorId: fixture.owner.id,
      title: "Queue a set of revisions",
      model: "openai/gpt-5",
      modelProvider: "openai",
      modelCredentialEnvKeys: [],
      status: "working",
    });
    await integrationDb.insert(schema.projectPrompts).values({
      id: activePromptId,
      orgId: fixture.orgA,
      projectId,
      sessionId,
      creatorId: fixture.owner.id,
      sequence: 1,
      text: "Draft the report",
      status: "running",
      idempotencyKey: `project-active-${activePromptId}`,
      payloadHash: "b".repeat(64),
      usageActivationRevision: 1,
      usageReservationMs: 0,
      opencodeMessageId: `message-${activePromptId}`,
      leaseOwner: "active-worker",
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    });
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("serializes concurrent admission and releases slots after cancel, head completion, and Stop", async () => {
    const actor = fixture.owner;
    const enqueue = (index: number) =>
      withTenantContext(
        { orgId: fixture.orgA, userId: actor.id },
        (database) =>
          enqueueProjectPrompt({
            actor,
            orgId: fixture.orgA,
            projectId,
            sessionId,
            text: `FIFO follow-up ${index}`,
            idempotencyKey: `project-queue-${sessionId}-${index}`,
            attachments: [],
            database,
          }),
      );

    const concurrent = await Promise.allSettled(
      Array.from(
        { length: PROJECT_PROMPT_MAX_QUEUED + 1 },
        (_, index) => enqueue(index + 1),
      ),
    );
    const accepted = concurrent.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const rejected = concurrent.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    expect(accepted).toHaveLength(PROJECT_PROMPT_MAX_QUEUED);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      name: "ProjectConflictError",
      code: "prompt_queue_full",
    });

    const queuedCount = async () =>
      (
        await integrationDb
          .select({ id: schema.projectPrompts.id })
          .from(schema.projectPrompts)
          .where(
            and(
              eq(schema.projectPrompts.orgId, fixture.orgA),
              eq(schema.projectPrompts.sessionId, sessionId),
              eq(schema.projectPrompts.status, "queued"),
            ),
          )
      ).length;
    await expect(queuedCount()).resolves.toBe(PROJECT_PROMPT_MAX_QUEUED);

    await withTenantContext(
      { orgId: fixture.orgA, userId: actor.id },
      (database) =>
        cancelQueuedProjectPrompt({
          actor,
          orgId: fixture.orgA,
          projectId,
          sessionId,
          promptId: accepted[0]!.id,
          database,
        }),
    );
    await expect(enqueue(100)).resolves.toMatchObject({
      status: "queued",
      text: "FIFO follow-up 100",
    });

    await integrationDb
      .update(schema.projectPrompts)
      .set({
        status: "completed",
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
      })
      .where(eq(schema.projectPrompts.id, activePromptId));
    await expect(enqueue(101)).resolves.toMatchObject({
      status: "queued",
      text: "FIFO follow-up 101",
    });
    const workerId = `project-queue-worker-${randomUUID()}`;
    const jobs = await claimProjectWorkspaceJobs({
      workerId,
      limit: 32,
      leaseSeconds: 30,
      database: integrationDb,
    });
    const job = jobs.find((candidate) => candidate.projectId === projectId);
    expect(job).toBeDefined();
    const claimed = await claimProjectPromptJobs({
      job: job!,
      workerId,
      limit: 1,
      leaseSeconds: 30,
      database: integrationDb,
    });
    expect(claimed).toHaveLength(1);
    await expect(enqueue(102)).rejects.toMatchObject({
      code: "prompt_queue_full",
    });

    await withTenantContext(
      { orgId: fixture.orgA, userId: actor.id },
      (database) =>
        requestProjectSessionStop({
          actor,
          orgId: fixture.orgA,
          projectId,
          sessionId,
          database,
        }),
    );
    await expect(queuedCount()).resolves.toBe(0);
  });

  it("keeps five follower slots whether the FIFO head is queued or dispatching", async () => {
    const coldProjectId = randomUUID();
    const coldSessionId = randomUUID();
    const coldHeadId = randomUUID();
    await integrationDb.insert(schema.projects).values({
      id: coldProjectId,
      orgId: fixture.orgA,
      creatorId: fixture.owner.id,
      name: "Cold prompt head",
      defaultModel: "openai/gpt-5",
      idempotencyKey: `project-cold-queue-${coldProjectId}`,
      payloadHash: "c".repeat(64),
    });
    await integrationDb.insert(schema.projectWorkspaces).values({
      orgId: fixture.orgA,
      projectId: coldProjectId,
      creatorId: fixture.owner.id,
      sandboxName: `project-${coldProjectId}`,
      status: "running",
      desiredGeneration: 1,
      appliedGeneration: 1,
      activationRevision: 1,
    });
    await integrationDb.insert(schema.projectSessions).values({
      id: coldSessionId,
      orgId: fixture.orgA,
      projectId: coldProjectId,
      creatorId: fixture.owner.id,
      title: "Waiting for its first worker claim",
      model: "openai/gpt-5",
      modelProvider: "openai",
      modelCredentialEnvKeys: [],
      status: "queued",
    });
    await integrationDb.insert(schema.projectPrompts).values({
      id: coldHeadId,
      orgId: fixture.orgA,
      projectId: coldProjectId,
      sessionId: coldSessionId,
      creatorId: fixture.owner.id,
      sequence: 1,
      text: "Start from a cold queue",
      status: "queued",
      idempotencyKey: `project-cold-head-${coldHeadId}`,
      payloadHash: "d".repeat(64),
      usageActivationRevision: 1,
      usageReservationMs: 0,
      opencodeMessageId: `message-${coldHeadId}`,
    });

    const enqueueCold = (index: number) =>
      withTenantContext(
        { orgId: fixture.orgA, userId: fixture.owner.id },
        (database) =>
          enqueueProjectPrompt({
            actor: fixture.owner,
            orgId: fixture.orgA,
            projectId: coldProjectId,
            sessionId: coldSessionId,
            text: `Cold FIFO follow-up ${index}`,
            idempotencyKey: `project-cold-queue-${coldSessionId}-${index}`,
            attachments: [],
            database,
          }),
      );

    for (let index = 1; index <= PROJECT_PROMPT_MAX_QUEUED; index += 1) {
      await expect(enqueueCold(index)).resolves.toMatchObject({
        status: "queued",
      });
    }
    await expect(enqueueCold(6)).rejects.toMatchObject({
      code: "prompt_queue_full",
    });
    const queuedBeforeClaim = await integrationDb
      .select({ id: schema.projectPrompts.id })
      .from(schema.projectPrompts)
      .where(
        and(
          eq(schema.projectPrompts.orgId, fixture.orgA),
          eq(schema.projectPrompts.sessionId, coldSessionId),
          eq(schema.projectPrompts.status, "queued"),
        ),
      );
    expect(queuedBeforeClaim).toHaveLength(PROJECT_PROMPT_MAX_QUEUED + 1);

    await integrationDb
      .update(schema.projectPrompts)
      .set({
        status: "dispatching",
        leaseOwner: "cold-worker",
        leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
      })
      .where(eq(schema.projectPrompts.id, coldHeadId));
    await expect(enqueueCold(7)).rejects.toMatchObject({
      code: "prompt_queue_full",
    });
  });

  it("keeps workspace-first lock ordering across prompt and Project mutations", async () => {
    const lockProjectId = randomUUID();
    const lockSessionId = randomUUID();
    await integrationDb.insert(schema.projects).values({
      id: lockProjectId,
      orgId: fixture.orgA,
      creatorId: fixture.owner.id,
      name: "Canonical Project lock order",
      defaultModel: "openai/gpt-5",
      idempotencyKey: `project-lock-order-${lockProjectId}`,
      payloadHash: "e".repeat(64),
    });
    await integrationDb.insert(schema.projectWorkspaces).values({
      orgId: fixture.orgA,
      projectId: lockProjectId,
      creatorId: fixture.owner.id,
      sandboxName: `project-${lockProjectId}`,
      status: "running",
      desiredGeneration: 1,
      appliedGeneration: 1,
      activationRevision: 1,
    });
    await integrationDb.insert(schema.projectSessions).values({
      id: lockSessionId,
      orgId: fixture.orgA,
      projectId: lockProjectId,
      creatorId: fixture.owner.id,
      title: "Concurrent lock-order probe",
      model: "openai/gpt-5",
      modelProvider: "openai",
      modelCredentialEnvKeys: [],
      status: "completed",
    });

    try {
      const actor = fixture.owner;
      for (let iteration = 0; iteration < 8; iteration += 1) {
        const enqueue = withTenantContext(
          { orgId: fixture.orgA, userId: actor.id },
          (database) =>
            enqueueProjectPrompt({
              actor,
              orgId: fixture.orgA,
              projectId: lockProjectId,
              sessionId: lockSessionId,
              text: `Concurrent settings prompt ${iteration}`,
              idempotencyKey: `project-lock-settings-${lockSessionId}-${iteration}`,
              attachments: [],
              database,
            }),
        );
        await new Promise((resolve) => setTimeout(resolve, 1));
        const settings = withTenantContext(
          { orgId: fixture.orgA, userId: actor.id },
          (database) =>
            setProjectSkills({
              actor,
              orgId: fixture.orgA,
              projectId: lockProjectId,
              value: { revision: iteration + 1, skill_slugs: [] },
              database,
            }),
        );
        const results = await Promise.allSettled([enqueue, settings]);
        expect(
          results.flatMap((result) =>
            result.status === "rejected"
              ? [{
                  name: result.reason instanceof Error
                    ? result.reason.name
                    : "unknown",
                  code:
                    typeof result.reason === "object"
                    && result.reason !== null
                    && "code" in result.reason
                      ? result.reason.code
                      : null,
                }]
              : []
          ),
          `settings/enqueue iteration ${iteration}`,
        ).toEqual([]);
        await integrationDb
          .update(schema.projectPrompts)
          .set({ status: "completed", completedAt: new Date() })
          .where(
            and(
              eq(schema.projectPrompts.orgId, fixture.orgA),
              eq(schema.projectPrompts.sessionId, lockSessionId),
              eq(schema.projectPrompts.status, "queued"),
            ),
          );
        await integrationDb
          .update(schema.projectSessions)
          .set({ status: "completed", stopRequestedAt: null })
          .where(eq(schema.projectSessions.id, lockSessionId));
      }

      for (let iteration = 0; iteration < 8; iteration += 1) {
        const enqueue = withTenantContext(
          { orgId: fixture.orgA, userId: actor.id },
          (database) =>
            enqueueProjectPrompt({
              actor,
              orgId: fixture.orgA,
              projectId: lockProjectId,
              sessionId: lockSessionId,
              text: `Concurrent new-session prompt ${iteration}`,
              idempotencyKey: `project-lock-enqueue-${lockSessionId}-${iteration}`,
              attachments: [],
              database,
            }),
        );
        await new Promise((resolve) => setTimeout(resolve, 1));
        const newSession = withTenantContext(
          { orgId: fixture.orgA, userId: actor.id },
          (database) =>
            createProjectSession({
              actor,
              orgId: fixture.orgA,
              projectId: lockProjectId,
              prompt: `Create a parallel conversation ${iteration}`,
              model: "openai/gpt-5",
              modelProvider: "openai",
              modelCredentialEnvKeys: [],
              idempotencyKey: `project-lock-session-${lockProjectId}-${iteration}`,
              attachments: [],
              database,
            }),
        );
        const results = await Promise.allSettled([enqueue, newSession]);
        expect(
          results.flatMap((result) =>
            result.status === "rejected"
              ? [{
                  name: result.reason instanceof Error
                    ? result.reason.name
                    : "unknown",
                  code:
                    typeof result.reason === "object"
                    && result.reason !== null
                    && "code" in result.reason
                      ? result.reason.code
                      : null,
                }]
              : []
          ),
          `new-session/enqueue iteration ${iteration}`,
        ).toEqual([]);
        await integrationDb
          .update(schema.projectPrompts)
          .set({ status: "completed", completedAt: new Date() })
          .where(
            and(
              eq(schema.projectPrompts.orgId, fixture.orgA),
              eq(schema.projectPrompts.sessionId, lockSessionId),
              eq(schema.projectPrompts.status, "queued"),
            ),
          );
        await integrationDb
          .update(schema.projectSessions)
          .set({ status: "completed", stopRequestedAt: null })
          .where(eq(schema.projectSessions.id, lockSessionId));
      }
    } finally {
      await integrationDb
        .delete(schema.projects)
        .where(eq(schema.projects.id, lockProjectId));
    }
  });

  it("acquires the quota advisory lock before waiting on an open usage row", async () => {
    const usageProjectId = randomUUID();
    const sandboxName = `project-quota-order-${usageProjectId}`;
    const activationRevision = 4;
    const now = new Date();
    const periodStart = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      1,
    ));
    const applicationName = `project-quota-order-${randomUUID()}`;
    const config: BillingRuntimeConfig = {
      billingMode: "stripe",
      entitlementMode: "off",
      pilotOrgIds: new Set(),
      proOrgAllowlist: new Set(),
      checkoutEnabled: false,
      webhooksEnabled: false,
      sandboxMinutesPerSeat: 250,
    };
    await integrationDb.insert(schema.sandboxUsageSessions).values({
      orgId: fixture.orgA,
      creatorId: fixture.owner.id,
      kind: "project",
      sourceId: usageProjectId,
      sandboxName,
      activationRevision,
      periodStart,
      reservedMs: 10 * 60_000,
      reservationExpiresAt: new Date(now.getTime() + 15 * 60_000),
    });

    let releaseUsageRow!: () => void;
    const usageRowReleased = new Promise<void>((resolve) => {
      releaseUsageRow = resolve;
    });
    let markUsageRowLocked!: () => void;
    const usageRowLocked = new Promise<void>((resolve) => {
      markUsageRowLocked = resolve;
    });
    const rowHolder = integrationSql.begin(async (tx) => {
      await tx`
        select id
        from sandbox_usage_sessions
        where org_id = ${fixture.orgA}::uuid
          and kind = 'project'
          and source_id = ${usageProjectId}::uuid
          and activation_revision = ${activationRevision}
        for update
      `;
      markUsageRowLocked();
      await usageRowReleased;
    });
    await usageRowLocked;

    const admission = withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      async (database) => {
        await database.execute(
          drizzleSql`select set_config('application_name', ${applicationName}, true)`,
        );
        return admitProjectPromptUsage({
          orgId: fixture.orgA,
          creatorId: fixture.owner.id,
          projectId: usageProjectId,
          sandboxName,
          currentActivationRevision: activationRevision,
          database,
          now,
          config,
        });
      },
    );

    let observed:
      | { waitEventType: string | null; advisoryGranted: boolean }
      | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        [observed] = await integrationSql<Array<{
          waitEventType: string | null;
          advisoryGranted: boolean;
        }>>`
          select
            activity.wait_event_type as "waitEventType",
            exists (
              select 1
              from pg_locks held
              where held.pid = activity.pid
                and held.locktype = 'advisory'
                and held.granted
            ) as "advisoryGranted"
          from pg_stat_activity activity
          where activity.application_name = ${applicationName}
            and activity.state = 'active'
        `;
        if (observed?.waitEventType === "Lock") break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // With the former usage-row -> quota-advisory order, this same blocked transaction had no
      // granted advisory lock, deterministically exposing the inversion with the worker runway path.
      expect(observed).toEqual({
        waitEventType: "Lock",
        advisoryGranted: true,
      });
    } finally {
      releaseUsageRow();
      await rowHolder;
    }
    await expect(admission).resolves.toEqual({
      activationRevision,
      reservationMs: 7 * 60_000,
    });
  });
});
