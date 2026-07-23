import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route tests for the activated-models surface: GET /v1/models (activated lists, pruned) and the
 * two PUT preference endpoints. The model catalog is stubbed explicitly so route behavior never
 * depends on models.dev latency or availability.
 */

const serviceMocks = vi.hoisted(() => {
  const noop = vi.fn(async () => undefined);
  return {
    ApiTokenRefreshError: class ApiTokenRefreshError extends Error {},
    ensureUserBootstrap: noop,
    listOrgs: vi.fn(),
    resolveApiToken: vi.fn(),
    refreshApiToken: vi.fn(),
    connectedProviderIds: vi.fn(async () => new Set<string>()),
    connectedOrgProviderIds: vi.fn(async () => new Set<string>()),
    getActivatedModels: vi.fn(),
    setUserActivatedModels: vi.fn(),
    setOrgActivatedModels: vi.fn(),
  };
});

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => fn({})),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
}));

const catalogMocks = vi.hoisted(() => ({
  listModels: vi.fn(async () => ({
    models: [
      {
        id: "anthropic/claude-sonnet-4-5",
        provider: "anthropic",
        provider_name: "Anthropic",
        name: "Claude Sonnet 4.5",
        description: null,
        context: 200_000,
        cost_input: null,
        cost_output: null,
        env_keys: ["ANTHROPIC_API_KEY"],
      },
      {
        id: "openai/gpt-5.2",
        provider: "openai",
        provider_name: "OpenAI",
        name: "GPT-5.2",
        description: null,
        context: 400_000,
        cost_input: null,
        cost_output: null,
        env_keys: ["OPENAI_API_KEY"],
      },
    ],
    providers: [],
  })),
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

vi.mock("@companion/auth", () => ({
  auth: {
    api: {
      getSession: authMocks.getSession,
    },
    handler: authMocks.handler,
    $Infer: {},
  },
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
}));

vi.mock("@companion/db", () => dbMocks);

vi.mock("@companion/core/services", () => serviceMocks);

vi.mock("@companion/sandbox", () => ({
  createModelCatalog: () => catalogMocks,
}));

import { app } from "./index";

const me = { id: "user-me", email: "me@example.test", name: "Me" };
const KNOWN_MODEL = "anthropic/claude-sonnet-4-5";

function signIn(): void {
  authMocks.getSession.mockResolvedValue({
    user: me,
    session: { id: "ses-1" },
  });
  serviceMocks.listOrgs.mockResolvedValue([{ org_id: "org-1", name: "Org" }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.getSession.mockResolvedValue(null);
});

describe("GET /v1/models", () => {
  it("returns the activated lists pruned to the live catalog", async () => {
    signIn();
    serviceMocks.getActivatedModels.mockResolvedValue({
      personal: [KNOWN_MODEL, "ghost/model-that-left-the-catalog"],
      org: ["openai/gpt-5.2"],
    });

    const res = await app.request("/v1/models");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { activated: { personal: string[]; org: string[] } };
    expect(body.activated).toEqual({ personal: [KNOWN_MODEL], org: ["openai/gpt-5.2"] });
  });
});

describe("PUT /v1/model-preferences (+ org variant)", () => {
  it("rejects personal access tokens on every route", async () => {
    serviceMocks.resolveApiToken.mockResolvedValue({ actor: me, orgId: "org-1", scopes: ["skills:read", "skills:write"] });
    for (const path of ["/v1/model-preferences", "/v1/org-model-preferences"]) {
      const res = await app.request(path, {
        method: "PUT",
        headers: { Authorization: "Bearer cmp_pat_x", "content-type": "application/json" },
        body: JSON.stringify({ models: [KNOWN_MODEL] }),
      });
      expect(res.status).toBe(401);
    }
    expect(serviceMocks.setUserActivatedModels).not.toHaveBeenCalled();
    expect(serviceMocks.setOrgActivatedModels).not.toHaveBeenCalled();
  });

  it("400s a malformed body", async () => {
    signIn();
    const res = await app.request("/v1/model-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: "not-an-array" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s models the catalog does not know, naming them", async () => {
    signIn();
    const res = await app.request("/v1/model-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [KNOWN_MODEL, "made-up/model"] }),
    });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("made-up/model") });
    expect(serviceMocks.setUserActivatedModels).not.toHaveBeenCalled();
  });

  it("saves the personal list and echoes the activated lists", async () => {
    signIn();
    serviceMocks.setUserActivatedModels.mockResolvedValue({ personal: [KNOWN_MODEL], org: [] });

    const res = await app.request("/v1/model-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [KNOWN_MODEL] }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ activated: { personal: [KNOWN_MODEL], org: [] } });
    expect(serviceMocks.setUserActivatedModels).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", models: [KNOWN_MODEL] }),
    );
  });

  it("routes the workspace list through setOrgActivatedModels (RBAC lives in core)", async () => {
    signIn();
    serviceMocks.setOrgActivatedModels.mockResolvedValue({ personal: [], org: [KNOWN_MODEL] });

    const res = await app.request("/v1/org-model-preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [KNOWN_MODEL] }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ activated: { personal: [], org: [KNOWN_MODEL] } });
    expect(serviceMocks.setOrgActivatedModels).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", models: [KNOWN_MODEL] }),
    );
  });
});
