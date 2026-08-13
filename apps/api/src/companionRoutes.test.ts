import { CompanionPluginConflictError, CompanionRegistryUnavailableError } from "@companion/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError, type ApiVariables } from "./context";
import { BoxRuntimeConfigurationError, BoxRuntimeProviderError } from "./boxCompanionRuntime";
import { COMPANION_RUNTIME_UNKNOWN_ERROR } from "./companionRuntimeError";
import { registerCompanionRoutes as registerCompanionRoutesImpl } from "./companionRoutes";

const contextMocks = vi.hoisted(() => ({
  actorFromContext: vi.fn(),
  jsonError: vi.fn(),
  orgIdFromContext: vi.fn(),
}));

const coreMocks = vi.hoisted(() => ({
  listCompanions: vi.fn(),
  listCompanionProviders: vi.fn(),
  listCompanionPlugins: vi.fn(),
  listCompanionRegistry: vi.fn(),
  getCompanionRegistryServer: vi.fn(),
  createCompanion: vi.fn(),
  saveCompanionPlugin: vi.fn(),
  deleteCompanionPlugin: vi.fn(),
  saveCompanionProvider: vi.fn(),
  setCompanionProvider: vi.fn(),
  deleteCompanionProvider: vi.fn(),
  setDefaultCompanionProvider: vi.fn(),
  resolveCompanionProviderAuth: vi.fn(),
  resolveCompanionPluginInjection: vi.fn(),
  getCompanion: vi.fn(),
  getCompanionForRuntime: vi.fn(),
  getCompanionThread: vi.fn(),
  sendCompanionMessage: vi.fn(),
  listPendingCompanionMessages: vi.fn(),
  recordCompanionPiProjection: vi.fn(),
  listCompanionShares: vi.fn(),
  setCompanionWorkspaceShare: vi.fn(),
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

function registerCompanionRoutes(
  ...[app, env, runtimeFactory]: Parameters<typeof registerCompanionRoutesImpl>
): void {
  registerCompanionRoutesImpl(
    app,
    {
      COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
      ...env,
    },
    runtimeFactory,
  );
}

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
  persona: "Incident research assistant",
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
    last_error: null,
    last_observed_at: null,
    last_started_at: null,
    last_stopped_at: null,
  },
  created_at: "2026-08-12T12:00:00.000Z",
  updated_at: "2026-08-12T12:00:00.000Z",
};

const viewerThread = {
  companion_id: companion.id,
  viewer_id: "user-2",
  access: "viewer" as const,
  read_only: true,
  can_send: false,
  entries: [],
  pending_count: 0,
  last_message_at: null,
};

const message = {
  event_id: "msg:33333333-3333-4333-8333-333333333333",
  ordinal: 0,
  role: "user" as const,
  content: "Summarize the incident",
  author_id: "user-1",
  author_name: "User",
  created_at: companion.created_at,
};

function boxRuntime(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    status: vi.fn(),
    desktop: vi.fn(),
    prompt: vi.fn(),
    readEvents: vi.fn(async () => ({ chunk: "", offset: 0 })),
    ...overrides,
  };
}

const runningCompanion = {
  ...companion,
  runtime: { ...companion.runtime, state: "running" as const, daemon_state: "running" as const },
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
    coreMocks.listCompanionPlugins.mockResolvedValue([]);
    coreMocks.listCompanionRegistry.mockResolvedValue({
      pins: [],
      servers: [],
      next_cursor: null,
      source: "live",
    });
    coreMocks.getCompanionRegistryServer.mockResolvedValue({
      server: {
        name: "app.linear/linear",
        provider: "linear",
        title: "Linear",
        description: "Linear.",
        version: "latest",
        website_url: null,
        repository_url: null,
        pinned: true,
        connect: { transport: "http", url: "https://mcp.linear.app/mcp", credential: null },
      },
      source: "live",
    });
    coreMocks.saveCompanionPlugin.mockResolvedValue({
      id: "44444444-4444-4444-8444-444444444444",
      provider: "github",
      label: "work",
      transport: "http",
      endpoint: "https://mcp.example.test/github",
      connected: true,
      created_at: companion.created_at,
      updated_at: companion.updated_at,
    });
    coreMocks.deleteCompanionPlugin.mockResolvedValue(undefined);
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
    coreMocks.resolveCompanionPluginInjection.mockResolvedValue({
      accounts: [],
      credentials: [],
    });
    coreMocks.getCompanion.mockResolvedValue(companion);
    coreMocks.getCompanionForRuntime.mockResolvedValue(companion);
    coreMocks.getCompanionThread.mockResolvedValue(viewerThread);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: message,
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({ pending: [], piLogOffset: 0 });
    coreMocks.recordCompanionPiProjection.mockResolvedValue({
      ...viewerThread,
      access: "owner",
      read_only: false,
      can_send: true,
    });
    const shares = {
      companion_id: companion.id,
      workspace_role: null,
    };
    coreMocks.listCompanionShares.mockResolvedValue(shares);
    coreMocks.setCompanionWorkspaceShare.mockResolvedValue(shares);
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
    expect((await app.request("/v1/companion-plugins")).status).toBe(404);
    expect((await app.request("/v1/companion-registry/servers")).status).toBe(404);
    expect((await app.request("/v1/companion-registry/server?name=app.linear/linear")).status)
      .toBe(404);
    expect(contextMocks.actorFromContext).not.toHaveBeenCalled();
  });

  it("does not register routes when the master flag is on without an allowlist", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();

    registerCompanionRoutesImpl(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    expect((await app.request("/v1/companions")).status).toBe(404);
    expect((await app.request("/v1/companion-providers")).status).toBe(404);
    expect((await app.request("/v1/companion-plugins")).status).toBe(404);
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

  it("allows an authenticated user whose email domain is allowlisted", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    contextMocks.actorFromContext.mockReturnValueOnce({
      id: "user-1",
      email: "User@TheVibeCompany.Co",
      name: "User",
    });
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "other.example, thevibecompany.co",
    });

    const response = await app.request("/v1/companions");

    expect(response.status).toBe(200);
    expect(contextMocks.orgIdFromContext).toHaveBeenCalledOnce();
    expect(coreMocks.listCompanions).toHaveBeenCalledOnce();
  });

  it.each([
    ["a non-allowlisted domain", "user@example.test"],
    ["a missing email", undefined],
  ])("returns 403 before tenant resolution for %s", async (_case, email) => {
    const app = new Hono<{ Variables: ApiVariables }>();
    contextMocks.actorFromContext.mockReturnValueOnce({
      id: "user-1",
      email,
      name: "User",
    });
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "thevibecompany.co",
    });

    const response = await app.request("/v1/companions");

    expect(response.status).toBe(403);
    expect(contextMocks.orgIdFromContext).not.toHaveBeenCalled();
    expect(coreMocks.listCompanions).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", "/v1/companion-plugins", undefined],
    ["POST", "/v1/companion-plugins", JSON.stringify({
      provider: "linear",
      label: "work",
      transport: "http",
      url: "https://mcp.example.test/linear",
      args: [],
    })],
    ["DELETE", "/v1/companion-plugins/44444444-4444-4444-8444-444444444444", undefined],
  ])("returns 403 before tenant resolution for %s %s outside the allowlist", async (
    method,
    path,
    body,
  ) => {
    const app = new Hono<{ Variables: ApiVariables }>();
    contextMocks.actorFromContext.mockReturnValueOnce({
      id: "user-1",
      email: "user@example.test",
      name: "User",
    });
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "thevibecompany.co",
    });

    const response = await app.request(path, {
      method,
      ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
    });

    expect(response.status).toBe(403);
    expect(contextMocks.orgIdFromContext).not.toHaveBeenCalled();
    expect(coreMocks.listCompanionPlugins).not.toHaveBeenCalled();
    expect(coreMocks.saveCompanionPlugin).not.toHaveBeenCalled();
    expect(coreMocks.deleteCompanionPlugin).not.toHaveBeenCalled();
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

  it("serves a viewer thread from the control plane without creating a Box client", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/thread`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ thread: viewerThread });
    expect(coreMocks.getCompanionThread).toHaveBeenCalledOnce();
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["send", `/v1/companions/${companion.id}/messages`, JSON.stringify({ content: "Hello" })],
    ["sync", `/v1/companions/${companion.id}/thread/sync`, "{}"],
  ])("guards viewer %s before creating or calling the Box client", async (_action, path, body) => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    coreMocks.getCompanionForRuntime.mockRejectedValue(
      new (await import("@companion/core")).CompanionRuntimeForbiddenError(),
    );
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(response.status).toBe(403);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.sendCompanionMessage).not.toHaveBeenCalled();
  });

  it("persists a message for a sleeping Companion without contacting Box", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "pending" });
    expect(coreMocks.sendCompanionMessage).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companion.id,
      content: "Summarize the incident",
    }));
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("hands a message to a running Pi daemon and records the delivery watermark", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({ pending: [message], piLogOffset: 0 });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "delivered" });
    expect(runtime.prompt).toHaveBeenCalledWith({
      boxId: companion.runtime.box_id,
      message: message.content,
      requestId: message.event_id,
    });
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenCalledWith(expect.objectContaining({
      deliveredOrdinal: 0,
      entries: [],
    }));
  });

  it("delivers the backlog a sleeping Box missed before the message that woke the send", async () => {
    const backlog = { ...message, event_id: "msg:earlier", ordinal: 0, content: "Earlier ask" };
    const latest = { ...message, event_id: "msg:latest", ordinal: 1, content: "Summarize the incident" };
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: latest,
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [backlog, latest],
      piLogOffset: 0,
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "delivered" });
    // Oldest first, so Pi reads the conversation in the order the members wrote it.
    expect(runtime.prompt.mock.calls.map(([input]) => input.message)).toEqual([
      "Earlier ask",
      "Summarize the incident",
    ]);
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenCalledWith(expect.objectContaining({
      deliveredOrdinal: 1,
    }));
  });

  it("leaves the newest message pending when Pi accepts only the backlog", async () => {
    const backlog = { ...message, event_id: "msg:earlier", ordinal: 0, content: "Earlier ask" };
    const latest = { ...message, event_id: "msg:latest", ordinal: 1, content: "Summarize the incident" };
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: latest,
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [backlog, latest],
      piLogOffset: 0,
    });
    const runtime = boxRuntime({
      prompt: vi.fn(async (input: { message: string }) => {
        if (input.message === "Summarize the incident") throw new Error("pi daemon stopped");
      }),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "pending" });
    // The watermark stops at what Pi accepted, so the refused message is retried instead of lost.
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenCalledWith(expect.objectContaining({
      deliveredOrdinal: 0,
    }));
  });

  it("keeps a message pending when Pi refuses it", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({ pending: [message], piLogOffset: 0 });
    const runtime = boxRuntime({
      prompt: vi.fn(async () => {
        throw new Error("pi daemon is not running");
      }),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "pending" });
    expect(coreMocks.recordCompanionPiProjection).not.toHaveBeenCalled();
  });

  it("rejects an empty message before any persistence", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "   " }),
    });

    expect(response.status).toBe(400);
    expect(coreMocks.sendCompanionMessage).not.toHaveBeenCalled();
  });

  it("syncs a running thread by delivering pending messages and projecting Pi events", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 512,
    });
    const reply = `${JSON.stringify({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "Two services timed out." }] },
    })}\n`;
    const runtime = boxRuntime({
      readEvents: vi.fn(async () => ({ chunk: reply, offset: 512 })),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: "box" });
    expect(runtime.prompt).toHaveBeenCalledOnce();
    expect(runtime.readEvents).toHaveBeenCalledWith({
      boxId: companion.runtime.box_id,
      offset: 512,
    });
    // Delivery is claimed before the log is read, so the prompt cannot be repeated by a retry.
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenNthCalledWith(1, expect.objectContaining({
      deliveredOrdinal: 0,
      entries: [],
    }));
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenNthCalledWith(2, expect.objectContaining({
      piLogOffset: 512 + Buffer.byteLength(reply, "utf8"),
      piLogRewound: false,
      entries: [expect.objectContaining({ role: "assistant", content: "Two services timed out." })],
    }));
  });

  it("records a reply when Pi answered inside a thinking block and settled", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [{ ...message, content: "What year is it? One word." }],
      piLogOffset: 512,
    });
    const chunk = [
      { type: "message_end", message: { role: "user", content: "What year is it? One word." } },
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "\n2025" }],
          stopReason: "stop",
        },
      },
      { type: "agent_settled" },
    ].map((event) => `${JSON.stringify(event)}\n`).join("");
    const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk, offset: 512 })) });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenNthCalledWith(2, expect.objectContaining({
      entries: [expect.objectContaining({ role: "assistant", content: "2025" })],
    }));
  });

  it("keeps the delivery watermark when reading the Pi log fails after the prompt", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({ pending: [message], piLogOffset: 512 });
    const runtime = boxRuntime({
      readEvents: vi.fn(async () => {
        throw new Error("box command failed");
      }),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(400);
    // The failed read must not cost Pi a second copy of the same message on the next sync.
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenCalledWith(expect.objectContaining({
      deliveredOrdinal: 0,
      entries: [],
    }));
  });

  it("rereads a shrunken Pi log from its start and owns the offset outright", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({ pending: [], piLogOffset: 4096 });
    const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk: "", offset: 0 })) });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenCalledWith(expect.objectContaining({
      piLogOffset: 0,
      piLogRewound: true,
    }));
  });

  it("syncs a sleeping thread from the control plane without contacting Box", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({ pending: [message], piLogOffset: 0 });
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: "control_plane" });
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.recordCompanionPiProjection).not.toHaveBeenCalled();
  });

  it("does not register chat routes when the flag is off", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();

    registerCompanionRoutes(app, {});

    expect((await app.request(`/v1/companions/${companion.id}/thread`)).status).toBe(404);
    const send = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Hello" }),
    });
    expect(send.status).toBe(404);
    const sync = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(sync.status).toBe(404);
    expect(contextMocks.actorFromContext).not.toHaveBeenCalled();
  });

  it.each([
    ["list", "GET", `/v1/companions/${companion.id}/shares`, undefined, "listCompanionShares"],
    ["workspace", "PUT", `/v1/companions/${companion.id}/shares/workspace`, {
      role: "viewer",
    }, "setCompanionWorkspaceShare"],
  ] as const)("supports owner workspace share %s", async (_name, method, path, body, mockName) => {
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
    ["list", "GET", `/v1/companions/${companion.id}/shares`, undefined, "listCompanionShares"],
    ["workspace", "PUT", `/v1/companions/${companion.id}/shares/workspace`, {
      role: "viewer",
    }, "setCompanionWorkspaceShare"],
  ] as const)("rejects non-owner workspace share %s", async (_name, method, path, body, mockName) => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const forbidden = new (await import("@companion/core")).CompanionShareForbiddenError();
    coreMocks[mockName].mockRejectedValueOnce(forbidden);
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    expect(response.status).toBe(403);
  });

  // THE-329 cut individual sharing: the per-member grant endpoints no longer exist.
  it.each([
    ["invite", "PUT", `/v1/companions/${companion.id}/shares/members`, {
      email: "editor@example.test",
      role: "editor",
    }],
    ["role change", "PATCH", `/v1/companions/${companion.id}/shares/members/user-2`, {
      role: "viewer",
    }],
    ["revoke", "DELETE", `/v1/companions/${companion.id}/shares/members/user-2`, undefined],
  ] as const)("no longer exposes the member share %s endpoint", async (_name, method, path, body) => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    expect(response.status).toBe(404);
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

  it("creates a Companion from a name, a persona, and one connected provider", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request("/v1/companions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Luna",
        persona: "Content marketing assistant",
        provider_id: "anthropic",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ companion });
    expect(coreMocks.createCompanion).toHaveBeenCalledWith(expect.objectContaining({
      name: "Luna",
      persona: "Content marketing assistant",
      providerId: "anthropic",
    }));
  });

  it("rejects a persona longer than the stored column allows", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request("/v1/companions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Luna", persona: "x".repeat(281) }),
    });

    expect(response.status).toBe(400);
    expect(coreMocks.createCompanion).not.toHaveBeenCalled();
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
    const runtimeFactory = vi.fn(() => boxRuntime({ start }));
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

  it("clears the recorded Box when the adapter reports it is not this Companion's", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    // The wake found that the id this row carried names a machine the Companion does not own — the
    // shared workspace Box the runtime restore copied onto every row — and moved onto its own.
    const start = vi.fn(async (input) => {
      await input.onBoxAssigned(null);
      await input.onBoxAssigned("bx_abcdefgh");
      return {
        boxId: "bx_abcdefgh",
        runtimeState: "running" as const,
        daemonState: "running" as const,
        desktopAvailable: true,
      };
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, vi.fn(() => boxRuntime({ start })));

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    const recorded = coreMocks.updateCompanionRuntime.mock.calls
      .map(([call]) => call.patch.boxId)
      .filter((boxId) => boxId !== undefined);
    expect(recorded).toEqual([null, "bx_abcdefgh", "bx_abcdefgh"]);
  });

  it.each([
    [
      "keeps a refreshed subscription file on an already provisioned Box at the current layout",
      {
        box_id: "bx_23456789",
        disk_layout_version: 4,
        provider_credential_generation: "22222222-2222-4222-8222-222222222222",
      },
      false,
    ],
    [
      "rewrites provider auth for a Companion that has no Box yet",
      {
        box_id: null,
        disk_layout_version: 4,
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
        disk_layout_version: 4,
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
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, vi.fn(() => boxRuntime({ start })));

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

  it("manages labeled MCP accounts outside the Companion thread", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const listed = await app.request("/v1/companion-plugins");
    expect(listed.status).toBe(200);
    await expect(listed.json()).resolves.toEqual({ accounts: [] });

    const created = await app.request("/v1/companion-plugins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        label: "work",
        transport: "http",
        url: "https://mcp.example.test/github",
        credential_name: "Authorization",
        credential_value: "Bearer secret-mcp",
      }),
    });
    expect(created.status).toBe(201);
    expect(coreMocks.saveCompanionPlugin).toHaveBeenCalledWith(expect.objectContaining({
      plugin: expect.objectContaining({ provider: "github", label: "work" }),
    }));
    expect(JSON.stringify(await created.json())).not.toContain("secret-mcp");

    const authless = await app.request("/v1/companion-plugins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        label: "personal",
        transport: "http",
        url: "https://mcp.example.test/github/personal",
        args: [],
      }),
    });
    expect(authless.status).toBe(201);

    coreMocks.saveCompanionPlugin.mockRejectedValueOnce(new CompanionPluginConflictError());
    const conflict = await app.request("/v1/companion-plugins", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "github",
        label: "work",
        transport: "http",
        url: "https://mcp.example.test/github/work",
        args: [],
      }),
    });
    expect(conflict.status).toBe(409);

    const removed = await app.request(
      "/v1/companion-plugins/44444444-4444-4444-8444-444444444444",
      { method: "DELETE" },
    );
    expect(removed.status).toBe(200);
    expect(coreMocks.deleteCompanionPlugin).toHaveBeenCalledWith(expect.objectContaining({
      accountId: "44444444-4444-4444-8444-444444444444",
    }));
  });

  it("injects saved member plugins through THE-325 without exposing their credential", async () => {
    coreMocks.resolveCompanionPluginInjection.mockResolvedValueOnce({
      accounts: [{
        id: "44444444-4444-4444-8444-444444444444",
        label: "work",
        transport: "http",
        url: "https://mcp.example.test/github",
        headers: { Authorization: "COMPANION_MCP_ACCOUNT" },
        lifecycle: "lazy",
        direct_tools: false,
      }],
      credentials: [{ env_key: "COMPANION_MCP_ACCOUNT", value: "secret-mcp" }],
    });
    const start = vi.fn(async () => ({
      boxId: "bx_23456789",
      runtimeState: "running" as const,
      daemonState: "running" as const,
      desktopAvailable: false,
    }));
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => boxRuntime({ start }));

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_surface: "mobile_web" }),
    });

    expect(response.status).toBe(200);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      mcpAccounts: [expect.objectContaining({ label: "work" })],
      mcpCredentials: [{ env_key: "COMPANION_MCP_ACCOUNT", value: "secret-mcp" }],
    }));
    expect(JSON.stringify(await response.json())).not.toContain("secret-mcp");
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
    const runtimeFactory = vi.fn(() => boxRuntime({
      start: vi.fn(async (input) => {
        starts.push(input);
        return {
          boxId: "bx_23456789",
          runtimeState: "running" as const,
          daemonState: "running" as const,
          desktopAvailable: true,
        };
      }),
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

  it("answers a wake with the configuration failure and records it on the Companion", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => boxRuntime({
      start: vi.fn(async () => {
        throw new BoxRuntimeConfigurationError(
          "Box runtime is not configured; set COMPANION_BOX_API_KEY",
        );
      }),
    }));
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Box runtime is not configured; set COMPANION_BOX_API_KEY",
    });
    expect(coreMocks.updateCompanionRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: "Box runtime is not configured; set COMPANION_BOX_API_KEY",
      }),
    }));
  });

  it("answers a wake with the Box failure and its code", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => boxRuntime({
      start: vi.fn(async () => {
        throw new BoxRuntimeProviderError("Box Pi setup failed: exit 1", 502, "setup_failed");
      }),
    }));
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Box Pi setup failed: exit 1",
      code: "setup_failed",
    });
    expect(coreMocks.updateCompanionRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ lastError: "Box Pi setup failed: exit 1" }),
    }));
  });

  it("records an unrecognized wake failure as a generic line instead of internal text", async () => {
    coreMocks.listCompanionRuntimeSkillPackages.mockResolvedValue([{
      slug: "incident-summary",
      version: "1.2.3",
      checksum: `sha256:${"a".repeat(64)}`,
      storagePath: "org-1/incident-summary/1.2.3.tar.gz",
    }]);
    storageMocks.getSkillArchive.mockRejectedValueOnce(
      new Error("connect ECONNREFUSED 10.1.2.3:443 while reading org-1/incident-summary/1.2.3.tar.gz"),
    );
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, vi.fn(() => boxRuntime()));

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(400);
    const recorded = coreMocks.updateCompanionRuntime.mock.calls.at(-1)?.[0].patch.lastError;
    expect(recorded).toBe(COMPANION_RUNTIME_UNKNOWN_ERROR);
    expect(recorded).not.toContain("ECONNREFUSED");
  });

  it("answers a failed sync with the Box failure rather than a bare status", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => boxRuntime({
      readEvents: vi.fn(async () => {
        throw new BoxRuntimeProviderError("Pi event log could not be read from Box", 502);
      }),
    }));
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "Pi event log could not be read from Box",
    });
  });

  it("hands a runner the Lux desktop of a Box it never starts", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    coreMocks.getCompanionForRuntime.mockResolvedValueOnce(runningCompanion);
    const runtime = boxRuntime({
      desktop: vi.fn(async () => ({ url: "https://ascii.dev/desktop/bx_23456789", provisioning: false })),
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/desktop`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      desktop_url: "https://ascii.dev/desktop/bx_23456789",
      provisioning: false,
      automation: "lux",
    });
    expect(runtime.desktop).toHaveBeenCalledWith({ boxId: "bx_23456789" });
    // Computer use observes a Box the runner already started; it is never a wake.
    expect(runtime.start).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
    // The secret-bearing URL belongs to this response only, so nothing records it.
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionObservation).not.toHaveBeenCalled();
  });

  it("reports a desktop Box is still provisioning instead of inventing a URL", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    coreMocks.getCompanionForRuntime.mockResolvedValueOnce(runningCompanion);
    const runtime = boxRuntime({
      desktop: vi.fn(async () => ({ url: null, provisioning: true })),
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/desktop`, {
      method: "POST",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      desktop_url: null,
      provisioning: true,
      automation: "lux",
    });
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

  it("proxies a registry search through the cache-backed core helper", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    coreMocks.listCompanionRegistry.mockResolvedValueOnce({
      pins: [{ name: "app.linear/linear", provider: "linear" }],
      servers: [{ name: "io.example.acme/search", provider: "acme" }],
      next_cursor: "next123",
      source: "live",
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request("/v1/companion-registry/servers?search=acme&cursor=abc");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: "live", next_cursor: "next123" });
    expect(coreMocks.listCompanionRegistry).toHaveBeenCalledWith(
      expect.objectContaining({ search: "acme", cursor: "abc" }),
    );
    // Browse is a stateless proxy: it never opens a tenant row.
    expect(contextMocks.orgIdFromContext).not.toHaveBeenCalled();
  });

  it("returns 403 for registry browse outside the allowlist", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    contextMocks.actorFromContext.mockReturnValueOnce({
      id: "user-1",
      email: "user@example.test",
      name: "User",
    });
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "thevibecompany.co",
    });

    const response = await app.request("/v1/companion-registry/servers");

    expect(response.status).toBe(403);
    expect(coreMocks.listCompanionRegistry).not.toHaveBeenCalled();
  });

  it("validates the registry detail server name", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request("/v1/companion-registry/server?name=not-a-registry-name");

    expect(response.status).toBe(400);
    expect(coreMocks.getCompanionRegistryServer).not.toHaveBeenCalled();
  });

  it("proxies a registry detail read", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(
      "/v1/companion-registry/server?name=app.linear%2Flinear",
    );

    expect(response.status).toBe(200);
    expect(coreMocks.getCompanionRegistryServer).toHaveBeenCalledWith(
      expect.objectContaining({ name: "app.linear/linear" }),
    );
  });

  it("answers 503 when the registry is unavailable with no cache", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    coreMocks.getCompanionRegistryServer.mockRejectedValueOnce(
      new CompanionRegistryUnavailableError(),
    );
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(
      "/v1/companion-registry/server?name=io.example.acme%2Fsearch",
    );

    expect(response.status).toBe(503);
  });
});
