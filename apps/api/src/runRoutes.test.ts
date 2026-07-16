import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.COMPANION_SECRETS_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
process.env.COMPANION_GOLDEN_SNAPSHOT_ID = "snapshot-test";
process.env.COMPANION_RUNS_ENABLED = "true";

const serviceMocks = vi.hoisted(() => ({
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
  ensureUserBootstrap: vi.fn(async () => undefined),
  listOrgs: vi.fn(),
  resolveApiToken: vi.fn(),
  getRunOptions: vi.fn(),
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
  })),
  isRunWorkerReady: vi.fn(async () => true),
  setProviderConnection: vi.fn(),
  setOrgProviderConnection: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
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
  putSkillArchive: storageMocks.putSkillArchive,
  deleteSkillArchive: storageMocks.deleteSkillArchive,
  getSkillArchive: storageMocks.getSkillArchive,
  headSkillArchive: storageMocks.headSkillArchive,
  streamSkillArchive: storageMocks.streamSkillArchive,
  resolveSkillArchiveByteRange: storageMocks.resolveSkillArchiveByteRange,
  InvalidSkillArchiveRangeError: storageMocks.InvalidSkillArchiveRangeError,
  isStoragePreconditionFailure: storageMocks.isStoragePreconditionFailure,
}));

import { app } from "./index";

const actor = { id: "run-user", email: "run-user@example.test", name: "Run User" };
const skillVersionId = "00000000-0000-4000-8000-000000000001";
const configId = "00000000-0000-4000-8000-000000000002";
const secretId = "00000000-0000-4000-8000-000000000003";
const providerConnectionId = "00000000-0000-4000-8000-000000000004";
const dependencySkillId = "00000000-0000-4000-8000-000000000004";
const dependencyVersionId = "00000000-0000-4000-8000-000000000005";

function signIn(): void {
  authMocks.getSession.mockResolvedValue({ user: actor, session: { id: "session-1" } });
  serviceMocks.listOrgs.mockResolvedValue([{ org_id: "00000000-0000-4000-8000-000000000010", name: "Org" }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.getSession.mockResolvedValue(null);
  delete process.env.COMPANION_RUN_PREWARM_ENABLED;
});

describe("session-only RunSkill routes", () => {
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

  it("keeps non-raster artifacts download-only and maps unavailable artifacts to 404", async () => {
    signIn();
    serviceMocks.getRunArtifact.mockResolvedValue({
      fileName: "report.html",
      contentType: "text/html; charset=utf-8",
      storageKey: "org/run-artifacts/run/report",
      previewable: false,
    });
    const attachment = await app.request("/v1/runs/run-1/artifacts/artifact-2");
    expect(attachment.headers.get("content-disposition")).toBe('attachment; filename="report.html"');
    serviceMocks.getRunArtifact.mockRejectedValueOnce(new Error("artifact not found"));
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
