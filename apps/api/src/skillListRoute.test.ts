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
    listOrgs: noop,
    listSkillComments: noop,
    listSkills: vi.fn(),
    listSkillVersions: noop,
    publishSkillVersion: noop,
    assertCanPublishSkillVersion: noop,
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
    resolveDeviceToken: vi.fn(),
    registerDevice: noop,
    recordHeartbeat: noop,
    listDevices: noop,
    revokeDevice: noop,
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
  };
});

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => fn({})),
}));

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
}));

vi.mock("@hono/node-server", () => ({
  serve: vi.fn(),
}));

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

const actorA = { id: "user-a", email: "a@example.test", name: "User A" };
const actorB = { id: "user-b", email: "b@example.test", name: "User B" };

function tokenFor(header: string | undefined) {
  if (header === "read-a") return { actor: actorA, orgId: "org-1", scopes: ["skills:read"] };
  if (header === "read-b") return { actor: actorB, orgId: "org-1", scopes: ["skills:read"] };
  if (header === "write-only") return { actor: actorA, orgId: "org-1", scopes: ["skills:write"] };
  if (header === "read-write") return { actor: actorA, orgId: "org-1", scopes: ["skills:read", "skills:write"] };
  return null;
}

describe("GET /v1/public/skills/:token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
  });

  it("returns a metadata-only skill preview without auth", async () => {
    serviceMocks.getSkillPublicPreviewByShareToken.mockResolvedValue({
      display_name: "Mega Code Review",
      slug: "mega-code-review",
      description: "Review changes with repository context.",
      current_version: "1.2.3",
      creator_name: "Ada Lovelace",
      creator_initials: "AL",
      star_count: 7,
      updated_at: "2026-06-25T10:00:00.000Z",
    });

    const res = await app.request("/v1/public/skills/share-token-1");

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, s-maxage=300, stale-while-revalidate=600");
    await expect(res.json()).resolves.toEqual({
      display_name: "Mega Code Review",
      slug: "mega-code-review",
      description: "Review changes with repository context.",
      current_version: "1.2.3",
      creator_name: "Ada Lovelace",
      creator_initials: "AL",
      star_count: 7,
      updated_at: "2026-06-25T10:00:00.000Z",
    });
    expect(serviceMocks.getSkillPublicPreviewByShareToken).toHaveBeenCalledWith({ token: "share-token-1" });
    expect(dbMocks.withTenantContext).not.toHaveBeenCalled();
  });

  it("404s unknown, personal, or archived share tokens", async () => {
    serviceMocks.getSkillPublicPreviewByShareToken.mockResolvedValue(null);

    const res = await app.request("/v1/public/skills/not-public");

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "skill not found" });
  });
});

describe("GET/POST /v1/skills/:slug/share", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
  });

  it("returns the mandatory private dependency plan", async () => {
    serviceMocks.buildSkillSharePlan.mockResolvedValue({
      slug: "pdf-extractor",
      dependencies: [{ slug: "markdown-report", status: "satisfied", note: null }],
      blocked: [],
    });

    const res = await app.request("/v1/skills/pdf-extractor/share-plan", { headers: { Authorization: "Bearer read-a" } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      slug: "pdf-extractor",
      dependencies: [{ slug: "markdown-report", status: "satisfied", note: null }],
      blocked: [],
    });
    expect(serviceMocks.buildSkillSharePlan).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "pdf-extractor" }),
    );
  });

  it("shares the skill and echoes migrated private dependencies", async () => {
    serviceMocks.shareSkill.mockResolvedValue({ scope: "org", shared_dependencies: ["markdown-report"] });

    const res = await app.request("/v1/skills/pdf-extractor/share", {
      method: "POST",
      headers: { Authorization: "Bearer write-only" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      slug: "pdf-extractor",
      scope: "org",
      shared_dependencies: ["markdown-report"],
    });
    expect(serviceMocks.shareSkill).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "pdf-extractor" }),
    );
  });

  it("keeps share-plan behind skills:read", async () => {
    const res = await app.request("/v1/skills/pdf-extractor/share-plan", { headers: { Authorization: "Bearer write-only" } });

    expect(res.status).toBe(400);
    expect(serviceMocks.buildSkillSharePlan).not.toHaveBeenCalled();
  });
});

describe("POST /v1/skills/:slug/rename", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
  });

  it("renames a skill through the explicit service mutation", async () => {
    serviceMocks.renameSkill.mockResolvedValue({
      ok: true,
      id: "skill-1",
      old_slug: "skill-creator",
      slug: "skill-creator-and-eval",
      title: "Skill Creator and Eval",
    });

    const res = await app.request("/v1/skills/skill-creator/rename", {
      method: "POST",
      headers: { Authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ newSlug: "skill-creator-and-eval", title: "Skill Creator and Eval" }),
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      id: "skill-1",
      old_slug: "skill-creator",
      slug: "skill-creator-and-eval",
      title: "Skill Creator and Eval",
    });
    expect(serviceMocks.renameSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: actorA,
        orgId: "org-1",
        slug: "skill-creator",
        newSlug: "skill-creator-and-eval",
        title: "Skill Creator and Eval",
      }),
    );
  });

  it("validates the new slug before calling the service", async () => {
    const res = await app.request("/v1/skills/skill-creator/rename", {
      method: "POST",
      headers: { Authorization: "Bearer write-only", "content-type": "application/json" },
      body: JSON.stringify({ newSlug: "Skill Creator" }),
    });

    expect(res.status).toBe(400);
    expect(serviceMocks.renameSkill).not.toHaveBeenCalled();
  });

  it("requires skills:write", async () => {
    const res = await app.request("/v1/skills/skill-creator/rename", {
      method: "POST",
      headers: { Authorization: "Bearer read-a", "content-type": "application/json" },
      body: JSON.stringify({ newSlug: "skill-creator-and-eval" }),
    });

    expect(res.status).toBe(400);
    expect(serviceMocks.renameSkill).not.toHaveBeenCalled();
  });
});

describe("GET /v1/skills/share-target/:token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue({
      user: { id: "user-a", email: "a@example.test", name: "User A" },
      session: { id: "session-1" },
    });
  });

  it("returns the token's org target for a signed-in member", async () => {
    serviceMocks.getSkillShareTargetByShareToken.mockResolvedValue({
      org_id: "org-target",
      slug: "mega-code-review",
    });

    const res = await app.request("/v1/skills/share-target/share-token-1", {
      headers: { cookie: "session=value" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ org_id: "org-target", slug: "mega-code-review" });
    expect(serviceMocks.getSkillShareTargetByShareToken).toHaveBeenCalledWith({
      actor: actorA,
      token: "share-token-1",
    });
  });

  it("404s when the token is unknown or not accessible to the signed-in user", async () => {
    serviceMocks.getSkillShareTargetByShareToken.mockResolvedValue(null);

    const res = await app.request("/v1/skills/share-target/not-public", {
      headers: { cookie: "session=value" },
    });

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "skill not found" });
  });

  it("requires a signed-in session", async () => {
    authMocks.getSession.mockResolvedValue(null);

    const res = await app.request("/v1/skills/share-target/share-token-1");

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "not authenticated" });
    expect(serviceMocks.getSkillShareTargetByShareToken).not.toHaveBeenCalled();
  });
});

describe("GET /v1/orgs/current/skill-naming-policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    serviceMocks.getSkillNamingPolicy.mockResolvedValue("verb-object-root");
  });

  it("allows a skills:read PAT to read the org policy", async () => {
    const res = await app.request("/v1/orgs/current/skill-naming-policy", {
      headers: { Authorization: "Bearer read-a" },
    });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ policy: "verb-object-root" });
    expect(serviceMocks.getSkillNamingPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1" }),
    );
  });

  it("rejects a PAT without skills:read with 401", async () => {
    const res = await app.request("/v1/orgs/current/skill-naming-policy", {
      headers: { Authorization: "Bearer write-only" },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("skills:read") });
    expect(serviceMocks.getSkillNamingPolicy).not.toHaveBeenCalled();
  });

  it("returns 401 when the actor is not a member of the selected org", async () => {
    serviceMocks.getSkillNamingPolicy.mockRejectedValue(new Error("not a member of this organization"));

    const res = await app.request("/v1/orgs/current/skill-naming-policy", {
      headers: { Authorization: "Bearer read-a" },
    });

    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ ok: false, error: "not a member of this organization" });
  });
});

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
