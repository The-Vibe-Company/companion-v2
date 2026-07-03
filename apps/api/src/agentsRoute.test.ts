import { beforeEach, describe, expect, it, vi } from "vitest";

const serviceMocks = vi.hoisted(() => {
  const noop = vi.fn(async () => undefined);
  return {
    acceptInvitation: noop,
    addComment: noop,
    assertCommentTarget: noop,
    addOrgAccessDomain: noop,
    archiveSkill: noop,
    assignLabel: noop,
    buildDependencyPlan: noop,
    buildSkillSharePlan: vi.fn(),
    completeOnboarding: noop,
    createInvitation: noop,
    createLabel: noop,
    createOrg: noop,
    deleteLabel: noop,
    DependencyPublishError: class DependencyPublishError extends Error {},
    computeLocalSkillStatus: vi.fn(() => "installed"),
    getLocalSkillInstall: noop,
    getOnboardingContext: noop,
    getOnboardingState: noop,
    getSkillBySlug: noop,
    getSkillById: noop,
    getSkillDependencies: noop,
    restoreSkill: noop,
    getSkillFilterPreferences: noop,
    getOrgSettings: noop,
    getSkillNamingPolicy: vi.fn(),
    getDownloadVersion: noop,
    getCommentImageAsset: noop,
    getOrgLogoAsset: noop,
    getSkillPublicPreviewByShareToken: vi.fn(),
    getSkillShareTargetByShareToken: vi.fn(),
    issueApiToken: noop,
    joinOrgByDomain: noop,
    listApiTokens: noop,
    listLabels: noop,
    listOrgs: vi.fn(),
    listSkillComments: noop,
    listSkills: vi.fn(),
    listSkillVersions: noop,
    publishSkillVersion: noop,
    assertCanPublishSkillVersion: noop,
    prepareSkillPublishDependencies: vi.fn(),
    renameSkill: vi.fn(),
    renameLabel: noop,
    reportLocalSkillInstall: noop,
    removeOrgAccessDomain: noop,
    removeMember: noop,
    revokeApiToken: noop,
    revokeInvitation: noop,
    setCommentDeprecated: noop,
    setLabelColor: noop,
    setLabelIcon: noop,
    setMemberRole: noop,
    setSkillFilterPreferences: noop,
    setOrgLogoFromUpload: noop,
    orgLogoPublicPath: vi.fn(() => "/org-logo.png"),
    setUserAvatarFromUpload: noop,
    clearUserAvatar: noop,
    getUserAvatarAsset: noop,
    getMyAvatarUrl: noop,
    shareSkill: vi.fn(),
    toggleStar: noop,
    installSkill: noop,
    unassignLabel: noop,
    uninstallSkill: noop,
    updateOrg: noop,
    updateUserProfile: noop,
    listPersonalLabels: noop,
    createPersonalLabel: noop,
    assignPersonalLabel: noop,
    unassignPersonalLabel: noop,
    setPersonalLabelColor: noop,
    setPersonalLabelIcon: noop,
    renamePersonalLabel: noop,
    deletePersonalLabel: noop,
    ensureUserBootstrap: noop,
    resolveApiToken: vi.fn(),
    resolveDependencyReferences: vi.fn(),
    resolvedDependencySlugs: vi.fn(),
    resolvedDependencyIdMap: vi.fn(),
    // ---- Companion Agents ----
    AgentBusyError: class AgentBusyError extends Error {},
    AgentValidationError: class AgentValidationError extends Error {},
    createAgent: vi.fn(),
    destroyAgent: vi.fn(),
    getAgentBySlug: vi.fn(),
    getProvisionProgress: vi.fn(),
    listAffectedAgents: vi.fn(),
    listAgents: vi.fn(),
    markProvisionInterrupted: vi.fn(async () => undefined),
    parseSecretsKey: vi.fn(() => Buffer.alloc(32)),
    pauseAgent: vi.fn(),
    provisionAgent: vi.fn(async () => undefined),
    pushSkillUpdate: vi.fn(),
    retryProvision: vi.fn(),
    runSkillPush: vi.fn(async () => undefined),
    sandboxNameFor: vi.fn((org: string, slug: string, attempt: number) => `cmp-x-${slug}-a${attempt}`),
    setAgentSecrets: vi.fn(),
    wakeAgent: vi.fn(),
    connectedProviderIds: vi.fn(async () => new Set<string>()),
    listProviderConnections: vi.fn(async (): Promise<unknown[]> => []),
    setProviderConnection: vi.fn(),
    deleteProviderConnection: vi.fn(async () => undefined),
  };
});

const sandboxMocks = vi.hoisted(() => ({
  runtime: {
    provider: "vercel" as const,
    forkFromGolden: vi.fn(),
    pushSkills: vi.fn(),
    startServer: vi.fn(),
    healthCheck: vi.fn(),
    wake: vi.fn(),
    stop: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    replaceSkill: vi.fn(),
    restartServer: vi.fn(),
  },
  catalog: {
    listModels: vi.fn(async () => ({
      models: [{ id: "anthropic/claude-x", provider: "anthropic", env_keys: ["ANTHROPIC_API_KEY"] }],
      providers: [{ id: "anthropic", name: "Anthropic", env_keys: ["ANTHROPIC_API_KEY"], connected: false }],
    })),
    resolveModel: vi.fn(async () => ({ envKeys: ["ANTHROPIC_API_KEY"] })),
    clearCache: vi.fn(),
  },
}));

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => fn({})),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: { api: { getSession: authMocks.getSession }, handler: authMocks.handler, $Infer: {} },
}));
vi.mock("@companion/db", () => dbMocks);
vi.mock("@companion/core/services", () => serviceMocks);
vi.mock("@companion/sandbox", () => ({
  createVercelRuntime: vi.fn(() => sandboxMocks.runtime),
  vercelConfigFromEnv: vi.fn(() => ({ token: "t", teamId: "team", projectId: "proj" })),
  createModelCatalog: vi.fn(() => sandboxMocks.catalog),
}));

import { app } from "./index";

const actorA = { id: "user-a", email: "a@example.test", name: "User A" };

function signIn() {
  authMocks.getSession.mockResolvedValue({
    user: { id: "user-a", email: "a@example.test", name: "User A" },
    session: { id: "session-1" },
  });
  serviceMocks.listOrgs.mockResolvedValue([{ org_id: "org-1", name: "Acme", slug: "acme" }]);
}

const AGENT_DETAIL = {
  id: "agent-1",
  org_id: "org-1",
  slug: "monka-support",
  scope: "personal",
  creator_id: "user-a",
  client_label: "Monka",
  group_label: null,
  description: "Support agent",
  model: "anthropic/claude-x",
  region: "iad1",
  lifecycle: "provisioning",
  status: "provisioning",
  sandbox_name: "cmp-x-monka-support-a1",
  skills: [],
  outdated_count: 0,
  sessions_count: 0,
  pending_op: null,
  last_active_at: null,
  created_at: "2026-07-03T00:00:00.000Z",
  instructions: "Help.",
  sandbox_id: null,
  golden_snapshot_id: "snap-1",
  opencode_version: "1.17.13",
  last_resume_ms: null,
  provision: { attempt: 1, steps: [], error: null },
  secrets: [{ key: "ZENDESK_API_TOKEN", set: false, required_by: ["monka-triage"], required: true }],
  sessions: [],
};

describe("/v1/agents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signIn();
  });

  it("lists agents for a library with a cookie session", async () => {
    serviceMocks.listAgents.mockResolvedValue({ agents: [], summary: { total: 0 }, updates: [] });
    const res = await app.request("/v1/agents?lib=org", { headers: { "x-companion-org": "org-1" } });
    expect(res.status).toBe(200);
    expect(serviceMocks.listAgents).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", library: "org" }),
    );
  });

  it("rejects personal access tokens on every agent route (session-only surface)", async () => {
    authMocks.getSession.mockResolvedValue(null);
    serviceMocks.resolveApiToken.mockResolvedValue({
      actor: actorA,
      orgId: "org-1",
      scopes: ["skills:read", "skills:write"],
    });
    for (const [method, path] of [
      ["GET", "/v1/agents"],
      ["POST", "/v1/agents/monka-support/wake"],
      ["DELETE", "/v1/agents/monka-support"],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { Authorization: "Bearer cmp_pat_x", "content-type": "application/json" },
        ...(method === "DELETE" ? { body: JSON.stringify({ confirm: "monka-support" }) } : {}),
      });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
    expect(serviceMocks.listAgents).not.toHaveBeenCalled();
  });

  it("creates an agent and kicks the provisioning pipeline once", async () => {
    serviceMocks.createAgent.mockResolvedValue(AGENT_DETAIL);
    let resolveProvision: () => void = () => {};
    serviceMocks.provisionAgent.mockImplementation(
      () => new Promise<undefined>((resolve) => (resolveProvision = () => resolve(undefined))),
    );

    const res = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json", "x-companion-org": "org-1" },
      body: JSON.stringify({
        slug: "monka-support",
        scope: "personal",
        instructions: "Help.",
        model: "anthropic/claude-x",
        skills: [{ slug: "monka-triage" }],
        secrets: { ZENDESK_API_TOKEN: "zd-1" },
      }),
    });

    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({ slug: "monka-support" });
    expect(serviceMocks.provisionAgent).toHaveBeenCalledTimes(1);
    expect(serviceMocks.provisionAgent).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: "org-1", actorId: "user-a", agentId: "agent-1" }),
    );
    resolveProvision();
  });

  it("maps validation failures to 422 and busy to 409", async () => {
    serviceMocks.createAgent.mockRejectedValue(new serviceMocks.AgentValidationError("an agent named x already exists"));
    const dup = await app.request("/v1/agents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "x", model: "anthropic/claude-x", skills: [{ slug: "s" }] }),
    });
    expect(dup.status).toBe(422);

    serviceMocks.pushSkillUpdate.mockRejectedValue(new serviceMocks.AgentBusyError("another operation is in flight"));
    const busy = await app.request("/v1/agents/x/skills/s/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(busy.status).toBe(409);
  });

  it("404s unknown agents", async () => {
    serviceMocks.getAgentBySlug.mockResolvedValue(null);
    const res = await app.request("/v1/agents/ghost");
    expect(res.status).toBe(404);
  });

  it("never echoes secret values + relaunches serve when the agent is running", async () => {
    serviceMocks.setAgentSecrets.mockResolvedValue({
      secrets: [{ key: "ZENDESK_API_TOKEN", set: true, required_by: ["monka-triage"], required: true }],
      shouldRestart: true,
    });
    serviceMocks.wakeAgent.mockResolvedValue({ resumeMs: 100, status: "running" });
    const res = await app.request("/v1/agents/monka-support/secrets", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secrets: { ZENDESK_API_TOKEN: "super-secret-value" } }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("super-secret-value");
    expect(JSON.parse(text)).toEqual({
      secrets: [{ key: "ZENDESK_API_TOKEN", set: true, required_by: ["monka-triage"], required: true }],
      restarting: true,
    });
    // The changed env only takes effect once serve is relaunched (deduped wake job).
    expect(serviceMocks.wakeAgent).toHaveBeenCalledWith(expect.objectContaining({ slug: "monka-support" }));
  });

  it("destroy passes the typed confirmation through and tears the sandbox down after", async () => {
    serviceMocks.destroyAgent.mockResolvedValue({
      sandbox: { sandboxName: "cmp-x-monka-support-a1", sandboxId: null, region: "iad1", timeoutMs: 300000 },
    });
    const res = await app.request("/v1/agents/monka-support", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: "monka-support" }),
    });
    expect(res.status).toBe(200);
    expect(serviceMocks.destroyAgent).toHaveBeenCalledWith(expect.objectContaining({ confirm: "monka-support" }));
    expect(sandboxMocks.runtime.destroy).toHaveBeenCalledWith(expect.objectContaining({ sandboxName: "cmp-x-monka-support-a1" }));
  });

  it("provision polling flips an orphaned run to the interrupted error (crash recovery)", async () => {
    serviceMocks.getProvisionProgress
      .mockResolvedValueOnce({ lifecycle: "provisioning", status: "provisioning", attempt: 1, steps: [], error: null })
      .mockResolvedValueOnce({
        lifecycle: "error",
        status: "error",
        attempt: 1,
        steps: [],
        error: { message: "Error: provisioning was interrupted (control plane restarted)" },
      });
    const res = await app.request("/v1/agents/monka-support/provision");
    expect(res.status).toBe(200);
    expect(serviceMocks.markProvisionInterrupted).toHaveBeenCalledWith(expect.objectContaining({ slug: "monka-support" }));
    await expect(res.json()).resolves.toMatchObject({ lifecycle: "error" });
  });

  it("wake returns the measured resume latency", async () => {
    serviceMocks.wakeAgent.mockResolvedValue({ resumeMs: 2400, status: "running" });
    const res = await app.request("/v1/agents/monka-support/wake", { method: "POST" });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, resume_ms: 2400, status: "running" });
  });

  it("skill push returns 202 with the pending op and kicks the runner", async () => {
    serviceMocks.pushSkillUpdate.mockResolvedValue({
      agentId: "agent-1",
      op: { kind: "skill-push", skill_slug: "meeting-digest", from_version: "1.2.4", to_version: "1.3.0", phase: "pushing", error: null, started_at: "now" },
    });
    let resolvePush: () => void = () => {};
    serviceMocks.runSkillPush.mockImplementation(
      () => new Promise<undefined>((resolve) => (resolvePush = () => resolve(undefined))),
    );
    const res = await app.request("/v1/agents/monka-support/skills/meeting-digest/push", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(202);
    await expect(res.json()).resolves.toMatchObject({ pending_op: { phase: "pushing" } });
    expect(serviceMocks.runSkillPush).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agent-1", skillSlug: "meeting-digest", toVersion: "1.3.0" }),
    );
    resolvePush();
  });

  it("serves the model catalog with per-user provider connected state", async () => {
    serviceMocks.connectedProviderIds.mockResolvedValue(new Set(["anthropic"]));
    const res = await app.request("/v1/agents/models");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      providers: [{ id: "anthropic", name: "Anthropic", env_keys: ["ANTHROPIC_API_KEY"], connected: true }],
    });
  });

  it("saves and lists per-user provider connections (session-only, write-only)", async () => {
    serviceMocks.setProviderConnection.mockResolvedValue({
      provider: "anthropic",
      key_name: "ANTHROPIC_API_KEY",
      set: true,
      created_at: "2026-07-03T00:00:00.000Z",
    });
    const put = await app.request("/v1/provider-connections", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic", key_name: "ANTHROPIC_API_KEY", key: "sk-secret-value" }),
    });
    expect(put.status).toBe(200);
    const putText = await put.text();
    expect(putText).not.toContain("sk-secret-value");
    expect(serviceMocks.setProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "anthropic", keyName: "ANTHROPIC_API_KEY", key: "sk-secret-value" }),
    );

    serviceMocks.listProviderConnections.mockResolvedValue([
      { provider: "anthropic", key_name: "ANTHROPIC_API_KEY", set: true, created_at: "2026-07-03T00:00:00.000Z" },
    ]);
    const list = await app.request("/v1/provider-connections");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toMatchObject({ connections: [{ provider: "anthropic", set: true }] });
  });
});
