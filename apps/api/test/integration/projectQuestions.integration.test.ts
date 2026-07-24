import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { schema, withTenantContext } from "@companion/db";
import {
  appendProjectSessionEvent,
  claimProjectSessionStops,
  claimProjectWorkspaceJobs,
  completeProjectSessionStop,
  enqueueProjectQuestionReply,
  enqueueProjectQuestionRejection,
  getProjectSession,
  ProjectConflictError,
  ProjectNotFoundError,
  ProjectValidationError,
  requestProjectSessionStop,
} from "@companion/core/services";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise:
 * A native OpenCode question is a creator-private durable command. The browser queues exactly one
 * validated response, reloads it from the conversation, and Stop cancels any response that has not
 * crossed the worker's external-side-effect fence.
 *
 * Regression caught:
 * An API route calls OpenCode directly, an admin can answer another member's private question, a
 * duplicate click changes the response, malformed answer matrices reach the worker, or Stop leaves
 * a queued response deliverable.
 *
 * Why this test is integrated:
 * The invariant spans creator-only service authorization, workspace/session/question row locks,
 * response idempotency, the durable session projection, and Postgres RLS.
 *
 * Failure proof:
 * Removing any creator predicate, answer validation, response conflict check, or Stop cancellation
 * makes one of the ownership, replay, projection, or terminal-state assertions fail.
 */
describe("Project native question commands", () => {
  let fixture: IntegrationFixture;
  const projectId = randomUUID();
  const sessionId = randomUUID();
  const promptId = randomUUID();
  const replyRequestId = `question-${randomUUID()}`;
  const rejectRequestId = `question-${randomUUID()}`;
  const attemptedRequestId = `question-${randomUUID()}`;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    await integrationDb.insert(schema.projects).values({
      id: projectId,
      orgId: fixture.orgA,
      creatorId: fixture.owner.id,
      name: "Native questions",
      defaultModel: "openai/gpt-5",
      idempotencyKey: `questions-${projectId}`,
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
    });
    await integrationDb.insert(schema.projectSessions).values({
      id: sessionId,
      orgId: fixture.orgA,
      projectId,
      creatorId: fixture.owner.id,
      title: "Choose the deliverable",
      model: "openai/gpt-5",
      modelProvider: "openai",
      modelCredentialEnvKeys: [],
      status: "working",
    });
    await integrationDb.insert(schema.projectPrompts).values({
      id: promptId,
      orgId: fixture.orgA,
      projectId,
      sessionId,
      creatorId: fixture.owner.id,
      sequence: 1,
      text: "Prepare the deliverable",
      status: "running",
      idempotencyKey: `question-prompt-${promptId}`,
      payloadHash: "b".repeat(64),
      usageActivationRevision: 1,
      usageReservationMs: 0,
      opencodeMessageId: `message-${promptId}`,
    });
    await integrationDb.insert(schema.projectQuestions).values([
      {
        orgId: fixture.orgA,
        projectId,
        sessionId,
        promptId,
        creatorId: fixture.owner.id,
        requestId: replyRequestId,
        protocol: "question.v2",
        questions: [
          {
            header: "Format",
            question: "Which format?",
            options: [
              { label: "PDF", description: "Portable document" },
              { label: "Markdown", description: "Editable text" },
            ],
            multiple: false,
            custom: false,
          },
          {
            header: "Audience",
            question: "Who is this for?",
            options: [],
            multiple: false,
            custom: false,
          },
        ],
      },
      {
        orgId: fixture.orgA,
        projectId,
        sessionId,
        promptId,
        creatorId: fixture.owner.id,
        requestId: rejectRequestId,
        protocol: "question",
        questions: [
          {
            header: "Optional",
            question: "Add an appendix?",
            options: [{ label: "Yes", description: "Include it" }],
            multiple: false,
            custom: false,
          },
        ],
      },
      {
        orgId: fixture.orgA,
        projectId,
        sessionId,
        promptId,
        creatorId: fixture.owner.id,
        requestId: attemptedRequestId,
        protocol: "question.v2",
        questions: [
          {
            header: "Delivery",
            question: "Was this answer already sent?",
            options: [{ label: "Yes", description: "Confirm it" }],
            multiple: false,
            custom: false,
          },
        ],
        status: "queued",
        responseKind: "reply",
        answers: [["Yes"]],
        responseRequestedAt: new Date(),
        deliveryAttemptedAt: new Date(),
      },
    ]);
  });

  afterAll(async () => {
    await fixture.cleanup();
  });

  it("is creator-only, validates and idempotently queues replies, then Stop cancels them", async () => {
    const replyAs = (
      actor: IntegrationFixture["owner"],
      answers: string[][],
    ) =>
      withTenantContext(
        { orgId: fixture.orgA, userId: actor.id },
        (database) =>
          enqueueProjectQuestionReply({
            actor,
            orgId: fixture.orgA,
            projectId,
            sessionId,
            requestId: replyRequestId,
            value: { answers },
            database,
          }),
      );

    await expect(
      replyAs(fixture.admin, [["PDF"], ["Leadership"]]),
    ).rejects.toBeInstanceOf(ProjectNotFoundError);
    await expect(
      replyAs(fixture.owner, [["Slides"], ["Leadership"]]),
    ).rejects.toBeInstanceOf(ProjectValidationError);

    const queued = await replyAs(fixture.owner, [["PDF"], ["Leadership"]]);
    expect(queued).toMatchObject({
      request_id: replyRequestId,
      status: "queued",
      response_kind: "reply",
      answers: [["PDF"], ["Leadership"]],
    });
    await expect(
      replyAs(fixture.owner, [["PDF"], ["Leadership"]]),
    ).resolves.toMatchObject({ status: "queued" });
    await expect(
      replyAs(fixture.owner, [["Markdown"], ["Leadership"]]),
    ).rejects.toBeInstanceOf(ProjectConflictError);

    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) =>
        enqueueProjectQuestionRejection({
          actor: fixture.owner,
          orgId: fixture.orgA,
          projectId,
          sessionId,
          requestId: rejectRequestId,
          database,
        }),
    );
    const detail = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) =>
        getProjectSession({
          actor: fixture.owner,
          orgId: fixture.orgA,
          projectId,
          sessionId,
          database,
        }),
    );
    expect(detail.questions).toHaveLength(3);
    expect(detail.questions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        request_id: replyRequestId,
        status: "queued",
        response_kind: "reply",
      }),
      expect.objectContaining({
        request_id: rejectRequestId,
        status: "queued",
        response_kind: "reject",
      }),
    ]));

    await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) =>
        requestProjectSessionStop({
          actor: fixture.owner,
          orgId: fixture.orgA,
          projectId,
          sessionId,
          database,
        }),
    );
    const afterRequest = await integrationSql<
      Array<{ request_id: string; status: string }>
    >`
      select request_id, status
      from project_questions
      where org_id = ${fixture.orgA}::uuid
        and project_id = ${projectId}::uuid
      order by created_at, request_id
    `;
    expect(afterRequest).toHaveLength(3);
    expect(afterRequest).toEqual(expect.arrayContaining([
      { request_id: replyRequestId, status: "cancelled" },
      { request_id: rejectRequestId, status: "cancelled" },
      // Stop cannot truthfully cancel an answer after the worker committed its external-side-effect
      // fence. The active task must finish it as delivered or fail it ambiguous during stop cleanup.
      { request_id: attemptedRequestId, status: "queued" },
    ]));

    const workerId = `question-integration-${randomUUID()}`;
    const jobs = await claimProjectWorkspaceJobs({
      workerId,
      limit: 1,
      leaseSeconds: 30,
      database: integrationDb,
    });
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.projectId).toBe(projectId);
    const stops = await claimProjectSessionStops({
      job,
      workerId,
      database: integrationDb,
    });
    expect(stops).toHaveLength(1);
    await expect(
      completeProjectSessionStop({
        job,
        stop: stops[0]!,
        workerId,
        database: integrationDb,
      }),
    ).resolves.toBe(true);

    const terminal = await integrationSql<
      Array<{ request_id: string; status: string; error_code: string | null }>
    >`
      select request_id, status, error_code
      from project_questions
      where org_id = ${fixture.orgA}::uuid
        and project_id = ${projectId}::uuid
      order by created_at, request_id
    `;
    expect(terminal).toEqual(expect.arrayContaining([
      {
        request_id: attemptedRequestId,
        status: "failed",
        error_code: "project_question_delivery_ambiguous",
      },
    ]));
  });

  it("does not let a native replied event overwrite the member answer already queued by Companion", async () => {
    const isolatedProjectId = randomUUID();
    const isolatedSessionId = randomUUID();
    const isolatedPromptId = randomUUID();
    const isolatedRequestId = `question-${randomUUID()}`;
    const workerId = `question-event-${randomUUID()}`;
    await integrationDb.insert(schema.projects).values({
      id: isolatedProjectId,
      orgId: fixture.orgA,
      creatorId: fixture.owner.id,
      name: "Question acknowledgement race",
      defaultModel: "openai/gpt-5",
      idempotencyKey: `question-event-${isolatedProjectId}`,
      payloadHash: "c".repeat(64),
    });
    await integrationDb.insert(schema.projectWorkspaces).values({
      orgId: fixture.orgA,
      projectId: isolatedProjectId,
      creatorId: fixture.owner.id,
      sandboxName: `project-${isolatedProjectId}`,
      status: "running",
      desiredGeneration: 1,
      appliedGeneration: 1,
    });
    await integrationDb.insert(schema.projectSessions).values({
      id: isolatedSessionId,
      orgId: fixture.orgA,
      projectId: isolatedProjectId,
      creatorId: fixture.owner.id,
      title: "Question acknowledgement race",
      model: "openai/gpt-5",
      modelProvider: "openai",
      modelCredentialEnvKeys: [],
      status: "working",
    });
    await integrationDb.insert(schema.projectPrompts).values({
      id: isolatedPromptId,
      orgId: fixture.orgA,
      projectId: isolatedProjectId,
      sessionId: isolatedSessionId,
      creatorId: fixture.owner.id,
      sequence: 1,
      text: "Choose the format",
      status: "running",
      idempotencyKey: `question-event-prompt-${isolatedPromptId}`,
      payloadHash: "d".repeat(64),
      usageActivationRevision: 1,
      usageReservationMs: 0,
      opencodeMessageId: `message-${isolatedPromptId}`,
    });
    await integrationDb.insert(schema.projectQuestions).values({
      orgId: fixture.orgA,
      projectId: isolatedProjectId,
      sessionId: isolatedSessionId,
      promptId: isolatedPromptId,
      creatorId: fixture.owner.id,
      requestId: isolatedRequestId,
      protocol: "question.v2",
      questions: [{
        header: "Format",
        question: "Which format?",
        options: [{ label: "Companion answer", description: "The local selection" }],
        multiple: false,
        custom: false,
      }],
      status: "queued",
      responseKind: "reply",
      answers: [["Companion answer"]],
      responseRequestedAt: new Date(),
    });

    const jobs = await claimProjectWorkspaceJobs({
      workerId,
      limit: 10,
      leaseSeconds: 30,
      database: integrationDb,
    });
    const isolatedJob = jobs.find((candidate) => candidate.projectId === isolatedProjectId);
    expect(isolatedJob).toBeDefined();
    await integrationDb
      .update(schema.projectPrompts)
      .set({
        leaseOwner: workerId,
        leaseExpiresAt: new Date(Date.now() + 30_000),
      })
      .where(eq(schema.projectPrompts.id, isolatedPromptId));

    await appendProjectSessionEvent({
      job: isolatedJob!,
      prompt: {
        id: isolatedPromptId,
        orgId: fixture.orgA,
        projectId: isolatedProjectId,
        sessionId: isolatedSessionId,
        creatorId: fixture.owner.id,
        sequence: 1,
        text: "Choose the format",
        model: "openai/gpt-5",
        opencodeSessionId: "native-question-event",
        opencodeMessageId: `message-${isolatedPromptId}`,
        sendAttemptedAt: new Date(),
        leaseOwner: workerId,
      },
      workerId,
      event: {
        type: "question.replied",
        request_id: isolatedRequestId,
        protocol: "question.v2",
        answers: [["Different native event answer"]],
      },
      database: integrationDb,
    });

    const rows = await integrationSql<
      Array<{ response_kind: string; answers: string[][]; status: string }>
    >`
      select response_kind, answers, status
      from project_questions
      where org_id = ${fixture.orgA}::uuid
        and project_id = ${isolatedProjectId}::uuid
        and request_id = ${isolatedRequestId}
    `;
    expect(rows).toEqual([{
      response_kind: "reply",
      answers: [["Companion answer"]],
      status: "delivered",
    }]);
  });
});
