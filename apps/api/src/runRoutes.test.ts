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
  listReferencedRunAttachmentKeys: vi.fn(async (_input: unknown): Promise<string[]> => []),
  listRuns: vi.fn(),
  getRun: vi.fn(),
  enqueueRunPrompt: vi.fn(),
  requestRunCancellation: vi.fn(),
  listRunEvents: vi.fn(),
  getRunAttachment: vi.fn(),
  isRunWorkerReady: vi.fn(async () => true),
  setProviderConnection: vi.fn(),
  setOrgProviderConnection: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  putSkillArchive: vi.fn(async (_input: { key: string }) => undefined),
  deleteSkillArchive: vi.fn(async (_input: { key: string }) => undefined),
}));

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
});

describe("session-only RunSkill routes", () => {
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
      }),
    );
    expect(catalogMocks.listModels).not.toHaveBeenCalled();
  });

  it("keeps a newly uploaded object when an ambiguous createRun failure has a durable attachment row", async () => {
    signIn();
    serviceMocks.createRun.mockRejectedValueOnce(new Error("commit acknowledgement lost"));
    serviceMocks.listReferencedRunAttachmentKeys.mockImplementationOnce(async () => {
      const upload = storageMocks.putSkillArchive.mock.calls[0]?.[0] as { key?: string } | undefined;
      return upload?.key ? [upload.key] : [];
    });
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
    expect(serviceMocks.listReferencedRunAttachmentKeys).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        storageKeys: [expect.stringContaining("/")],
      }),
    );
    expect(storageMocks.deleteSkillArchive).not.toHaveBeenCalled();
  });

  it("fails safe and retains uploaded objects when durable attachment verification fails", async () => {
    signIn();
    serviceMocks.createRun.mockRejectedValueOnce(new Error("commit acknowledgement lost"));
    serviceMocks.listReferencedRunAttachmentKeys.mockRejectedValueOnce(new Error("database unavailable"));
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
      headers: { "Idempotency-Key": "ambiguous-launch-2" },
      body: form,
    });

    expect(response.status).toBe(400);
    expect(serviceMocks.listReferencedRunAttachmentKeys).toHaveBeenCalledTimes(1);
    expect(storageMocks.deleteSkillArchive).not.toHaveBeenCalled();
  });

  it("deletes a newly uploaded object only after durable verification proves it unreferenced", async () => {
    signIn();
    serviceMocks.createRun.mockRejectedValueOnce(new Error("launch rejected before commit"));
    serviceMocks.listReferencedRunAttachmentKeys.mockResolvedValueOnce([]);
    const form = new FormData();
    form.set("prompt", "Run this skill");
    form.set("model", "openai/gpt-5");
    form.set("skill_version_id", skillVersionId);
    form.set("dependency_pins", "[]");
    form.set("inputs", JSON.stringify({ secrets: [], variables: [] }));
    form.set("model_provider_connection_id", providerConnectionId);
    form.set("model_provider_credential_version", "1");
    form.set("file", new Blob(["orphan bytes"], { type: "text/plain" }), "notes.txt");

    const response = await app.request("/v1/skills/demo/runs", {
      method: "POST",
      headers: { "Idempotency-Key": "rejected-launch-1" },
      body: form,
    });

    expect(response.status).toBe(400);
    const uploadedKey = (storageMocks.putSkillArchive.mock.calls[0]?.[0] as { key: string }).key;
    expect(serviceMocks.listReferencedRunAttachmentKeys).toHaveBeenCalledTimes(1);
    expect(storageMocks.deleteSkillArchive).toHaveBeenCalledWith({ key: uploadedKey });
  });

  it("enqueues follow-ups and cancellation without contacting a sandbox", async () => {
    signIn();
    serviceMocks.enqueueRunPrompt.mockResolvedValue({ id: "prompt-1", status: "queued" });
    serviceMocks.requestRunCancellation.mockResolvedValue({ status: "running", requested: true });
    const prompt = await app.request("/v1/runs/run-1/prompt", {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": "prompt-request-1" },
      body: JSON.stringify({ text: "Continue" }),
    });
    expect(prompt.status).toBe(202);
    await expect(prompt.json()).resolves.toEqual({ accepted: true, prompt_id: "prompt-1" });

    const canceled = await app.request("/v1/runs/run-1/cancel", { method: "POST" });
    expect(canceled.status).toBe(202);
    await expect(canceled.json()).resolves.toEqual({ status: "running", requested: true });
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
