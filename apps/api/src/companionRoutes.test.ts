import {
  COMPANION_RUNTIME_START_BUDGET_MS,
  CompanionDeleteForbiddenError,
  CompanionPluginConflictError,
  CompanionProviderError,
  CompanionProviderOAuthError,
  CompanionRuntimeTransitionError,
  CompanionSettingsForbiddenError,
} from "@companion/core";
import type { Companion } from "@companion/contracts";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AuthenticationRequiredError, type ApiVariables } from "./context";
import {
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
  COMPANION_PI_DISK_LAYOUT_VERSION,
  COMPANION_RUNTIME_UNKNOWN_ERROR,
  deliverCompanionMessages,
} from "@companion/box-runtime";
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
  claimCompanionDelivery: vi.fn(),
  releaseCompanionDelivery: vi.fn(),
  renewCompanionDelivery: vi.fn(),
  recordCompanionTimeoutRestart: vi.fn(),
  recordCompanionPiProjectionWithEffects: vi.fn(),
  attachCompanionToolRunScreenshot: vi.fn(),
  decideCompanionDecision: vi.fn(),
  expireCompanionDecisions: vi.fn(),
  settleExpiredCompanionDecisions: vi.fn(),
  expireCompanionToolRuns: vi.fn(),
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

const dbMocks = vi.hoisted(() => ({
  withDatabaseAdvisoryLock: vi.fn(
    async (_input: unknown, fn: () => Promise<unknown>) => fn(),
  ),
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
  ...dbMocks,
  withTenantContext: vi.fn(
    async (
      _input: unknown,
      fn: (database: Record<string, never>) => Promise<unknown>,
    ) => fn({}),
  ),
}));

vi.mock("@companion/storage", () => storageMocks);
vi.mock("@companion/skills", () => skillsMocks);
vi.mock("@companion/box-runtime/companionSkillPackage", () => companionSkillPackageMocks);
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
    healPiDaemon: vi.fn(async () => ({ daemonState: "running" as const, detail: null })),
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
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    });
    coreMocks.claimCompanionDelivery.mockResolvedValue(true);
    coreMocks.releaseCompanionDelivery.mockResolvedValue(true);
    coreMocks.renewCompanionDelivery.mockResolvedValue(true);
    coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
      thread: {
        ...viewerThread,
        access: "owner",
        read_only: false,
        can_send: true,
      },
      settledToolRuns: [],
    });
    coreMocks.settleExpiredCompanionDecisions.mockResolvedValue([]);
    coreMocks.recordCompanionTimeoutRestart.mockResolvedValue(undefined);
    coreMocks.expireCompanionDecisions.mockImplementation(async () => {
      const last = coreMocks.recordCompanionPiProjectionWithEffects.mock.results.at(-1);
      const thread = last?.type === "return"
        ? (await last.value).thread
        : {
          ...viewerThread,
          access: "owner",
          read_only: false,
          can_send: true,
        };
      return { thread, responses: [] };
    });
    coreMocks.expireCompanionToolRuns.mockImplementation(async () => {
      const last = coreMocks.recordCompanionPiProjectionWithEffects.mock.results.at(-1);
      const thread = last?.type === "return"
        ? (await last.value).thread
        : {
          ...viewerThread,
          access: "owner",
          read_only: false,
          can_send: true,
        };
      return { thread, timedOut: [] };
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

  it("restarts only Pi inside an observably online Box", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const start = vi.fn(async () => ({
      boxId: "bx_23456789",
      runtimeState: "running" as const,
      daemonState: "running" as const,
      desktopAvailable: true,
    }));
    const stop = vi.fn();
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionObservation.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionRuntime.mockResolvedValue(runningCompanion);
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({ start, stop })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "pi" }),
    });

    expect(response.status).toBe(200);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      allowBoxWake: false,
      restartPi: true,
    }));
    expect(stop).not.toHaveBeenCalled();
  });

  it.each(["stopping", "stopped"] as const)(
    "does not turn a Pi-only archive race into an automatic full-Box wake when Box reports %s",
    async (archiveState) => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const waiting = {
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: archiveState,
        daemon_state: "stopped" as const,
      },
    };
    const start = vi.fn(async () => ({
      boxId: "bx_23456789",
      runtimeState: archiveState,
      daemonState: "stopped" as const,
      desktopAvailable: false,
    }));
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionObservation.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...waiting,
      runtime: {
        ...waiting.runtime,
        state: input.patch.runtimeState ?? waiting.runtime.state,
        daemon_state: input.patch.daemonState ?? waiting.runtime.daemon_state,
      },
    }));
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({ start })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "pi" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      companion: { runtime: { state: archiveState, daemon_state: "stopped" } },
    });
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ daemonState: "starting" }),
    }));

    coreMocks.getCompanionForRuntime.mockResolvedValue(waiting);
    const sync = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(sync.status).toBe(200);
    await expect(sync.json()).resolves.toMatchObject({ source: "control_plane" });
    expect(start).toHaveBeenCalledOnce();
    },
  );

  it("restarts the full Box by archiving it before resuming it", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const start = vi.fn(async () => ({
      boxId: "bx_23456789",
      runtimeState: "running" as const,
      daemonState: "running" as const,
      desktopAvailable: true,
    }));
    const stop = vi.fn(async () => ({
      boxId: "bx_23456789",
      runtimeState: "stopped" as const,
      daemonState: "stopped" as const,
      desktopAvailable: false,
    }));
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStop.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue({
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, state: "stopped", daemon_state: "stopped" },
    });
    coreMocks.updateCompanionObservation.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: input.patch.runtimeState ?? "running",
        daemon_state: input.patch.daemonState ?? "running",
      },
    }));
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({ start, stop })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box" }),
    });

    expect(response.status).toBe(200);
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(stop.mock.invocationCallOrder[0]).toBeLessThan(start.mock.invocationCallOrder[0]!);
  });

  it("keeps a full Box restart waiting without writing Error while archive is in flight", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const start = vi.fn();
    const stop = vi.fn(async () => ({
      boxId: "bx_23456789",
      runtimeState: "stopping" as const,
      daemonState: "stopped" as const,
      desktopAvailable: false,
    }));
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStop.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue({
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, state: "stopped", daemon_state: "stopped" },
    });
    coreMocks.updateCompanionObservation.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: input.patch.runtimeState ?? "running",
        daemon_state: input.patch.daemonState ?? "running",
        last_error: input.patch.lastError ?? null,
      },
    }));
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({ start, stop })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box" }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      companion: { runtime: { state: "stopping", daemon_state: "starting", last_error: null } },
    });
    expect(start).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ runtimeState: "error" }),
    }));
  });

  it("continues a waiting full Box restart once the archive is ready", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const waiting = {
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, state: "stopping" as const, daemon_state: "starting" as const },
    };
    const start = vi.fn(async () => ({
      boxId: "bx_23456789",
      runtimeState: "running" as const,
      daemonState: "running" as const,
      desktopAvailable: true,
    }));
    const stop = vi.fn();
    coreMocks.getCompanionForRuntime.mockResolvedValue(waiting);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue({
      ...waiting,
      runtime: { ...waiting.runtime, state: "stopped", daemon_state: "stopped" },
    });
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...waiting,
      runtime: {
        ...waiting.runtime,
        state: input.patch.runtimeState ?? waiting.runtime.state,
        daemon_state: input.patch.daemonState ?? waiting.runtime.daemon_state,
      },
    }));
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({
        start,
        stop,
        status: vi.fn(async () => ({
          boxId: "bx_23456789",
          runtimeState: "stopped" as const,
          daemonState: "stopped" as const,
          desktopAvailable: false,
        })),
      })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box", continuation: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      companion: { runtime: { state: "running", daemon_state: "running" } },
    });
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(coreMocks.claimCompanionRuntimeStart).toHaveBeenCalledWith(expect.objectContaining({
      allowArchiveResume: true,
    }));
  });

  it("lets a continuation reclaim a provisioning start instead of restarting the Box", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const claimed = {
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: "provisioning" as const,
        daemon_state: "starting" as const,
      },
    };
    const start = vi.fn(async () => ({
      boxId: "bx_23456789",
      runtimeState: "running" as const,
      daemonState: "running" as const,
      desktopAvailable: true,
    }));
    const stop = vi.fn();
    coreMocks.getCompanionForRuntime.mockResolvedValue(claimed);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(claimed);
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...claimed,
      runtime: {
        ...claimed.runtime,
        state: input.patch.runtimeState ?? claimed.runtime.state,
        daemon_state: input.patch.daemonState ?? claimed.runtime.daemon_state,
      },
    }));
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({
        start,
        stop,
        status: vi.fn(async () => ({
          boxId: "bx_23456789",
          runtimeState: "stopped" as const,
          daemonState: "stopped" as const,
          desktopAvailable: false,
        })),
      })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box", continuation: true }),
    });

    expect(response.status).toBe(200);
    expect(stop).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
    expect(coreMocks.claimCompanionRuntimeStart).toHaveBeenCalledWith(expect.objectContaining({
      allowArchiveResume: true,
    }));
  });

  it("lets a provisioning continuation replace a Box that disappeared with its owner", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const claimed = {
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: "provisioning" as const,
        daemon_state: "starting" as const,
      },
    };
    const start = vi.fn(async () => ({
      boxId: "bx_replacement",
      runtimeState: "running" as const,
      daemonState: "running" as const,
      desktopAvailable: true,
    }));
    const status = vi.fn(async () => {
      throw new BoxRuntimeProviderError("Box not found", 404);
    });
    coreMocks.getCompanionForRuntime.mockResolvedValue(claimed);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(claimed);
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...claimed,
      runtime: {
        ...claimed.runtime,
        box_id: input.patch.boxId ?? claimed.runtime.box_id,
        state: input.patch.runtimeState ?? claimed.runtime.state,
        daemon_state: input.patch.daemonState ?? claimed.runtime.daemon_state,
      },
    }));
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({ start, status })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box", continuation: true }),
    });

    expect(response.status).toBe(200);
    expect(status).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledOnce();
  });

  it("keeps a retried full Box restart waiting while the provider still reports archiving", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const waiting = {
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, state: "stopping" as const, daemon_state: "starting" as const },
    };
    const start = vi.fn();
    const stop = vi.fn();
    coreMocks.getCompanionForRuntime.mockResolvedValue(waiting);
    coreMocks.updateCompanionRuntime.mockResolvedValue(waiting);
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({
        start,
        stop,
        status: vi.fn(async () => ({
          boxId: "bx_23456789",
          runtimeState: "stopping" as const,
          daemonState: "stopped" as const,
          desktopAvailable: false,
        })),
      })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box", continuation: true }),
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      companion: { runtime: { state: "stopping", last_error: null } },
    });
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ runtimeState: "error" }),
    }));
  });

  it("treats a delayed continuation as complete after another request brought the Box online", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => boxRuntime());
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      runtimeFactory,
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box", continuation: true }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      companion: { runtime: { state: "running", daemon_state: "running" } },
    });
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStop).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
  });

  it("does not treat an explicit stop or deletion lock as a Box-restart continuation", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => boxRuntime());
    coreMocks.getCompanionForRuntime.mockResolvedValue({
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: "stopping",
        daemon_state: "stopped",
      },
    });
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      runtimeFactory,
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box", continuation: true }),
    });

    expect(response.status).toBe(409);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalled();
  });

  it("records a terminal provider state instead of leaving a restart labeled archiving", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const waiting = {
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: "stopping" as const,
        daemon_state: "starting" as const,
      },
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(waiting);
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...waiting,
      runtime: {
        ...waiting.runtime,
        state: input.patch.runtimeState ?? waiting.runtime.state,
        daemon_state: input.patch.daemonState ?? waiting.runtime.daemon_state,
        last_error: input.patch.lastError ?? null,
      },
    }));
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({
        status: vi.fn(async () => ({
          boxId: "bx_23456789",
          runtimeState: "error" as const,
          daemonState: "error" as const,
          desktopAvailable: false,
        })),
      })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box", continuation: true }),
    });

    expect(response.status).toBe(409);
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      expectedUpdatedAt: new Date(waiting.updated_at),
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: "companion Box cannot continue restart from error",
      }),
    }));
  });

  it("keeps the stop failure projected and never starts after a partial full-Box restart", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const start = vi.fn();
    const stop = vi.fn(async () => {
      throw new BoxRuntimeProviderError("Box archive failed", 502);
    });
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStop.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionObservation.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionRuntime.mockResolvedValue({
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, state: "error", daemon_state: "error" },
    });
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({ start, stop })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box" }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: "Box archive failed" });
    expect(start).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: "Box archive failed",
      }),
    }));
  });

  it("projects an error when full-Box archive succeeds but resume fails", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const start = vi.fn(async () => {
      throw new BoxRuntimeProviderError("Box resume failed", 502);
    });
    const stop = vi.fn(async () => ({
      boxId: "bx_23456789",
      runtimeState: "stopped" as const,
      daemonState: "stopped" as const,
      desktopAvailable: false,
    }));
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStop.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue({
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, state: "stopped", daemon_state: "stopped" },
    });
    coreMocks.updateCompanionObservation.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: input.patch.runtimeState ?? "running",
        daemon_state: input.patch.daemonState ?? "running",
      },
    }));
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({ start, stop })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box" }),
    });

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ error: "Box resume failed" });
    expect(stop).toHaveBeenCalledOnce();
    expect(start).toHaveBeenCalledOnce();
    expect(coreMocks.updateCompanionRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: "Box resume failed",
      }),
    }));
  });

  it("rejects an unknown restart target before creating a Box client", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "machine" }),
    });

    expect(response.status).toBe(400);
    expect(runtimeFactory).not.toHaveBeenCalled();
    // Authorization still runs before body validation so an unauthorized caller cannot probe this
    // operator-only contract, but no Box client or lifecycle claim is created for invalid input.
    expect(coreMocks.getCompanionForRuntime).toHaveBeenCalledOnce();
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStop).not.toHaveBeenCalled();
  });

  it("refuses to restart an asleep Companion without creating a Box client", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const runtimeFactory = vi.fn(() => {
      throw new Error("Box client must not be created");
    });
    coreMocks.getCompanionForRuntime.mockResolvedValue(companion);
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, runtimeFactory);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "pi" }),
    });

    expect(response.status).toBe(409);
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
  });

  it("corrects a stale Online projection and refuses to wake the stopped Box", async () => {
    const app = new Hono<{ Variables: ApiVariables }>();
    const start = vi.fn();
    const stop = vi.fn();
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.updateCompanionObservation.mockResolvedValue({
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, state: "stopped", daemon_state: "stopped" },
    });
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      vi.fn(() => boxRuntime({
        start,
        stop,
        status: vi.fn(async () => ({
          boxId: "bx_23456789",
          runtimeState: "stopped" as const,
          daemonState: "stopped" as const,
          desktopAvailable: false,
        })),
      })),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/restart`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "box" }),
    });

    expect(response.status).toBe(409);
    expect(coreMocks.updateCompanionObservation).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ runtimeState: "stopped", daemonState: "stopped" }),
    }));
    expect(start).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
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
    expect(coreMocks.expireCompanionToolRuns).toHaveBeenCalledOnce();
    // A read must also close permission cards past their deadline — a sleeping Box otherwise
    // leaves the card spinning on every control-plane read — while still never contacting Box.
    // Settlement-only: this path reads its own thread, so no thread is built to be discarded.
    expect(coreMocks.settleExpiredCompanionDecisions).toHaveBeenCalledOnce();
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).not.toHaveBeenCalled();
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

  it("keeps a wake pending without stamping Error while the Box is archiving", async () => {
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    const runtime = boxRuntime({
      start: vi.fn(async () => ({
        boxId: "bx_23456789",
        runtimeState: "stopping" as const,
        daemonState: "stopped" as const,
        desktopAvailable: false,
      })),
    });
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...companion,
      runtime: {
        ...companion.runtime,
        state: input.patch.runtimeState ?? companion.runtime.state,
        daemon_state: input.patch.daemonState ?? companion.runtime.daemon_state,
        last_error: input.patch.lastError ?? null,
      },
    }));
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
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "stopping",
        daemonState: "starting",
      }),
    }));
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ runtimeState: "error" }),
    }));
    expect(coreMocks.claimCompanionRuntimeStart).toHaveBeenCalledWith(expect.objectContaining({
      allowArchiveResume: true,
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

  it("lets the first-keystroke wake deliver a send that loses its provisioning claim", async () => {
    const emptyPending = {
      pending: [],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    };
    const savedPending = { ...emptyPending, pending: [message] };
    coreMocks.listPendingCompanionMessages
      // The prewarm begins before Send has persisted anything.
      .mockResolvedValueOnce(emptyPending)
      // Send persists, snapshots its durable tail, then loses the lifecycle claim.
      .mockResolvedValueOnce(savedPending)
      // The winning prewarm must take a new snapshot after it commits Online.
      .mockResolvedValueOnce(savedPending)
      // Delivery revalidates under the cross-replica advisory lock.
      .mockResolvedValueOnce(savedPending);
    coreMocks.claimCompanionRuntimeStart
      .mockResolvedValueOnce(companion)
      .mockRejectedValueOnce(
        new CompanionRuntimeTransitionError("companion runtime is already provisioning"),
      );
    let releaseStart: (() => void) | undefined;
    let startReached: (() => void) | undefined;
    const atStart = new Promise<void>((resolve) => { startReached = resolve; });
    const heldStart = new Promise<void>((resolve) => { releaseStart = resolve; });
    const runtime = boxRuntime({
      start: vi.fn(async () => {
        startReached?.();
        await heldStart;
        return {
          boxId: companion.runtime.box_id,
          runtimeState: "running" as const,
          daemonState: "running" as const,
          desktopAvailable: true,
        };
      }),
      stop: vi.fn(async () => ({
        boxId: companion.runtime.box_id,
        runtimeState: "stopped" as const,
        daemonState: "stopped" as const,
        desktopAvailable: false,
      })),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    // Step 1: the suite always owns a fresh fixture. Production uses the same create route and must
    // never borrow a historic timed-out or incident Companion.
    const created = await app.request("/v1/companions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "THE-371 local e2e",
        persona: "Exercise wake-on-send",
        provider_id: "anthropic",
        model_id: "claude-opus-4-8",
      }),
    });
    expect(created.status).toBe(201);

    const prewarm = app.request(`/v1/companions/${companion.id}/runtime/start?intent=message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_surface: "web" }),
    });
    await atStart;
    const sent = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message.content }),
    });

    expect(sent.status).toBe(200);
    await expect(sent.json()).resolves.toMatchObject({ delivery: "pending" });
    expect(runtime.prompt).not.toHaveBeenCalled();

    releaseStart?.();
    const woke = await prewarm;
    expect(woke.status).toBe(200);
    expect(runtime.prompt).toHaveBeenCalledOnce();
    expect(runtime.prompt).toHaveBeenCalledWith({
      boxId: companion.runtime.box_id,
      message: message.content,
      requestId: message.event_id,
    });
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({ deliveredOrdinal: message.ordinal }),
    );
    expect(runtime.refreshTtl).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).toHaveBeenCalledWith(expect.objectContaining({
      patch: expect.objectContaining({ runtimeState: "running", daemonState: "running" }),
    }));
    expect(coreMocks.updateCompanionRuntime.mock.calls.some(
      ([input]) => input.patch.runtimeState === "stopped",
    )).toBe(false);

    // Steps 2-3: project the answer plus a successful image read. The image tool is allowed to run
    // and settles by call id; it is not an open/timed-out chip and the assistant reply follows it.
    const imageReply = [
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{
            type: "toolCall",
            id: "call-image-read",
            name: "read",
            arguments: { path: "/tmp/conductor-cli.png" },
          }],
          stopReason: "toolUse",
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "call-image-read",
          content: [{ type: "text", text: "Read image file [image/png]" }],
        },
      }),
      JSON.stringify({
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The image is readable." }],
          stopReason: "stop",
        },
      }),
      JSON.stringify({ type: "agent_settled" }),
      "",
    ].join("\n");
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      ...emptyPending,
      piLogOffset: 0,
    });
    runtime.readEvents.mockResolvedValueOnce({ chunk: imageReply, offset: 0 });
    const firstReply = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(firstReply.status).toBe(200);
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({ role: "tool", tool: expect.objectContaining({
            name: "read",
            title: "/tmp/conductor-cli.png",
            status: "running",
          }) }),
          expect.objectContaining({ role: "assistant", content: "The image is readable." }),
        ]),
        toolCompletions: [expect.objectContaining({
          callId: "call-image-read",
          status: "ok",
        })],
      }),
    );

    // Step 4: sleep only through the public stop lifecycle. The test never archives, deletes, or
    // invokes Full Box restart as a substitute for a reliable warm wake.
    coreMocks.claimCompanionRuntimeStop.mockResolvedValue(runningCompanion);
    const slept = await app.request(`/v1/companions/${companion.id}/runtime/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(slept.status).toBe(200);
    expect(runtime.stop).toHaveBeenCalledWith({ boxId: companion.runtime.box_id });

    // Step 5: a second saved turn from Asleep owns a normal wake and reaches Pi without another
    // stop in the middle. A following sync projects the second assistant answer.
    const secondMessage = {
      ...message,
      event_id: "msg:44444444-4444-4444-8444-444444444444",
      ordinal: 1,
      content: "Wake and answer again",
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(companion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(companion);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: secondMessage,
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      ...emptyPending,
      pending: [secondMessage],
    });
    const stopCallsBeforeSecondWake = runtime.stop.mock.calls.length;
    const sentAgain = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: secondMessage.content }),
    });
    expect(sentAgain.status).toBe(200);
    await expect(sentAgain.json()).resolves.toMatchObject({ delivery: "delivered" });
    expect(runtime.prompt).toHaveBeenLastCalledWith({
      boxId: companion.runtime.box_id,
      message: secondMessage.content,
      requestId: secondMessage.event_id,
    });
    expect(runtime.stop).toHaveBeenCalledTimes(stopCallsBeforeSecondWake);

    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue(emptyPending);
    const secondReply = `${JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Awake and answering again." }],
        stopReason: "stop",
      },
    })}\n${JSON.stringify({ type: "agent_settled" })}\n`;
    runtime.readEvents.mockResolvedValueOnce({ chunk: secondReply, offset: imageReply.length });
    const repliedAgain = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(repliedAgain.status).toBe(200);
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        entries: [expect.objectContaining({
          role: "assistant",
          content: "Awake and answering again.",
        })],
      }),
    );
  });

  it("revalidates a stale overlapping send under the delivery lock instead of prompting twice", async () => {
    const emptyPending = {
      pending: [],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    };
    const stalePending = { ...emptyPending, pending: [message] };
    coreMocks.listPendingCompanionMessages
      // Prewarm before-start, post-Online handoff, and its locked delivery snapshot.
      .mockResolvedValueOnce(emptyPending)
      .mockResolvedValueOnce(stalePending)
      .mockResolvedValueOnce(stalePending)
      // An overlapping send captured the same stale tail, then waited for the delivery lock. Its
      // revalidation observes the first producer's committed watermark.
      .mockResolvedValueOnce(stalePending)
      .mockResolvedValueOnce(emptyPending);
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const prewarm = await app.request(
      `/v1/companions/${companion.id}/runtime/start?intent=message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_surface: "web" }),
      },
    );
    expect(prewarm.status).toBe(200);
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    const overlappingSend = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message.content }),
    });

    expect(overlappingSend.status).toBe(200);
    expect(runtime.prompt).toHaveBeenCalledOnce();
    expect(dbMocks.withDatabaseAdvisoryLock).toHaveBeenCalledTimes(2);
    expect(coreMocks.listPendingCompanionMessages).toHaveBeenCalledTimes(5);
  });

  it("makes a post-wake Pi refusal visible instead of leaving a saved turn silently pending", async () => {
    const emptyPending = {
      pending: [],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    };
    coreMocks.listPendingCompanionMessages
      .mockResolvedValueOnce(emptyPending)
      .mockResolvedValueOnce({ ...emptyPending, pending: [message] })
      .mockResolvedValueOnce({ ...emptyPending, pending: [message] });
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    const runtime = boxRuntime({
      prompt: vi.fn(async () => {
        throw new BoxRuntimeProviderError("Pi RPC input is not ready", 409);
      }),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start?intent=message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_surface: "web" }),
    });

    expect(response.status).toBe(409);
    expect(coreMocks.recordCompanionPiProjectionWithEffects).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: expect.stringContaining("Pi RPC input is not ready"),
      }),
    }));
  });

  it("records an accepted backlog prefix and still exposes refusal of the current wake turn", async () => {
    const backlog = { ...message, event_id: "msg:backlog", ordinal: 0, content: "Earlier" };
    const current = { ...message, event_id: "msg:current", ordinal: 1, content: "Current" };
    const emptyPending = {
      pending: [],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    };
    const pending = { ...emptyPending, pending: [backlog, current] };
    coreMocks.listPendingCompanionMessages
      .mockResolvedValueOnce(emptyPending)
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending);
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    const runtime = boxRuntime({
      prompt: vi.fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new BoxRuntimeProviderError("Pi refused the current turn", 409)),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(
      `/v1/companions/${companion.id}/runtime/start?intent=message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_surface: "web" }),
      },
    );

    expect(response.status).toBe(409);
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({ deliveredOrdinal: backlog.ordinal }),
    );
    expect(coreMocks.updateCompanionRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: expect.stringContaining("Pi refused the current turn"),
      }),
    }));
  });

  it("lets a successful retry clear an earlier prewarm refusal in delivery order", async () => {
    const pending = {
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    };
    coreMocks.listPendingCompanionMessages
      .mockResolvedValueOnce(pending)
      .mockResolvedValueOnce(pending);
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    const runtime = boxRuntime({
      prompt: vi.fn()
        .mockRejectedValueOnce(new BoxRuntimeProviderError("Pi input raced its wake", 409))
        .mockResolvedValueOnce(undefined),
    });
    const context = {
      actor: { id: "user-1", email: "user@example.test", name: "User" },
      orgId: "org-1",
      env: {},
      runtimeFactory: () => runtime,
    };

    await expect(deliverCompanionMessages(context, {
      companionId: companion.id,
      boxId: companion.runtime.box_id!,
      runtime,
      throwOnRefusal: true,
    })).rejects.toThrow("Pi input raced its wake");
    await deliverCompanionMessages(context, {
      companionId: companion.id,
      boxId: companion.runtime.box_id!,
      runtime,
    });

    expect(coreMocks.updateCompanionRuntime).toHaveBeenNthCalledWith(1, expect.objectContaining({
      patch: expect.objectContaining({ runtimeState: "error", daemonState: "error" }),
    }));
    expect(coreMocks.updateCompanionRuntime).toHaveBeenNthCalledWith(2, expect.objectContaining({
      patch: expect.objectContaining({ runtimeState: "running", daemonState: "running" }),
    }));
  });

  it("does not let delivery health overwrite a concurrent Stop claim", async () => {
    const pending = {
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    };
    const stopping = {
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: "stopping" as const,
        daemon_state: "stopped" as const,
      },
    };
    coreMocks.listPendingCompanionMessages.mockResolvedValue(pending);
    coreMocks.getCompanionForRuntime.mockResolvedValue(stopping);
    const runtime = boxRuntime();
    const context = {
      actor: { id: "user-1", email: "user@example.test", name: "User" },
      orgId: "org-1",
      env: {},
      runtimeFactory: () => runtime,
    };

    await deliverCompanionMessages(context, {
      companionId: companion.id,
      boxId: companion.runtime.box_id!,
      runtime,
    });

    expect(runtime.prompt).toHaveBeenCalledOnce();
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({ deliveredOrdinal: message.ordinal }),
    );
    expect(coreMocks.updateCompanionRuntime).not.toHaveBeenCalled();
  });

  it("recycles Pi when timeout settlement exposes a tail only after prewarm", async () => {
    const stranded = { ...message, event_id: "msg:late-timeout", ordinal: 1, content: "Continue" };
    const beforeTimeout = {
      pending: [],
      piLogOffset: 256,
      deliveredOrdinal: null,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    };
    const afterTimeout = {
      ...beforeTimeout,
      pending: [stranded],
      timeoutRecoveryPending: true,
      timeoutRestartPending: true,
      timeoutRecoveryOrdinal: 0,
    };
    coreMocks.listPendingCompanionMessages
      // The first snapshot still sees an open tool, then post-wake settlement exposes its tail.
      .mockResolvedValueOnce(beforeTimeout)
      .mockResolvedValueOnce(afterTimeout)
      // The second lifecycle claim revalidates the one-shot restart, then delivery re-reads it.
      .mockResolvedValueOnce(afterTimeout)
      .mockResolvedValueOnce(afterTimeout);
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(runningCompanion);
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start?intent=message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_surface: "web" }),
    });

    expect(response.status).toBe(200);
    expect(runtime.start).toHaveBeenCalledTimes(2);
    expect(runtime.start).toHaveBeenNthCalledWith(1, expect.objectContaining({ restartPi: false }));
    expect(runtime.start).toHaveBeenNthCalledWith(2, expect.objectContaining({ restartPi: true }));
    expect(coreMocks.recordCompanionTimeoutRestart).toHaveBeenCalledWith(expect.objectContaining({
      timeoutOrdinal: 0,
    }));
    expect(runtime.prompt.mock.invocationCallOrder[0]!)
      .toBeGreaterThan(runtime.start.mock.invocationCallOrder[1]!);
    expect(runtime.prompt).toHaveBeenCalledWith(expect.objectContaining({
      message: stranded.content,
      requestId: stranded.event_id,
    }));
  });

  it("keeps timeout recovery one-shot when a delivery-intent prewarm owns the wake", async () => {
    const stranded = { ...message, event_id: "msg:after-timeout", ordinal: 1, content: "Continue" };
    const timedOutState = {
      pending: [stranded],
      piLogOffset: 256,
      deliveredOrdinal: null,
      timeoutRecoveryPending: true,
      timeoutRestartPending: true,
      timeoutRecoveryOrdinal: 0,
    };
    coreMocks.listPendingCompanionMessages
      // Pre-start settlement, lifecycle revalidation, then the post-Online delivery snapshot.
      .mockResolvedValueOnce(timedOutState)
      .mockResolvedValueOnce(timedOutState)
      .mockResolvedValueOnce({ ...timedOutState, timeoutRestartPending: false })
      // The delivery lock owns one final pending/timeout revalidation.
      .mockResolvedValueOnce({ ...timedOutState, timeoutRestartPending: false });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start?intent=message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_surface: "web" }),
    });

    expect(response.status).toBe(200);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ restartPi: true }));
    expect(coreMocks.recordCompanionTimeoutRestart).toHaveBeenCalledWith(expect.objectContaining({
      timeoutOrdinal: 0,
    }));
    expect(runtime.prompt).toHaveBeenCalledWith(expect.objectContaining({
      message: stranded.content,
      requestId: stranded.event_id,
    }));
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({ deliveredOrdinal: 1, timeoutDeliveryOrdinal: 1 }),
    );
    expect(runtime.stop).not.toHaveBeenCalled();
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(expect.objectContaining({
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(expect.objectContaining({
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(expect.objectContaining({
      deliveredOrdinal: 1,
    }));
  });

  it("hands expired-card cancellations to a running Pi even when a replay has nothing to deliver", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: message,
    });
    // The send is an idempotent replay: everything is already delivered, nothing is pending.
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [],
      piLogOffset: 0,
      deliveredOrdinal: message.ordinal,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    });
    coreMocks.settleExpiredCompanionDecisions.mockResolvedValue([
      { type: "extension_ui_response", id: "ui-stale-replay", confirmed: false },
    ]);
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident" }),
    });

    expect(response.status).toBe(200);
    // Pi is still blocked on the stale question; the replay must not strand its cancellation
    // behind the next sync. No prompt goes out — there is nothing to deliver.
    expect(runtime.respondExtensionUi).toHaveBeenCalledWith({
      boxId: companion.runtime.box_id,
      response: { type: "extension_ui_response", id: "ui-stale-replay", confirmed: false },
    });
    expect(runtime.prompt).not.toHaveBeenCalled();
  });

  it("cancels an expired permission card in Pi before delivering the new send", async () => {
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
    coreMocks.settleExpiredCompanionDecisions.mockResolvedValue([
      { type: "extension_ui_response", id: "ui-stale", confirmed: false },
    ]);
    const order: string[] = [];
    const runtime = boxRuntime({
      respondExtensionUi: vi.fn(async () => {
        order.push("cancel");
      }),
      prompt: vi.fn(async () => {
        order.push("prompt");
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
    // The stale question blocks Pi on its FIFO answer; the cancel must land before the prompt so
    // the turn this send starts cannot deadlock behind it.
    expect(order).toEqual(["cancel", "prompt"]);
    expect(runtime.respondExtensionUi).toHaveBeenCalledWith({
      boxId: companion.runtime.box_id,
      response: { type: "extension_ui_response", id: "ui-stale", confirmed: false },
    });
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(expect.objectContaining({
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).not.toHaveBeenCalled();
    expect(runtime.healPiDaemon).toHaveBeenCalledOnce();
    expect(runtime.prompt).toHaveBeenCalledTimes(2);
  });

  it("leaves an overlapping delivery pending without probing or recycling Pi", async () => {
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: true,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: 0,
    });
    coreMocks.claimCompanionDelivery.mockResolvedValue(false);
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "ping THE-370" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "pending" });
    expect(runtime.healPiDaemon).not.toHaveBeenCalled();
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(coreMocks.releaseCompanionDelivery).not.toHaveBeenCalled();
  });

  it("heals a FIFO consume miss and records delivery only after Pi accepts the retry", async () => {
    const newest = { ...message, event_id: "msg:the-370", ordinal: 5, content: "ping THE-370" };
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: newest,
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [newest],
      piLogOffset: 0,
      deliveredOrdinal: 4,
      // Reproduce the post-#312 production row: timeout recycle was already marked complete, so
      // the send reaches the warm path and must heal based on failed RPC acceptance itself.
      timeoutRecoveryPending: true,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: 0,
    });
    const order: string[] = [];
    const prompt = vi.fn()
      .mockImplementationOnce(async () => {
        order.push("prompt-refused");
        throw new Error("FIFO write completed without a Pi response");
      })
      .mockImplementationOnce(async () => {
        order.push("prompt-accepted");
      });
    const runtime = boxRuntime({
      prompt,
      healPiDaemon: vi.fn(async (input: { requireIdle?: boolean }) => {
        order.push(input.requireIdle ? "heal-idle" : "heal");
        return { daemonState: "running" as const, detail: null };
      }),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "ping THE-370" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "delivered" });
    expect(order).toEqual(["heal-idle", "prompt-refused", "heal-idle", "prompt-accepted"]);
    expect(runtime.start).not.toHaveBeenCalled();
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveredOrdinal: newest.ordinal,
        acceptedDeliveryOrdinal: newest.ordinal,
        timeoutDeliveryOrdinal: newest.ordinal,
      }),
    );
  });

  it("projects Error when a send-owned wake cannot hand its saved turn to Pi", async () => {
    coreMocks.getCompanionForRuntime
      .mockResolvedValueOnce(companion)
      .mockResolvedValue(runningCompanion);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    });
    const runtime = boxRuntime({
      prompt: vi.fn(async () => {
        throw new BoxRuntimeProviderError("Pi refused the completed wake", 409);
      }),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Summarize the incident" }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining("Pi refused the completed wake"),
    });
    expect(coreMocks.updateCompanionRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: expect.stringContaining("Pi refused the completed wake"),
      }),
    }));
  });

  it("delivers the stranded tail and a new send after terminalizing the prior tool", async () => {
    const stranded = { ...message, event_id: "msg:alors", content: "Alors ?", ordinal: 1 };
    const newest = { ...message, event_id: "msg:ca-va", content: "Ca va ?", ordinal: 2 };
    const timedOut = {
      ...message,
      event_id: "pi:read:tool:0",
      ordinal: 0,
      role: "tool" as const,
      content: "/tmp/conductor-cli.png",
      author_id: null,
      author_name: null,
      tool: {
        call_id: "call-read",
        kind: "file" as const,
        name: "read",
        title: "/tmp/conductor-cli.png",
        status: "timeout" as const,
        detail: "Timed out after 90 seconds without a tool result.",
        screenshot: null,
      },
    };
    const timedOutThread = {
      ...viewerThread,
      access: "owner" as const,
      read_only: false,
      can_send: true,
      entries: [timedOut, stranded, newest],
      pending_count: 0,
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(runningCompanion);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: timedOutThread,
      entry: newest,
    });
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [stranded, newest],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: true,
      timeoutRestartPending: true,
      timeoutRecoveryOrdinal: 0,
    });
    coreMocks.expireCompanionToolRuns.mockResolvedValue({
      thread: timedOutThread,
      timedOut: [],
    });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "Ca va ?" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ delivery: "delivered" });
    expect(coreMocks.expireCompanionToolRuns.mock.invocationCallOrder[0])
      .toBeLessThan(coreMocks.listPendingCompanionMessages.mock.invocationCallOrder[0]!);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ restartPi: true }));
    expect(coreMocks.recordCompanionTimeoutRestart).toHaveBeenCalledWith(expect.objectContaining({
      timeoutOrdinal: 0,
    }));
    expect(runtime.start.mock.invocationCallOrder[0]!)
      .toBeLessThan(runtime.prompt.mock.invocationCallOrder[0]!);
    expect(runtime.stop).not.toHaveBeenCalled();
    expect(runtime.prompt).toHaveBeenNthCalledWith(1, expect.objectContaining({
      message: "Alors ?",
      requestId: "msg:alors",
    }));
    expect(runtime.prompt).toHaveBeenNthCalledWith(2, expect.objectContaining({
      message: "Ca va ?",
      requestId: "msg:ca-va",
    }));
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
      expect.objectContaining({ deliveredOrdinal: 2, timeoutDeliveryOrdinal: 2 }),
    );
  });

  it("revalidates a delayed timeout recovery after another request already recycled Pi", async () => {
    const pendingState = {
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: true,
      timeoutRestartPending: true,
      timeoutRecoveryOrdinal: 0,
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(runningCompanion);
    coreMocks.sendCompanionMessage.mockResolvedValue({
      thread: { ...viewerThread, access: "owner", read_only: false, can_send: true },
      entry: message,
    });
    coreMocks.listPendingCompanionMessages
      .mockResolvedValueOnce(pendingState)
      .mockResolvedValue({ ...pendingState, timeoutRestartPending: false });
    const runtime = boxRuntime();
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message.content }),
    });

    expect(response.status).toBe(200);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ restartPi: false }));
    expect(coreMocks.recordCompanionTimeoutRestart).not.toHaveBeenCalled();
    expect(runtime.prompt).toHaveBeenCalledWith(expect.objectContaining({
      requestId: message.event_id,
    }));
  });

  it("refreshes an already-running legacy Pi layout before delivering a message", async () => {
    const legacy = {
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, disk_layout_version: 9 },
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(legacy);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(legacy);
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
      body: JSON.stringify({ content: "Alors ?" }),
    });

    expect(response.status).toBe(200);
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      refreshRuntimeLayout: true,
      restartPi: true,
    }));
    expect(runtime.prompt).toHaveBeenCalledOnce();
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).not.toHaveBeenCalled();
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenNthCalledWith(1, expect.objectContaining({
      deliveredOrdinal: 0,
      entries: [],
    }));
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenNthCalledWith(2, expect.objectContaining({
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

  it("keeps sync on the control plane when Box starts archiving during provider refresh", async () => {
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
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...stale,
      runtime: {
        ...stale.runtime,
        state: input.patch.runtimeState ?? stale.runtime.state,
        daemon_state: input.patch.daemonState ?? stale.runtime.daemon_state,
      },
    }));
    const runtime = boxRuntime({
      start: vi.fn(async () => ({
        boxId: "bx_23456789",
        runtimeState: "stopping" as const,
        daemonState: "stopped" as const,
        desktopAvailable: false,
      })),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ source: "control_plane" });
    expect(runtime.prompt).not.toHaveBeenCalled();
    expect(runtime.readEvents).not.toHaveBeenCalled();
  });

  it("automatically resumes a waiting wake on thread sync and delivers its pending message", async () => {
    const waiting = {
      ...companion,
      runtime: {
        ...companion.runtime,
        state: "stopping" as const,
        daemon_state: "starting" as const,
      },
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(waiting);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(waiting);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...waiting,
      runtime: {
        ...waiting.runtime,
        state: input.patch.runtimeState ?? waiting.runtime.state,
        daemon_state: input.patch.daemonState ?? waiting.runtime.daemon_state,
      },
    }));
    const runtime = boxRuntime({
      start: vi.fn(async () => ({
        boxId: "bx_23456789",
        runtimeState: "running" as const,
        daemonState: "running" as const,
        desktopAvailable: true,
      })),
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
    expect(coreMocks.claimCompanionRuntimeStart).toHaveBeenCalledWith(expect.objectContaining({
      allowArchiveResume: true,
    }));
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.prompt).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      requestId: message.event_id,
    }));
    expect(runtime.readEvents).toHaveBeenCalledOnce();
  });

  it("projects Error when a recovery sync wake cannot hand its pending turn to Pi", async () => {
    const waiting = {
      ...companion,
      runtime: {
        ...companion.runtime,
        state: "stopping" as const,
        daemon_state: "starting" as const,
      },
    };
    coreMocks.getCompanionForRuntime
      .mockResolvedValueOnce(waiting)
      .mockResolvedValue(runningCompanion);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(waiting);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
      timeoutRecoveryPending: false,
      timeoutRestartPending: false,
      timeoutRecoveryOrdinal: null,
    });
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...runningCompanion,
      runtime: {
        ...runningCompanion.runtime,
        state: input.patch.runtimeState ?? runningCompanion.runtime.state,
        daemon_state: input.patch.daemonState ?? runningCompanion.runtime.daemon_state,
      },
    }));
    const runtime = boxRuntime({
      prompt: vi.fn(async () => {
        throw new BoxRuntimeProviderError("Pi refused the recovered wake", 409);
      }),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const response = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(409);
    expect(runtime.readEvents).not.toHaveBeenCalled();
    expect(coreMocks.updateCompanionRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      patch: expect.objectContaining({
        runtimeState: "error",
        daemonState: "error",
        lastError: expect.stringContaining("Pi refused the recovered wake"),
      }),
    }));
  });

  it("keeps syncing until an abandoned provisioning wake can be reclaimed", async () => {
    const provisioning = {
      ...companion,
      runtime: {
        ...companion.runtime,
        state: "provisioning" as const,
        daemon_state: "starting" as const,
      },
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(provisioning);
    coreMocks.claimCompanionRuntimeStart
      .mockRejectedValueOnce(new CompanionRuntimeTransitionError("companion runtime is already provisioning"))
      .mockResolvedValueOnce(provisioning);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...provisioning,
      runtime: {
        ...provisioning.runtime,
        state: input.patch.runtimeState ?? provisioning.runtime.state,
        daemon_state: input.patch.daemonState ?? provisioning.runtime.daemon_state,
      },
    }));
    const runtime = boxRuntime({
      start: vi.fn(async () => ({
        boxId: "bx_23456789",
        runtimeState: "running" as const,
        daemonState: "running" as const,
        desktopAvailable: true,
      })),
    });
    const app = new Hono<{ Variables: ApiVariables }>();
    registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);

    const first = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ source: "control_plane" });
    expect(runtime.start).not.toHaveBeenCalled();

    const second = await app.request(`/v1/companions/${companion.id}/thread/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ source: "box" });
    expect(runtime.start).toHaveBeenCalledOnce();
    expect(runtime.prompt).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      requestId: message.event_id,
    }));
  });

  it("does not turn an abandoned no-wake provisioning claim into a thread wake", async () => {
    const provisioning = {
      ...companion,
      runtime: {
        ...companion.runtime,
        state: "provisioning" as const,
        daemon_state: "starting" as const,
      },
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(provisioning);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [],
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
    await expect(response.json()).resolves.toMatchObject({ source: "control_plane" });
    expect(coreMocks.claimCompanionRuntimeStart).not.toHaveBeenCalled();
    expect(runtime.start).not.toHaveBeenCalled();
  });

  it("refreshes an already-running legacy Pi layout before syncing its thread", async () => {
    const legacy = {
      ...runningCompanion,
      runtime: { ...runningCompanion.runtime, disk_layout_version: 9 },
    };
    coreMocks.getCompanionForRuntime.mockResolvedValue(legacy);
    coreMocks.claimCompanionRuntimeStart.mockResolvedValue(legacy);
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [],
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
    expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({
      refreshRuntimeLayout: true,
      restartPi: true,
      allowBoxWake: false,
    }));
    expect(runtime.readEvents).toHaveBeenCalledOnce();
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenNthCalledWith(2, expect.objectContaining({
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(expect.objectContaining({
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
    expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(expect.objectContaining({
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

    function syncing(
      runtime: ReturnType<typeof boxRuntime>,
      pending: Array<typeof message> = [],
      timeoutRecoveryPending = false,
      projectedCompanion: Companion = runningCompanion,
    ) {
      coreMocks.getCompanionForRuntime.mockResolvedValue(projectedCompanion);
      coreMocks.listPendingCompanionMessages.mockResolvedValue({
        pending,
        piLogOffset: 512,
        deliveredOrdinal: null,
        timeoutRecoveryPending,
        timeoutRestartPending: timeoutRecoveryPending,
        timeoutRecoveryOrdinal: timeoutRecoveryPending ? 1 : null,
      });
      const app = new Hono<{ Variables: ApiVariables }>();
      registerCompanionRoutes(app, { COMPANION_COMPANIONS_ENABLED: "true" }, () => runtime);
      return app.request(`/v1/companions/${companion.id}/thread/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
    }

    it("hands Pi's call and its result to the projection as a run and its completion", async () => {
      coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
        thread: {
          ...viewerThread,
          access: "owner",
          read_only: false,
          can_send: true,
          entries: [visualRun()],
        },
        settledToolRuns: [],
      });
      const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk, offset: 512 })) });

      const response = await syncing(runtime);

      expect(response.status).toBe(200);
      expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(expect.objectContaining({
        entries: [expect.objectContaining({
          role: "tool",
          tool: expect.objectContaining({ kind: "computer", status: "running" }),
        })],
        toolCompletions: [expect.objectContaining({ callId: "call_1", status: "ok" })],
      }));
      // Raw log completion is not enough: only the database compare-and-set winner gets a frame.
      expect(runtime.captureDesktopFrame).not.toHaveBeenCalled();
    });

    it("photographs the Box once for the visual run this sync finished", async () => {
      const frame = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
      coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
        thread: { ...viewerThread, access: "owner", entries: [visualRun()] },
        settledToolRuns: [{ eventId: "pi:512:tool:0", kind: "computer" }],
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
      expect(runtime.captureDesktopFrame).toHaveBeenCalledOnce();
      expect(coreMocks.attachCompanionToolRunScreenshot).toHaveBeenCalledWith(expect.objectContaining({
        eventId: "pi:512:tool:0",
        screenshot: frame,
      }));
      // The reader gets the framed thread from the sync that took it, not on the next poll.
      expect(body.thread.entries[0]?.tool.screenshot).toBe(frame);
    });

    it("stores one frame on each exact visual run when one Pi chunk settles several", async () => {
      const frame = "data:image/jpeg;base64,/9j/4AAQSkZJRg==";
      const second = {
        ...visualRun(),
        event_id: "pi:512:tool:1",
        tool: { ...visualRun().tool, call_id: "call_2" },
      };
      coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
        thread: { ...viewerThread, access: "owner", entries: [visualRun(), second] },
        settledToolRuns: [
          { eventId: "pi:512:tool:0", kind: "computer" },
          { eventId: "pi:512:tool:1", kind: "computer" },
        ],
      });
      coreMocks.attachCompanionToolRunScreenshot.mockResolvedValue({
        ...viewerThread,
        access: "owner",
        entries: [visualRun(frame), { ...second, tool: { ...second.tool, screenshot: frame } }],
      });
      const runtime = boxRuntime({
        readEvents: vi.fn(async () => ({ chunk, offset: 512 })),
        captureDesktopFrame: vi.fn(async () => frame),
      });

      expect((await syncing(runtime)).status).toBe(200);

      expect(runtime.captureDesktopFrame).toHaveBeenCalledOnce();
      expect(coreMocks.attachCompanionToolRunScreenshot).toHaveBeenCalledTimes(2);
      expect(coreMocks.attachCompanionToolRunScreenshot.mock.calls.map(([input]) => input.eventId))
        .toEqual(["pi:512:tool:0", "pi:512:tool:1"]);
    });

    it("fails a hung read closed without changing Box lifecycle or sending an unscoped abort", async () => {
      const runningRead = {
        ...visualRun(),
        event_id: "pi:read:tool:0",
        content: "/tmp/conductor-cli.png",
        tool: {
          ...visualRun().tool,
          call_id: "call-read",
          kind: "file" as const,
          name: "read",
          title: "/tmp/conductor-cli.png",
          status: "running" as const,
        },
      };
      const timedOutRead = {
        ...runningRead,
        tool: {
          ...runningRead.tool,
          status: "timeout" as const,
          detail: "Timed out after 90 seconds without a tool result.",
        },
      };
      coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
        thread: { ...viewerThread, access: "owner", entries: [runningRead] },
        settledToolRuns: [],
      });
      coreMocks.expireCompanionToolRuns.mockResolvedValue({
        thread: { ...viewerThread, access: "owner", entries: [timedOutRead] },
        timedOut: [{ eventId: runningRead.event_id, kind: "file" }],
      });
      coreMocks.expireCompanionDecisions.mockResolvedValue({
        thread: { ...viewerThread, access: "owner", entries: [timedOutRead] },
        responses: [],
      });
      const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk: "", offset: 512 })) });

      const response = await syncing(runtime);
      const body = await response.json() as { thread: { entries: Array<typeof timedOutRead> } };

      expect(response.status).toBe(200);
      expect(body.thread.entries[0]?.tool.status).toBe("timeout");
      expect(runtime.start).not.toHaveBeenCalled();
      expect(runtime.stop).not.toHaveBeenCalled();
      expect(runtime.captureDesktopFrame).not.toHaveBeenCalled();
    });

    it("prompts a user tail re-queued by timeout settlement on the same live sync", async () => {
      const stranded = {
        ...message,
        event_id: "msg:ca-va",
        ordinal: 3,
        content: "Ca va ?",
      };
      coreMocks.expireCompanionToolRuns.mockResolvedValue({
        thread: {
          ...viewerThread,
          access: "owner",
          entries: [stranded],
          pending_count: 1,
        },
        timedOut: [{ eventId: "pi:read:tool:0", kind: "file" }],
      });
      const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk: "", offset: 512 })) });

      coreMocks.claimCompanionRuntimeStart.mockResolvedValue(runningCompanion);

      const response = await syncing(runtime, [stranded], true);

      expect(response.status).toBe(200);
      expect(coreMocks.expireCompanionToolRuns.mock.invocationCallOrder[0])
        .toBeLessThan(coreMocks.listPendingCompanionMessages.mock.invocationCallOrder[0]!);
      expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ restartPi: true }));
      expect(coreMocks.recordCompanionTimeoutRestart).toHaveBeenCalledWith(expect.objectContaining({
        timeoutOrdinal: 1,
      }));
      expect(runtime.start.mock.invocationCallOrder[0]!)
        .toBeLessThan(runtime.prompt.mock.invocationCallOrder[0]!);
      expect(runtime.prompt).toHaveBeenCalledWith(expect.objectContaining({
        message: "Ca va ?",
        requestId: "msg:ca-va",
      }));
      expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
        expect.objectContaining({ deliveredOrdinal: 3, timeoutDeliveryOrdinal: 3 }),
      );
    });

    it("preserves the timeout recycle while reclaiming a stale provisioning start", async () => {
      const stranded = {
        ...message,
        event_id: "msg:after-stale-start",
        ordinal: 3,
        content: "Still there?",
      };
      const staleStart = {
        ...runningCompanion,
        runtime: {
          ...runningCompanion.runtime,
          state: "provisioning" as const,
          daemon_state: "starting" as const,
        },
      };
      const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk: "", offset: 512 })) });
      coreMocks.claimCompanionRuntimeStart.mockResolvedValue(runningCompanion);

      const response = await syncing(runtime, [stranded], true, staleStart);

      expect(response.status).toBe(200);
      expect(runtime.start).toHaveBeenCalledWith(expect.objectContaining({ restartPi: true }));
      expect(coreMocks.recordCompanionTimeoutRestart).toHaveBeenCalledWith(expect.objectContaining({
        timeoutOrdinal: 1,
      }));
      expect(runtime.start.mock.invocationCallOrder[0]!)
        .toBeLessThan(runtime.prompt.mock.invocationCallOrder[0]!);
      expect(runtime.prompt).toHaveBeenCalledWith(expect.objectContaining({
        message: "Still there?",
        requestId: "msg:after-stale-start",
      }));
      expect(coreMocks.recordCompanionPiProjectionWithEffects).toHaveBeenCalledWith(
        expect.objectContaining({ deliveredOrdinal: 3, timeoutDeliveryOrdinal: 3 }),
      );
    });

    it("leaves a run that touched no screen without a picture", async () => {
      coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
        thread: { ...viewerThread, access: "owner", entries: [shellRun] },
        settledToolRuns: [{ eventId: shellRun.event_id, kind: "shell" }],
      });
      const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk, offset: 512 })) });

      await syncing(runtime);

      expect(runtime.captureDesktopFrame).not.toHaveBeenCalled();
    });

    it("leaves a run that already has its picture alone", async () => {
      // The desktop only tells the truth about the run that just ended, so a second capture would
      // replace the screen as the run left it with whatever is on it now.
      coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
        thread: {
          ...viewerThread,
          access: "owner",
          entries: [visualRun("data:image/jpeg;base64,/9j/4AAQSkZJRg==")],
        },
        settledToolRuns: [],
      });
      const runtime = boxRuntime({ readEvents: vi.fn(async () => ({ chunk, offset: 512 })) });

      await syncing(runtime);

      expect(runtime.captureDesktopFrame).not.toHaveBeenCalled();
    });

    it("does not reach for a frame on a Box with no desktop", async () => {
      coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
        thread: { ...viewerThread, access: "owner", entries: [visualRun()] },
        settledToolRuns: [{ eventId: "pi:512:tool:0", kind: "computer" }],
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
      coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
        thread: { ...viewerThread, access: "owner", entries: [visualRun()] },
        settledToolRuns: [{ eventId: "pi:512:tool:0", kind: "computer" }],
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
      coreMocks.recordCompanionPiProjectionWithEffects.mockResolvedValue({
        thread: {
          ...viewerThread,
          access: "owner",
          can_send: true,
          read_only: false,
          entries: [pendingDecision],
        },
        settledToolRuns: [],
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
    const timedOut = {
      event_id: "pi:sleeping-read",
      ordinal: 1,
      role: "tool" as const,
      content: "/tmp/conductor-cli.png",
      author_id: null,
      author_name: null,
      tool: {
        call_id: "call-sleeping-read",
        kind: "file" as const,
        name: "read",
        title: "/tmp/conductor-cli.png",
        status: "timeout" as const,
        detail: "Timed out after 90 seconds without a tool result.",
        screenshot: null,
      },
      created_at: companion.created_at,
    };
    coreMocks.listPendingCompanionMessages.mockResolvedValue({
      pending: [message],
      piLogOffset: 0,
      deliveredOrdinal: null,
    });
    coreMocks.expireCompanionToolRuns.mockResolvedValue({
      thread: { ...viewerThread, entries: [timedOut] },
      timedOut: [{ eventId: timedOut.event_id, kind: "file" }],
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
    await expect(response.json()).resolves.toMatchObject({
      source: "control_plane",
      thread: { entries: [{ tool: { status: "timeout" } }] },
    });
    expect(runtimeFactory).not.toHaveBeenCalled();
    expect(coreMocks.recordCompanionPiProjectionWithEffects).not.toHaveBeenCalled();
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
    ["restart", `/v1/companions/${companion.id}/runtime/restart`],
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
      restartPi: refreshRuntimeLayout,
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

  it("answers an explicit wake with 202 while archiving, then resumes it on retry", async () => {
    coreMocks.updateCompanionRuntime.mockImplementation(async (input) => ({
      ...companion,
      runtime: {
        ...companion.runtime,
        state: input.patch.runtimeState ?? companion.runtime.state,
        daemon_state: input.patch.daemonState ?? companion.runtime.daemon_state,
        last_error: input.patch.lastError ?? null,
      },
    }));
    const app = new Hono<{ Variables: ApiVariables }>();
    const start = vi.fn()
      .mockResolvedValueOnce({
        boxId: "bx_23456789",
        runtimeState: "stopping" as const,
        daemonState: "stopped" as const,
        desktopAvailable: false,
      })
      .mockResolvedValueOnce({
        boxId: "bx_23456789",
        runtimeState: "running" as const,
        daemonState: "running" as const,
        desktopAvailable: true,
      });
    registerCompanionRoutes(
      app,
      { COMPANION_COMPANIONS_ENABLED: "true" },
      () => boxRuntime({ start }),
    );

    const response = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      companion: { runtime: { state: "stopping", daemon_state: "starting", last_error: null } },
    });

    const retried = await app.request(`/v1/companions/${companion.id}/runtime/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      companion: { runtime: { state: "running", daemon_state: "running" } },
    });
    expect(coreMocks.claimCompanionRuntimeStart).toHaveBeenCalledTimes(2);
    expect(coreMocks.claimCompanionRuntimeStart).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ allowArchiveResume: true }),
    );
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
