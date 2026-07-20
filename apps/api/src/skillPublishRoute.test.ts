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
    getSkillNamingPolicy: noop,
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
    resolveDependencyReferences: vi.fn(async (input: { slugs: string[] }) =>
      input.slugs.map((slug) => ({ declaredSlug: slug, slug, skillId: null })),
    ),
    resolvedDependencySlugs: vi.fn((dependencies: Array<{ slug: string }>) => [...new Set(dependencies.map((d) => d.slug))]),
    resolvedDependencyIdMap: vi.fn((dependencies: Array<{ slug: string; skillId: string | null }>) =>
      Object.fromEntries(dependencies.filter((d) => d.skillId).map((d) => [d.slug, d.skillId])),
    ),
    prepareSkillPublishDependencies: vi.fn(async (input: { slugs: string[] }) => {
      const references = input.slugs.map((slug) => ({ declaredSlug: slug, slug, skillId: null }));
      return { references, slugs: [...new Set(input.slugs)], manifestDependencies: {} };
    }),
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
    shareSkill: noop,
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

  it("rejects an old-slug upload after an explicit rename", async () => {
    skillsMocks.validateSkillArchive.mockResolvedValue(validated("skill-creator", "skill-1"));
    serviceMocks.getSkillBySlug.mockResolvedValue(null); // old slug no longer resolves after rename
    serviceMocks.getSkillById.mockResolvedValue({ id: "skill-1", slug: "skill-creator-and-eval" });

    const res = await publish();
    expect(res.status).toBe(422);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining(
        'package Companion skill id "skill-1" belongs to skill "skill-creator-and-eval", not "skill-creator"',
      ),
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
    expect(serviceMocks.getSkillBySlug).toHaveBeenCalledWith(expect.objectContaining({ database: expect.any(Object) }));
    expect(serviceMocks.getSkillById).toHaveBeenCalledWith(expect.objectContaining({ database: expect.any(Object) }));
    expect(serviceMocks.prepareSkillPublishDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ database: expect.any(Object) }),
    );
  });
});

describe("POST /v1/skills/create tenant context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) =>
      token === "write" ? { actor: actorA, orgId: "org-1", scopes: ["skills:write", "skills:read"] } : null,
    );
  });

  it("preflights carried dependencies with the request-scoped database", async () => {
    serviceMocks.getSkillBySlug.mockResolvedValue(null);
    skillsMocks.validateSkillArchive.mockResolvedValue({ ok: false, error: "stop after dependency preflight" });

    const res = await app.request("/v1/skills/create", {
      method: "POST",
      headers: { Authorization: "Bearer write", "content-type": "application/json" },
      body: JSON.stringify({
        id: "inline-skill",
        description: "Inline skill.",
        body: "# Inline skill",
        scope: "personal",
        labels: [],
      }),
    });

    expect(res.status).toBe(422);
    expect(serviceMocks.prepareSkillPublishDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", slugs: [], database: expect.any(Object) }),
    );
  });
});
