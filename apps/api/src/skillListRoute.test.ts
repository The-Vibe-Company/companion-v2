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
    getSkillDependencies: noop,
    restoreSkill: noop,
    getSkillFilterPreferences: noop,
    getOrgSettings: noop,
    getDownloadVersion: noop,
    getCommentImageAsset: noop,
    getOrgLogoAsset: noop,
    issueApiToken: noop,
    joinOrgByDomain: noop,
    listApiTokens: noop,
    listLabels: noop,
    listOrgs: noop,
    listSkillComments: noop,
    listSkills: vi.fn(),
    listSkillVersions: noop,
    publishSkillVersion: noop,
    assertCanPublishSkillVersion: noop,
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
  };
});

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => fn({})),
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

vi.mock("@companion/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => null),
    },
    handler: vi.fn(),
    $Infer: {},
  },
}));

vi.mock("@companion/db", () => dbMocks);

vi.mock("@companion/core/services", () => serviceMocks);

import { app } from "./index";

const actorA = { id: "user-a", email: "a@example.test", name: "User A" };
const actorB = { id: "user-b", email: "b@example.test", name: "User B" };

function tokenFor(header: string | undefined) {
  if (header === "read-a") return { actor: actorA, orgId: "org-1", scopes: ["skills:read"] };
  if (header === "read-b") return { actor: actorB, orgId: "org-1", scopes: ["skills:read"] };
  if (header === "write-only") return { actor: actorA, orgId: "org-1", scopes: ["skills:write"] };
  return null;
}

describe("GET /v1/skills", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    serviceMocks.listSkills.mockResolvedValue([{ slug: "workspace-skill", install_status: "none" }]);
  });

  it("allows a skills:read PAT to list org and My Skills libraries", async () => {
    const org = await app.request("/v1/skills", { headers: { Authorization: "Bearer read-a" } });
    const mine = await app.request("/v1/skills?lib=mine", { headers: { Authorization: "Bearer read-a" } });

    expect(org.status).toBe(200);
    expect(mine.status).toBe(200);
    expect(serviceMocks.listSkills).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actor: actorA, orgId: "org-1", library: "org", installedOnly: false }),
    );
    expect(serviceMocks.listSkills).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actor: actorA, orgId: "org-1", library: "mine", installedOnly: false }),
    );
  });

  it("rejects a PAT without skills:read", async () => {
    const res = await app.request("/v1/skills", { headers: { Authorization: "Bearer write-only" } });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("skills:read") });
    expect(serviceMocks.listSkills).not.toHaveBeenCalled();
  });

  it("passes installed=true through with the current token actor", async () => {
    serviceMocks.listSkills.mockImplementation(async ({ actor, installedOnly }) => {
      if (!installedOnly) return [];
      return actor.id === "user-a" ? [{ slug: "a-installed" }] : [{ slug: "b-installed" }];
    });

    const a = await app.request("/v1/skills?installed=true", { headers: { Authorization: "Bearer read-a" } });
    const b = await app.request("/v1/skills?installed=true", { headers: { Authorization: "Bearer read-b" } });

    await expect(a.json()).resolves.toEqual([{ slug: "a-installed" }]);
    await expect(b.json()).resolves.toEqual([{ slug: "b-installed" }]);
    expect(serviceMocks.listSkills).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ actor: actorA, orgId: "org-1", library: "org", installedOnly: true }),
    );
    expect(serviceMocks.listSkills).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ actor: actorB, orgId: "org-1", library: "org", installedOnly: true }),
    );
  });
});
