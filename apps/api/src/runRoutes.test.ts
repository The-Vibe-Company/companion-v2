import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.COMPANION_SECRETS_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.COMPANION_GOLDEN_SNAPSHOT_ID = "snapshot-test";
process.env.COMPANION_RUNS_ENABLED = "true";
process.env.COMPANION_PROJECTS_ENABLED = "true";

const serviceMocks = vi.hoisted(() => ({
  ApiTokenRefreshError: class ApiTokenRefreshError extends Error {},
  RunBusyError: class RunBusyError extends Error {
    readonly code: string;

    constructor(message: string, code = "run_conflict") {
      super(message);
      this.code = code;
    }
  },
  RunValidationError: class RunValidationError extends Error {
    readonly code: string;

    constructor(message: string, code = "invalid_run") {
      super(message);
      this.code = code;
    }
  },
  ProjectConflictError: class ProjectConflictError extends Error {},
  ProjectNotFoundError: class ProjectNotFoundError extends Error {},
  ProjectValidationError: class ProjectValidationError extends Error {
    readonly code: string;

    constructor(message: string, code = "invalid_project") {
      super(message);
      this.code = code;
    }
  },
  ensureUserBootstrap: vi.fn(async () => undefined),
  listOrgs: vi.fn(),
  resolveApiToken: vi.fn(),
  refreshApiToken: vi.fn(),
  getRunOptions: vi.fn(),
  listProjects: vi.fn(),
  getProject: vi.fn(),
  getProjectCreateReplay: vi.fn(async (): Promise<unknown> => null),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  retryProjectWorkspace: vi.fn(),
  setProjectSkills: vi.fn(),
  requestProjectDeletion: vi.fn(async () => undefined),
  listProjectSessions: vi.fn(),
  updateProjectSession: vi.fn(),
  getProjectSession: vi.fn(),
  getProjectPromptAttachment: vi.fn(),
  createProjectSession: vi.fn(),
  enqueueProjectPrompt: vi.fn(),
  cancelQueuedProjectPrompt: vi.fn(),
  enqueueProjectQuestionReply: vi.fn(),
  enqueueProjectQuestionRejection: vi.fn(),
  hasProjectPromptIdempotencyKey: vi.fn(async () => false),
  reserveProjectAttachmentUploads: vi.fn(async () => undefined),
  reserveProjectFileUploads: vi.fn(async () => undefined),
  commitProjectFileUploads: vi.fn(),
  requestProjectSessionStop: vi.fn(),
  listProjectSessionEvents: vi.fn(),
  listProjectFiles: vi.fn(),
  getProjectFile: vi.fn(),
  listProjectFileVersions: vi.fn(),
  getProjectFileVersion: vi.fn(),
  isProjectWorkerReady: vi.fn(async () => true),
  connectedProviderIds: vi.fn(async () => new Set(["openai"])),
  connectedOrgProviderIds: vi.fn(async () => new Set<string>()),
  listProviderConnections: vi.fn(async () => [{
    id: "00000000-0000-4000-8000-000000000004",
    provider: "openai",
    key_name: "OPENAI_API_KEY",
    scope: "personal",
    credential_version: 1,
    set: true,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
  }]),
  listOrgProviderConnections: vi.fn(async () => []),
  getActivatedModels: vi.fn(async () => ({ personal: ["openai/gpt-5"], org: [] })),
  listRunConfigurations: vi.fn(),
  createRunConfiguration: vi.fn(),
  updateRunConfiguration: vi.fn(),
  deleteRunConfiguration: vi.fn(async () => undefined),
  createRun: vi.fn(),
  createRunPrewarm: vi.fn(),
  heartbeatRunPrewarm: vi.fn(),
  cancelRunPrewarm: vi.fn(async () => undefined),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  enqueueRunPrompt: vi.fn(),
  preflightRunPromptUpload: vi.fn(async () => undefined),
  reserveRunAttachmentUploads: vi.fn(async () => undefined),
  requestRunPromptCancellation: vi.fn(),
  requestRunCancellation: vi.fn(),
  listRunEvents: vi.fn(),
  getRunAttachment: vi.fn(),
  getRunArtifact: vi.fn(),
  detectRunFileType: vi.fn((_path: string, data: Buffer) => ({
    contentType: data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? "image/png"
      : "application/octet-stream",
    previewable: data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
    previewContentType: data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? "image/png"
      : null,
    previewKind: data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      ? "image"
      : null,
  })),
  isRunWorkerReady: vi.fn(async () => true),
  setProviderConnection: vi.fn(),
  setOrgProviderConnection: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  authenticateAgentRequest: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
}));

const storageMocks = vi.hoisted(() => {
  class InvalidSkillArchiveRangeError extends Error {}
  return {
    InvalidSkillArchiveRangeError,
    putSkillArchive: vi.fn(async (_input: { key: string }) => undefined),
    deleteSkillArchive: vi.fn(async (_input: { key: string }) => undefined),
    getSkillArchive: vi.fn(async (_input: { key: string }) => Buffer.from("artifact")),
    headSkillArchive: vi.fn(async (_input: { key: string }) => ({ etag: '"asset-etag"', contentLength: 8 })),
    streamSkillArchive: vi.fn(async (input: { key: string; range?: string; ifMatch?: string }) => {
      const match = input.range ? /^bytes=(\d+)-(\d+)$/.exec(input.range) : null;
      const start = match ? Number(match[1]) : 0;
      const end = match ? Number(match[2]) : 7;
      const body = "artifact".slice(start, end + 1);
      return {
        body: new Response(body).body!,
        contentLength: body.length,
        contentRange: match ? `bytes ${start}-${end}/8` : null,
        contentType: "application/octet-stream",
        etag: input.ifMatch ?? '"asset-etag"',
      };
    }),
    resolveSkillArchiveByteRange: (value: string, size: number) => {
      const match = /^bytes=(\d*)-(\d*)$/.exec(value);
      if (!match || (match[1] === "" && match[2] === "") || value.includes(",")) {
        throw new InvalidSkillArchiveRangeError();
      }
      const start = match[1] === "" ? Math.max(0, size - Number(match[2])) : Number(match[1]);
      const end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) {
        throw new InvalidSkillArchiveRangeError();
      }
      return { start, end, length: end - start + 1, header: `bytes=${start}-${end}` };
    },
    isStoragePreconditionFailure: (error: unknown) => error instanceof Error && error.name === "PreconditionFailed",
  };
});

const catalogMocks = vi.hoisted(() => ({
  listModels: vi.fn(async () => ({
    models: [{ id: "openai/gpt-5", provider: "openai", provider_name: "OpenAI", name: "GPT-5", description: null, context: null, cost_input: null, cost_output: null, env_keys: ["OPENAI_API_KEY"] }],
    providers: [{ id: "openai", name: "OpenAI", env_keys: ["OPENAI_API_KEY"] }],
  })),
  resolveModel: vi.fn(async () => ({ envKeys: ["OPENAI_API_KEY"] })),
  clearCache: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: { api: { getSession: authMocks.getSession }, handler: authMocks.handler, $Infer: {} },
  authenticateAgentRequest: authMocks.authenticateAgentRequest,
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
}));
vi.mock("@companion/core/services", () => serviceMocks);
vi.mock("@companion/db", () => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => fn({})),
  sql: { listen: vi.fn() },
}));
vi.mock("@companion/sandbox", () => ({
  createModelCatalog: () => catalogMocks,
}));
vi.mock("@companion/storage", () => ({
    runAttachmentKey: ({ orgId, attachmentId }: { orgId: string; attachmentId: string }) => `${orgId}/${attachmentId}`,
    projectAttachmentKey: ({ orgId, projectId, attachmentId }: { orgId: string; projectId: string; attachmentId: string }) =>
      `${orgId}/projects/${projectId}/attachments/${attachmentId}`,
  projectFileCacheKey: ({ orgId, projectId, checksum }: { orgId: string; projectId: string; checksum: string }) =>
    `${orgId}/project-files/${projectId}/sha256/${checksum.slice("sha256:".length)}`,
  putSkillArchive: storageMocks.putSkillArchive,
  deleteSkillArchive: storageMocks.deleteSkillArchive,
  getSkillArchive: storageMocks.getSkillArchive,
  headSkillArchive: storageMocks.headSkillArchive,
  streamSkillArchive: storageMocks.streamSkillArchive,
  resolveSkillArchiveByteRange: storageMocks.resolveSkillArchiveByteRange,
  InvalidSkillArchiveRangeError: storageMocks.InvalidSkillArchiveRangeError,
  isStoragePreconditionFailure: storageMocks.isStoragePreconditionFailure,
  publicSkillReleaseKey: ({ orgId, checksum }: { orgId: string; checksum: string }) =>
    `${orgId}/public-releases/sha256/${checksum.slice("sha256:".length)}.zip`,
  putPublicSkillReleaseSnapshot: vi.fn(async () => "public-snapshot.zip"),
}));

import { app } from "./index";

const actor = { id: "run-user", email: "run-user@thevibecompany.co", name: "Run User" };
const ineligibleActor = {
  id: "outside-user",
  email: "outside@example.test",
  name: "Outside User",
};
const skillVersionId = "00000000-0000-4000-8000-000000000001";
const configId = "00000000-0000-4000-8000-000000000002";
const secretId = "00000000-0000-4000-8000-000000000003";
const providerConnectionId = "00000000-0000-4000-8000-000000000004";
const dependencySkillId = "00000000-0000-4000-8000-000000000004";
const dependencyVersionId = "00000000-0000-4000-8000-000000000005";
const projectId = "00000000-0000-4000-8000-000000000006";

function signIn(): void {
  authMocks.getSession.mockResolvedValue({ user: actor, session: { id: "session-1" } });
  serviceMocks.listOrgs.mockResolvedValue([{ org_id: "00000000-0000-4000-8000-000000000010", name: "Org" }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.getSession.mockResolvedValue(null);
  process.env.COMPANION_PROJECTS_ENABLED = "true";
  delete process.env.COMPANION_RUN_PREWARM_ENABLED;
});

describe("session-only project routes", () => {
  const project = {
    id: projectId,
    name: "Quarterly review",
    default_model: "openai/gpt-5",
    revision: 1,
    status: "ready",
    skill_count: 0,
    session_count: 0,
    active_session_count: 0,
    archived_session_count: 0,
    unread_session_count: 0,
    file_count: 0,
    recent_sessions: [],
    last_activity_at: "2026-07-23T18:00:00.000Z",
    error_code: null,
    message: null,
    archived_at: null,
    created_at: "2026-07-23T18:00:00.000Z",
    updated_at: "2026-07-23T18:00:00.000Z",
    skills: [],
    sessions: [],
    secret_count: 0,
    model_connection_count: 1,
    access: {
      secrets: [],
      model_connections: [
        {
          id: providerConnectionId,
          provider: "openai",
          source: "personal",
        },
      ],
    },
  };
  const session = {
    id: "00000000-0000-4000-8000-000000000007",
    project_id: projectId,
    title: "Prepare the review",
    model: "openai/gpt-5",
    status: "queued",
    opencode_session_id: null,
    stop_requested_at: null,
    error_code: null,
    message: null,
    last_active_at: "2026-07-23T18:01:00.000Z",
    archived_at: null,
    last_viewed_at: "2026-07-23T18:01:00.000Z",
    is_unread: false,
    created_at: "2026-07-23T18:01:00.000Z",
    updated_at: "2026-07-23T18:01:00.000Z",
    prompts: [],
    questions: [],
    transcript: [],
    current_event_sequence: 0,
    latest_event_sequence: 0,
  };

  it("hides Projects from signed-in users outside the internal pilot", async () => {
    authMocks.getSession.mockResolvedValue({
      user: ineligibleActor,
      session: { id: "session-outside" },
    });

    const response = await app.request("/v1/projects");

    expect(response.status).toBe(404);
    expect(serviceMocks.listProjects).not.toHaveBeenCalled();
    expect(serviceMocks.listOrgs).not.toHaveBeenCalled();
  });

  it("lists runtime readiness and supports exact create/update/skills contracts", async () => {
    signIn();
    serviceMocks.listProjects.mockResolvedValue([project]);
    serviceMocks.createProject.mockResolvedValue(project);
    serviceMocks.updateProject.mockResolvedValue({ ...project, name: "Q3 review", revision: 2 });
    serviceMocks.retryProjectWorkspace.mockResolvedValue({ ...project, status: "queued" });
    serviceMocks.setProjectSkills.mockResolvedValue({
      ...project,
      revision: 2,
      skill_count: 1,
    });

    const listed = await app.request("/v1/projects");
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      projects: [project],
      runtime: { available: true, message: null },
    });
    expect(serviceMocks.listProjects).toHaveBeenCalledWith(
      expect.objectContaining({ view: "active" }),
    );
    const archivedList = await app.request("/v1/projects?view=archived");
    expect(archivedList.status).toBe(200);
    expect(serviceMocks.listProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ view: "archived" }),
    );

    const created = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "project-create-1",
      },
      body: JSON.stringify({
        name: project.name,
        default_model: project.default_model,
        skill_slugs: [],
      }),
    });
    expect(created.status).toBe(201);
    expect(serviceMocks.createProject).toHaveBeenCalledWith(
      expect.objectContaining({
        value: {
          name: project.name,
          default_model: project.default_model,
          skill_slugs: [],
        },
        idempotencyKey: "project-create-1",
      }),
    );

    const renamed = await app.request(`/v1/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, name: "Q3 review" }),
    });
    expect(renamed.status).toBe(200);
    expect(serviceMocks.updateProject).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        value: { revision: 1, name: "Q3 review" },
      }),
    );
    const archived = await app.request(`/v1/projects/${projectId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 2, archived: true }),
    });
    expect(archived.status).toBe(200);
    expect(serviceMocks.updateProject).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId,
        value: { revision: 2, archived: true },
      }),
    );

    const retried = await app.request(`/v1/projects/${projectId}/retry`, {
      method: "POST",
    });
    expect(retried.status).toBe(202);
    expect(serviceMocks.retryProjectWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({ projectId }),
    );

    const skills = await app.request(`/v1/projects/${projectId}/skills`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, skill_slugs: ["research"] }),
    });
    expect(skills.status).toBe(200);
    expect(serviceMocks.setProjectSkills).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        value: { revision: 1, skill_slugs: ["research"] },
      }),
    );
  });

  it("requires an idempotency key before accepting Project creation", async () => {
    signIn();
    const response = await app.request("/v1/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: project.name,
        default_model: project.default_model,
        skill_slugs: [],
      }),
    });
    expect(response.status).toBe(422);
    expect(serviceMocks.createProject).not.toHaveBeenCalled();
  });

  it("replays a committed Project create before mutable runtime readiness checks", async () => {
    signIn();
    serviceMocks.getProjectCreateReplay.mockResolvedValueOnce(project);
    serviceMocks.isProjectWorkerReady.mockResolvedValueOnce(false);
    const response = await app.request("/v1/projects", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": "project-create-replay",
      },
      body: JSON.stringify({
        name: project.name,
        default_model: project.default_model,
        skill_slugs: [],
      }),
    });
    expect(response.status).toBe(201);
    expect(serviceMocks.createProject).not.toHaveBeenCalled();
    expect(serviceMocks.isProjectWorkerReady).not.toHaveBeenCalled();
    expect(catalogMocks.listModels).not.toHaveBeenCalled();
  });

  it("creates multipart sessions, queues follow-ups and returns the durable session after stop", async () => {
    signIn();
    serviceMocks.getProject.mockResolvedValue(project);
    serviceMocks.createProjectSession.mockResolvedValue(session);
    serviceMocks.getProjectSession.mockResolvedValue(session);
    serviceMocks.enqueueProjectPrompt.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000008",
      session_id: session.id,
      sequence: 2,
      opencode_message_id: "project-message-2",
      text: "Add sources",
      status: "queued",
      error_code: null,
      error_message: null,
      attachments: [],
      file_changes: [],
      created_at: session.created_at,
      started_at: null,
      completed_at: null,
    });
    serviceMocks.requestProjectSessionStop.mockResolvedValue({
      ...session,
      status: "stopping",
    });
    serviceMocks.cancelQueuedProjectPrompt.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000008",
      session_id: session.id,
      sequence: 2,
      opencode_message_id: "project-message-2",
      text: "Add sources",
      status: "cancelled",
      error_code: null,
      error_message: null,
      attachments: [],
      file_changes: [],
      created_at: session.created_at,
      started_at: null,
      completed_at: session.created_at,
    });

    const createForm = new FormData();
    createForm.set("prompt", "Prepare the quarterly review");
    createForm.set("model", "openai/gpt-5");
    createForm.set(
      "file",
      new File([Buffer.from("quarterly data")], "brief.txt", { type: "text/plain" }),
    );
    const created = await app.request(`/v1/projects/${projectId}/sessions`, {
      method: "POST",
      headers: { "Idempotency-Key": "project-session-1" },
      body: createForm,
    });
    expect(created.status).toBe(201);
    expect(serviceMocks.createProjectSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        prompt: "Prepare the quarterly review",
        model: "openai/gpt-5",
        idempotencyKey: "project-session-1",
        attachments: [
          expect.objectContaining({
            fileName: "brief.txt",
            contentType: "text/plain",
            workspacePath: "files/brief.txt",
          }),
        ],
      }),
    );
    expect(serviceMocks.reserveProjectAttachmentUploads).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        storageKeys: [expect.stringContaining(`/projects/${projectId}/attachments/`)],
      }),
    );
    expect(
      serviceMocks.reserveProjectAttachmentUploads.mock.invocationCallOrder[0],
    ).toBeLessThan(storageMocks.putSkillArchive.mock.invocationCallOrder[0]!);

    const followUpForm = new FormData();
    followUpForm.set("prompt", "Add sources");
    const followUp = await app.request(
      `/v1/projects/${projectId}/sessions/${session.id}/prompts`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "project-prompt-2" },
        body: followUpForm,
      },
    );
    expect(followUp.status).toBe(202);
    expect(serviceMocks.enqueueProjectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        sessionId: session.id,
        text: "Add sources",
      }),
    );

    const cancelled = await app.request(
      `/v1/projects/${projectId}/sessions/${session.id}/prompts/00000000-0000-4000-8000-000000000008/cancel`,
      { method: "POST" },
    );
    expect(cancelled.status).toBe(200);
    expect(serviceMocks.cancelQueuedProjectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        sessionId: session.id,
        promptId: "00000000-0000-4000-8000-000000000008",
      }),
    );

    const stopped = await app.request(
      `/v1/projects/${projectId}/sessions/${session.id}/stop`,
      { method: "POST" },
    );
    expect(stopped.status).toBe(202);
    await expect(stopped.json()).resolves.toEqual(session);
  });

  it("queues native Project question replies and rejections without contacting OpenCode", async () => {
    signIn();
    serviceMocks.getProjectSession.mockResolvedValue(session);
    serviceMocks.enqueueProjectQuestionReply.mockResolvedValue({
      request_id: "question-request-1",
      status: "queued",
    });
    serviceMocks.enqueueProjectQuestionRejection.mockResolvedValue({
      request_id: "question-request-2",
      status: "queued",
    });

    const replied = await app.request(
      `/v1/projects/${projectId}/sessions/${session.id}/questions/question-request-1/reply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: [["Quarterly"], ["PDF", "Markdown"]] }),
      },
    );
    expect(replied.status).toBe(202);
    await expect(replied.json()).resolves.toEqual(session);
    expect(serviceMocks.enqueueProjectQuestionReply).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        sessionId: session.id,
        requestId: "question-request-1",
        value: { answers: [["Quarterly"], ["PDF", "Markdown"]] },
      }),
    );

    const rejected = await app.request(
      `/v1/projects/${projectId}/sessions/${session.id}/questions/question-request-2/reject`,
      { method: "POST" },
    );
    expect(rejected.status).toBe(202);
    expect(serviceMocks.enqueueProjectQuestionRejection).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        sessionId: session.id,
        requestId: "question-request-2",
      }),
    );

    const invalid = await app.request(
      `/v1/projects/${projectId}/sessions/${session.id}/questions/question-request-3/reply`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers: [] }),
      },
    );
    expect(invalid.status).toBe(400);
    expect(serviceMocks.enqueueProjectQuestionReply).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicit follow-up for a completed Project conversation", async () => {
    signIn();
    const completedSession = { ...session, status: "completed" };
    serviceMocks.getProjectSession.mockResolvedValue(completedSession);
    serviceMocks.enqueueProjectPrompt.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000088",
      session_id: session.id,
      sequence: 2,
      opencode_message_id: "project-message-completed-follow-up",
      text: "Continue from the completed result",
      status: "queued",
      error_code: null,
      error_message: null,
      attachments: [],
      file_changes: [],
      created_at: session.created_at,
      started_at: null,
      completed_at: null,
    });

    const form = new FormData();
    form.set("prompt", "Continue from the completed result");
    const response = await app.request(
      `/v1/projects/${projectId}/sessions/${session.id}/prompts`,
      {
        method: "POST",
        headers: { "Idempotency-Key": "project-completed-follow-up" },
        body: form,
      },
    );

    expect(response.status).toBe(202);
    expect(serviceMocks.enqueueProjectPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        sessionId: session.id,
        text: "Continue from the completed result",
      }),
    );
  });

  it("lists, renames, archives and marks conversations read through creator-scoped commands", async () => {
    signIn();
    serviceMocks.listProjectSessions.mockResolvedValue({
      sessions: [session],
      next_cursor: "next-page",
    });
    serviceMocks.updateProjectSession.mockResolvedValue({
      ...session,
      title: "Board review",
      archived_at: session.created_at,
    });
    serviceMocks.getProjectSession.mockResolvedValue({
      ...session,
      title: "Board review",
      archived_at: session.created_at,
    });

    const listed = await app.request(
      `/v1/projects/${projectId}/sessions?q=review&view=archived&cursor=opaque&limit=25`,
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({
      sessions: [session],
      next_cursor: "next-page",
    });
    expect(serviceMocks.listProjectSessions).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        query: {
          q: "review",
          view: "archived",
          cursor: "opaque",
          limit: 25,
        },
      }),
    );

    const patched = await app.request(
      `/v1/projects/${projectId}/sessions/${session.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: "Board review",
          archived: true,
          viewed: true,
          stop_active: true,
        }),
      },
    );
    expect(patched.status).toBe(202);
    expect(serviceMocks.updateProjectSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        sessionId: session.id,
        value: {
          title: "Board review",
          archived: true,
          viewed: true,
          stop_active: true,
        },
      }),
    );
    await expect(patched.json()).resolves.toMatchObject({
      id: session.id,
      title: "Board review",
      archived_at: session.created_at,
      prompts: session.prompts,
      transcript: session.transcript,
    });
    expect(serviceMocks.getProjectSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId,
        sessionId: session.id,
      }),
    );
  });

  it("streams a durable Project prompt attachment without exposing storage identity", async () => {
    signIn();
    serviceMocks.getProjectPromptAttachment.mockResolvedValue({
      fileName: "brief.txt",
      contentType: "text/plain",
      byteSize: 8,
      storageKey: "private-project-attachment",
    });

    const response = await app.request(
      `/v1/projects/${projectId}/sessions/${session.id}/attachments/00000000-0000-4000-8000-000000000099?download=1`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toContain("attachment");
    const body = await response.text();
    expect(body).toBe("artifact");
    expect(body).not.toContain("private-project-attachment");
  });

  it("publishes Project files as durable desired state without contacting the runtime", async () => {
    signIn();
    const file = {
      id: "00000000-0000-4000-8000-000000000009",
      project_id: projectId,
      path: "files/brief.txt",
      version: 1,
      content_type: "text/plain",
      byte_size: 11,
      checksum: `sha256:${"a".repeat(64)}`,
      modified_by_session_id: null,
      modified_by_prompt_id: null,
      conflict_detected: false,
      created_at: "2026-07-23T18:02:00.000Z",
      updated_at: "2026-07-23T18:02:00.000Z",
    };
    serviceMocks.commitProjectFileUploads.mockResolvedValue([file]);
    const form = new FormData();
    form.set("file", new File([Buffer.from("hello world")], "brief.txt", {
      type: "text/plain",
    }));

    const response = await app.request(`/v1/projects/${projectId}/files`, {
      method: "POST",
      body: form,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ files: [file] });
    expect(serviceMocks.reserveProjectFileUploads).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        projectId,
        storageKeys: [
          expect.stringMatching(
            new RegExp(`/project-files/${projectId}/sha256/[0-9a-f]{64}$`),
          ),
        ],
      }),
    );
    expect(serviceMocks.reserveProjectFileUploads.mock.invocationCallOrder[0]).toBeLessThan(
      storageMocks.putSkillArchive.mock.invocationCallOrder[0]!,
    );
    expect(storageMocks.putSkillArchive).toHaveBeenCalledWith(
      expect.objectContaining({
        preventOverwrite: true,
        contentType: "text/plain",
      }),
    );
    expect(serviceMocks.commitProjectFileUploads).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        projectId,
        files: [
          expect.objectContaining({
            path: "files/brief.txt",
            byteSize: 11,
          }),
        ],
      }),
    );
    expect(serviceMocks.isProjectWorkerReady).not.toHaveBeenCalled();
  });

  it("lists and downloads creator-scoped immutable Project file versions", async () => {
    signIn();
    const fileId = "00000000-0000-4000-8000-000000000009";
    const version = {
      project_id: projectId,
      file_id: fileId,
      path: "files/report.md",
      version: 2,
      content_type: "text/markdown",
      byte_size: 8,
      checksum: "a".repeat(64),
      modified_by_session_id: session.id,
      modified_by_prompt_id: "00000000-0000-4000-8000-000000000008",
      base_version: 1,
      conflict_detected: true,
      created_at: "2026-07-23T18:02:00.000Z",
    };
    serviceMocks.listProjectFileVersions.mockResolvedValue([version]);
    serviceMocks.getProjectFileVersion.mockResolvedValue({
      ...version,
      storage_key: "project-version-object",
    });

    const listed = await app.request(
      `/v1/projects/${projectId}/files/${fileId}/versions`,
    );
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ versions: [version] });

    const downloaded = await app.request(
      `/v1/projects/${projectId}/files/${fileId}/versions/2`,
    );
    expect(downloaded.status).toBe(200);
    await expect(downloaded.text()).resolves.toBe("artifact");
    expect(serviceMocks.getProjectFileVersion).toHaveBeenCalledWith(
      expect.objectContaining({ projectId, fileId, version: 2 }),
    );
  });

  it("keeps the feature flag and session-only/private boundaries explicit", async () => {
    signIn();
    process.env.COMPANION_PROJECTS_ENABLED = "false";
    expect((await app.request("/v1/projects")).status).toBe(404);
    process.env.COMPANION_PROJECTS_ENABLED = "true";

    authMocks.getSession.mockResolvedValue(null);
    serviceMocks.resolveApiToken.mockResolvedValue({
      actor,
      orgId: "00000000-0000-4000-8000-000000000010",
      scopes: ["skills:read"],
    });
    const tokenResponse = await app.request("/v1/projects", {
      headers: { Authorization: "Bearer cmp_pat_test" },
    });
    expect(tokenResponse.status).toBe(401);
    expect(serviceMocks.listProjects).not.toHaveBeenCalled();

    serviceMocks.resolveApiToken.mockResolvedValue(null);
    authMocks.authenticateAgentRequest.mockResolvedValue({
      actor,
      workspaceId: "00000000-0000-4000-8000-000000000010",
      capability: "skills:read",
      session: { agentId: "agent-1" },
    });
    const agentResponse = await app.request("/v1/projects", {
      headers: {
        Authorization: "Bearer signed.agent.jwt",
        "x-companion-workspace-id": "00000000-0000-4000-8000-000000000010",
      },
    });
    expect(agentResponse.status).toBe(401);
    expect(serviceMocks.listProjects).not.toHaveBeenCalled();

    signIn();
    serviceMocks.getProject.mockRejectedValueOnce(new serviceMocks.ProjectNotFoundError());
    expect((await app.request(`/v1/projects/${projectId}`)).status).toBe(404);
  });

  it("rejects unauthenticated Project uploads before the large-body limiter", async () => {
    authMocks.getSession.mockResolvedValue(null);
    const headers = {
      "content-type": "multipart/form-data; boundary=blocked",
      "content-length": String(65 * 1024 * 1024),
    };
    const create = await app.request(`/v1/projects/${projectId}/sessions`, {
      method: "POST",
      headers,
      body: "--blocked--",
    });
    const followUp = await app.request(
      `/v1/projects/${projectId}/sessions/00000000-0000-4000-8000-000000000007/prompts`,
      { method: "POST", headers, body: "--blocked--" },
    );
    expect(create.status).toBe(401);
    expect(followUp.status).toBe(401);
    expect(serviceMocks.createProjectSession).not.toHaveBeenCalled();
    expect(serviceMocks.enqueueProjectPrompt).not.toHaveBeenCalled();
  });
});

describe("session-only RunSkill routes", () => {
  it("hides Run Skill when its deployment flag is disabled", async () => {
    signIn();
    process.env.COMPANION_RUNS_ENABLED = "false";
    try {
      const response = await app.request("/v1/skills/demo/run-options");

      expect(response.status).toBe(404);
      expect(serviceMocks.getRunOptions).not.toHaveBeenCalled();
      expect(catalogMocks.listModels).not.toHaveBeenCalled();
      expect(serviceMocks.listOrgs).not.toHaveBeenCalled();
    } finally {
      process.env.COMPANION_RUNS_ENABLED = "true";
    }
  });

  it("hides Run Skill options from signed-in users outside the internal pilot", async () => {
    authMocks.getSession.mockResolvedValue({
      user: ineligibleActor,
      session: { id: "session-outside" },
    });

    const response = await app.request("/v1/skills/demo/run-options");

    expect(response.status).toBe(404);
    expect(serviceMocks.getRunOptions).not.toHaveBeenCalled();
    expect(catalogMocks.listModels).not.toHaveBeenCalled();
    expect(serviceMocks.listOrgs).not.toHaveBeenCalled();
  });

  it("rejects an ineligible Run Skill launch before reading its multipart body", async () => {
    authMocks.getSession.mockResolvedValue({
      user: ineligibleActor,
      session: { id: "session-outside" },
    });
    const response = await app.request("/v1/skills/demo/runs", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=blocked",
        "content-length": String(65 * 1024 * 1024),
      },
      body: "--blocked--",
    });

    expect(response.status).toBe(404);
    expect(serviceMocks.createRun).not.toHaveBeenCalled();
    expect(storageMocks.putSkillArchive).not.toHaveBeenCalled();
    expect(serviceMocks.listOrgs).not.toHaveBeenCalled();
  });

  it("creates, heartbeats and cancels creator-private prewarms without exposing provider state", async () => {
    signIn();
    const prewarm = {
      id: "88888888-8888-4888-8888-888888888888",
      status: "queued",
      expires_at: "2026-07-15T10:05:00.000Z",
    };
    serviceMocks.createRunPrewarm.mockResolvedValue(prewarm);
    serviceMocks.heartbeatRunPrewarm.mockResolvedValue({ ...prewarm, status: "warming" });

    const created = await app.request("/v1/skills/demo/run-prewarms", { method: "POST" });
    expect(created.status).toBe(202);
    expect(await created.json()).toEqual({ prewarm });
    const heartbeat = await app.request(`/v1/run-prewarms/${prewarm.id}/heartbeat`, { method: "POST" });
    expect(JSON.stringify(await heartbeat.json())).not.toContain("sandbox");
    expect((await app.request(`/v1/run-prewarms/${prewarm.id}/cancel`, { method: "POST" })).status).toBe(202);
    expect(serviceMocks.cancelRunPrewarm).toHaveBeenCalledWith(expect.objectContaining({ prewarmId: prewarm.id }));
  });

  it("rejects PAT access before creating a prewarm", async () => {
    serviceMocks.resolveApiToken.mockResolvedValue({ actor, orgId: "00000000-0000-4000-8000-000000000010", scopes: ["skills:read"] });
    const response = await app.request("/v1/skills/demo/run-prewarms", {
      method: "POST",
      headers: { Authorization: "Bearer cmp_pat_test" },
    });
    expect(response.status).toBe(401);
    expect(serviceMocks.createRunPrewarm).not.toHaveBeenCalled();
  });

  it("returns caught-up run options without requiring Vercel credentials in the API", async () => {
    signIn();
    serviceMocks.getRunOptions.mockResolvedValue({ runtime: { available: true, message: null }, configurations: [] });
    const response = await app.request("/v1/skills/demo/run-options");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ runtime: { available: true } });
    expect(serviceMocks.getRunOptions).toHaveBeenCalledWith(expect.objectContaining({ slug: "demo" }));
  });

  it("rejects PAT access to RunSkill", async () => {
    serviceMocks.resolveApiToken.mockResolvedValue({ actor, orgId: "00000000-0000-4000-8000-000000000010", scopes: ["skills:read"] });
    const response = await app.request("/v1/skills/demo/run-options", {
      headers: { Authorization: "Bearer cmp_pat_test" },
    });
    expect(response.status).toBe(401);
    expect(serviceMocks.getRunOptions).not.toHaveBeenCalled();
  });

  it("persists configurations and forwards optimistic revisions", async () => {
    signIn();
    const configuration = { id: configId, name: "Daily", revision: 1 };
    serviceMocks.createRunConfiguration.mockResolvedValue(configuration);
    serviceMocks.updateRunConfiguration.mockResolvedValue({ ...configuration, revision: 2, name: "Daily 2" });

    const created = await app.request("/v1/skills/demo/run-configurations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Daily", model: "openai/gpt-5", inputs: { secrets: [], variables: [] }, is_default: true }),
    });
    expect(created.status).toBe(201);

    const updated = await app.request(`/v1/run-configurations/${configId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ revision: 1, name: "Daily 2" }),
    });
    expect(updated.status).toBe(200);
    expect(serviceMocks.updateRunConfiguration).toHaveBeenCalledWith(
      expect.objectContaining({ configId, value: { revision: 1, name: "Daily 2" } }),
    );
  });

  it("requires and forwards the authoritative idempotent multipart launch payload", async () => {
    signIn();
    serviceMocks.createRun.mockResolvedValue({ id: "run-1", status: "queued" });
    const form = new FormData();
    form.set("prompt", "Run this skill");
    form.set("model", "openai/gpt-5");
    form.set("skill_version_id", skillVersionId);
    form.set("dependency_pins", JSON.stringify([
      { skill_id: dependencySkillId, skill_version_id: dependencyVersionId },
    ]));
    form.set("inputs", JSON.stringify({ secrets: [], variables: [] }));
    form.set("model_provider_connection_id", providerConnectionId);
    form.set("model_provider_credential_version", "1");
    form.set("prewarm_id", "88888888-8888-4888-8888-888888888888");
    form.set("run_config_id", configId);

    const missingKey = await app.request("/v1/skills/demo/runs", { method: "POST", body: form });
    expect(missingKey.status).toBe(422);
    expect(serviceMocks.createRun).not.toHaveBeenCalled();

    const launched = await app.request("/v1/skills/demo/runs", {
      method: "POST",
      headers: { "Idempotency-Key": "launch-request-1" },
      body: form,
    });
    expect(launched.status).toBe(201);
    expect(serviceMocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        slug: "demo",
        skillVersionId,
        dependencyPins: [{ skill_id: dependencySkillId, skill_version_id: dependencyVersionId }],
        runConfigId: configId,
        idempotencyKey: "launch-request-1",
        inputs: { secrets: [], variables: [] },
        modelProviderConnectionId: providerConnectionId,
        modelProviderCredentialVersion: 1,
        prewarmId: "88888888-8888-4888-8888-888888888888",
      }),
    );
    expect(catalogMocks.listModels).not.toHaveBeenCalled();
  });

  it("forces a cold launch when prewarming is disabled after a ticket was issued", async () => {
    signIn();
    process.env.COMPANION_RUN_PREWARM_ENABLED = "false";
    serviceMocks.createRun.mockResolvedValue({ id: "run-cold", status: "queued" });
    const form = new FormData();
    form.set("prompt", "Run this skill");
    form.set("model", "openai/gpt-5");
    form.set("skill_version_id", skillVersionId);
    form.set("dependency_pins", "[]");
    form.set("inputs", JSON.stringify({ secrets: [], variables: [] }));
    form.set("prewarm_id", "88888888-8888-4888-8888-888888888888");

    const response = await app.request("/v1/skills/demo/runs", {
      method: "POST",
      headers: { "Idempotency-Key": "cold-launch-after-rollback" },
      body: form,
    });

    expect(response.status).toBe(201);
    expect(serviceMocks.createRun).toHaveBeenCalledWith(
      expect.objectContaining({ prewarmId: undefined }),
    );
  });

  it("retains a newly uploaded object after an ambiguous createRun failure", async () => {
    signIn();
    serviceMocks.createRun.mockRejectedValueOnce(new Error("commit acknowledgement lost"));
    const form = new FormData();
    form.set("prompt", "Run this skill");
    form.set("model", "openai/gpt-5");
    form.set("skill_version_id", skillVersionId);
    form.set("dependency_pins", "[]");
    form.set("inputs", JSON.stringify({ secrets: [], variables: [] }));
    form.set("model_provider_connection_id", providerConnectionId);
    form.set("model_provider_credential_version", "1");
    form.set("file", new Blob(["durable bytes"], { type: "text/plain" }), "notes.txt");

    const response = await app.request("/v1/skills/demo/runs", {
      method: "POST",
      headers: { "Idempotency-Key": "ambiguous-launch-1" },
      body: form,
    });

    expect(response.status).toBe(400);
    expect(storageMocks.putSkillArchive).toHaveBeenCalledTimes(1);
    expect(storageMocks.deleteSkillArchive).not.toHaveBeenCalled();
    expect(serviceMocks.createRun).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ previewContentType: null })],
    }));
  });

  it("retains uploaded objects even when a failed transaction appears uncommitted", async () => {
    signIn();
    serviceMocks.createRun.mockRejectedValueOnce(new Error("launch rejected before commit"));
    const form = new FormData();
    form.set("prompt", "Run this skill");
    form.set("model", "openai/gpt-5");
    form.set("skill_version_id", skillVersionId);
    form.set("dependency_pins", "[]");
    form.set("inputs", JSON.stringify({ secrets: [], variables: [] }));
    form.set("model_provider_connection_id", providerConnectionId);
    form.set("model_provider_credential_version", "1");
    form.set("file", new Blob(["uncertain bytes"], { type: "text/plain" }), "notes.txt");

    const response = await app.request("/v1/skills/demo/runs", {
      method: "POST",
      headers: { "Idempotency-Key": "rejected-launch-1" },
      body: form,
    });

    expect(response.status).toBe(400);
    expect(storageMocks.deleteSkillArchive).not.toHaveBeenCalled();
  });

  it("enqueues follow-ups and cancellation without contacting a sandbox", async () => {
    signIn();
    const promptId = "00000000-0000-4000-8000-000000000099";
    serviceMocks.enqueueRunPrompt.mockResolvedValue({
      id: promptId,
      messageId: "msg_123456789012abcdefghijklmn",
      ordinal: 1,
      status: "queued",
      attachments: [],
      reactivated: true,
    });
    serviceMocks.requestRunCancellation.mockResolvedValue({ status: "running", requested: true });
    const prompt = await app.request("/v1/runs/run-1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "prompt-request-1" },
      body: JSON.stringify({ text: "Continue" }),
    });
    expect(prompt.status).toBe(202);
    await expect(prompt.json()).resolves.toEqual({
      accepted: true,
      prompt_id: promptId,
      message_id: "msg_123456789012abcdefghijklmn",
      ordinal: 1,
      status: "queued",
      attachments: [],
      reactivated: true,
    });
    expect(serviceMocks.enqueueRunPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ text: "Continue", attachments: [], reactivationAvailable: true }),
    );

    const canceled = await app.request("/v1/runs/run-1/cancel", { method: "POST" });
    expect(canceled.status).toBe(202);
    await expect(canceled.json()).resolves.toEqual({ status: "running", requested: true });
  });

  it("cancels the exact queued or processing prompt without ending the run", async () => {
    signIn();
    const promptId = "00000000-0000-4000-8000-000000000099";
    serviceMocks.requestRunPromptCancellation.mockResolvedValue({
      prompt_id: promptId,
      status: "cancel_requested",
      requested: true,
    });

    const response = await app.request(`/v1/runs/run-1/prompts/${promptId}/cancel`, { method: "POST" });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      prompt_id: promptId,
      status: "cancel_requested",
      requested: true,
    });
    expect(serviceMocks.requestRunPromptCancellation).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      runId: "run-1",
      promptId,
    }));
    expect(serviceMocks.requestRunCancellation).not.toHaveBeenCalled();
  });

  it("keeps prompt cancellation session-only and hides unknown prompt ownership", async () => {
    const promptId = "00000000-0000-4000-8000-000000000099";
    serviceMocks.resolveApiToken.mockResolvedValue({
      actor,
      orgId: "00000000-0000-4000-8000-000000000010",
      scopes: ["skills:read"],
    });
    const tokenResponse = await app.request(`/v1/runs/run-1/prompts/${promptId}/cancel`, {
      method: "POST",
      headers: { Authorization: "Bearer cmp_pat_test" },
    });
    expect(tokenResponse.status).toBe(401);
    expect(serviceMocks.requestRunPromptCancellation).not.toHaveBeenCalled();

    signIn();
    serviceMocks.requestRunPromptCancellation.mockRejectedValueOnce(
      new serviceMocks.RunValidationError("prompt not found", "prompt_not_found"),
    );
    const missing = await app.request(`/v1/runs/run-1/prompts/${promptId}/cancel`, { method: "POST" });
    expect(missing.status).toBe(404);
  });

  it("serves safe raster artifacts inline and forces all downloads when requested", async () => {
    signIn();
    serviceMocks.getRunArtifact.mockResolvedValue({
      fileName: "cat.png",
      contentType: "image/png",
      storageKey: "org/run-artifacts/run/cat",
      previewable: true,
    });
    const inline = await app.request("/v1/runs/run-1/artifacts/artifact-1");
    expect(inline.status).toBe(200);
    expect(inline.headers.get("content-disposition")).toBe('inline; filename="cat.png"');
    expect(inline.headers.get("x-content-type-options")).toBe("nosniff");
    expect(inline.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(inline.headers.get("cache-control")).toBe("private, no-store");
    expect(inline.headers.get("etag")).toBe('"asset-etag"');

    const download = await app.request("/v1/runs/run-1/artifacts/artifact-1?download=1");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="cat.png"');
  });

  it("streams verified video ranges and rejects multiple ranges", async () => {
    signIn();
    serviceMocks.getRunArtifact.mockResolvedValue({
      fileName: "clip.mp4",
      contentType: "video/mp4",
      storageKey: "org/run-artifacts/run/clip",
      previewable: true,
    });

    const partial = await app.request("/v1/runs/run-1/artifacts/video-1", {
      headers: { Range: "bytes=2-5", "If-Range": '"asset-etag"' },
    });
    expect(partial.status).toBe(206);
    expect(partial.headers.get("accept-ranges")).toBe("bytes");
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/8");
    expect(partial.headers.get("content-length")).toBe("4");
    expect(storageMocks.streamSkillArchive).toHaveBeenCalledWith(expect.objectContaining({
      range: "bytes=2-5",
      ifMatch: '"asset-etag"',
    }));

    storageMocks.streamSkillArchive.mockClear();
    const invalid = await app.request("/v1/runs/run-1/artifacts/video-1", {
      headers: { Range: "bytes=0-1,4-5", "If-Range": '"asset-etag"' },
    });
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */8");
    expect(storageMocks.streamSkillArchive).not.toHaveBeenCalled();
  });

  it("ignores an invalid Range when If-Range does not select the current representation", async () => {
    signIn();
    serviceMocks.getRunArtifact.mockResolvedValue({
      fileName: "clip.mp4",
      contentType: "video/mp4",
      storageKey: "org/run-artifacts/run/clip",
      previewable: true,
    });

    const response = await app.request("/v1/runs/run-1/artifacts/video-1", {
      headers: { Range: "bytes=0-1,4-5", "If-Range": '"stale-etag"' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-range")).toBeNull();
    await expect(response.text()).resolves.toBe("artifact");
    expect(storageMocks.streamSkillArchive).toHaveBeenCalledWith(expect.objectContaining({
      range: undefined,
      ifMatch: '"asset-etag"',
    }));
  });

  it("ignores Range when If-Range is stale or weak while preserving the S3 generation fence", async () => {
    signIn();
    serviceMocks.getRunArtifact.mockResolvedValue({
      fileName: "clip.mp4",
      contentType: "video/mp4",
      storageKey: "org/run-artifacts/run/clip",
      previewable: true,
    });

    for (const ifRange of ['"stale-etag"', 'W/"asset-etag"']) {
      storageMocks.streamSkillArchive.mockClear();
      const response = await app.request("/v1/runs/run-1/artifacts/video-1", {
        headers: { Range: "bytes=2-5", "If-Range": ifRange },
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("content-range")).toBeNull();
      expect(response.headers.get("content-length")).toBe("8");
      await expect(response.text()).resolves.toBe("artifact");
      expect(storageMocks.streamSkillArchive).toHaveBeenCalledWith(expect.objectContaining({
        range: undefined,
        ifMatch: '"asset-etag"',
      }));
    }
  });

  it("reopens an asset when its ETag changes between HEAD and GET", async () => {
    signIn();
    const oldAsset = {
      fileName: "clip.mp4",
      contentType: "video/mp4",
      byteSize: 8,
      storageKey: "org/run-artifacts/run/clip",
      previewable: true,
      generation: "generation-1",
    };
    const newAsset = { ...oldAsset, generation: "generation-2" };
    serviceMocks.getRunArtifact
      .mockResolvedValueOnce(oldAsset)
      .mockResolvedValueOnce(oldAsset)
      .mockResolvedValueOnce(newAsset)
      .mockResolvedValueOnce(newAsset);
    storageMocks.headSkillArchive
      .mockResolvedValueOnce({ etag: '"old-etag"', contentLength: 8 })
      .mockResolvedValueOnce({ etag: '"new-etag"', contentLength: 8 });
    storageMocks.streamSkillArchive.mockRejectedValueOnce(
      Object.assign(new Error("changed"), { name: "PreconditionFailed" }),
    );

    const response = await app.request("/v1/runs/run-1/artifacts/video-1");

    expect(response.status).toBe(200);
    expect(storageMocks.headSkillArchive).toHaveBeenCalledTimes(2);
    expect(storageMocks.streamSkillArchive).toHaveBeenNthCalledWith(2, expect.objectContaining({
      ifMatch: '"new-etag"',
    }));
  });

  it("returns the complete replacement when an If-Range ETag becomes stale during a stable-key overwrite", async () => {
    signIn();
    const oldAsset = {
      fileName: "clip.mp4",
      contentType: "video/mp4",
      byteSize: 8,
      storageKey: "org/run-artifacts/run/clip",
      previewable: true,
      generation: "generation-1",
    };
    const newAsset = { ...oldAsset, generation: "generation-2" };
    serviceMocks.getRunArtifact
      .mockResolvedValueOnce(oldAsset)
      .mockResolvedValueOnce(oldAsset)
      .mockResolvedValueOnce(newAsset)
      .mockResolvedValueOnce(newAsset);
    storageMocks.headSkillArchive
      .mockResolvedValueOnce({ etag: '"old-etag"', contentLength: 8 })
      .mockResolvedValueOnce({ etag: '"new-etag"', contentLength: 8 });
    storageMocks.streamSkillArchive.mockRejectedValueOnce(
      Object.assign(new Error("changed"), { name: "PreconditionFailed" }),
    );

    const response = await app.request("/v1/runs/run-1/artifacts/video-1", {
      headers: { Range: "bytes=2-5", "If-Range": '"old-etag"' },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("etag")).toBe('"new-etag"');
    expect(response.headers.get("content-range")).toBeNull();
    await expect(response.text()).resolves.toBe("artifact");
    expect(storageMocks.streamSkillArchive).toHaveBeenNthCalledWith(1, expect.objectContaining({
      range: "bytes=2-5",
      ifMatch: '"old-etag"',
    }));
    expect(storageMocks.streamSkillArchive).toHaveBeenNthCalledWith(2, expect.objectContaining({
      range: undefined,
      ifMatch: '"new-etag"',
    }));
  });

  it("never serves replacement bytes while artifact metadata is not ready", async () => {
    signIn();
    serviceMocks.getRunArtifact
      .mockResolvedValueOnce({
        fileName: "old.png",
        contentType: "image/png",
        byteSize: 8,
        storageKey: "org/run-artifacts/run/stable",
        previewable: true,
        generation: "generation-old",
      })
      .mockRejectedValueOnce(new Error("artifact replacement is not ready"));
    storageMocks.headSkillArchive.mockResolvedValueOnce({ etag: '"replacement-etag"', contentLength: 8 });

    const response = await app.request("/v1/runs/run-1/artifacts/replacing");

    expect(response.status).toBe(404);
    expect(storageMocks.streamSkillArchive).not.toHaveBeenCalled();
  });

  it("renders only server-verified attachments inline", async () => {
    signIn();
    serviceMocks.getRunAttachment.mockResolvedValueOnce({
      fileName: "photo.png",
      contentType: "text/html",
      previewContentType: "image/png",
      storageKey: "org/run-attachments/photo",
    });
    const image = await app.request("/v1/runs/run-1/attachments/attachment-1");
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("content-disposition")).toBe('inline; filename="photo.png"');

    serviceMocks.getRunAttachment.mockResolvedValueOnce({
      fileName: "fake.png",
      contentType: "image/png",
      previewContentType: null,
      storageKey: "org/run-attachments/fake",
    });
    const download = await app.request("/v1/runs/run-1/attachments/attachment-2");
    expect(download.headers.get("content-disposition")).toBe('attachment; filename="fake.png"');
  });

  it("previews safe documents inline and maps unavailable artifacts to 404", async () => {
    signIn();
    serviceMocks.getRunArtifact.mockResolvedValue({
      fileName: "report.html",
      contentType: "text/html; charset=utf-8",
      storageKey: "org/run-artifacts/run/report",
      previewable: false,
    });
    const attachment = await app.request("/v1/runs/run-1/artifacts/artifact-2");
    expect(attachment.headers.get("content-disposition")).toBe('attachment; filename="report.html"');
    serviceMocks.getRunArtifact.mockResolvedValue({
      fileName: "report.pdf",
      contentType: "application/pdf",
      storageKey: "org/run-artifacts/run/pdf",
      previewable: true,
    });
    const pdf = await app.request("/v1/runs/run-1/artifacts/artifact-pdf");
    expect(pdf.headers.get("content-disposition")).toBe('inline; filename="report.pdf"');
    serviceMocks.getRunArtifact.mockRejectedValue(new Error("artifact not found"));
    expect((await app.request("/v1/runs/run-1/artifacts/expired")).status).toBe(404);
  });

  it("accepts an attachment-only multipart follow-up and forwards stored metadata", async () => {
    signIn();
    const promptId = "00000000-0000-4000-8000-000000000098";
    serviceMocks.enqueueRunPrompt.mockImplementation(async (input: { attachments: Array<{ id: string; fileName: string; byteSize: number }> }) => ({
      id: promptId,
      messageId: "msg_123456789012abcdefghijklm1",
      ordinal: 1,
      status: "queued",
      attachments: input.attachments.map((attachment) => ({
        id: attachment.id,
        prompt_id: promptId,
        message_id: "msg_123456789012abcdefghijklm1",
        prompt_ordinal: 1,
        file_name: attachment.fileName,
        content_type: "text/plain",
        byte_size: attachment.byteSize,
      })),
    }));
    const form = new FormData();
    form.set("text", "");
    form.set("file", new Blob(["follow-up bytes"], { type: "text/plain" }), "follow-up.txt");

    const response = await app.request("/v1/runs/run-1/prompt", {
      method: "POST",
      headers: { "Idempotency-Key": "prompt-file-request-1" },
      body: form,
    });

    expect(response.status).toBe(202);
    expect(storageMocks.putSkillArchive).toHaveBeenCalledTimes(1);
    expect(serviceMocks.preflightRunPromptUpload).toHaveBeenCalledWith(
      expect.objectContaining({ actor, runId: "run-1", text: "", attachments: [expect.objectContaining({ fileName: "follow-up.txt" })] }),
    );
    expect(serviceMocks.preflightRunPromptUpload.mock.invocationCallOrder[0]).toBeLessThan(
      storageMocks.putSkillArchive.mock.invocationCallOrder[0]!,
    );
    expect(serviceMocks.enqueueRunPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        text: "",
        attachments: [expect.objectContaining({ fileName: "follow-up.txt", byteSize: 15, previewContentType: null })],
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      accepted: true,
      prompt_id: promptId,
      attachments: [{ file_name: "follow-up.txt" }],
    });
  });

  it("derives inline attachment media from bytes rather than the browser MIME", async () => {
    signIn();
    serviceMocks.enqueueRunPrompt.mockImplementation(async (input: { attachments: Array<{ previewContentType: string | null }> }) => ({
      id: "00000000-0000-4000-8000-000000000097",
      messageId: "msg_123456789012abcdefghijklm2",
      ordinal: 2,
      status: "queued",
      attachments: input.attachments,
    }));
    const form = new FormData();
    form.set("text", "Inspect this image");
    form.set("file", new Blob([
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ], { type: "text/html" }), "photo.png");

    const response = await app.request("/v1/runs/run-1/prompt", {
      method: "POST",
      headers: { "Idempotency-Key": "prompt-image-request-1" },
      body: form,
    });

    expect(response.status).toBe(202);
    expect(serviceMocks.enqueueRunPrompt).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({
        contentType: "text/html",
        previewContentType: "image/png",
      })],
    }));
  });
});

describe("dedicated provider credentials", () => {
  it("accepts a write-only key and returns metadata only", async () => {
    signIn();
    serviceMocks.setProviderConnection.mockResolvedValue({
      id: providerConnectionId,
      provider: "openai",
      key_name: "OPENAI_API_KEY",
      scope: "personal",
      credential_version: 1,
      set: true,
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T00:00:00.000Z",
    });
    const response = await app.request("/v1/provider-connections", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", key_name: "OPENAI_API_KEY", api_key: "sk-write-only" }),
    });
    expect(response.status).toBe(200);
    expect(serviceMocks.setProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", keyName: "OPENAI_API_KEY", apiKey: "sk-write-only" }),
    );
    expect(JSON.stringify(await response.json())).not.toContain("sk-write-only");
    const vaultReference = await app.request("/v1/provider-connections", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", key_name: "OPENAI_API_KEY", secret_id: secretId }),
    });
    expect(vaultReference.status).toBeGreaterThanOrEqual(400);
  });

});
