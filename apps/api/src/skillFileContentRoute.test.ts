import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packDir } from "@companion/skills";

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
    getSkillBySlug: noop,
    getSkillById: noop,
    getSkillDependencies: noop,
    restoreSkill: noop,
    getSkillFilterPreferences: noop,
    getOrgSettings: noop,
    getSkillNamingPolicy: noop,
    getDownloadVersion: vi.fn(),
    getCommentImageAsset: noop,
    getOrgLogoAsset: noop,
    getSkillPublicPreviewByShareToken: noop,
    getSkillShareTargetByShareToken: noop,
    issueApiToken: noop,
    joinOrgByDomain: noop,
    listApiTokens: noop,
    listLabels: noop,
    listOrgs: noop,
    listSkillComments: noop,
    listSkills: noop,
    listSkillVersions: noop,
    publishSkillVersion: noop,
    assertCanPublishSkillVersion: noop,
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

const storageMocks = vi.hoisted(() => ({
  commentImageKey: vi.fn(),
  deleteSkillArchive: vi.fn(),
  getSkillArchive: vi.fn(),
  getOrgLogo: vi.fn(),
  putOrgLogo: vi.fn(),
  skillArchiveKey: vi.fn(),
  putSkillArchive: vi.fn(),
  signedSkillArchiveUrl: vi.fn(),
}));

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
vi.mock("@companion/storage", () => storageMocks);

import { app } from "./index";

const actorA = { id: "user-a", email: "a@example.test", name: "User A" };

function tokenFor(header: string | undefined) {
  if (header === "read-a") return { actor: actorA, orgId: "org-1", scopes: ["skills:read"] };
  if (header === "write-only") return { actor: actorA, orgId: "org-1", scopes: ["skills:write"] };
  return null;
}

async function buildPackage(entries: Array<{ name: string; content: string | Buffer }>): Promise<Buffer> {
  const dir = await mkdtemp(join(tmpdir(), "companion-api-skill-"));
  try {
    for (const entry of entries) {
      const path = join(dir, entry.name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, entry.content);
    }
    return (await packDir(dir)).archive;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("GET /v1/skills/:slug/versions/:version/files/content", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    serviceMocks.getDownloadVersion.mockResolvedValue({ version: "1.0.0", storagePath: "skills/demo.tar.gz" });
    storageMocks.getSkillArchive.mockResolvedValue(
      await buildPackage([
        { name: "SKILL.md", content: "# demo\n" },
        { name: "assets/logo.png", content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
        { name: "archive.bin", content: Buffer.from([1, 2, 3]) },
      ]),
    );
  });

  it("serves a previewable file inline with the detected content type", async () => {
    const res = await app.request("/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.png", {
      headers: { Authorization: "Bearer read-a" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="logo.png"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(serviceMocks.getDownloadVersion).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "demo", version: "1.0.0" }),
    );
  });

  it("keeps unsupported files and missing read scope out of the preview endpoint", async () => {
    const unsupported = await app.request("/v1/skills/demo/versions/1.0.0/files/content?path=archive.bin", {
      headers: { Authorization: "Bearer read-a" },
    });
    expect(unsupported.status).toBe(415);
    await expect(unsupported.json()).resolves.toMatchObject({ ok: false, error: "file is not previewable" });

    const writeOnly = await app.request("/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.png", {
      headers: { Authorization: "Bearer write-only" },
    });
    expect(writeOnly.status).toBe(400);
    await expect(writeOnly.json()).resolves.toMatchObject({ ok: false, error: "token is missing the skills:read scope" });
  });
});
