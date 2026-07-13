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
  listRuns: vi.fn(),
  getRun: vi.fn(),
  enqueueRunPrompt: vi.fn(),
  requestRunCancellation: vi.fn(),
  listRunEvents: vi.fn(),
  getRunAttachment: vi.fn(),
  setProviderConnection: vi.fn(),
  setOrgProviderConnection: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
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
  createModelCatalog: () => ({
    listModels: async () => ({
      models: [{ id: "openai/gpt-5", provider: "openai", provider_name: "OpenAI", name: "GPT-5", description: null, context: null, cost_input: null, cost_output: null, env_keys: ["OPENAI_API_KEY"] }],
      providers: [],
    }),
    resolveModel: async () => ({ envKeys: ["OPENAI_API_KEY"] }),
    clearCache: () => undefined,
  }),
}));
vi.mock("@companion/storage", () => ({
  runAttachmentKey: ({ orgId, attachmentId }: { orgId: string; attachmentId: string }) => `${orgId}/${attachmentId}`,
  putSkillArchive: vi.fn(async () => undefined),
  deleteSkillArchive: vi.fn(async () => undefined),
}));

import { app } from "./index";

const actor = { id: "run-user", email: "run-user@example.test", name: "Run User" };
const skillVersionId = "00000000-0000-4000-8000-000000000001";
const configId = "00000000-0000-4000-8000-000000000002";
const secretId = "00000000-0000-4000-8000-000000000003";

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
    form.set("inputs", JSON.stringify({ secrets: [], variables: [] }));
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
        runConfigId: configId,
        idempotencyKey: "launch-request-1",
        inputs: { secrets: [], variables: [] },
      }),
    );
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

describe("provider vault bindings", () => {
  it("forwards a secret reference and never accepts plaintext provider keys", async () => {
    signIn();
    serviceMocks.setProviderConnection.mockResolvedValue({ provider: "openai", secret_id: secretId, set: true });
    const response = await app.request("/v1/provider-connections", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", key_name: "OPENAI_API_KEY", secret_id: secretId }),
    });
    expect(response.status).toBe(200);
    expect(serviceMocks.setProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai", keyName: "OPENAI_API_KEY", secretId }),
    );
    expect(JSON.stringify(serviceMocks.setProviderConnection.mock.calls)).not.toContain('"key"');
  });
});
