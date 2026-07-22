import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The identity guard must run unconditionally on POST /v1/skills, so these tests drive the route with
// a stubbed archive validator and assert the 422 retarget / strict-update behavior without building a
// real package or touching a database.

const serviceMocks = vi.hoisted(() => {
  const noop = vi.fn(async () => undefined);
  return {
    ApiTokenRefreshError: class ApiTokenRefreshError extends Error {},
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
    createSkillDownloadTransferTicket: noop,
    createSkillUploadTransferTicket: noop,
    consumeSkillPackageTransferTicket: vi.fn(),
    preflightSkillPackageTransferTicket: vi.fn(async () => true),
    revalidateAgentTransferTicket: vi.fn(async () => true),
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
    publishSkillVersion: vi.fn(),
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
    refreshApiToken: vi.fn(),
  };
});

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => fn({})),
}));

const storageMocks = vi.hoisted(() => ({
  putSkillArchive: vi.fn(async () => undefined),
  deleteSkillArchive: vi.fn(async () => undefined),
}));

const skillsMocks = vi.hoisted(() => ({ validateSkillArchive: vi.fn() }));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));

vi.mock("@companion/auth", () => ({
  auth: { api: { getSession: vi.fn(async () => null) }, handler: vi.fn(), $Infer: {} },
  authenticateAgentRequest: vi.fn(async () => null),
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
}));

vi.mock("@companion/db", () => dbMocks);
vi.mock("@companion/core/services", () => serviceMocks);
vi.mock("@companion/storage", async (importActual) => ({
  ...await importActual<typeof import("@companion/storage")>(),
  putSkillArchive: storageMocks.putSkillArchive,
  deleteSkillArchive: storageMocks.deleteSkillArchive,
}));
vi.mock("@companion/skills", async (importActual) => {
  const actual = await importActual<typeof import("@companion/skills")>();
  return { ...actual, validateSkillArchive: skillsMocks.validateSkillArchive };
});

import { packDir } from "@companion/skills";
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

async function validArchive(name: string): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "companion-route-ticket-test-"));
  try {
    await writeFile(
      join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: Research helper.\n---\n\n# ${name}\n`,
      "utf8",
    );
    return (await packDir(dir)).archive;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

describe("POST /v1/skills with Agent Auth upload ticket", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.preflightSkillPackageTransferTicket.mockResolvedValue(true);
    serviceMocks.revalidateAgentTransferTicket.mockResolvedValue(true);
  });

  it("rejects a fake or replayed ticket before reading and hashing the archive", async () => {
    serviceMocks.preflightSkillPackageTransferTicket.mockResolvedValue(false);
    const archive = Buffer.from("PK-agent-upload-bytes");
    const response = await app.request(
      "/v1/skills?action=publish&expect_slug=research-agent&version=1.0.0",
      {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-companion-transfer-ticket": "cmp_xfer_invalid",
        },
        body: archive,
      },
    );

    expect(response.status, await response.clone().text()).toBe(401);
    expect(skillsMocks.validateSkillArchive).not.toHaveBeenCalled();
    expect(serviceMocks.preflightSkillPackageTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_invalid",
      action: "skill_package.upload",
      slug: "research-agent",
      version: "1.0.0",
    });
    expect(serviceMocks.consumeSkillPackageTransferTicket).not.toHaveBeenCalled();
  });

  it("consumes the raw-body ticket but refuses a package with a different root skill name", async () => {
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValue({
      ticketId: "ticket-1",
      orgId: "org-1",
      actor: actorA,
      agentId: "agent-1",
      agentGrantId: "grant-1",
      action: "skill_package.upload",
      expectedSkillId: null,
      expectedSkillVersionId: null,
      slug: "research-agent",
      version: "1.0.0",
      checksum: `sha256:${"a".repeat(64)}`,
      sizeBytes: 21,
    });
    skillsMocks.validateSkillArchive.mockResolvedValue(validated("different-skill"));

    const response = await app.request(
      "/v1/skills?action=publish&expect_slug=research-agent&version=1.0.0",
      {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-companion-transfer-ticket": "cmp_xfer_bound",
        },
        body: Buffer.from("PK-agent-upload-bytes"),
      },
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: "package name does not match the Agent Auth upload ticket",
    });
    expect(serviceMocks.publishSkillVersion).not.toHaveBeenCalled();
  });

  it("does not accept multipart bodies and requires a valid transfer ticket for validate-only actions", async () => {
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValue(null);
    const multipart = await app.request("/v1/skills?action=publish&expect_slug=research-agent&version=1.0.0", {
      method: "POST",
      headers: {
        "content-type": "multipart/form-data; boundary=test",
        "x-companion-transfer-ticket": "cmp_xfer_bound",
      },
      body: "--test--",
    });
    expect(multipart.status).toBe(400);

    const validate = await app.request("/v1/skills?action=validate&expect_slug=research-agent&version=1.0.0", {
      method: "POST",
      headers: {
        "content-type": "application/zip",
        "x-companion-transfer-ticket": "cmp_xfer_bound",
      },
      body: Buffer.from("PK-agent-upload-bytes"),
    });
    expect(validate.status).toBe(401);
    expect(serviceMocks.consumeSkillPackageTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_bound",
      action: "skill_package.upload",
      slug: "research-agent",
      version: "1.0.0",
      checksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      sizeBytes: Buffer.from("PK-agent-upload-bytes").length,
    });
  });

  it("revalidates delegated authority after normalization and immediately before publishing", async () => {
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValue({
      ticketId: "ticket-final-gate",
      orgId: "org-1",
      actor: actorA,
      agentId: "agent-1",
      agentGrantId: "grant-1",
      action: "skill_package.upload",
      expectedSkillId: null,
      expectedSkillVersionId: null,
      slug: "research-agent",
      version: "1.0.0",
      checksum: `sha256:${"a".repeat(64)}`,
      sizeBytes: 21,
    });
    serviceMocks.getSkillBySlug.mockResolvedValue(null);
    skillsMocks.validateSkillArchive.mockResolvedValue(validated("research-agent"));
    serviceMocks.revalidateAgentTransferTicket.mockResolvedValue(false);
    const archive = await validArchive("research-agent");

    const response = await app.request(
      "/v1/skills?action=publish&expect_slug=research-agent&version=1.0.0",
      {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "x-companion-transfer-ticket": "cmp_xfer_final_gate",
        },
        body: archive,
      },
    );

    expect(response.status, await response.clone().text()).toBe(401);
    expect(serviceMocks.revalidateAgentTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_final_gate",
    });
    expect(serviceMocks.publishSkillVersion).not.toHaveBeenCalled();
    expect(storageMocks.deleteSkillArchive).toHaveBeenCalledTimes(1);
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

describe("POST /v1/tokens/refresh", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns active-token metadata without a plaintext token", async () => {
    serviceMocks.refreshApiToken.mockResolvedValue({
      status: "current",
      scopes: ["skills:read"],
      expires_at: "2026-08-01T00:00:00.000Z",
    });
    const res = await app.request("/v1/tokens/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer cmp_pat_active" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      status: "current",
      scopes: ["skills:read"],
      expires_at: "2026-08-01T00:00:00.000Z",
    });
    expect(body).not.toHaveProperty("token");
  });

  it("returns the replacement plaintext exactly on a rotated response", async () => {
    serviceMocks.refreshApiToken.mockResolvedValue({
      status: "rotated",
      id: "token-2",
      token: "cmp_pat_replacement",
      prefix: "cmp_pat_replac",
      scopes: ["skills:read"],
      expires_at: "2026-10-19T00:00:00.000Z",
    });
    const res = await app.request("/v1/tokens/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer cmp_pat_expired" },
    });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "rotated", token: "cmp_pat_replacement" });
    expect(serviceMocks.refreshApiToken).toHaveBeenCalledWith("cmp_pat_expired");
  });

  it("makes missing and ineligible credentials indistinguishable", async () => {
    serviceMocks.refreshApiToken.mockRejectedValue(new serviceMocks.ApiTokenRefreshError());
    const ineligible = await app.request("/v1/tokens/refresh", {
      method: "POST",
      headers: { Authorization: "Bearer cmp_pat_too_old" },
    });
    const missing = await app.request("/v1/tokens/refresh", { method: "POST" });
    expect(ineligible.status).toBe(401);
    expect(missing.status).toBe(401);
    await expect(ineligible.json()).resolves.toEqual({ ok: false, error: "token cannot be refreshed" });
    await expect(missing.json()).resolves.toEqual({ ok: false, error: "token cannot be refreshed" });
  });
});
