import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => {
  const noop = vi.fn(async () => undefined);
  return {
    ApiTokenRefreshError: class ApiTokenRefreshError extends Error {},
    ensureUserBootstrap: noop,
    resolveApiToken: vi.fn(),
    listOrgs: vi.fn(),
    getOnboardingState: vi.fn(),
    getMyAvatarUrl: vi.fn(),
  };
});

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  handler: vi.fn(),
  guardAgentAuthRemoteKeys: vi.fn<() => Promise<"allowed" | "remote-jwks" | "body-too-large">>(
    async () => "allowed",
  ),
}));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: {
    api: { getSession: authMocks.getSession },
    handler: authMocks.handler,
    $Infer: {},
  },
  guardAgentAuthRemoteKeys: authMocks.guardAgentAuthRemoteKeys,
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
}));
vi.mock("@companion/core/services", () => serviceMocks);

import { app } from "./index";

describe("GET /v1/auth/whoami", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    authMocks.guardAgentAuthRemoteKeys.mockResolvedValue("allowed");
  });

  it("returns 401 only when no authenticated actor exists", async () => {
    const response = await app.request("/v1/auth/whoami");

    expect(response.status).toBe(401);
  });

  it("keeps an authenticated dependency failure retryable as a 5xx", async () => {
    authMocks.getSession.mockResolvedValue({
      user: { id: "user-1", email: "user@example.test", name: "User" },
      session: { id: "session-1" },
    });
    serviceMocks.listOrgs.mockRejectedValue(new Error("database unavailable"));

    const response = await app.request("/v1/auth/whoami");

    expect(response.status).toBe(500);
  });
});

describe("raw Agent Auth capability mutation routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    authMocks.guardAgentAuthRemoteKeys.mockResolvedValue("allowed");
  });

  it.each([
    "/auth/agent/approve-capability",
    "/auth/agent/approve-capability/",
    "/auth/agent/grant-capability",
    "/auth/agent/grant-capability//",
  ])("blocks %s before the Better Auth wildcard handler", async (path) => {
    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: "use_device_approval_route" });
    expect(authMocks.handler).not.toHaveBeenCalled();
  });

  it.each([
    "/auth/host/create",
    "/auth/host/create/",
    "/auth/host/create//",
  ])("forces host creation defaults to an empty capability list at %s", async (path) => {
    authMocks.handler.mockImplementationOnce(async (request: Request) =>
      Response.json(await request.json()));

    const response = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Codex host",
        default_capabilities: ["skills:write", "secrets:read"],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "Codex host", default_capabilities: [] });
  });

  it("runs the remote-key guard before a host wrapper reads or forwards the body", async () => {
    authMocks.guardAgentAuthRemoteKeys.mockResolvedValueOnce("remote-jwks");
    const response = await app.request("/auth/host/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jwks_url: "https://metadata.attacker.example/jwks" }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "remote_agent_jwks_disabled" });
    expect(authMocks.handler).not.toHaveBeenCalled();
  });

  it.each([
    "/auth/host/update",
    "/auth/host/update/",
    "/auth/host/update//",
  ])("blocks host default-capability updates at %s", async (path) => {
    const blocked = await app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host_id: "host-1", default_capabilities: [] }),
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ error: "host_default_capabilities_disabled" });
    expect(authMocks.handler).not.toHaveBeenCalled();
  });

  it("forwards identity-only host updates", async () => {
    authMocks.handler.mockResolvedValueOnce(Response.json({ ok: true }));
    const allowed = await app.request("/auth/host/update/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ host_id: "host-1", name: "Renamed host" }),
    });
    expect(allowed.status).toBe(200);
    expect(authMocks.handler).toHaveBeenCalledOnce();
    const forwarded = authMocks.handler.mock.calls[0]?.[0] as Request;
    expect(await forwarded.json()).toEqual({ host_id: "host-1", name: "Renamed host" });
  });
});
