import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError, type ApiVariables } from "./context";
import { registerCompanionRoutes } from "./companionRoutes";

const contextMocks = vi.hoisted(() => ({
  actorFromContext: vi.fn(),
  jsonError: vi.fn(),
  orgIdFromContext: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  listCompanions: vi.fn(),
  listCompanionProviders: vi.fn(),
  createCompanion: vi.fn(),
  saveCompanionProvider: vi.fn(),
  setCompanionProvider: vi.fn(),
  deleteCompanionProvider: vi.fn(),
  setDefaultCompanionProvider: vi.fn(),
  resolveCompanionProviderAuth: vi.fn(),
  getCompanion: vi.fn(),
  getCompanionForRuntime: vi.fn(),
  getCompanionTranscript: vi.fn(),
  listCompanionShares: vi.fn(),
  setCompanionWorkspaceShare: vi.fn(),
  inviteCompanionMember: vi.fn(),
  updateCompanionMemberRole: vi.fn(),
  revokeCompanionMember: vi.fn(),
  listCompanionRuntimeSkillPackages: vi.fn(),
  claimCompanionRuntimeStart: vi.fn(),
  claimCompanionRuntimeStop: vi.fn(),
  updateCompanionObservation: vi.fn(),
  updateCompanionRuntime: vi.fn(),
}));

const storageMocks = vi.hoisted(() => ({
  getSkillArchive: vi.fn(),
}));

const skillsMocks = vi.hoisted(() => ({
  skillChecksum: vi.fn(),
  toTar: vi.fn((archive) => archive),
}));

vi.mock("./context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context")>()),
  ...contextMocks,
}));

vi.mock("@companion/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/core")>()),
  ...coreMocks,
}));

vi.mock("@companion/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/db")>()),
  withTenantContext: vi.fn(
    async (
      _input: unknown,
      fn: (database: Record<string, never>) => Promise<unknown>,
    ) => fn({}),
  ),
}));

vi.mock("@companion/storage", () => storageMocks);
vi.mock("@companion/skills", () => skillsMocks);

const companion = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Research",
  owner_id: "user-1",
  access: "owner" as const,
  runtime: {
    state: "stopped" as const,
    daemon_state: "stopped" as const,
    box_id: "bx_23456789",
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 1,
    desktop_available: true,
    last_observed_at: null,
    last_started_at: null,
    last_stopped_at: null,
  },
  created_at: "2026-08-12T12:00:00.000Z",
  updated_at: "2026-08-12T12:00:00.000Z",
};

describe("Companions API feature gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    contextMocks.actorFromContext.mockReturnValue({
      id: "user-1",
      email: "user@example.test",
      name: "User",
    });
    contextMocks.orgIdFromContext.mockResolvedValue("org-1");
    contextMocks.jsonError.mockImplementation((_context, _error, status) =>
      Response.json({ ok: false }, { status }),
    );
    coreMocks.listCompanions.mockResolvedValue([]);
    coreMocks.listCompanionProviders.mockResolvedValue({
      catalog: [],
      connections: [],
      default_provider_id: null,
      can_manage: true,
    });
    coreMocks.createCompanion.mockResolvedValue(companion);
    coreMocks.saveCompanionProvider.mockResolvedValue({
      provider_id: "anthropic",
      auth_method: "api_key",
      connected_by: "user-1",
      created_at: companion.created_at,
      updated_at: companion.updated_at,
    });
    coreMocks.setCompanionProvider.mockResolvedValue(companion);
    coreMocks.deleteCompanionProvider.mockResolvedValue(undefined);
    coreMocks.setDefaultCompanionProvider.mockResolvedValue(undefined);
    coreMocks.resolveCompanionProviderAuth.mockResolvedValue({
      providerId: "anthropic",
      credentialGeneration: "22222222-2222-4222-8222-222222222222",
      authEntry: { type: "api_key", key: "secret-a" },
    });
    coreMocks.getCompanion.mockResolvedValue(companion);
    coreMocks.getCompanionForRuntime.mockResolvedValue(companion);
    coreMocks.getCompanionTranscript.mockResolvedValue({
      companion_id: companion.id,
      access: "viewer",
      read_only: true,
      entries: [],
    });
    const shares = {
      companion_id: companion.id,
      workspace_role: null,
      members: [{
        user_id: "user-1",
        name: "User",
        email: "user@example.test",
        role: "owner",
        is_owner: true,
      }],
    };
    coreMocks.listCompanionShares.mockResolvedValue(shares);
    coreMocks.setCompanionWorkspaceShare.mockResolvedValue(shares);
    coreMocks.inviteCompanionMember.mockResolvedValue(shares);
    coreMocks.updateCompanionMemberRole.mockResolvedValue(shares);
    coreMocks.revokeCompanionMember.mockResolvedValue(shares);
    coreMocks.listCompanionRuntimeSkillPackages.mockResolvedValue([]);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(companion);
    coreMocks.claimCompanionRuntimeStop.mockResolvedValue(companion);
    coreMocks.updateCompanionObservation.mockResolvedValue(companion);
    coreMocks.updateCompanionRuntime.mockResolvedValue(companion);
    skillsMocks.skillChecksum.mockReturnValue(`sha256:${"a".repeat(64)}`);
  });

  it("does not register the route when the flag is off", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();

    registerCompanionRoutes(app, {});

    expect((await app.request("/v1/companions")).status).toBe(404);
    expect((await app.request("/v1/companion-providers")).status).toBe(404);
    expect(contextMocks.actorFromContext).not.toHaveBeenCalled();
  });

  it("registers an authenticated empty list when the flag is on", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();

    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request("/v1/companions");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ companions: [] });
    expect(contextMocks.actorFromContext).toHaveBeenCalledOnce();
    expect(contextMocks.orgIdFromContext).toHaveBeenCalledOnce();
    expect(coreMocks.listCompanions).toHaveBeenCalledOnce();
  });

  it("returns 401 before tenant resolution when no session exists", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    contextMocks.actorFromContext.mockImplementationOnce(() => {
      throw new AuthenticationRequiredError();
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request("/v1/companions");

    expect(response.status).toBe(401);
    expect(contextMocks.jsonError).toHaveBeenCalledWith(expect.anything(), expect.any(Error), 401);
    expect(contextMocks.orgIdFromContext).not.toHaveBeenCalled();
  });

  it("serves default runtime status from control-plane metadata without creating a Box client", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/runtime`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ companion, source: "control_plane" });
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.getCompanion).toHaveBeenCalledOnce();
    expect(coreMocks.getCompanionForRuntime).not.toHaveBeenCalled();
  });

  it("guards viewer live status before creating or calling the Box client", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    coreMocks.getCompanionForRuntime.mockRejectedValueOnce(
      new (await import("@companion/core")).CompanionRuntimeForbiddenError(),
    );
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/runtime?live=true`);

    expect(response.status).toBe(403);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("serves a viewer transcript from the control plane without creating a Box client", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/transcript`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      transcript: {
        companion_id: companion.id,
        access: "viewer",
        read_only: true,
        entries: [],
      },
    });
    expect(coreMocks.getCompanionTranscript).toHaveBeenCalledOnce();
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["invite", "PUT", `/v1/companions/${companion.id}/shares/members`, {
      email: "editor@example.test",
      role: "editor",
    }, "inviteCompanionMember"],
    ["role change", "PATCH", `/v1/companions/${companion.id}/shares/members/user-2`, {
      role: "viewer",
    }, "updateCompanionMemberRole"],
    ["revoke", "DELETE", `/v1/companions/${companion.id}/shares/members/user-2`, undefined,
      "revokeCompanionMember"],
  ] as const)("supports owner share %s", async (_name, method, path, body, mockName) => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    expect(response.status).toBe(200);
    expect(coreMocks[mockName]).toHaveBeenCalledOnce();
  });

  it.each([
    ["start", `/v1/companions/${companion.id}/runtime/start`],
    ["stop", `/v1/companions/${companion.id}/runtime/stop`],
    ["desktop", `/v1/companions/${companion.id}/runtime/desktop`],
  ])("guards viewer %s before creating or calling the Box client", async (_action, path) => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    const forbidden = new (await import("@companion/core")).CompanionRuntimeForbiddenError();
    coreMocks.getCompanionForRuntime.mockRejectedValue(forbidden);
    coreMocks.claimCompanionRuntimeStart.mockRejectedValue(forbidden);
    coreMocks.claimCompanionRuntimeStop.mockRejectedValue(forbidden);
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(403);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("guards provider attachment with the same owner-only Companion boundary", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const forbidden = new (await import("@companion/core")).CompanionRuntimeForbiddenError();
    coreMocks.setCompanionProvider.mockRejectedValueOnce(forbidden);
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(`/v1/companions/${companion.id}/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "anthropic" }),
    });

    expect(response.status).toBe(403);
  });

  it("resolves the selected encrypted provider and passes only Pi auth to Box", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const start = vi.fn(async (input) => {
      await input.onBoxAssigned("bx_23456789");
      return {
        boxId: "bx_23456789",
        runtimeState: "running" as const,
        daemonState: "running" as const,
        desktopAvailable: true,
      };
    });
    const runtimeFactory = vi.fn(() => ({
      start,
      stop: vi.fn(),
      status: vi.fn(),
      desktop: vi.fn(),
    }));
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mcp_credentials: [
          { env_key: "GITHUB_TOKEN_WORK", value: "secret-b" },
        ],
        mcp_accounts: [{
          id: "github-work",
          label: "GitHub work",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "GITHUB_TOKEN_WORK" },
        }],
      }),
    });

    expect(response.status).toBe(200);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companion.id,
      orgId: "org-1",
      boxId: "bx_23456789",
      clientSurface: "web",
      providerAuth: {
        anthropic: { type: "api_key", key: "secret-a" },
      },
      replaceProviderAuth: true,
      mcpCredentials: [
        { env_key: "GITHUB_TOKEN_WORK", value: "secret-b" },
      ],
      mcpAccounts: [
        expect.objectContaining({ id: "github-work", label: "GitHub work", transport: "stdio" }),
      ],
      skills: [],
    }));
    expect(coreMocks.resolveCompanionProviderAuth).toHaveBeenCalledOnce();
    expect(coreMocks.claimCompanionRuntimeStart).toHaveBeenCalledOnce();
    expect(JSON.stringify(await response.json())).not.toContain("secret-");
  });

  it.each([
    [
      "keeps a refreshed subscription file on an already provisioned Box at the current layout",
      {
        box_id: "bx_23456789",
        disk_layout_version: 2,
        provider_credential_generation: "22222222-2222-4222-8222-222222222222",
      },
      false,
    ],
    [
      "rewrites provider auth for a Companion that has no Box yet",
      {
        box_id: null,
        disk_layout_version: 2,
        provider_credential_generation: "22222222-2222-4222-8222-222222222222",
      },
      true,
    ],
    [
      "rewrites provider auth when the Box still holds an older Pi layout",
      {
        box_id: "bx_23456789",
        disk_layout_version: 1,
        provider_credential_generation: "22222222-2222-4222-8222-222222222222",
      },
      true,
    ],
    [
      "rewrites provider auth after the workspace connection was rotated",
      {
        box_id: "bx_23456789",
        disk_layout_version: 2,
        provider_credential_generation: "33333333-3333-4333-8333-333333333333",
      },
      true,
    ],
  ])("%s", async (_name, runtime, expected) => {
    const claimed = { ...companion, runtime: { ...companion.runtime, ...runtime } };
    coreMocks.getCompanionForRuntime.mockResolvedValue(claimed);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(claimed);
    const start = vi.fn(async (input) => {
      await input.onBoxAssigned("bx_23456789");
      return {
        boxId: "bx_23456789",
        runtimeState: "running" as const,
        daemonState: "running" as const,
        desktopAvailable: true,
      };
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, vi.fn(() => ({
      start,
      stop: vi.fn(),
      status: vi.fn(),
      desktop: vi.fn(),
    })));

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ replaceProviderAuth: expected }));
  });

  it("stores provider credentials without returning their value", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request("/v1/companion-providers/anthropic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auth_method: "api_key", credential: "secret-a" }),
    });

    expect(response.status).toBe(200);
    expect(coreMocks.saveCompanionProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "secret-a",
    }));
    expect(JSON.stringify(await response.json())).not.toContain("secret-a");
  });

  it("lets an owner attach a connected provider to a pre-provider Companion", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(`/v1/companions/${companion.id}/provider`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "anthropic" }),
    });

    expect(response.status).toBe(200);
    expect(coreMocks.setCompanionProvider).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companion.id,
      providerId: "anthropic",
    }));
  });

  it("injects Installed skills for mobile web but never for native mobile", async () => {
    const skillPackage = {
      slug: "incident-summary",
      version: "1.2.3",
      checksum: `sha256:${"a".repeat(64)}`,
      storagePath: "org-1/incident-summary/1.2.3.tar.gz",
    };
    coreMocks.listCompanionRuntimeSkillPackages.mockResolvedValue([skillPackage]);
    storageMocks.getSkillArchive.mockResolvedValue(Buffer.from("skill-archive"));
    const starts: Array<Record<string, unknown>> = [];
    const runtimeFactory = vi.fn(() => ({
      start: vi.fn(async (input) => {
        starts.push(input);
        return {
          boxId: "bx_23456789",
          runtimeState: "running" as const,
          daemonState: "running" as const,
          desktopAvailable: true,
        };
      }),
      stop: vi.fn(),
      status: vi.fn(),
      desktop: vi.fn(),
    }));
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const mobileWeb = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_surface: "mobile_web" }),
    });
    expect(mobileWeb.status).toBe(200);
    expect(starts[0]?.skills).toEqual([{
      slug: "incident-summary",
      version: "1.2.3",
      checksum: skillPackage.checksum,
      archive: Buffer.from("skill-archive"),
    }]);

    const nativeMobile = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_surface: "native_mobile" }),
    });
    expect(nativeMobile.status).toBe(200);
    expect(starts[1]?.skills).toEqual([]);
    expect(coreMocks.listCompanionRuntimeSkillPackages).toHaveBeenCalledOnce();
  });

  it("rejects a stored skill archive whose checksum changed before contacting Box", async () => {
    coreMocks.listCompanionRuntimeSkillPackages.mockResolvedValue([{
      slug: "incident-summary",
      version: "1.2.3",
      checksum: `sha256:${"a".repeat(64)}`,
      storagePath: "org-1/incident-summary/1.2.3.tar.gz",
    }]);
    storageMocks.getSkillArchive.mockResolvedValue(Buffer.from("corrupt"));
    skillsMocks.skillChecksum.mockReturnValueOnce(`sha256:${"b".repeat(64)}`);
    const runtimeFactory = vi.fn();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(502);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("returns a transition conflict when desktop is requested before Box creation", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    coreMocks.getCompanionForRuntime.mockResolvedValueOnce({
      ...companion,
      runtime: { ...companion.runtime, box_id: null },
    });
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/desktop`, {
      method: "POST",
    });

    expect(response.status).toBe(409);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });
});
