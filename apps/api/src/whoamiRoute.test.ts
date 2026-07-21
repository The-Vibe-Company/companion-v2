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
}));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: {
    api: { getSession: authMocks.getSession },
    handler: authMocks.handler,
    $Infer: {},
  },
}));
vi.mock("@companion/core/services", () => serviceMocks);

import { app } from "./index";

describe("GET /v1/auth/whoami", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
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
