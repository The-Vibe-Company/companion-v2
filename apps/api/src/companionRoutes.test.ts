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
  createCompanion: vi.fn(),
  getCompanion: vi.fn(),
  getCompanionForRuntime: vi.fn(),
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
    provider_ids: [],
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
    coreMocks.createCompanion.mockResolvedValue(companion);
    coreMocks.getCompanion.mockResolvedValue(companion);
    coreMocks.getCompanionForRuntime.mockResolvedValue(companion);
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

  it("passes multi-provider credentials transiently to an owner start", async () => {
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
        credentials: [
          { provider: "anthropic", env_key: "ANTHROPIC_API_KEY", value: "secret-a" },
          { provider: "openai", env_key: "OPENAI_API_KEY", value: "secret-b" },
        ],
        mcp_accounts: [{
          id: "github-work",
          label: "GitHub work",
          transport: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-github"],
          env: { GITHUB_TOKEN: "OPENAI_API_KEY" },
        }],
      }),
    });

    expect(response.status).toBe(200);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companion.id,
      orgId: "org-1",
      boxId: "bx_23456789",
      clientSurface: "web",
      credentials: [
        { provider: "anthropic", envKey: "ANTHROPIC_API_KEY", value: "secret-a" },
        { provider: "openai", envKey: "OPENAI_API_KEY", value: "secret-b" },
      ],
      mcpAccounts: [
        expect.objectContaining({ id: "github-work", label: "GitHub work", transport: "stdio" }),
      ],
      skills: [],
    }));
    expect(coreMocks.claimCompanionRuntimeStart).toHaveBeenCalledOnce();
    expect(JSON.stringify(await response.json())).not.toContain("secret-");
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
