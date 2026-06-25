import { beforeEach, describe, expect, it, vi } from "vitest";

// The identity guard must run unconditionally on POST /v1/skills, so these tests drive the route with
// a stubbed archive validator and assert the 422 retarget / strict-update behavior without building a
// real package or touching a database.

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
    getOnboardingState: noop,
    getSkillBySlug: vi.fn(),
    getSkillById: vi.fn(),
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
    listSkills: vi.fn(async () => []),
    listSkillVersions: noop,
    publishSkillVersion: noop,
    assertCanPublishSkillVersion: noop,
    assertManifestDependencyIds: noop,
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

const skillsMocks = vi.hoisted(() => ({ validateSkillArchive: vi.fn() }));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

vi.mock("@companion/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => null) }, handler: vi.fn(), $Infer: {} },
}));

vi.mock("@companion/db", () => dbMocks);
vi.mock("@companion/core/services", () => serviceMocks);
vi.mock("@companion/skills", async (importActual) => {
  const actual = await importActual<typeof import("@companion/skills")>();
  return { ...actual, validateSkillArchive: skillsMocks.validateSkillArchive };
});

import { app } from "./index";

const actorA = { id: "user-a", email: "a@example.test", name: "User A" };

function fm(name: string, companionSkillId?: string) {
  return {
    name,
    description: "Research helper.",
    metadata: companionSkillId ? { companion_skill_id: companionSkillId } : {},
    allowedTools: [],
    requirements: [],
  };
}

function validated(name: string, companionSkillId?: string) {
  return {
    ok: true,
    frontmatter: fm(name, companionSkillId),
    companion_manifest: companionSkillId
      ? { metadata: { companionSkillId }, version: "1.0.0", dependencies: {} }
      : undefined,
    warnings: [],
  };
}

async function publish(query = "", action = "publish") {
  return app.request(`/v1/skills?action=${action}${query}`, {
    method: "POST",
    headers: { Authorization: "Bearer write", "content-type": "application/zip" },
    body: Buffer.from("PK-fake-archive-bytes"),
  });
}

describe("POST /v1/skills identity guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) =>
      token === "write" ? { actor: actorA, orgId: "org-1", scopes: ["skills:write", "skills:read"] } : null,
    );
  });

  it("rejects a package whose Companion id belongs to another skill, without expect_*", async () => {
    skillsMocks.validateSkillArchive.mockResolvedValue(validated("research-agent", "skill-2"));
    serviceMocks.getSkillBySlug.mockResolvedValue(null); // slug is free
    serviceMocks.getSkillById.mockResolvedValue({ id: "skill-2", slug: "other-skill" });

    const res = await publish();
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining('belongs to skill "other-skill", not "research-agent"'),
    });
    expect(serviceMocks.publishSkillVersion).not.toHaveBeenCalled();
  });

  it("rejects an update that omits expect_slug and expect_skill_id", async () => {
    skillsMocks.validateSkillArchive.mockResolvedValue(validated("research-agent", "skill-1"));
    serviceMocks.getSkillBySlug.mockResolvedValue({ id: "skill-1", slug: "research-agent" });
    serviceMocks.getSkillById.mockResolvedValue({ id: "skill-1", slug: "research-agent" });

    const res = await publish();
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("requires expect_slug and expect_skill_id"),
    });
  });

  it("does not gate a validate of an existing skill on expect_*", async () => {
    skillsMocks.validateSkillArchive.mockResolvedValue(validated("research-agent", "skill-1"));
    serviceMocks.getSkillBySlug.mockResolvedValue({ id: "skill-1", slug: "research-agent" });
    serviceMocks.getSkillById.mockResolvedValue({ id: "skill-1", slug: "research-agent" });

    const res = await publish("", "validate");
    expect(res.status).toBe(200);
  });
});
