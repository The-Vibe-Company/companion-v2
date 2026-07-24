import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { PROJECT_PROMPT_MAX_QUEUED } from "@companion/contracts";
import { schema, withTenantContext } from "@companion/db";
import {
  cancelQueuedProjectPrompt,
  claimProjectPromptJobs,
  claimProjectWorkspaceJobs,
  enqueueProjectPrompt,
  requestProjectSessionStop,
} from "@companion/core/services";
import {
  createIntegrationFixture,
  integrationDb,
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
});
