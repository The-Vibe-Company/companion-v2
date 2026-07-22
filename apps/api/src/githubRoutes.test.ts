import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Product promise:
 * GitHub integration credentials and repository control are browser-session-only workspace governance.
 *
 * Regression caught:
 * Accidentally opting these routes into PAT authentication would let a leaked skills token install an
 * App, enumerate repositories, overwrite a branch, or disconnect an organization's mirrors.
 *
 * Why this test is HTTP-level:
 * The risk is the route's actorFromContext/withTenant boundary, before the RBAC-aware core service.
 *
 * Failure proof:
 * Passing `true` as the route's allowToken argument makes these PAT cases reach a service mock.
 */

const serviceMocks = vi.hoisted(() => ({
  ApiTokenRefreshError: class ApiTokenRefreshError extends Error {},
  GitHubSkillSyncConflictError: class GitHubSkillSyncConflictError extends Error {},
  GitHubSkillSyncNotFoundError: class GitHubSkillSyncNotFoundError extends Error {},
  ensureUserBootstrap: vi.fn(async () => undefined),
  listOrgs: vi.fn(),
  resolveApiToken: vi.fn(),
  refreshApiToken: vi.fn(),
  getGitHubIntegration: vi.fn(),
  getGitHubSkillSyncOverview: vi.fn(),
  getGitHubUserCredential: vi.fn(),
  refreshGitHubConnectionCredential: vi.fn(),
  saveGitHubConnection: vi.fn(),
  deleteGitHubConnection: vi.fn(),
  createGitHubDestination: vi.fn(),
  updateGitHubDestination: vi.fn(),
  deleteGitHubDestination: vi.fn(),
  requestGitHubDestinationSync: vi.fn(),
  setGitHubDestinationSkillSelection: vi.fn(),
}));

const dbMocks = vi.hoisted(() => {
  const state = {
    activeTransactions: 0,
    withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => {
      state.activeTransactions += 1;
      try {
        return await fn({});
      } finally {
        state.activeTransactions -= 1;
      }
    }),
  };
  return state;
});

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
}));

const githubMocks = vi.hoisted(() => ({
  repositories: vi.fn(async () => []),
  installations: vi.fn(async () => []),
  user: vi.fn(),
  createRepository: vi.fn(),
  refreshUserToken: vi.fn(),
  revokeUserToken: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: { api: { getSession: authMocks.getSession }, handler: authMocks.handler, $Infer: {} },
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
}));
vi.mock("@companion/db", () => dbMocks);
vi.mock("@companion/core/services", () => serviceMocks);
vi.mock("@companion/github", () => ({
  githubOAuthConfig: () => ({
    slug: "companion", clientId: "client", clientSecret: "secret", name: "Companion", managed: true,
  }),
  githubSyncEnabled: () => true,
  GitHubOAuthClient: class {
    config = { slug: "companion", clientSecret: "secret", name: "Companion", managed: true };
    authorizationUrl = () => "https://github.com/login/oauth/authorize";
    installationUrl = () => "https://github.com/apps/companion/installations/new";
    revokeUserToken = githubMocks.revokeUserToken;
    repositories = githubMocks.repositories;
    installations = githubMocks.installations;
    user = githubMocks.user;
    createRepository = githubMocks.createRepository;
    refreshUserToken = githubMocks.refreshUserToken;
  },
}));

import { app } from "./index";

const me = { id: "user-me", email: "me@example.test", name: "Me" };

beforeEach(() => {
  vi.clearAllMocks();
  authMocks.getSession.mockResolvedValue(null);
  dbMocks.activeTransactions = 0;
  serviceMocks.resolveApiToken.mockResolvedValue({ actor: me, orgId: "00000000-0000-4000-8000-000000000001", scopes: ["skills:read", "skills:write"] });
});

describe("GitHub browser-session routes", () => {
  it("rejects PATs on every repository and destination mutation surface", async () => {
    const destinationId = "00000000-0000-4000-8000-000000000010";
    const cases: Array<{ path: string; method?: string; body?: unknown }> = [
      { path: "/v1/integrations/github" },
      { path: "/v1/integrations/github/skills" },
      { path: "/v1/integrations/github/connect", method: "POST", body: {} },
      { path: "/v1/integrations/github/account", method: "DELETE" },
      { path: "/v1/integrations/github/repositories" },
      { path: "/v1/integrations/github/repositories", method: "POST", body: { installation_id: "1", owner: "acme", name: "skills", private: true } },
      { path: "/v1/integrations/github/destinations", method: "POST", body: {} },
      { path: `/v1/integrations/github/destinations/${destinationId}`, method: "PATCH", body: { mode: "all", selected_skill_ids: [] } },
      { path: `/v1/integrations/github/destinations/${destinationId}/skills/22222222-2222-4222-8222-222222222222`, method: "PUT", body: {} },
      { path: `/v1/integrations/github/destinations/${destinationId}/skills/22222222-2222-4222-8222-222222222222`, method: "DELETE" },
      { path: `/v1/integrations/github/destinations/${destinationId}/sync`, method: "POST", body: {} },
      { path: `/v1/integrations/github/destinations/${destinationId}`, method: "DELETE" },
    ];
    for (const testCase of cases) {
      const response = await app.request(testCase.path, {
        method: testCase.method,
        headers: { authorization: "Bearer cmp_pat_never-github", "content-type": "application/json" },
        body: testCase.body === undefined ? undefined : JSON.stringify(testCase.body),
      });
      expect(response.status, `${testCase.method ?? "GET"} ${testCase.path}`).toBeGreaterThanOrEqual(400);
      expect(response.status, `${testCase.method ?? "GET"} ${testCase.path}`).toBeLessThan(500);
    }
    expect(serviceMocks.getGitHubIntegration).not.toHaveBeenCalled();
    expect(serviceMocks.createGitHubDestination).not.toHaveBeenCalled();
    expect(serviceMocks.updateGitHubDestination).not.toHaveBeenCalled();
    expect(serviceMocks.getGitHubSkillSyncOverview).not.toHaveBeenCalled();
    expect(serviceMocks.setGitHubDestinationSkillSelection).not.toHaveBeenCalled();
    expect(serviceMocks.deleteGitHubDestination).not.toHaveBeenCalled();
  });

  it("uses the browser actor and tenant service for an authenticated admin request", async () => {
    authMocks.getSession.mockResolvedValue({ user: me, session: { id: "session" } });
    serviceMocks.listOrgs.mockResolvedValue([{ org_id: "00000000-0000-4000-8000-000000000001", name: "Acme" }]);
    serviceMocks.getGitHubIntegration.mockResolvedValue({
      connection: { configured: true, app_slug: "companion", app_name: "Companion", managed: true, connected: false, github_login: null, github_avatar_url: null, connected_at: null },
      destinations: [],
    });
    const response = await app.request("/v1/integrations/github");
    expect(response.status).toBe(200);
    expect(serviceMocks.getGitHubIntegration).toHaveBeenCalledWith(expect.objectContaining({ actor: me, configured: true }));
  });

  it("serves the skill matrix and routes atomic selection changes through the tenant service", async () => {
    authMocks.getSession.mockResolvedValue({ user: me, session: { id: "session" } });
    serviceMocks.listOrgs.mockResolvedValue([{ org_id: "00000000-0000-4000-8000-000000000001", name: "Acme" }]);
    serviceMocks.getGitHubSkillSyncOverview.mockResolvedValue({ skills: [] });
    serviceMocks.setGitHubDestinationSkillSelection.mockResolvedValue(true);
    const destinationId = "11111111-1111-4111-8111-111111111111";
    const skillId = "22222222-2222-4222-8222-222222222222";

    const overview = await app.request("/v1/integrations/github/skills");
    const selected = await app.request(`/v1/integrations/github/destinations/${destinationId}/skills/${skillId}`, {
      method: "PUT",
    });
    const removed = await app.request(`/v1/integrations/github/destinations/${destinationId}/skills/${skillId}`, {
      method: "DELETE",
    });

    expect(overview.status).toBe(200);
    expect(await overview.json()).toEqual({ skills: [] });
    expect(selected.status).toBe(200);
    expect(await selected.json()).toEqual({ ok: true, changed: true });
    expect(removed.status).toBe(200);
    expect(serviceMocks.setGitHubDestinationSkillSelection).toHaveBeenNthCalledWith(1, expect.objectContaining({
      actor: me, destinationId, skillId, selected: true,
    }));
    expect(serviceMocks.setGitHubDestinationSkillSelection).toHaveBeenNthCalledWith(2, expect.objectContaining({
      actor: me, destinationId, skillId, selected: false,
    }));
  });

  it("maps skill-selection conflicts and missing resources to stable HTTP statuses", async () => {
    authMocks.getSession.mockResolvedValue({ user: me, session: { id: "session" } });
    serviceMocks.listOrgs.mockResolvedValue([{ org_id: "00000000-0000-4000-8000-000000000001", name: "Acme" }]);
    const path = "/v1/integrations/github/destinations/11111111-1111-4111-8111-111111111111/skills/22222222-2222-4222-8222-222222222222";
    serviceMocks.setGitHubDestinationSkillSelection
      .mockRejectedValueOnce(new serviceMocks.GitHubSkillSyncConflictError("keep at least one skill"))
      .mockRejectedValueOnce(new serviceMocks.GitHubSkillSyncNotFoundError("skill not found"));

    expect((await app.request(path, { method: "DELETE" })).status).toBe(409);
    expect((await app.request(path, { method: "PUT" })).status).toBe(404);
  });

  it("keeps GitHub repository I/O outside short tenant credential transactions", async () => {
    authMocks.getSession.mockResolvedValue({ user: me, session: { id: "session" } });
    serviceMocks.listOrgs.mockResolvedValue([{ org_id: "00000000-0000-4000-8000-000000000001", name: "Acme" }]);
    serviceMocks.getGitHubUserCredential.mockResolvedValue({
      accessToken: "access-current",
      refreshToken: "refresh-current",
      accessExpiresAt: new Date(Date.now() + 60 * 60_000),
      refreshExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      credentialGeneration: "00000000-0000-4000-8000-000000000099",
      credentialVersion: 3,
    });
    githubMocks.repositories.mockImplementationOnce(async () => {
      expect(dbMocks.activeTransactions).toBe(0);
      return [];
    });
    githubMocks.installations.mockImplementationOnce(async () => {
      expect(dbMocks.activeTransactions).toBe(0);
      return [];
    });

    const response = await app.request("/v1/integrations/github/repositories");

    expect(response.status).toBe(200);
    expect(serviceMocks.getGitHubUserCredential).toHaveBeenCalledOnce();
    expect(dbMocks.activeTransactions).toBe(0);
  });

  it("revokes a freshly issued token when disconnect wins the refresh generation CAS", async () => {
    authMocks.getSession.mockResolvedValue({ user: me, session: { id: "session" } });
    serviceMocks.listOrgs.mockResolvedValue([{ org_id: "00000000-0000-4000-8000-000000000001", name: "Acme" }]);
    serviceMocks.getGitHubUserCredential.mockResolvedValue({
      accessToken: "access-old",
      refreshToken: "refresh-old",
      accessExpiresAt: new Date(Date.now() - 60_000),
      refreshExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      credentialGeneration: "00000000-0000-4000-8000-000000000098",
      credentialVersion: 7,
    });
    let releaseRefresh!: () => void;
    const refreshBarrier = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    let refreshStarted!: () => void;
    const refreshWasStarted = new Promise<void>((resolve) => { refreshStarted = resolve; });
    githubMocks.refreshUserToken.mockImplementationOnce(async () => {
      refreshStarted();
      await refreshBarrier;
      return {
        accessToken: "access-newly-issued",
        refreshToken: "refresh-newly-issued",
        accessExpiresAt: new Date(Date.now() + 60 * 60_000),
        refreshExpiresAt: new Date(Date.now() + 24 * 60 * 60_000),
      };
    });
    serviceMocks.refreshGitHubConnectionCredential.mockResolvedValue(false);

    const request = app.request("/v1/integrations/github/repositories");
    await refreshWasStarted;
    // The false CAS models disconnect deleting the exact generation while GitHub refresh is in flight.
    releaseRefresh();
    const response = await request;

    expect(response.status).toBe(403);
    expect(serviceMocks.refreshGitHubConnectionCredential).toHaveBeenCalledWith(expect.objectContaining({
      expectedCredentialGeneration: "00000000-0000-4000-8000-000000000098",
      expectedCredentialVersion: 7,
      accessToken: "access-newly-issued",
    }));
    expect(githubMocks.revokeUserToken).toHaveBeenCalledWith("access-newly-issued");
    expect(githubMocks.repositories).not.toHaveBeenCalled();
  });
});
