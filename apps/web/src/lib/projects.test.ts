import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProject,
  createProjectSession,
  deleteProject,
  ensureProjectSkill,
  fetchProject,
  fetchProjectFileVersions,
  fetchProjectSession,
  fetchProjects,
  projectFileHref,
  projectFileVersionHref,
  projectSessionEventsHref,
  replaceProjectSkills,
  retryProjectWorkspace,
  sendProjectPrompt,
  stopProjectSession,
  updateProject,
} from "./projects";

const api = vi.hoisted(() => ({ apiFetch: vi.fn() }));
vi.mock("./apiClient", () => api);

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-07-23T10:00:00.000Z";
const rawRow = {
  id: PROJECT_ID,
  name: "September launch",
  default_model: "openai/gpt-5",
  revision: 1,
  status: "running",
  skill_count: 1,
  session_count: 1,
  file_count: 1,
  recent_sessions: [],
  last_activity_at: NOW,
  error_code: null,
  message: null,
  created_at: NOW,
  updated_at: NOW,
};
const rawSkill = {
  skill_id: "33333333-3333-4333-8333-333333333333",
  slug: "campaign-planner",
  display_name: "Campaign planner",
  summary: "Plan a launch campaign.",
  version: "1.0.0",
  archived: false,
};
const rawSession = {
  id: SESSION_ID,
  project_id: PROJECT_ID,
  title: "Draft the launch calendar",
  model: "openai/gpt-5",
  status: "working",
  stop_requested_at: null,
  last_active_at: NOW,
  error_code: null,
  message: null,
  created_at: NOW,
  updated_at: NOW,
};
const rawDetail = {
  ...rawRow,
  skills: [rawSkill],
  sessions: [rawSession],
  secret_count: 2,
  model_connection_count: 1,
};
const rawFile = {
  id: "44444444-4444-4444-8444-444444444444",
  project_id: PROJECT_ID,
  path: "files/planning/calendar.md",
  version: 1,
  content_type: "text/markdown",
  byte_size: 1200,
  checksum: "a".repeat(64),
  conflict_detected: true,
  created_at: NOW,
  updated_at: NOW,
};
const rawSessionDetail = {
  ...rawSession,
  prompts: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      session_id: SESSION_ID,
      sequence: 1,
      text: "Prepare the calendar",
      status: "queued",
      error_code: null,
      error_message: null,
      created_at: NOW,
      started_at: null,
      completed_at: null,
    },
  ],
  transcript: [],
  latest_event_sequence: 0,
};

describe("project queries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("normalizes list runtime readiness and persistent workspace states", async () => {
    api.apiFetch.mockResolvedValue({
      projects: [rawRow],
      runtime: { available: true, message: null },
    });

    await expect(fetchProjects()).resolves.toMatchObject({
      runtime: { available: true, message: null },
      projects: [
        {
          id: PROJECT_ID,
          defaultModel: "openai/gpt-5",
          status: "running",
          updatedAt: NOW,
        },
      ],
    });
    expect(api.apiFetch).toHaveBeenCalledWith("/v1/projects");
  });

  it("creates a project with explicit name, model, and exact skill selection", async () => {
    api.apiFetch.mockResolvedValue(rawDetail);
    await createProject({
      name: "September launch",
      defaultModel: "openai/gpt-5",
      skillSlugs: ["campaign-planner"],
      idempotencyKey: "create-project-1",
    });

    expect(api.apiFetch).toHaveBeenCalledWith("/v1/projects", {
      method: "POST",
      body: JSON.stringify({
        name: "September launch",
        default_model: "openai/gpt-5",
        skill_slugs: ["campaign-planner"],
      }),
      headers: { "Idempotency-Key": "create-project-1" },
    });
  });

  it("loads project detail and its user-facing Files index together", async () => {
    api.apiFetch
      .mockResolvedValueOnce(rawDetail)
      .mockResolvedValueOnce({ files: [rawFile] });

    await expect(fetchProject(PROJECT_ID)).resolves.toMatchObject({
      id: PROJECT_ID,
      secretCount: 2,
      modelConnectionCount: 1,
      files: [
        {
          name: "planning/calendar.md",
          version: 1,
          byteSize: 1200,
          conflictDetected: true,
        },
      ],
      sessions: [{ id: SESSION_ID, status: "working" }],
    });
    expect(api.apiFetch.mock.calls).toEqual([
      [`/v1/projects/${PROJECT_ID}`],
      [`/v1/projects/${PROJECT_ID}/files`],
    ]);
  });

  it("loads and links exact retained file versions", async () => {
    api.apiFetch.mockResolvedValue({
      versions: [
        {
          project_id: PROJECT_ID,
          file_id: rawFile.id,
          path: rawFile.path,
          version: 1,
          content_type: rawFile.content_type,
          byte_size: rawFile.byte_size,
          checksum: rawFile.checksum,
          modified_by_session_id: SESSION_ID,
          base_version: 0,
          conflict_detected: true,
          created_at: NOW,
        },
      ],
    });

    await expect(
      fetchProjectFileVersions(PROJECT_ID, rawFile.id),
    ).resolves.toMatchObject([
      {
        fileId: rawFile.id,
        path: rawFile.path,
        version: 1,
        baseVersion: 0,
        conflictDetected: true,
      },
    ]);
    expect(api.apiFetch).toHaveBeenCalledWith(
      `/v1/projects/${PROJECT_ID}/files/${rawFile.id}/versions`,
    );
    expect(
      projectFileVersionHref(PROJECT_ID, rawFile.id, 1, true),
    ).toBe(
      `/v1/projects/${PROJECT_ID}/files/${rawFile.id}/versions/1?download=1`,
    );
  });

  it("uses optimistic revisions when updating details and replacing skills", async () => {
    api.apiFetch
      .mockResolvedValueOnce({ ...rawDetail, revision: 2 })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({ ...rawDetail, revision: 3 })
      .mockResolvedValueOnce({ files: [] });

    await updateProject(PROJECT_ID, {
      revision: 1,
      name: "Launch workspace",
      defaultModel: "anthropic/claude-sonnet-4",
    });
    await replaceProjectSkills(PROJECT_ID, 2, ["campaign-planner"]);

    expect(api.apiFetch.mock.calls).toEqual([
      [
        `/v1/projects/${PROJECT_ID}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            revision: 1,
            name: "Launch workspace",
            default_model: "anthropic/claude-sonnet-4",
          }),
        },
      ],
      [`/v1/projects/${PROJECT_ID}/files`],
      [
        `/v1/projects/${PROJECT_ID}/skills`,
        {
          method: "PUT",
          body: JSON.stringify({
            revision: 2,
            skill_slugs: ["campaign-planner"],
          }),
        },
      ],
      [`/v1/projects/${PROJECT_ID}/files`],
    ]);
  });

  it("persists an idempotent workspace retry command without contacting a runtime client", async () => {
    api.apiFetch
      .mockResolvedValueOnce({ ...rawDetail, status: "queued" })
      .mockResolvedValueOnce({ files: [rawFile] });

    await expect(retryProjectWorkspace(PROJECT_ID)).resolves.toMatchObject({
      id: PROJECT_ID,
      status: "queued",
      files: [{ id: rawFile.id }],
    });
    expect(api.apiFetch.mock.calls).toEqual([
      [
        `/v1/projects/${PROJECT_ID}/retry`,
        { method: "POST" },
      ],
      [`/v1/projects/${PROJECT_ID}/files`],
    ]);
  });

  it("creates sessions and follow-ups as idempotent multipart commands", async () => {
    const firstFile = new File(["brief"], "brief.md", {
      type: "text/markdown",
    });
    const secondFile = new File(["notes"], "notes.txt", { type: "text/plain" });
    api.apiFetch.mockResolvedValue(rawSessionDetail);

    const created = await createProjectSession(PROJECT_ID, {
      prompt: "Prepare the calendar",
      model: "openai/gpt-5",
      files: [firstFile],
      idempotencyKey: "create-session-1",
    });
    await sendProjectPrompt(PROJECT_ID, SESSION_ID, {
      prompt: "Add owners",
      model: "openai/gpt-5",
      files: [secondFile],
      idempotencyKey: "follow-up-1",
    });

    expect(created.pendingPrompts).toMatchObject([
      { text: "Prepare the calendar" },
    ]);
    const createInit = api.apiFetch.mock.calls[0]![1] as RequestInit;
    const createBody = createInit.body as FormData;
    expect(createBody.get("prompt")).toBe("Prepare the calendar");
    expect(createBody.get("model")).toBe("openai/gpt-5");
    expect(createBody.getAll("file")).toEqual([firstFile]);
    expect(createInit.headers).toEqual({
      "Idempotency-Key": "create-session-1",
    });
    const followUpInit = api.apiFetch.mock.calls[1]![1] as RequestInit;
    const followUpBody = followUpInit.body as FormData;
    expect(followUpBody.get("prompt")).toBe("Add owners");
    expect(followUpBody.get("model")).toBe("openai/gpt-5");
    expect(followUpBody.getAll("file")).toEqual([secondFile]);
    expect(followUpInit.headers).toEqual({ "Idempotency-Key": "follow-up-1" });
  });

  it("degrades an invalid transcript entry without losing the durable Session", async () => {
    api.apiFetch.mockResolvedValue({
      ...rawSessionDetail,
      transcript: [{ kind: "unexpected", payload: "invalid" }],
    });

    await expect(
      fetchProjectSession(PROJECT_ID, SESSION_ID),
    ).resolves.toMatchObject({
      id: SESSION_ID,
      history: [],
      errorMessage: "Some transcript entries could not be displayed.",
    });
  });

  it("uses durable session, event, stop, and cached file routes", async () => {
    api.apiFetch.mockResolvedValue(rawSessionDetail);
    await fetchProjectSession(PROJECT_ID, SESSION_ID);
    await stopProjectSession(PROJECT_ID, SESSION_ID);

    expect(api.apiFetch.mock.calls).toEqual([
      [`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}`],
      [
        `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/stop`,
        { method: "POST" },
      ],
    ]);
    expect(projectSessionEventsHref(PROJECT_ID, SESSION_ID)).toBe(
      `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/events`,
    );
    expect(projectFileHref(PROJECT_ID, rawFile.id, true)).toBe(
      `/v1/projects/${PROJECT_ID}/files/${rawFile.id}?download=1`,
    );
  });

  it("requests durable Project deletion without touching legacy Skill Runs", async () => {
    api.apiFetch.mockResolvedValue({ ok: true });

    await deleteProject(PROJECT_ID);

    expect(api.apiFetch).toHaveBeenCalledWith(`/v1/projects/${PROJECT_ID}`, {
      method: "DELETE",
    });
  });

  it("attaches Run Skill without losing a concurrent project skill edit", async () => {
    const conflict = Object.assign(new Error("revision conflict"), {
      status: 409,
    });
    api.apiFetch
      .mockResolvedValueOnce({ ...rawDetail, skills: [], skill_count: 0 })
      .mockResolvedValueOnce({ files: [] })
      .mockRejectedValueOnce(conflict)
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({
        ...rawDetail,
        revision: 2,
        skills: [{ ...rawSkill, slug: "research", display_name: "Research" }],
      })
      .mockResolvedValueOnce({ files: [] })
      .mockResolvedValueOnce({
        ...rawDetail,
        revision: 3,
        skills: [
          { ...rawSkill, slug: "research", display_name: "Research" },
          rawSkill,
        ],
      })
      .mockResolvedValueOnce({ files: [] });

    await ensureProjectSkill(PROJECT_ID, "campaign-planner");

    const putCalls = api.apiFetch.mock.calls.filter(
      ([path]) => path === `/v1/projects/${PROJECT_ID}/skills`,
    );
    expect(putCalls).toHaveLength(2);
    expect(putCalls[1]?.[1]).toMatchObject({
      body: JSON.stringify({
        revision: 2,
        skill_slugs: ["research", "campaign-planner"],
      }),
    });
  });
});
