import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = { id: "user-a", email: "a@example.test", name: "User A" };
const deviceActor = { actor, orgId: "org-1", deviceId: "device-1" };

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
    buildSkillSharePlan: noop,
    completeOnboarding: noop,
    createInvitation: noop,
    createLabel: noop,
    createOrg: noop,
    deleteLabel: noop,
    DependencyPublishError: class DependencyPublishError extends Error {},
    computeLocalSkillStatus: vi.fn(() => "installed"),
    getLocalSkillInstall: noop,
    getOnboardingContext: noop,
    getOnboardingState: vi.fn(async () => ({ onboarded: true })),
    getSkillBySlug: noop,
    getSkillById: noop,
    getSkillDependencies: noop,
    restoreSkill: noop,
    getSkillFilterPreferences: noop,
    getOrgSettings: noop,
    getSkillNamingPolicy: noop,
    getDownloadVersion: noop,
    getCommentImageAsset: noop,
    getOrgLogoAsset: noop,
    getSkillPublicPreviewByShareToken: noop,
    getSkillShareTargetByShareToken: noop,
    issueApiToken: noop,
    joinOrgByDomain: noop,
    listApiTokens: noop,
    listLabels: noop,
    listOrgs: vi.fn(async () => [{ org_id: "org-1", name: "Acme", slug: "acme", org_role: "developer" }]),
    listSkillComments: noop,
    listSkills: noop,
    listSkillVersions: noop,
    publishSkillVersion: noop,
    assertCanPublishSkillVersion: noop,
    prepareSkillPublishDependencies: noop,
    renameSkill: noop,
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
    getMyAvatarUrl: vi.fn(async () => null),
    shareSkill: noop,
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
    resolveDeviceToken: vi.fn(),
    registerDevice: vi.fn(),
    recordHeartbeat: vi.fn(),
    listDevices: vi.fn(),
    revokeDevice: vi.fn(),
  };
});

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => fn({ testDb: true })),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

vi.mock("@companion/auth", () => ({
  auth: {
    api: {
      getSession: authMocks.getSession,
    },
    handler: authMocks.handler,
    $Infer: {},
  },
}));

vi.mock("@companion/db", () => dbMocks);
vi.mock("@companion/core/services", () => serviceMocks);

import { app } from "./index";

function session() {
  authMocks.getSession.mockResolvedValue({
    user: actor,
    session: { id: "session-1" },
  });
}

function tokenFor(raw: string) {
  if (raw === "pat") return { actor, orgId: "org-1", scopes: ["skills:read", "skills:write"] };
  return null;
}

const heartbeat = {
  agent_version: "0.0.0",
  platform: "darwin",
  hostname: "stan-mac",
  tools: ["codex"],
  companion_skill_version: "1.18.0",
  inventory: { lockfileVersion: 2, skills: [] },
};

describe("agent device routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    serviceMocks.resolveDeviceToken.mockImplementation(async (token: string) => (token === "device" ? deviceActor : null));
    serviceMocks.registerDevice.mockResolvedValue({
      device_id: "device-1",
      device_token: "cmp_dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      org_id: "org-1",
      api_url: "http://api.test",
    });
    serviceMocks.recordHeartbeat.mockResolvedValue({
      ok: true,
      interval_seconds: 900,
      latest_agent_version: "0.0.0",
      agent_update_available: false,
      skills: {},
      rotate_token: null,
      commands: [],
    });
    serviceMocks.listDevices.mockResolvedValue([]);
  });

  it("registers a device with a cookie session only", async () => {
    session();

    const res = await app.request("/v1/agent/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "stan-mac", platform: "darwin", agent_version: "0.0.0" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ device_id: "device-1", org_id: "org-1" });
    expect(serviceMocks.registerDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        orgId: "org-1",
        device: { name: "stan-mac", platform: "darwin", agent_version: "0.0.0" },
      }),
    );
  });

  it("rejects PAT and anonymous registration", async () => {
    const pat = await app.request("/v1/agent/devices", {
      method: "POST",
      headers: { authorization: "Bearer pat" },
      body: "{}",
    });
    expect(pat.status).toBe(401);

    const anon = await app.request("/v1/agent/devices", { method: "POST", body: "{}" });
    expect(anon.status).toBe(401);
  });

  it("rejects malformed and oversized registration payloads before minting a token", async () => {
    session();

    const malformed = await app.request("/v1/agent/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(422);

    const oversized = await app.request("/v1/agent/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "x".repeat(10_000), platform: "darwin" }),
    });
    expect(oversized.status).toBe(413);

    expect(serviceMocks.registerDevice).not.toHaveBeenCalled();
  });

  it("accepts heartbeat with a device token only", async () => {
    const res = await app.request("/v1/agent/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer device", "content-type": "application/json" },
      body: JSON.stringify(heartbeat),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, interval_seconds: 900 });
    expect(serviceMocks.recordHeartbeat).toHaveBeenCalledWith(
      expect.objectContaining({
        device: deviceActor,
        heartbeat: expect.objectContaining({
          agent_version: heartbeat.agent_version,
          hostname: heartbeat.hostname,
          inventory: expect.objectContaining({ lockfileVersion: 2, skills: [] }),
        }),
      }),
    );
  });

  it("rejects heartbeat auth modes other than a live device token", async () => {
    session();
    const cookie = await app.request("/v1/agent/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(heartbeat),
    });
    expect(cookie.status).toBe(401);

    authMocks.getSession.mockResolvedValue(null);
    const pat = await app.request("/v1/agent/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer pat", "content-type": "application/json" },
      body: JSON.stringify(heartbeat),
    });
    expect(pat.status).toBe(401);

    const unknown = await app.request("/v1/agent/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer unknown", "content-type": "application/json" },
      body: JSON.stringify(heartbeat),
    });
    expect(unknown.status).toBe(401);
  });

  it("returns 422 for invalid heartbeat payloads and 413 for oversized payloads", async () => {
    const invalid = await app.request("/v1/agent/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer device", "content-type": "application/json" },
      body: JSON.stringify({ ...heartbeat, platform: "freebsd" }),
    });
    expect(invalid.status).toBe(422);

    const oversized = await app.request("/v1/agent/heartbeat", {
      method: "POST",
      headers: { authorization: "Bearer device", "content-type": "application/json" },
      body: JSON.stringify({ ...heartbeat, inventory: { lockfileVersion: 2, skills: [], pad: "x".repeat(300_000) } }),
    });
    expect(oversized.status).toBe(413);
  });

  it("lists and revokes devices with a cookie session only", async () => {
    session();
    serviceMocks.listDevices.mockResolvedValue([{ id: "device-1", name: "stan-mac" }]);

    const list = await app.request("/v1/devices");
    expect(list.status).toBe(200);
    await expect(list.json()).resolves.toEqual([{ id: "device-1", name: "stan-mac" }]);
    expect(serviceMocks.listDevices).toHaveBeenCalledWith(expect.objectContaining({ actor, orgId: "org-1" }));

    const revoke = await app.request("/v1/devices/device-1", { method: "DELETE" });
    expect(revoke.status).toBe(200);
    expect(serviceMocks.revokeDevice).toHaveBeenCalledWith(
      expect.objectContaining({ actor, orgId: "org-1", deviceId: "device-1" }),
    );
  });

  it("rejects PATs on devices read/write routes", async () => {
    const list = await app.request("/v1/devices", { headers: { authorization: "Bearer pat" } });
    expect(list.status).toBe(401);

    const revoke = await app.request("/v1/devices/device-1", {
      method: "DELETE",
      headers: { authorization: "Bearer pat" },
    });
    expect(revoke.status).toBe(400);
  });
});
