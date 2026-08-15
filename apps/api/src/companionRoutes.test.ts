import {
  COMPANION_RUNTIME_START_BUDGET_MS,
  CompanionDeleteForbiddenError,
  CompanionPluginConflictError,
  CompanionProviderError,
  CompanionProviderOAuthError,
  CompanionRuntimeTransitionError,
  CompanionSettingsForbiddenError,
} from "@companion/core";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError, type ApiVariables } from "./context";
import {
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
  COMPANION_PI_DISK_LAYOUT_VERSION,
} from "./boxCompanionRuntime";
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
  createCompanion: vi.fn(),
  updateCompanion: vi.fn(),
  updateCompanionMemberState: vi.fn(),
  duplicateCompanion: vi.fn(),
  claimCompanionDeletion: vi.fn(),
  deleteCompanion: vi.fn(),
  saveCompanionPlugin: vi.fn(),
  beginAnthropicProviderOAuth: vi.fn(),
  beginOpenAICodexProviderOAuth: vi.fn(),
  completeAnthropicProviderOAuth: vi.fn(),
  pollOpenAICodexProviderOAuth: vi.fn(),
  beginCompanionPluginOAuth: vi.fn(),
  completeCompanionPluginOAuth: vi.fn(),
  saveCompanionOAuthPlugin: vi.fn(),
  deleteCompanionPlugin: vi.fn(),
  saveCompanionProvider: vi.fn(),
  setCompanionProvider: vi.fn(),
  deleteCompanionProvider: vi.fn(),
  setDefaultCompanionProvider: vi.fn(),
  getCompanionProviderCredentialGeneration: vi.fn(),
  resolveCompanionProviderAuth: vi.fn(),
  resolveCompanionPluginInjection: vi.fn(),
  getCompanion: vi.fn(),
  getCompanionForRuntime: vi.fn(),
  getCompanionThread: vi.fn(),
  markCompanionThreadRead: vi.fn(),
  sendCompanionMessage: vi.fn(),
  listPendingCompanionMessages: vi.fn(),
  recordCompanionPiProjection: vi.fn(),
  attachCompanionToolRunScreenshot: vi.fn(),
  decideCompanionDecision: vi.fn(),
  expireCompanionDecisions: vi.fn(),
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
  packDir: vi.fn(async () => ({
    archive: Buffer.from("companion-agent-skill"),
    checksum: "sha256:companion-agent",
    sizeBytes: 22,
  })),
}));

const companionSkillPackageMocks = vi.hoisted(() => ({
  getCompanionSkillPackage: vi.fn(async () => ({
    key: "companion",
    zip: Buffer.from("zip"),
    checksum: "sha256:companion-agent",
    sizeBytes: 3,
    version: "1.0.0",
    integrity: { packageChecksum: "sha256:companion-agent", files: { "SKILL.md": "sha256:a" } },
  })),
}));

const servicesMocks = vi.hoisted(() => ({
  issueApiToken: vi.fn(async () => ({
    id: "token-1",
    token: "cmp_pat_testtoken",
    prefix: "cmp_pat_test",
    scopes: ["skills:read"],
    expiresAt: new Date("2026-08-15T00:00:00.000Z"),
    targetWorkspaceId: null,
  })),
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
vi.mock("./companionSkillPackage", () => companionSkillPackageMocks);
vi.mock("@companion/core/services", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@companion/core/services")>()),
  ...servicesMocks,
}));

const companion = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Research",
  persona: "Incident research assistant",
  model_id: "claude-opus-4-8",
  selected_skill_ids: [],
  can_write_skills: false,
  selected_mcp_account_ids: [],
  owner_id: "user-1",
  access: "owner" as const,
  pinned: false,
  hidden: false,
  unread: false,
  last_message: null,
  runtime: {
    state: "stopped" as const,
    daemon_state: "stopped" as const,
    box_id: "bx_23456789",
    provider_ids: ["anthropic"],
    provider_credential_generation: null,
    disk_layout_version: 1,
    desktop_available: true,
    last_error: null,
    skills_revision: 1,
    skills_applied_revision: 1,
    skills_applied_at: null,
    skills_last_error: null,
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
  tool: null,
    decision: null,
  reasoning: null,
  created_at: companion.created_at,
};

function boxRuntime(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn(async () => ({
      boxId: companion.runtime.box_id,
      runtimeState: "running" as const,
      daemonState: "running" as const,
      desktopAvailable: true,
    })),
    stop: vi.fn(),
    status: vi.fn(async () => ({
      boxId: companion.runtime.box_id,
      runtimeState: "running" as const,
      daemonState: "running" as const,
      desktopAvailable: true,
    })),
    desktop: vi.fn(),
    prompt: vi.fn(),
    respondExtensionUi: vi.fn(async () => undefined),
    refreshTtl: vi.fn(async () => undefined),
    readEvents: vi.fn(async () => ({ chunk: "", offset: 0 })),
    captureDesktopFrame: vi.fn(async () => null),
    ...overrides,
  };
}

const runningCompanion = {
  ...companion,
  runtime: {
    ...companion.runtime,
    state: "running" as const,
    daemon_state: "running" as const,
    provider_credential_generation: "22222222-2222-4222-8222-222222222222",
    disk_layout_version: COMPANION_PI_DISK_LAYOUT_VERSION,
  },
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
    coreMocks.beginAnthropicProviderOAuth.mockReturnValue({
      authorizationUrl: "https://claude.ai/oauth/authorize?state=provider-state",
      flow: {
        providerId: "anthropic",
        verifier: "provider-verifier",
        state: "provider-state",
        expiresAt: Date.now() + 15 * 60_000,
      },
    });
    coreMocks.beginOpenAICodexProviderOAuth.mockResolvedValue({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-EFGH",
      pollIntervalSeconds: 2,
      flow: {
        providerId: "openai-codex",
        deviceAuthId: "device-auth-secret",
        userCode: "ABCD-EFGH",
        pollIntervalSeconds: 2,
        expiresAt: Date.now() + 15 * 60_000,
      },
    });
    coreMocks.completeAnthropicProviderOAuth.mockResolvedValue({
      type: "oauth",
      access: "claude-access-secret",
      refresh: "claude-refresh-secret",
      expires: Date.now() + 3600_000,
    });
    coreMocks.pollOpenAICodexProviderOAuth.mockResolvedValue({
      status: "complete",
      credential: {
        type: "oauth",
        access: "codex-access-secret",
        refresh: "codex-refresh-secret",
        expires: Date.now() + 3600_000,
        accountId: "acct-123",
      },
    });
    coreMocks.beginCompanionPluginOAuth.mockImplementation(async (input) => ({
      authorizationUrl: `https://mcp.linear.app/authorize?state=${encodeURIComponent(input.state)}`,
      flow: {
        serverName: "app.linear/linear",
        provider: "linear",
        remoteUrl: "https://mcp.linear.app/mcp",
        authorizationEndpoint: "https://mcp.linear.app/authorize",
        tokenEndpoint: "https://mcp.linear.app/token",
        resource: "https://mcp.linear.app/mcp",
        scope: "read write",
        codeVerifier: "pkce-verifier",
        client: {
          clientId: "dynamic-client",
          clientSecret: null,
          tokenEndpointAuthMethod: "none",
        },
      },
    }));
    coreMocks.completeCompanionPluginOAuth.mockResolvedValue({
      kind: "oauth",
      version: 1,
      serverName: "app.linear/linear",
      accessToken: "provider-access-token",
      refreshToken: "provider-refresh-token",
      accessExpiresAt: "2026-08-14T12:00:00.000Z",
      scope: "read write",
      tokenType: "Bearer",
      tokenEndpoint: "https://mcp.linear.app/token",
      resource: "https://mcp.linear.app/mcp",
      client: {
        clientId: "dynamic-client",
        clientSecret: null,
        tokenEndpointAuthMethod: "none",
      },
    });
    coreMocks.saveCompanionOAuthPlugin.mockResolvedValue({
      id: "55555555-5555-4555-8555-555555555555",
      provider: "linear",
      label: "work",
      transport: "http",
      endpoint: "https://mcp.linear.app/mcp",
      connected: true,
      created_at: companion.created_at,
      updated_at: companion.updated_at,
    });
    coreMocks.deleteCompanionPlugin.mockResolvedValue(undefined);
    coreMocks.createCompanion.mockResolvedValue(companion);
    coreMocks.updateCompanion.mockResolvedValue(companion);
    coreMocks.updateCompanionMemberState.mockResolvedValue(companion);
    coreMocks.duplicateCompanion.mockResolvedValue({
      ...companion,
      id: "22222222-2222-4222-8222-222222222222",
      name: "Research (copy)",
    });
    coreMocks.claimCompanionDeletion.mockResolvedValue(companion);
    coreMocks.deleteCompanion.mockResolvedValue(undefined);
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
    coreMocks.getCompanionProviderCredentialGeneration.mockResolvedValue({
      providerId: "anthropic",
      credentialGeneration: "22222222-2222-4222-8222-222222222222",
    });
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
    coreMocks.markCompanionThreadRead.mockResolvedValue(undefined);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: message,
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    coreMocks.recordCompanionPiProjection.mockResolvedValue({
      ...viewerThread,
      access: "owner",
      read_only: false,
      can_send: true,
    });
    coreMocks.expireCompanionDecisions.mockImplementation(async () => {
      const last = coreMocks.recordCompanionPiProjection.mock.results.at(-1);
      const thread = last?.type === "return"
        ? await last.value
        : {
          ...viewerThread,
          access: "owner",
          read_only: false,
          can_send: true,
        };
      return { thread, responses: [] };
    });
    coreMocks.decideCompanionDecision.mockResolvedValue({
      thread: {
        ...viewerThread,
        access: "owner",
        read_only: false,
        can_send: true,
      },
      response: { type: "extension_ui_response", id: "req-1", confirmed: true },
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
    expect((await app.request("/v1/companion-plugins/oauth/start", { method: "POST" })).status)
      .toBe(404);
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

  it("carries each thread's last line on the list a conversation sidebar reads", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    coreMocks.listCompanions.mockResolvedValue([{
      ...companion,
      last_message: {
        preview: "Drafted the launch note.",
        role: "assistant",
        author_id: null,
        author_name: null,
        created_at: "2026-08-14T09:05:00.000Z",
      },
    }]);
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => {
      throw new Error("Box client must not be created");
    });

    const response = await app.request("/v1/companions");

    expect(response.status).toBe(200);
    const body = await response.json() as { companions: Array<{ last_message: unknown }> };
    expect(body.companions[0]?.last_message).toEqual({
      preview: "Drafted the launch note.",
      role: "assistant",
      author_id: null,
      author_name: null,
      created_at: "2026-08-14T09:05:00.000Z",
    });
  });

  it("answers without previews when a caller asks for the roster alone", async () => {
    // The Skills page needs names and attachments to say which Companions stage a skill. It shows
    // nobody's conversation, so it must not be handed everybody's.
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    await app.request("/v1/companions?preview=false");
    expect(coreMocks.listCompanions).toHaveBeenCalledWith(
      expect.objectContaining({ withLastMessage: false }),
    );

    await app.request("/v1/companions");
    expect(coreMocks.listCompanions).toHaveBeenLastCalledWith(
      expect.objectContaining({ withLastMessage: true }),
    );
  });

  it("keeps the chat text it now carries out of the browser's disk cache", async () => {
    // The list used to be settings and runtime state; it carries each thread's last line now, so it
    // gets the same `no-store` every other read of sensitive content in this API gets.
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const list = await app.request("/v1/companions");
    expect(list.headers.get("cache-control")).toBe("private, no-store");

    coreMocks.getCompanion.mockResolvedValue(companion);
    const one = await app.request(`/v1/companions/${companion.id}`);
    expect(one.headers.get("cache-control")).toBe("private, no-store");
  });

  it("saves a provider change without waking an asleep Box", async () => {
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Research desk",
        persona: "Challenge every source.",
        provider_id: "openai-codex",
      }),
    });

    expect(response.status).toBe(200);
    expect(coreMocks.updateCompanion).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companion.id,
      name: "Research desk",
      persona: "Challenge every source.",
      providerId: "openai-codex",
    }));
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("applies a provider change immediately when Box and Pi are already running", async () => {
    const changed = {
      ...runningCompanion,
      model_id: "gpt-5.5",
      runtime: {
        ...runningCompanion.runtime,
        provider_ids: ["openai-codex"],
        provider_credential_generation: null,
      },
    };
    coreMocks.getCompanion.mockResolvedValueOnce(runningCompanion);
    coreMocks.updateCompanion.mockResolvedValueOnce(changed);
    coreMocks.getCompanionProviderCredentialGeneration.mockResolvedValueOnce({
      providerId: "openai-codex",
      credentialGeneration: "44444444-4444-4444-8444-444444444444",
    });
    coreMocks.claimCompanionRuntimeStart.mockResolvedValueOnce(changed);
    coreMocks.resolveCompanionProviderAuth.mockResolvedValueOnce({
      providerId: "openai-codex",
      credentialGeneration: "44444444-4444-4444-8444-444444444444",
      authEntry: { type: "oauth", access: "secret-b" },
    });
    coreMocks.updateCompanionRuntime.mockResolvedValueOnce({
      ...changed,
      runtime: {
        ...changed.runtime,
        provider_credential_generation: "44444444-4444-4444-8444-444444444444",
      },
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: "openai-codex" }),
    });

    expect(response.status).toBe(200);
    expect(runtime.status).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      boxId: companion.runtime.box_id,
      providerAuth: { "openai-codex": { type: "oauth", access: "secret-b" } },
      replaceProviderAuth: true,
      modelId: "gpt-5.5",
      allowBoxWake: false,
    }));
  });

  it("recycles Pi for an online plugin-selection change without waking or recreating the Box", async () => {
    const changed = {
      ...runningCompanion,
      selected_mcp_account_ids: [
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      ],
    };
    coreMocks.getCompanion.mockResolvedValueOnce(runningCompanion);
    coreMocks.updateCompanion.mockResolvedValueOnce(changed);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValueOnce(changed);
    coreMocks.resolveCompanionPluginInjection.mockResolvedValueOnce({
      accounts: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          label: "work",
          lifecycle: "lazy",
          direct_tools: false,
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "COMPANION_MCP_LINEAR" },
        },
      ],
      credentials: [{ env_key: "COMPANION_MCP_LINEAR", value: "Bearer secret-linear" }],
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selected_mcp_account_ids: [
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        ],
      }),
    });

    expect(response.status).toBe(200);
    expect(runtime.status).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      boxId: companion.runtime.box_id,
      restartPi: true,
      allowBoxWake: false,
      mcpAccounts: [
        expect.objectContaining({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }),
      ],
    }));
    expect(JSON.stringify(await response.json())).not.toContain("secret-linear");
  });

  it("saves a plugin-selection change without waking an asleep Box", async () => {
    const changed = {
      ...companion,
      selected_mcp_account_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
    };
    coreMocks.getCompanion.mockResolvedValueOnce(companion);
    coreMocks.updateCompanion.mockResolvedValueOnce(changed);
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selected_mcp_account_ids: ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"],
      }),
    });

    expect(response.status).toBe(200);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
  });

  it("recycles Pi for an online model-only change without replacing provider auth", async () => {
    const changed = { ...runningCompanion, model_id: "claude-sonnet-4-6" };
    coreMocks.getCompanion.mockResolvedValueOnce(runningCompanion);
    coreMocks.updateCompanion.mockResolvedValueOnce(changed);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValueOnce(changed);
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model_id: "claude-sonnet-4-6" }),
    });

    expect(response.status).toBe(200);
    expect(runtime.status).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      boxId: companion.runtime.box_id,
      modelId: "claude-sonnet-4-6",
      replaceProviderAuth: false,
      restartPi: true,
      allowBoxWake: false,
    }));
  });

  it("saves a model-only change without waking an asleep Box", async () => {
    const changed = { ...companion, model_id: "claude-sonnet-4-6" };
    coreMocks.getCompanion.mockResolvedValueOnce(companion);
    coreMocks.updateCompanion.mockResolvedValueOnce(changed);
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model_id: "claude-sonnet-4-6" }),
    });

    expect(response.status).toBe(200);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
  });

  it("records the claimed skills revision as applied when an online skills change recycles Pi", async () => {
    const changed = {
      ...runningCompanion,
      selected_skill_ids: ["33333333-3333-4333-8333-333333333333"],
      runtime: { ...runningCompanion.runtime, skills_revision: 5, skills_applied_revision: 4 },
    };
    coreMocks.getCompanion.mockResolvedValueOnce(runningCompanion);
    coreMocks.updateCompanion.mockResolvedValueOnce(changed);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValueOnce(changed);
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        selected_skill_ids: ["33333333-3333-4333-8333-333333333333"],
      }),
    });

    expect(response.status).toBe(200);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      restartPi: true,
      allowBoxWake: false,
    }));
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        skillsAppliedRevision: 5,
        skillsLastError: null,
      }),
    }));
  });

  it("restages a pending skill revision on start and refuses to record a warm shortcut as applied", async () => {
    const pending = {
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, skills_revision: 6, skills_applied_revision: 4 },
    };
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(pending);
    // A warm answer reports it staged nothing; the row must stay pending and keep its error trace.
    const runtime = boxRuntime({
      start: vi.fn(async () => ({
        boxId: companion.runtime.box_id,
        runtimeState: "running" as const,
        daemonState: "running" as const,
        desktopAvailable: true,
        staged: false,
      })),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_surface: "web" }),
    });

    expect(response.status).toBe(200);
    // Pending forces the restage this start's settings copy promises.
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ restartPi: true }));
    for (const call of coreMocks.updateCompanionRuntime.mock.calls) {
      expect(call[0].patch).not.toHaveProperty("skillsAppliedRevision");
      expect(call[0].patch).not.toHaveProperty("skillsLastError");
    }
  });

  it("never records applied skills for a native-mobile start that stages none", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Summarize the incident",
        client_surface: "native_mobile",
      }),
    });

    expect(response.status).toBe(200);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ skills: [] }));
    for (const call of coreMocks.updateCompanionRuntime.mock.calls) {
      expect(call[0].patch).not.toHaveProperty("skillsAppliedRevision");
    }
  });

  it("does not contact or recycle Pi for a name-only save on a running Companion", async () => {
    coreMocks.getCompanion.mockResolvedValueOnce(runningCompanion);
    coreMocks.updateCompanion.mockResolvedValueOnce({
      ...runningCompanion,
      name: "Research desk",
    });
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Research desk" }),
    });

    expect(response.status).toBe(200);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
  });

  it("retries an unapplied provider save without requiring another provider change", async () => {
    const unapplied = {
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: "error" as const,
        daemon_state: "error" as const,
        provider_ids: ["openai-codex"],
        provider_credential_generation: null,
      },
    };
    coreMocks.getCompanion.mockResolvedValueOnce(unapplied);
    coreMocks.updateCompanion.mockResolvedValueOnce(unapplied);
    coreMocks.getCompanionProviderCredentialGeneration.mockResolvedValueOnce({
      providerId: "openai-codex",
      credentialGeneration: "44444444-4444-4444-8444-444444444444",
    });
    coreMocks.claimCompanionRuntimeStart.mockResolvedValueOnce(unapplied);
    coreMocks.resolveCompanionProviderAuth.mockResolvedValueOnce({
      providerId: "openai-codex",
      credentialGeneration: "44444444-4444-4444-8444-444444444444",
      authEntry: { type: "oauth", access: "secret-b" },
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider_id: "openai-codex" }),
    });

    expect(response.status).toBe(200);
    expect(runtime.status).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      replaceProviderAuth: true,
      modelId: "claude-opus-4-8",
      allowBoxWake: false,
    }));
  });

  it("refuses Viewer settings writes before any Box contact", async () => {
    coreMocks.updateCompanion.mockRejectedValueOnce(new CompanionSettingsForbiddenError());
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Forbidden" }),
    });

    expect(response.status).toBe(403);
    expect(runtimeFactory).not.toHaveBeenCalled();
  });

  it("locks deletion, archives the Companion Box, then removes the row", async () => {
    const stop = vi.fn(async () => ({
      boxId: companion.runtime.box_id,
      runtimeState: "stopped" as const,
      daemonState: "stopped" as const,
      desktopAvailable: false,
    }));
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () =>
      boxRuntime({ stop }));

    const response = await app.request(`/v1/companions/${companion.id}`, { method: "DELETE" });

    expect(response.status).toBe(204);
    expect(coreMocks.claimCompanionDeletion).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith({ boxId: "bx_23456789" });
    expect(coreMocks.deleteCompanion).toHaveBeenCalledOnce();
    expect(coreMocks.claimCompanionDeletion.mock.invocationCallOrder[0])
      .toBeLessThan(stop.mock.invocationCallOrder[0]!);
    expect(stop.mock.invocationCallOrder[0])
      .toBeLessThan(coreMocks.deleteCompanion.mock.invocationCallOrder[0]!);
  });

  it("refuses non-owner deletion before creating a Box client", async () => {
    coreMocks.claimCompanionDeletion.mockRejectedValueOnce(new CompanionDeleteForbiddenError());
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}`, { method: "DELETE" });

    expect(response.status).toBe(403);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.deleteCompanion).not.toHaveBeenCalled();
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
    ["POST", "/v1/companion-plugins/oauth/start", JSON.stringify({
      server_name: "app.linear/linear",
      label: "work",
    })],
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

  it("persists a message, wakes a sleeping Companion, and delivers it without a Wake click", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
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
    expect(coreMocks.sendCompanionMessage).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companion.id,
      content: "Summarize the incident",
    }));
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      boxId: companion.runtime.box_id,
      clientSurface: "web",
    }));
    expect(runtime.prompt).toHaveBeenCalledWith({
      boxId: companion.runtime.box_id,
      message: message.content,
      requestId: message.event_id,
    });
  });

  it("starts Pi before delivery when the Box is online but the daemon is stopped", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue({
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, daemon_state: "stopped" as const },
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
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
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.start.mock.invocationCallOrder[0]!)
      .toBeLessThan(runtime.prompt.mock.invocationCallOrder[0]!);
  });

  it("keeps native-mobile Skills and plugins empty during automatic wake", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Summarize the incident",
        client_surface: "native_mobile",
      }),
    });

    expect(response.status).toBe(200);
    expect(coreMocks.resolveCompanionPluginInjection).not.toHaveBeenCalled();
    expect(coreMocks.listCompanionRuntimeSkillPackages).not.toHaveBeenCalled();
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      clientSurface: "native_mobile",
      mcpCredentials: [],
      mcpAccounts: [],
      skills: [],
    }));
  });

  it("keeps the persisted message pending and records last_error when automatic wake fails", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime({
      start: vi.fn(async () => {
        throw new BoxRuntimeProviderError("Box resume failed", 502);
      }),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Summarize the incident",
        client_message_id: "33333333-3333-4333-8333-333333333333",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "pending" });
    expect(coreMocks.sendCompanionMessage).toHaveBeenCalledOnce();
    expect(coreMocks.recordCompanionPiProjection).not.toHaveBeenCalled();
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companion.id,
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: "Box resume failed",
      }),
    }));
  });

  it("records last_error when automatic wake fails before the runtime claim", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    coreMocks.resolveCompanionProviderAuth.mockRejectedValueOnce(
      new CompanionProviderError(
        "provider_not_configured",
        "The provider connection is unavailable.",
      ),
    );
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "pending" });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      companionId: companion.id,
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: "The provider connection is unavailable.",
      }),
    }));
  });

  /**
   * THE-340: a send claimed `provisioning` and then waited on a start that never came back, so the
   * Companion reported Starting for as long as nobody looked at its Box. The claim now has a deadline
   * and the failure it records is what releases it.
   */
  it("records last_error and leaves a retryable error when automatic wake outlives its budget", async () => {
    vi.useFakeTimers();
    try {
      coreMocks.listPendingCompanionMessages.mockResolvedValue({
        pending: [message],
        piLogOffset: 0,
        deliveredOrdinal: null,
      });
      let wake: AbortSignal | undefined;
      const runtime = boxRuntime({
        // The production signature: a start that neither resolves nor rejects.
        start: vi.fn((input: { signal?: AbortSignal }) => {
          wake = input.signal;
          return new Promise(() => undefined);
        }),
      });
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

      const pending = app.request(`/v1/companions/${companion.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Summarize the incident" }),
      });
      await vi.advanceTimersByTimeAsync(COMPANION_RUNTIME_START_BUDGET_MS);
      const response = await pending;

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ delivery: "pending" });
      expect(runtime.prompt).not.toHaveBeenCalled();
      expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
        companionId: companion.id,
        patch: expect.objectContaining({
          runtimeState: "error",
          daemonState: "error",
          lastError: expect.stringContaining("did not finish within 180s"),
        }),
      }));
      // The start is told the wake is over, so it stops working against a Box nobody is waiting on.
      expect(wake?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The reported stall left its Box untouched: idle, setup done, no error, not even a changed
   * timestamp. Reading the skill archives is the step that explains that, because it sits between the
   * claim and the first Box call, and the storage client is built with no request timeout of its own.
   */
  it("records last_error when reading a skill archive never answers, without contacting the Box", async () => {
    vi.useFakeTimers();
    try {
      coreMocks.listPendingCompanionMessages.mockResolvedValue({
        pending: [message],
        piLogOffset: 0,
        deliveredOrdinal: null,
      });
      coreMocks.listCompanionRuntimeSkillPackages.mockResolvedValue([{
        slug: "incident-summary",
        version: "1.2.3",
        checksum: `sha256:${"a".repeat(64)}`,
        storagePath: "org-1/incident-summary/1.2.3.tar.gz",
      }]);
      let read: AbortSignal | undefined;
      storageMocks.getSkillArchive.mockImplementation((input: { signal?: AbortSignal }) => {
        read = input.signal;
        return new Promise(() => undefined);
      });
      const runtime = boxRuntime();
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

      const pending = app.request(`/v1/companions/${companion.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Summarize the incident" }),
      });
      await vi.advanceTimersByTimeAsync(COMPANION_RUNTIME_START_BUDGET_MS);
      const response = await pending;

      expect(response.status).toBe(200);
      expect(runtime.start).not.toHaveBeenCalled();
      expect(read?.aborted).toBe(true);
      expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
        companionId: companion.id,
        patch: expect.objectContaining({
          runtimeState: "error",
          daemonState: "error",
          lastError: expect.stringContaining("did not finish within 180s"),
        }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The deadline does not wait for the call it interrupts, so a Box assignment already in flight can
   * still commit `provisioning` after the failure was recorded. The Companion would be reading as
   * Starting again, with the reason it failed erased and its claim renewed for another stale window.
   */
  it("keeps the wake failure the last state written when the deadline lands mid-assignment", async () => {
    vi.useFakeTimers();
    try {
      coreMocks.listPendingCompanionMessages.mockResolvedValue({
        pending: [message],
        piLogOffset: 0,
        deliveredOrdinal: null,
      });
      let releaseAssignment: (() => void) | undefined;
      const assignmentReached = new Promise<void>((resolve) => { releaseAssignment = resolve; });
      const committed: (string | undefined)[] = [];
      coreMocks.updateCompanionRuntime.mockImplementation(
        async (input: { patch: { runtimeState?: string } }) => {
          // Hold the assignment write open so the budget expires while it is still in flight.
          if (input.patch.runtimeState === "provisioning") await assignmentReached;
          committed.push(input.patch.runtimeState);
          return companion;
        },
      );
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => boxRuntime({
        start: vi.fn(async (input: { onBoxAssigned: (boxId: string) => Promise<void> }) => {
          await input.onBoxAssigned("bx_abcdefgh");
          return new Promise(() => undefined);
        }),
      }));

      const pending = app.request(`/v1/companions/${companion.id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "Summarize the incident" }),
      });
      await vi.advanceTimersByTimeAsync(COMPANION_RUNTIME_START_BUDGET_MS);
      releaseAssignment?.();
      const response = await pending;

      expect(response.status).toBe(200);
      expect(committed).toEqual(["provisioning", "error"]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The same deadline, reached before the adapter offers the Box. Refusing the assignment is what
   * tells the adapter no row points at that Box, which is how it knows to put it back to sleep.
   */
  it("refuses a Box assignment offered after the deadline", async () => {
    vi.useFakeTimers();
    try {
      let assign: ((boxId: string | null) => Promise<void>) | undefined;
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => boxRuntime({
        start: vi.fn((input: { onBoxAssigned: (boxId: string | null) => Promise<void> }) => {
          assign = input.onBoxAssigned;
          return new Promise(() => undefined);
        }),
      }));

      const pending = app.request(`/v1/companions/${companion.id}/runtime/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await vi.advanceTimersByTimeAsync(COMPANION_RUNTIME_START_BUDGET_MS);
      const response = await pending;

      expect(response.status).toBe(504);
      await expect(assign?.("bx_abcdefgh")).rejects.toThrow(/did not finish within 180s/);
      // The recorded failure survives the assignment the abandoned start still tried to make.
      expect(coreMocks.updateCompanionRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
        patch: expect.objectContaining({ runtimeState: "error", daemonState: "error" }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers an explicit wake that outlived its budget with a retryable failure", async () => {
    vi.useFakeTimers();
    try {
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => boxRuntime({
        start: vi.fn(() => new Promise(() => undefined)),
      }));

      const pending = app.request(`/v1/companions/${companion.id}/runtime/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      await vi.advanceTimersByTimeAsync(COMPANION_RUNTIME_START_BUDGET_MS);
      const response = await pending;

      expect(response.status).toBe(504);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("Try again."),
      });
      expect(coreMocks.updateCompanionRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
        patch: expect.objectContaining({ runtimeState: "error", daemonState: "error" }),
      }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("records an error when a wake returns something other than a running Pi", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime({
      // A start that finished without a running daemon is a failed wake with an observation attached.
      // Storing this observation verbatim is what made a Companion read as Starting forever.
      start: vi.fn(async () => ({
        boxId: companion.runtime.box_id,
        runtimeState: "provisioning" as const,
        daemonState: "starting" as const,
        desktopAvailable: true,
      })),
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
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledOnce();
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: expect.stringContaining("as provisioning with Pi starting instead of running"),
      }),
    }));
  });

  it("preserves another send's provisioning claim during concurrent automatic wake", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    coreMocks.claimCompanionRuntimeStart.mockRejectedValueOnce(
      new CompanionRuntimeTransitionError("companion is already provisioning"),
    );
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "pending" });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalled();
  });

  it("hands a message to a running Pi daemon and records the delivery watermark", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
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
    expect(runtime.prompt).toHaveBeenCalledWith({
      boxId: companion.runtime.box_id,
      message: message.content,
      requestId: message.event_id,
    });
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenCalledWith(expect.objectContaining({
      deliveredOrdinal: 0,
      entries: [],
    }));
    expect(runtime.refreshTtl).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(runtime.start).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
    expect(coreMocks.resolveCompanionProviderAuth).not.toHaveBeenCalled();
    expect(coreMocks.listCompanionRuntimeSkillPackages).not.toHaveBeenCalled();
  });

  it("starts runtime before sending when an online Companion has no applied provider generation", async () => {
    const stale = {
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, provider_credential_generation: null },
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(stale);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(stale);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Use the newly selected model" }),
    });

    expect(response.status).toBe(200);
    expect(runtime.status).not.toHaveBeenCalled();
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      replaceProviderAuth: true,
      modelId: "claude-opus-4-8",
    }));
    expect(runtime.start.mock.invocationCallOrder[0]!)
      .toBeLessThan(runtime.prompt.mock.invocationCallOrder[0]!);
  });

  it("wakes a provider-archived Box when the running projection is stale", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime({
      status: vi.fn(async () => ({
        boxId: companion.runtime.box_id,
        runtimeState: "stopped" as const,
        daemonState: "stopped" as const,
        desktopAvailable: false,
      })),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Wake from provider idle" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "delivered" });
    expect(runtime.status).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.prompt).toHaveBeenCalledOnce();
  });

  it("keeps a delivered send successful when the TTL refresh fails", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime({
      refreshTtl: vi.fn(async () => {
        throw new BoxRuntimeProviderError("Box TTL refresh failed", 502);
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
    await expect(response.json()).resolves.toMatchObject({ delivery: "delivered" });
    expect(coreMocks.recordCompanionPiProjection).toHaveBeenCalledWith(expect.objectContaining({
      deliveredOrdinal: message.ordinal,
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
      deliveredOrdinal: null,
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
      deliveredOrdinal: null,
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
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
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

  it("carries the sender's message id into persistence so one send is one turn", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => boxRuntime());

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Summarize the incident",
        client_message_id: "33333333-3333-4333-8333-333333333333",
      }),
    });

    expect(response.status).toBe(200);
    expect(coreMocks.sendCompanionMessage).toHaveBeenCalledWith(expect.objectContaining({
      clientMessageId: "33333333-3333-4333-8333-333333333333",
    }));
  });

  it("rejects a message id that is not one", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident", client_message_id: "msg:33" }),
    });

    expect(response.status).toBe(400);
    expect(coreMocks.sendCompanionMessage).not.toHaveBeenCalled();
  });

  it("answers a resent send with the turn it already stored and never prompts Pi twice", async () => {
    // The same send arriving again: the message is already in the transcript and already delivered, so
    // nothing is pending. Pi must not be handed the prompt a second time, or the turn is answered
    // twice over a message that was only ever sent once.
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: message,
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [],
      piLogOffset: 0,
      deliveredOrdinal: message.ordinal,
    });
    const runtime = boxRuntime({
      refreshTtl: vi.fn(async () => {
        throw new BoxRuntimeProviderError("Box is archived", 409);
      }),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Summarize the incident",
        client_message_id: "33333333-3333-4333-8333-333333333333",
      }),
    });

    expect(response.status).toBe(200);
    // Already delivered stays delivered: a replay must not report the turn as still waiting.
    await expect(response.json()).resolves.toMatchObject({ delivery: "delivered" });
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(runtime.refreshTtl).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(coreMocks.recordCompanionPiProjection).not.toHaveBeenCalled();
  });

  it("delivers a resent send whose first attempt never reached Pi", async () => {
    // The retry semantics the watermark already owns: a message that is durable but undelivered is
    // still pending, so resending it hands it to Pi once rather than storing it again.
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: message,
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: "Summarize the incident",
        client_message_id: "33333333-3333-4333-8333-333333333333",
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "delivered" });
    expect(runtime.prompt).toHaveBeenCalledTimes(1);
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
      deliveredOrdinal: null,
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
    expect(runtime.refreshTtl).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
  });

  it("restarts runtime before syncing an online thread with stale provider auth", async () => {
    const stale = {
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        provider_credential_generation: "33333333-3333-4333-8333-333333333333",
      },
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(stale);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(stale);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(runtime.status).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      replaceProviderAuth: true,
      modelId: "claude-opus-4-8",
      allowBoxWake: false,
    }));
    expect(runtime.start.mock.invocationCallOrder[0]!)
      .toBeLessThan(runtime.prompt.mock.invocationCallOrder[0]!);
  });

  it("retries stale provider recovery when a prior sync left the projection in error", async () => {
    const staleError = {
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: "error" as const,
        daemon_state: "error" as const,
        provider_credential_generation: null,
      },
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(staleError);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(staleError);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(runtime.status).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      replaceProviderAuth: true,
      modelId: "claude-opus-4-8",
      allowBoxWake: false,
    }));
    expect(runtime.prompt).toHaveBeenCalledOnce();
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

  /**
   * Product promise:
   * A tool run appears in the thread as a chip that spins and then stops, and a run that moved the
   * Box desktop carries one picture of it. Reading a thread still never wakes a Box, and a Box that
   * cannot be photographed still gets its transcript.
   *
   * Regression caught:
   * Tool results dropped on the floor so a chip spins forever; a frame taken for a run that did not
   * touch a screen, or for one photographed already; a failed capture failing the whole sync.
   *
   * Why this level:
   * The decision to photograph is the route's: it knows what the projection just closed, what the
   * Box observation said, and that the transcript is already durable either way.
   *
   * Failure proof:
   * Photographing every finished run, or letting a capture failure escape, fails a case below.
   */
  describe("tool runs in a synced thread", () => {
    const visualRun = (screenshot: string | null = null) => ({
      event_id: "pi:512:tool:0",
      ordinal: 1,
      role: "tool" as const,
      content: "screenshot",
      author_id: null,
      author_name: null,
      tool: {
        call_id: "call_1",
        kind: "computer" as const,
        name: "computer",
        title: "screenshot",
        status: "ok" as const,
        detail: null,
        screenshot,
      },
      created_at: companion.created_at,
    });

    const shellRun = {
      ...visualRun(),
      event_id: "pi:512:tool:1",
      content: "ls",
      tool: { ...visualRun().tool, call_id: "call_2", kind: "shell" as const, name: "bash", title: "ls" },
    };

    /** One call and its result, the two halves of a chip, in a single read of the log. */
    const chunk = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_1", name: "computer", arguments: { action: "screenshot" } }],
          stopReason: "toolUse",
        },
      },
      { type: "message_end", message: { role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "ok" }] } },
    ].map((event) => `${JSON.stringify(event)}\n`).join("");

    function syncing(runtime: ReturnType<typeof boxRuntime>) {
      coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
      coreMocks.listPendingCompanionMessages.mockResolvedValue({ pending: [], piLogOffset: 512 });
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);
      return app.request(`/v1/companions/${companion.id}/thread/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    }

    it("hands Pi's call and its result to the projection as a run and its completion", async () => {
      coreMocks.recordCompanionPiProjection.mockResolvedValue({
        ...viewerThread,
        access: "owner",
        read_only: false,
        can_send: true,
        entries: [visualRun()],
      });
      const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk, offset: 512 })) });

      const response = await syncing(runtime);

      expect(response.status).toBe(200);
      expect(coreMocks.recordCompanionPiProjection).toHaveBeenCalledWith(expect.objectContaining({
        entries: [expect.objectContaining({
          role: "tool",
          tool: expect.objectContaining({ kind: "computer", status: "running" }),
        })],
        toolCompletions: [expect.objectContaining({ callId: "call_1", status: "ok" })],
      }));
    });

    it("photographs the Box once for the visual run this sync finished", async () => {
      const frame = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
      coreMocks.recordCompanionPiProjection.mockResolvedValue({
        ...viewerThread,
        access: "owner",
        entries: [visualRun()],
      });
      coreMocks.attachCompanionToolRunScreenshot.mockResolvedValue({
        ...viewerThread,
        access: "owner",
        entries: [visualRun(frame)],
      });
      const runtime = boxRuntime({
        readEvents: vi.fn(async () => ({ chunk, offset: 512 })),
        captureDesktopFrame: vi.fn(async () => frame),
      });

      const response = await syncing(runtime);
      const body = await response.json() as { thread: { entries: Array<{ tool: { screenshot: string } }> } };

      expect(runtime.captureDesktopFrame).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
      expect(coreMocks.attachCompanionToolRunScreenshot).toHaveBeenCalledWith(expect.objectContaining({
        eventId: "pi:512:tool:0",
        screenshot: frame,
      }));
      // The reader gets the framed thread from the sync that took it, not on the next poll.
      expect(body.thread.entries[0]?.tool.screenshot).toBe(frame);
    });

    it("leaves a run that touched no screen without a picture", async () => {
      coreMocks.recordCompanionPiProjection.mockResolvedValue({
        ...viewerThread,
        access: "owner",
        entries: [shellRun],
      });
      const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk, offset: 512 })) });

      await syncing(runtime);

      expect(runtime.captureDesktopFrame).not.toHaveBeenCalled();
    });

    it("leaves a run that already has its picture alone", async () => {
      // The desktop only tells the truth about the run that just ended, so a second capture would
      // replace the screen as the run left it with whatever is on it now.
      coreMocks.recordCompanionPiProjection.mockResolvedValue({
        ...viewerThread,
        access: "owner",
        entries: [visualRun("data:image/jpeg;base64,/9j/4AAQSkZJRg==")],
      });
      const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk, offset: 512 })) });

      await syncing(runtime);

      expect(runtime.captureDesktopFrame).not.toHaveBeenCalled();
    });

    it("does not reach for a frame on a Box with no desktop", async () => {
      coreMocks.recordCompanionPiProjection.mockResolvedValue({
        ...viewerThread,
        access: "owner",
        entries: [visualRun()],
      });
      const runtime = boxRuntime({
        readEvents: vi.fn(async () => ({ chunk, offset: 512 })),
        status: vi.fn(async () => ({
          boxId: companion.runtime.box_id,
          runtimeState: "running" as const,
          daemonState: "running" as const,
          desktopAvailable: false,
        })),
      });

      await syncing(runtime);

      expect(runtime.captureDesktopFrame).not.toHaveBeenCalled();
    });

    it("keeps the projected transcript when the capture fails", async () => {
      coreMocks.recordCompanionPiProjection.mockResolvedValue({
        ...viewerThread,
        access: "owner",
        entries: [visualRun()],
      });
      const runtime = boxRuntime({
        readEvents: vi.fn(async () => ({ chunk, offset: 512 })),
        captureDesktopFrame: vi.fn(async () => {
          throw new Error("box command failed");
        }),
      });

      const response = await syncing(runtime);
      const body = await response.json() as { thread: { entries: unknown[] } };

      expect(response.status).toBe(200);
      expect(body.thread.entries).toHaveLength(1);
      expect(coreMocks.attachCompanionToolRunScreenshot).not.toHaveBeenCalled();
    });
  });

  /**
   * Product promise:
   * Shell / file / question pause behind an inline Allow / Deny / answer card. Allow unblocks Pi,
   * Deny / timeout never execute the action, and the decision stays on the transcript for Viewers.
   */
  describe("permission broker decisions", () => {
    const pendingDecision = {
      event_id: "decision:ui-1",
      ordinal: 2,
      role: "decision" as const,
      content: "ls -la",
      author_id: null,
      author_name: null,
      tool: null,
      decision: {
        request_id: "ui-1",
        kind: "shell" as const,
        name: "bash",
        title: "ls -la",
        detail: "ls -la",
        status: "pending" as const,
        answer: null,
        decided_by_id: null,
        decided_by_name: null,
        decided_at: null,
        expires_at: "2026-08-12T12:05:00.000Z",
      },
      created_at: companion.created_at,
    };

    it("allows a pending card and writes the FIFO response that unblocks Pi", async () => {
      coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
      coreMocks.decideCompanionDecision.mockResolvedValue({
        thread: {
          ...viewerThread,
          access: "owner",
          can_send: true,
          read_only: false,
          entries: [{
            ...pendingDecision,
            decision: {
              ...pendingDecision.decision,
              status: "allowed",
              decided_by_id: "user-1",
              decided_by_name: "Ada",
              decided_at: "2026-08-12T12:01:00.000Z",
            },
          }],
        },
        response: { type: "extension_ui_response", id: "ui-1", confirmed: true },
      });
      const runtime = boxRuntime();
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

      const response = await app.request(`/v1/companions/${companion.id}/decisions/ui-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "allow" }),
      });
      const body = await response.json() as { thread: { entries: Array<{ decision: { status: string } }> } };

      expect(response.status).toBe(200);
      expect(body.thread.entries[0]?.decision.status).toBe("allowed");
      expect(runtime.respondExtensionUi).toHaveBeenCalledWith({
        boxId: companion.runtime.box_id,
        response: { type: "extension_ui_response", id: "ui-1", confirmed: true },
      });
    });

    it("refuses Viewer allow/deny before any Box contact", async () => {
      coreMocks.getCompanionForRuntime.mockRejectedValue(
        new (await import("@companion/core")).CompanionRuntimeForbiddenError(),
      );
      const runtimeFactory = vi.fn(() => {
        throw new Error("Box client must not be created");
      });
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

      const response = await app.request(`/v1/companions/${companion.id}/decisions/ui-1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "deny" }),
      });

      expect(response.status).toBe(403);
      expect(runtimeFactory).not.toHaveBeenCalled();
      expect(coreMocks.decideCompanionDecision).not.toHaveBeenCalled();
    });

    it("expires pending cards on sync and sends cancel to Pi", async () => {
      coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
      coreMocks.listPendingCompanionMessages.mockResolvedValue({ pending: [], piLogOffset: 0 });
      coreMocks.recordCompanionPiProjection.mockResolvedValue({
        ...viewerThread,
        access: "owner",
        can_send: true,
        read_only: false,
        entries: [pendingDecision],
      });
      coreMocks.expireCompanionDecisions.mockResolvedValue({
        thread: {
          ...viewerThread,
          access: "owner",
          can_send: true,
          read_only: false,
          entries: [{
            ...pendingDecision,
            decision: { ...pendingDecision.decision, status: "expired", decided_at: companion.created_at },
          }],
        },
        responses: [{ type: "extension_ui_response", id: "ui-1", confirmed: false }],
      });
      const runtime = boxRuntime({
        readEvents: vi.fn(async () => ({ chunk: "", offset: 0 })),
      });
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

      const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const body = await response.json() as { thread: { entries: Array<{ decision: { status: string } }> } };

      expect(response.status).toBe(200);
      expect(body.thread.entries[0]?.decision.status).toBe("expired");
      expect(runtime.respondExtensionUi).toHaveBeenCalledWith({
        boxId: companion.runtime.box_id,
        response: { type: "extension_ui_response", id: "ui-1", confirmed: false },
      });
    });
  });

  it("syncs a sleeping thread from the control plane without contacting Box", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
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
    // The Computer panel's join is this same route, so a Viewer who reached for one — by any means —
    // is refused before a Box client exists to wake anything with.
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

  it("creates a Companion from a name, persona, connected provider, and catalog model", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request("/v1/companions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Luna",
        persona: "Content marketing assistant",
        provider_id: "anthropic",
        model_id: "claude-opus-4-8",
      }),
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ companion });
    expect(coreMocks.createCompanion).toHaveBeenCalledWith(expect.objectContaining({
      name: "Luna",
      persona: "Content marketing assistant",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
    }));
  });

  it.each([
    ["create", "/v1/companions", "POST", { name: "Luna", provider_id: "anthropic", model_id: "glm-4.7" }],
    [
      "update",
      `/v1/companions/${companion.id}`,
      "PATCH",
      { provider_id: "anthropic", model_id: "glm-4.7" },
    ],
  ])("returns the catalog service rejection for an unknown model on %s", async (
    name,
    path,
    method,
    body,
  ) => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const error = new CompanionProviderError(
      "provider_model_invalid",
      "The model glm-4.7 is not available for Claude.",
      "anthropic",
    );
    if (name === "create") coreMocks.createCompanion.mockRejectedValueOnce(error);
    else coreMocks.updateCompanion.mockRejectedValueOnce(error);
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    const response = await app.request(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(422);
    expect(name === "create" ? coreMocks.createCompanion : coreMocks.updateCompanion)
      .toHaveBeenCalledOnce();
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
      modelId: "claude-opus-4-8",
      mcpCredentials: [
        { env_key: "GITHUB_TOKEN_WORK", value: "secret-b" },
      ],
      mcpAccounts: [
        expect.objectContaining({ id: "github-work", label: "GitHub work", transport: "stdio" }),
      ],
      skills: [
        expect.objectContaining({ slug: "companion", version: "1.0.0" }),
      ],
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
        disk_layout_version: COMPANION_PI_DISK_LAYOUT_VERSION,
        provider_credential_generation: "22222222-2222-4222-8222-222222222222",
      },
      false,
      false,
    ],
    [
      "rewrites provider auth for a Companion that has no Box yet",
      {
        box_id: null,
        disk_layout_version: COMPANION_PI_DISK_LAYOUT_VERSION,
        provider_credential_generation: "22222222-2222-4222-8222-222222222222",
      },
      true,
      false,
    ],
    [
      "refreshes an older Pi layout without replacing current provider auth",
      {
        box_id: "bx_23456789",
        disk_layout_version: 1,
        provider_credential_generation: "22222222-2222-4222-8222-222222222222",
      },
      false,
      true,
    ],
    [
      "rewrites provider auth after the workspace connection was rotated",
      {
        box_id: "bx_23456789",
        disk_layout_version: COMPANION_PI_DISK_LAYOUT_VERSION,
        provider_credential_generation: "33333333-3333-4333-8333-333333333333",
      },
      true,
      false,
    ],
  ])("%s", async (_name, runtime, replaceProviderAuth, refreshRuntimeLayout) => {
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
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      replaceProviderAuth,
      refreshRuntimeLayout,
    }));
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

  it("rejects pasted subscription JSON and brokers Claude subscription login server-side", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 17).toString("base64"),
    });

    const pasted = await app.request("/v1/companion-providers/anthropic", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        auth_method: "subscription",
        credential: { type: "oauth", access: "pasted-secret" },
      }),
    });
    expect(pasted.status).toBe(400);
    expect(coreMocks.saveCompanionProvider).not.toHaveBeenCalled();

    const started = await app.request("/v1/companion-providers/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "anthropic" }),
    });
    expect(started.status).toBe(200);
    const startPayload = await started.json() as { authorization_url: string };
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
    expect(startPayload.authorization_url).toContain("https://claude.ai/");
    expect(cookie).not.toContain("provider-verifier");

    coreMocks.saveCompanionProvider.mockResolvedValueOnce({
      provider_id: "anthropic",
      auth_method: "subscription",
      connected_by: "user-1",
      created_at: companion.created_at,
      updated_at: companion.updated_at,
    });
    const completed = await app.request("/v1/companion-providers/oauth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ authorization_code: "one-time-code" }),
    });
    const completedBody = JSON.stringify(await completed.json());

    expect(completed.status).toBe(200);
    expect(coreMocks.completeAnthropicProviderOAuth).toHaveBeenCalledWith(expect.objectContaining({
      authorizationInput: "one-time-code",
      flow: expect.objectContaining({ verifier: "provider-verifier" }),
    }));
    expect(coreMocks.saveCompanionProvider).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "anthropic",
      authMethod: "subscription",
      credential: expect.objectContaining({ type: "oauth", access: "claude-access-secret" }),
    }));
    expect(completedBody).not.toContain("claude-access-secret");
    expect(completedBody).not.toContain("claude-refresh-secret");
  });

  it("keeps the Claude flow cookie after a recoverable completion error", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 29).toString("base64"),
    });
    const started = await app.request("/v1/companion-providers/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "anthropic" }),
    });
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
    coreMocks.completeAnthropicProviderOAuth.mockRejectedValueOnce(
      new CompanionProviderOAuthError("oauth_invalid", "Try the complete code."),
    );

    const failed = await app.request("/v1/companion-providers/oauth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ authorization_code: "incomplete-code" }),
    });

    expect(failed.status).toBe(400);
    expect(failed.headers.get("set-cookie")).toBeNull();
    coreMocks.saveCompanionProvider.mockResolvedValueOnce({
      provider_id: "anthropic",
      auth_method: "subscription",
      connected_by: "user-1",
      created_at: companion.created_at,
      updated_at: companion.updated_at,
    });
    const retried = await app.request("/v1/companion-providers/oauth/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie },
      body: JSON.stringify({ authorization_code: "complete-code#provider-state" }),
    });
    expect(retried.status).toBe(200);
  });

  it("connects Codex with a device code while keeping device and OAuth secrets off the browser", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 19).toString("base64"),
    });
    const started = await app.request("/v1/companion-providers/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "openai-codex" }),
    });
    const payload = await started.json() as { verification_url: string; user_code: string };
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;

    expect(payload).toMatchObject({
      verification_url: "https://auth.openai.com/codex/device",
      user_code: "ABCD-EFGH",
    });
    expect(cookie).not.toContain("device-auth-secret");

    coreMocks.saveCompanionProvider.mockResolvedValueOnce({
      provider_id: "openai-codex",
      auth_method: "subscription",
      connected_by: "user-1",
      created_at: companion.created_at,
      updated_at: companion.updated_at,
    });
    const polled = await app.request("/v1/companion-providers/oauth/poll", {
      method: "POST",
      headers: { cookie },
    });
    const responseText = JSON.stringify(await polled.json());

    expect(polled.status).toBe(200);
    expect(coreMocks.pollOpenAICodexProviderOAuth).toHaveBeenCalledWith(expect.objectContaining({
      flow: expect.objectContaining({ deviceAuthId: "device-auth-secret" }),
    }));
    expect(responseText).not.toContain("codex-access-secret");
    expect(responseText).not.toContain("codex-refresh-secret");
  });

  it("keeps Codex device authorization pending without clearing its cookie", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 31).toString("base64"),
    });
    const started = await app.request("/v1/companion-providers/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "openai-codex" }),
    });
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
    coreMocks.pollOpenAICodexProviderOAuth.mockResolvedValueOnce({ status: "pending" });

    const polled = await app.request("/v1/companion-providers/oauth/poll", {
      method: "POST",
      headers: { cookie },
    });

    expect(polled.status).toBe(202);
    await expect(polled.json()).resolves.toEqual({ status: "pending" });
    expect(polled.headers.get("set-cookie")).toBeNull();
  });

  it("keeps provider OAuth unavailable to workspace members without admin rights", async () => {
    coreMocks.listCompanionProviders.mockResolvedValueOnce({
      catalog: [],
      connections: [],
      default_provider_id: null,
      can_manage: false,
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 23).toString("base64"),
    });

    const response = await app.request("/v1/companion-providers/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "anthropic" }),
    });

    expect(response.status).toBe(403);
    expect(coreMocks.beginAnthropicProviderOAuth).not.toHaveBeenCalled();

    coreMocks.listCompanionProviders.mockResolvedValueOnce({
      catalog: [],
      connections: [],
      default_provider_id: null,
      can_manage: false,
    });
    const polled = await app.request("/v1/companion-providers/oauth/poll", {
      method: "POST",
      headers: { cookie: "companion_provider_oauth=owner-flow" },
    });
    expect(polled.status).toBe(403);
    expect(polled.headers.get("set-cookie")).toBeNull();
    expect(coreMocks.pollOpenAICodexProviderOAuth).not.toHaveBeenCalled();
  });

  it("rejects a provider OAuth cookie bound to another user", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 37).toString("base64"),
    });
    const started = await app.request("/v1/companion-providers/oauth/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider_id: "openai-codex" }),
    });
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
    contextMocks.actorFromContext.mockReturnValue({
      id: "user-2",
      email: "other@example.test",
      name: "Other",
    });

    const polled = await app.request("/v1/companion-providers/oauth/poll", {
      method: "POST",
      headers: { cookie },
    });

    expect(polled.status).toBe(400);
    expect(coreMocks.pollOpenAICodexProviderOAuth).not.toHaveBeenCalled();
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

  it("brokers a signed OAuth callback and stores the grant through the encrypted plugin path", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const masterKey = Buffer.alloc(32, 29).toString("base64");
    const web = "https://companion.example";
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: masterKey,
      COMPANION_WEB_URL: web,
    });

    const started = await app.request("/v1/companion-plugins/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server_name: "app.linear/linear", label: "work" }),
    });
    expect(started.status).toBe(200);
    const payload = await started.json() as { authorization_url: string };
    const state = new URL(payload.authorization_url).searchParams.get("state");
    const cookie = started.headers.get("set-cookie")?.split(";")[0];
    expect(state).toBeTruthy();
    expect(cookie).toMatch(/^companion_mcp_oauth_[a-f0-9]+=.+/);
    expect(cookie).not.toContain("pkce-verifier");

    const callback = await app.request(
      `/v1/companion-plugins/oauth/callback?code=provider-code&state=${encodeURIComponent(state!)}`,
      { headers: { cookie: cookie! } },
    );
    expect(callback.status).toBe(303);
    expect(callback.headers.get("location"))
      .toBe("https://companion.example/companions?view=plugins&oauth=connected");
    expect(coreMocks.completeCompanionPluginOAuth).toHaveBeenCalledWith(expect.objectContaining({
      code: "provider-code",
      redirectUri: "https://companion.example/v1/companion-plugins/oauth/callback",
      flow: expect.objectContaining({ codeVerifier: "pkce-verifier" }),
    }));
    expect(coreMocks.saveCompanionOAuthPlugin).toHaveBeenCalledWith(expect.objectContaining({
      provider: "linear",
      label: "work",
      remoteUrl: "https://mcp.linear.app/mcp",
      credential: expect.objectContaining({ accessToken: "provider-access-token" }),
    }));
    expect(callback.headers.get("set-cookie")).not.toContain("provider-access-token");
  });

  it("rejects a duplicate OAuth label before discovery or registration", async () => {
    coreMocks.listCompanionPlugins.mockResolvedValueOnce([{
      id: "44444444-4444-4444-8444-444444444444",
      provider: "linear",
      label: "Work",
      transport: "http",
      endpoint: "https://mcp.linear.app/mcp",
      connected: true,
      created_at: companion.created_at,
      updated_at: companion.updated_at,
    }]);
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 29).toString("base64"),
    });

    const response = await app.request("/v1/companion-plugins/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server_name: "app.linear/linear", label: "work" }),
    });

    expect(response.status).toBe(409);
    expect(coreMocks.beginCompanionPluginOAuth).not.toHaveBeenCalled();
  });

  it("clears the pending OAuth cookie when the provider denies authorization", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 29).toString("base64"),
      COMPANION_WEB_URL: "https://companion.example",
    });
    const started = await app.request("/v1/companion-plugins/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server_name: "app.linear/linear", label: "work" }),
    });
    const payload = await started.json() as { authorization_url: string };
    const state = new URL(payload.authorization_url).searchParams.get("state")!;
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
    const cookieName = cookie.split("=")[0]!;

    const denied = await app.request(
      `/v1/companion-plugins/oauth/callback?error=access_denied&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );

    expect(denied.status).toBe(303);
    expect(denied.headers.get("location"))
      .toBe("https://companion.example/companions?view=plugins&oauth_error=authorization_failed");
    expect(denied.headers.get("set-cookie")).toContain(`${cookieName}=`);
    expect(denied.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(coreMocks.completeCompanionPluginOAuth).not.toHaveBeenCalled();
    expect(coreMocks.saveCompanionOAuthPlugin).not.toHaveBeenCalled();
  });

  it("rejects an OAuth callback completed under another user session", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, {
      COMPANION_COMPANIONS_ENABLED: "true",
      COMPANION_SECRETS_MASTER_KEY: Buffer.alloc(32, 29).toString("base64"),
      COMPANION_WEB_URL: "https://companion.example",
    });
    const started = await app.request("/v1/companion-plugins/oauth/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ server_name: "app.linear/linear", label: "work" }),
    });
    const payload = await started.json() as { authorization_url: string };
    const state = new URL(payload.authorization_url).searchParams.get("state")!;
    const cookie = started.headers.get("set-cookie")!.split(";")[0]!;
    contextMocks.actorFromContext.mockReturnValue({
      id: "user-2",
      email: "other@example.test",
      name: "Other user",
    });

    const mismatched = await app.request(
      `/v1/companion-plugins/oauth/callback?code=provider-code&state=${encodeURIComponent(state)}`,
      { headers: { cookie } },
    );

    expect(mismatched.status).toBe(303);
    expect(mismatched.headers.get("location")).toContain("oauth_error=authorization_failed");
    expect(mismatched.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(coreMocks.completeCompanionPluginOAuth).not.toHaveBeenCalled();
    expect(coreMocks.saveCompanionOAuthPlugin).not.toHaveBeenCalled();
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

  it("injects selected library skills plus the bundled Companion agent skill for mobile web but never for native mobile", async () => {
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
    expect(starts[0]?.skills).toEqual([
      {
        slug: "companion",
        version: "1.0.0",
        checksum: "sha256:companion-agent",
        archive: Buffer.from("companion-agent-skill"),
      },
      {
        slug: "incident-summary",
        version: "1.2.3",
        checksum: skillPackage.checksum,
        archive: Buffer.from("skill-archive"),
      },
    ]);
    expect(starts[0]?.hubEnv).toEqual(expect.objectContaining({
      COMPANION_WORKSPACE_ID: "org-1",
      COMPANION_DELEGATION_TOKEN: "cmp_pat_testtoken",
    }));
    expect(coreMocks.listCompanionRuntimeSkillPackages).toHaveBeenCalledWith(
      expect.objectContaining({ companionId: companion.id }),
    );

    const nativeMobile = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_surface: "native_mobile" }),
    });
    expect(nativeMobile.status).toBe(200);
    expect(starts[1]?.skills).toEqual([]);
    expect(starts[1]?.hubEnv).toEqual({});
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
      desktop: vi.fn(async () => ({
        url: "https://ascii.dev/desktop/bx_23456789",
        provisioning: false,
        transport: "vnc" as const,
      })),
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
      // The Computer panel is handed the stream this mint got rather than left to infer it.
      transport: "vnc",
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
      desktop: vi.fn(async () => ({ url: null, provisioning: true, transport: null })),
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
      transport: null,
    });
  });

  it("mints a Computer panel's desktop again on every join instead of repeating one", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    const minted = [
      "https://ascii.dev/desktop/bx_23456789?token=first",
      "https://ascii.dev/desktop/bx_23456789?token=second",
    ];
    const runtime = boxRuntime({
      desktop: vi.fn(async () => ({
        url: minted.shift() ?? null,
        provisioning: false,
        transport: "vnc" as const,
      })),
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const join = async () => {
      const response = await app.request(`/v1/companions/${companion.id}/runtime/desktop`, {
        method: "POST",
      });
      return await response.json() as { desktop_url: string | null };
    };
    const first = await join();
    const second = await join();

    // Box rotates the stream token on every state change, so the panel opening and the desktop tab
    // each get their own URL and the control plane keeps neither.
    expect(first.desktop_url).not.toBe(second.desktop_url);
    expect(runtime.desktop).toHaveBeenCalledTimes(2);
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionObservation).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
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

  it("does not register the removed MCP registry routes", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" });

    expect((await app.request("/v1/companion-registry/servers")).status).toBe(404);
    expect((await app.request(
      "/v1/companion-registry/server?name=app.linear%2Flinear",
    )).status).toBe(404);
  });
});
