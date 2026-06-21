import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const actor = { id: "user-1", email: "user@example.com", name: "User One" };

const mocks = vi.hoisted(() => {
  const serviceNames = [
    "acceptInvitation",
    "addComment",
    "addOrgAccessDomain",
    "addTeamMember",
    "archiveSkill",
    "assertCanPublishSkillVersion",
    "buildDependencyPlan",
    "completeOnboarding",
    "createInvitation",
    "createOrg",
    "createTeam",
    "deleteTeam",
    "getDownloadVersion",
    "getLocalSkillInstall",
    "getOnboardingContext",
    "getOnboardingState",
    "getOrgLogoAsset",
    "getOrgSettings",
    "getSkillBySlug",
    "getSkillComments",
    "getSkillDependencies",
    "getSkillFilterPreferences",
    "installSkill",
    "issueApiToken",
    "joinOrgByDomain",
    "listApiTokens",
    "listSkillComments",
    "listSkillVersions",
    "listTeamsForUser",
    "publishSkillVersion",
    "removeMember",
    "removeOrgAccessDomain",
    "removeTeamMember",
    "reportLocalSkillInstall",
    "restoreSkill",
    "revokeApiToken",
    "revokeInvitation",
    "setCommentDeprecated",
    "setMemberRole",
    "setOrgLogoFromUpload",
    "setSkillFilterPreferences",
    "setSkillVisibility",
    "setTeamMemberRole",
    "toggleStar",
    "uninstallSkill",
    "updateOrg",
    "updateTeam",
    "updateUserProfile",
  ];
  return {
    authGetSession: vi.fn(),
    ensureUserBootstrap: vi.fn(),
    listOrgs: vi.fn(),
    listSkills: vi.fn(),
    listOrgTags: vi.fn(),
    resolveApiToken: vi.fn(),
    setSkillTags: vi.fn(),
    withTenantContext: vi.fn(),
    services: Object.fromEntries(serviceNames.map((name) => [name, vi.fn()])),
  };
});

vi.mock("@companion/auth", () => ({
  auth: {
    api: {
      getSession: mocks.authGetSession,
    },
  },
}));

vi.mock("@companion/db", () => ({
  withTenantContext: mocks.withTenantContext,
}));

vi.mock("@companion/core/services", () => ({
  ...mocks.services,
  DependencyPublishError: class DependencyPublishError extends Error {},
  computeLocalSkillStatus: vi.fn(() => "installed"),
  ensureUserBootstrap: mocks.ensureUserBootstrap,
  listOrgs: mocks.listOrgs,
  listOrgTags: mocks.listOrgTags,
  listSkills: mocks.listSkills,
  orgLogoPublicPath: vi.fn((path: string | null) => path),
  resolveApiToken: mocks.resolveApiToken,
  setSkillTags: mocks.setSkillTags,
}));

describe("skill tag routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authGetSession.mockResolvedValue({
      user: actor,
      session: { id: "session-1", userId: actor.id },
    });
    mocks.ensureUserBootstrap.mockResolvedValue(undefined);
    mocks.listOrgs.mockResolvedValue([{ org_id: ORG }]);
    mocks.withTenantContext.mockImplementation(async (_input, fn) => fn({}));
    mocks.listSkills.mockResolvedValue([]);
    mocks.listOrgTags.mockResolvedValue(["incident response", "ops"]);
    mocks.setSkillTags.mockResolvedValue({ tags: ["incident response", "ops"] });
    mocks.resolveApiToken.mockResolvedValue({ actor, orgId: ORG, scopes: ["skills:write"] });
  });

  it("normalizes repeatable and comma-delimited tag filters for the skills list", async () => {
    const { app } = await import("./index");

    const response = await app.request("http://api.test/v1/skills?tag=Ops&tag=incident%20response,Infra");

    expect(response.status).toBe(200);
    expect(mocks.listSkills).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      orgId: ORG,
      tags: ["ops", "incident response", "infra"],
      database: {},
    }));
  });

  it("rejects invalid tag filters before the service layer", async () => {
    const { app } = await import("./index");

    const response = await app.request("http://api.test/v1/skills?tag=bad_tag");
    const body = await response.json() as { error: string };

    expect(response.status).not.toBe(200);
    expect(body.error).toContain("tag must be");
    expect(mocks.listSkills).not.toHaveBeenCalled();
  });

  it("returns the visible organization tag list", async () => {
    const { app } = await import("./index");

    const response = await app.request("http://api.test/v1/skills/tags");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(["incident response", "ops"]);
    expect(mocks.listOrgTags).toHaveBeenCalledWith(expect.objectContaining({ actor, orgId: ORG, database: {} }));
  });

  it("replaces tags through the PAT-enabled write endpoint", async () => {
    mocks.authGetSession.mockResolvedValue(null);
    const { app } = await import("./index");

    const response = await app.request("http://api.test/v1/skills/incident-summary/tags", {
      method: "PUT",
      headers: {
        authorization: "Bearer cmp_pat_test",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tags: ["Ops", "incident response"] }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ tags: ["incident response", "ops"] });
    expect(mocks.setSkillTags).toHaveBeenCalledWith(expect.objectContaining({
      actor,
      orgId: ORG,
      slug: "incident-summary",
      tags: ["ops", "incident response"],
      database: {},
    }));
  });

  it("requires a skills:write token scope for tag replacement", async () => {
    mocks.authGetSession.mockResolvedValue(null);
    mocks.resolveApiToken.mockResolvedValue({ actor, orgId: ORG, scopes: ["skills:read"] });
    const { app } = await import("./index");

    const response = await app.request("http://api.test/v1/skills/incident-summary/tags", {
      method: "PUT",
      headers: {
        authorization: "Bearer cmp_pat_readonly",
        "content-type": "application/json",
      },
      body: JSON.stringify({ tags: ["ops"] }),
    });
    const body = await response.json() as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toContain("skills:write");
    expect(mocks.setSkillTags).not.toHaveBeenCalled();
  });
});
