import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { packDir, tarGzToZip } from "@companion/skills";

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
    authorizePublicSkillPackageForSession: vi.fn(),
    buildDependencyPlan: noop,
    buildSkillSharePlan: noop,
    clearSkillPublicVersion: noop,
    completeOnboarding: noop,
    createInvitation: noop,
    createLabel: noop,
    createOrg: noop,
    createLocalSkillDownloadTransferTicket: vi.fn(),
    createSkillDownloadTransferTicket: vi.fn(),
    createSkillFileDownloadTransferTicket: vi.fn(),
    createSkillUploadTransferTicket: vi.fn(),
    consumePublicSkillTransferTicket: vi.fn(),
    consumeSkillPackageTransferTicket: vi.fn(),
    revalidateAgentTransferTicket: vi.fn(async () => true),
    deleteLabel: noop,
    DependencyPublishError: class DependencyPublishError extends Error {},
    computeLocalSkillStatus: vi.fn(() => "installed"),
    getLocalSkillInstall: noop,
    getOnboardingContext: noop,
    getOnboardingState: noop,
    getSkillBySlug: vi.fn(),
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
    listOrgs: vi.fn(),
    listSkillComments: noop,
    listSkills: noop,
    listSkillVersions: vi.fn(),
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
    setSkillPublicVersion: noop,
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
    SkillPublicReleaseConflictError: class SkillPublicReleaseConflictError extends Error {},
    SkillPublicReleaseForbiddenError: class SkillPublicReleaseForbiddenError extends Error {},
    SkillPublicReleaseNotFoundError: class SkillPublicReleaseNotFoundError extends Error {},
    SkillPublicReleaseValidationError: class SkillPublicReleaseValidationError extends Error {},
  };
});

const storageMocks = vi.hoisted(() => ({
  commentImageKey: vi.fn(),
  deleteSkillArchive: vi.fn(),
  getSkillArchive: vi.fn(),
  getOrgLogo: vi.fn(),
  publicSkillReleaseKey: vi.fn(({ orgId, checksum }: { orgId: string; checksum: string }) =>
    `${orgId}/public-releases/sha256/${checksum.slice("sha256:".length)}.zip`),
  putPublicSkillReleaseSnapshot: vi.fn(),
  putOrgLogo: vi.fn(),
  skillArchiveKey: vi.fn(),
  putSkillArchive: vi.fn(),
  signedSkillArchiveUrl: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  withTenantContext: vi.fn(async (_ctx: unknown, fn: (database: unknown) => unknown) => fn({})),
}));

const localPackageMocks = vi.hoisted(() => ({
  getCompanionSkillPackage: vi.fn(),
  buildCompanionSkillRow: vi.fn(),
}));

const authMocks = vi.hoisted(() => ({
  authenticateAgentRequest: vi.fn(),
  getSession: vi.fn(async (): Promise<unknown | null> => null),
  handler: vi.fn(),
  executors: new Map<string, (input: Record<string, unknown>) => Promise<unknown>>(),
  registerAgentCapabilityExecutor: vi.fn(
    (capability: string, executor: (input: Record<string, unknown>) => Promise<unknown>) => {
      authMocks.executors.set(capability, executor);
      return () => authMocks.executors.delete(capability);
    },
  ),
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
  authenticateAgentRequest: authMocks.authenticateAgentRequest,
  registerAgentCapabilityExecutor: authMocks.registerAgentCapabilityExecutor,
}));

vi.mock("@companion/db", () => dbMocks);
vi.mock("@companion/core/services", () => serviceMocks);
vi.mock("@companion/storage", () => storageMocks);
vi.mock("./companionSkillPackage", () => localPackageMocks);

import { app } from "./index";

const actorA = { id: "user-a", email: "a@example.test", name: "User A" };

function tokenFor(header: string | undefined) {
  if (header === "read-a") return { actor: actorA, orgId: "org-1", scopes: ["skills:read"] };
  if (header === "write-only") return { actor: actorA, orgId: "org-1", scopes: ["skills:write"] };
  return null;
}

describe("GET /v1/skills/:slug/download Agent Auth metadata", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    serviceMocks.resolveApiToken.mockResolvedValue(null);
    authMocks.authenticateAgentRequest.mockResolvedValue({
      actor: actorA,
      workspaceId: "00000000-0000-4000-8000-000000000001",
      capability: "skills:read",
      session: { agentId: "agent-1" },
    });
    serviceMocks.getDownloadVersion.mockResolvedValue({
      version: "1.2.3",
      checksum: "sha256:metadata-only",
      storagePath: "skills/demo/1.2.3.tar.gz",
    });
    storageMocks.signedSkillArchiveUrl.mockResolvedValue("https://storage.example/signed-package");
  });

  it("exposes metadata but never a signed package URL to an Agent JWT", async () => {
    const response = await app.request("/v1/skills/demo/download", {
      headers: {
        Authorization: "Bearer agent-jwt",
        "X-Companion-Workspace-Id": "00000000-0000-4000-8000-000000000001",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      version: "1.2.3",
      checksum: "sha256:metadata-only",
      storagePath: "skills/demo/1.2.3.tar.gz",
    });
    expect(storageMocks.signedSkillArchiveUrl).not.toHaveBeenCalled();
  });
});

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
    authMocks.authenticateAgentRequest.mockResolvedValue(null);
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

  it("keeps the signed-in session path compatible", async () => {
    authMocks.getSession.mockResolvedValue({
      user: { ...actorA, emailVerified: true },
      session: { id: "session-file", userId: actorA.id },
    });
    serviceMocks.listOrgs.mockResolvedValue([{ org_id: "org-1" }]);
    const response = await app.request(
      "/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.png",
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(serviceMocks.revalidateAgentTransferTicket).not.toHaveBeenCalled();
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

  it("serves an exact file once with a header-only Agent Auth transfer ticket", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const checksum = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    serviceMocks.consumeSkillPackageTransferTicket
      .mockResolvedValueOnce({
        ticketId: "ticket-file",
        orgId: "org-1",
        actor: actorA,
        agentId: "agent-1",
        agentGrantId: "grant-file",
        action: "skill_file.download",
        expectedSkillId: "skill-1",
        expectedSkillVersionId: "version-1",
        slug: "demo",
        version: "1.0.0",
        filePath: "assets/logo.png",
        checksum,
        sizeBytes: bytes.length,
      })
      .mockResolvedValueOnce(null);
    serviceMocks.getSkillBySlug.mockResolvedValue({ id: "skill-1", slug: "demo" });
    serviceMocks.listSkillVersions.mockResolvedValue([{ id: "version-1", version: "1.0.0" }]);

    const headers = { "x-companion-transfer-ticket": "cmp_xfer_file-secret" };
    const first = await app.request(
      "/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.png",
      { headers },
    );
    const replay = await app.request(
      "/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.png",
      { headers },
    );

    expect(first.status).toBe(200);
    expect(first.headers.get("x-companion-file-checksum")).toBe(checksum);
    expect(first.headers.get("x-companion-file-size")).toBe(String(bytes.length));
    expect(first.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await first.arrayBuffer())).toEqual(bytes);
    expect(replay.status).toBe(401);
    expect(serviceMocks.consumeSkillPackageTransferTicket).toHaveBeenNthCalledWith(1, {
      ticket: "cmp_xfer_file-secret",
      action: "skill_file.download",
      slug: "demo",
      version: "1.0.0",
      filePath: "assets/logo.png",
    });
    expect(serviceMocks.getDownloadVersion).toHaveBeenCalledWith(expect.objectContaining({
      actor: actorA,
      orgId: "org-1",
      slug: "demo",
      version: "1.0.0",
    }));
    expect(serviceMocks.revalidateAgentTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_file-secret",
    });
  });

  it("withholds exact-file bytes when the Agent Auth grant is revoked after consumption", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValueOnce({
      ticketId: "ticket-file-revoked",
      orgId: "org-1",
      actor: actorA,
      agentId: "agent-1",
      agentGrantId: "grant-file",
      action: "skill_file.download",
      expectedSkillId: "skill-1",
      expectedSkillVersionId: "version-1",
      slug: "demo",
      version: "1.0.0",
      filePath: "assets/logo.png",
      checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      sizeBytes: bytes.length,
    });
    serviceMocks.getSkillBySlug.mockResolvedValue({ id: "skill-1", slug: "demo" });
    serviceMocks.listSkillVersions.mockResolvedValue([{ id: "version-1", version: "1.0.0" }]);
    serviceMocks.revalidateAgentTransferTicket.mockResolvedValueOnce(false);

    const response = await app.request(
      "/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.png",
      { headers: { "x-companion-transfer-ticket": "cmp_xfer_file-revoked" } },
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(storageMocks.getSkillArchive).toHaveBeenCalledOnce();
    expect(serviceMocks.revalidateAgentTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_file-revoked",
    });
  });

  it("burns a wrong-path ticket and refuses changed file bytes", async () => {
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValueOnce(null);
    const wrongPath = await app.request(
      "/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Fother.png",
      { headers: { "x-companion-transfer-ticket": "cmp_xfer_wrong-path" } },
    );
    expect(wrongPath.status).toBe(401);
    expect(storageMocks.getSkillArchive).not.toHaveBeenCalled();

    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValueOnce({
      ticketId: "ticket-changed-file",
      orgId: "org-1",
      actor: actorA,
      agentId: "agent-1",
      agentGrantId: "grant-file",
      action: "skill_file.download",
      expectedSkillId: "skill-1",
      expectedSkillVersionId: "version-1",
      slug: "demo",
      version: "1.0.0",
      filePath: "assets/logo.png",
      checksum: `sha256:${"0".repeat(64)}`,
      sizeBytes: 8,
    });
    serviceMocks.getSkillBySlug.mockResolvedValue({ id: "skill-1", slug: "demo" });
    serviceMocks.listSkillVersions.mockResolvedValue([{ id: "version-1", version: "1.0.0" }]);
    const changed = await app.request(
      "/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.png",
      { headers: { "x-companion-transfer-ticket": "cmp_xfer_changed-file" } },
    );
    expect(changed.status).toBe(409);
    expect(changed.headers.get("content-type")).toContain("application/json");
  });

  it("revalidates the exact live skill and immutable version after ticket consumption", async () => {
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValueOnce({
      ticketId: "ticket-stale-target",
      orgId: "org-1",
      actor: actorA,
      agentId: "agent-1",
      agentGrantId: "grant-file",
      action: "skill_file.download",
      expectedSkillId: "skill-original",
      expectedSkillVersionId: "version-original",
      slug: "demo",
      version: "1.0.0",
      filePath: "assets/logo.png",
      checksum: `sha256:${"1".repeat(64)}`,
      sizeBytes: 8,
    });
    serviceMocks.getSkillBySlug.mockResolvedValue({ id: "skill-replaced", slug: "demo" });
    serviceMocks.listSkillVersions.mockResolvedValue([{ id: "version-replaced", version: "1.0.0" }]);
    const response = await app.request(
      "/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.png",
      { headers: { "x-companion-transfer-ticket": "cmp_xfer_stale-target" } },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      error: "skill file changed after the transfer ticket was issued",
    });
    expect(storageMocks.getSkillArchive).not.toHaveBeenCalled();
  });

  it("does not accept an Agent JWT directly on the binary file route", async () => {
    serviceMocks.resolveApiToken.mockResolvedValue(null);
    authMocks.authenticateAgentRequest.mockResolvedValue(null);
    const response = await app.request(
      "/v1/skills/demo/versions/1.0.0/files/content?path=assets%2Flogo.png",
      {
        headers: {
          authorization: "Bearer agent-jwt",
          "x-companion-workspace-id": "00000000-0000-4000-8000-000000000001",
        },
      },
    );
    expect(response.status).toBe(400);
    expect(storageMocks.getSkillArchive).not.toHaveBeenCalled();
  });
});

describe("GET /v1/public/skills/:token/versions/:version/package", () => {
  let descriptor = {
    orgId: "org-1",
    slug: "demo",
    version: "1.0.0",
    checksum: "",
    sizeBytes: 0,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    serviceMocks.resolveApiToken.mockImplementation(async (token: string) => tokenFor(token));
    const archive = await buildPackage([{ name: "SKILL.md", content: "# demo\n" }]);
    const zip = await tarGzToZip(archive);
    descriptor = {
      ...descriptor,
      checksum: `sha256:${createHash("sha256").update(zip).digest("hex")}`,
      sizeBytes: zip.length,
    };
    storageMocks.getSkillArchive.mockResolvedValue(zip);
  });

  it("delivers no package bytes to anonymous requests or PATs", async () => {
    const anonymous = await app.request("/v1/public/skills/share-token/versions/1.0.0/package");
    expect(anonymous.status).toBe(401);

    const pat = await app.request("/v1/public/skills/share-token/versions/1.0.0/package", {
      headers: { authorization: "Bearer read-a" },
    });
    expect(pat.status).toBe(401);
    expect(storageMocks.getSkillArchive).not.toHaveBeenCalled();
  });

  it("downloads the exact public release for a verified browser session", async () => {
    authMocks.getSession.mockResolvedValue({
      user: { ...actorA, emailVerified: true },
      session: { id: "session-1", userId: actorA.id },
    });
    serviceMocks.authorizePublicSkillPackageForSession.mockResolvedValue(descriptor);

    const response = await app.request("/v1/public/skills/share-token/versions/1.0.0/package");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-companion-package-checksum")).toBe(descriptor.checksum);
    expect(await response.arrayBuffer()).not.toHaveProperty("byteLength", 0);
    expect(serviceMocks.authorizePublicSkillPackageForSession).toHaveBeenCalledWith({
      token: "share-token",
      version: "1.0.0",
      userId: actorA.id,
    });
    expect(storageMocks.getSkillArchive).toHaveBeenCalledWith({
      key: `org-1/public-releases/sha256/${descriptor.checksum.slice("sha256:".length)}.zip`,
    });
  });

  it("consumes a header-only Agent Auth ticket once and rejects replay", async () => {
    serviceMocks.consumePublicSkillTransferTicket
      .mockResolvedValueOnce(descriptor)
      .mockResolvedValueOnce(null);

    const headers = { "x-companion-transfer-ticket": "cmp_xfer_secret-never-in-url" };
    const first = await app.request("/v1/public/skills/share-token/versions/1.0.0/package", { headers });
    const replay = await app.request("/v1/public/skills/share-token/versions/1.0.0/package", { headers });

    expect(first.status).toBe(200);
    expect(replay.status).toBe(401);
    expect(serviceMocks.consumePublicSkillTransferTicket).toHaveBeenNthCalledWith(1, {
      ticket: "cmp_xfer_secret-never-in-url",
      token: "share-token",
      version: "1.0.0",
    });
    expect(serviceMocks.revalidateAgentTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_secret-never-in-url",
    });
  });

  it("withholds public package bytes when the Agent Auth grant is revoked after storage read", async () => {
    serviceMocks.consumePublicSkillTransferTicket.mockResolvedValueOnce(descriptor);
    serviceMocks.revalidateAgentTransferTicket.mockResolvedValueOnce(false);

    const response = await app.request("/v1/public/skills/share-token/versions/1.0.0/package", {
      headers: { "x-companion-transfer-ticket": "cmp_xfer_public-revoked" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(storageMocks.getSkillArchive).toHaveBeenCalledOnce();
    expect(serviceMocks.revalidateAgentTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_public-revoked",
    });
  });

  it("404s a wrong version, withdrawn, personal, or archived release for a valid session", async () => {
    authMocks.getSession.mockResolvedValue({
      user: { ...actorA, emailVerified: true },
      session: { id: "session-1", userId: actorA.id },
    });
    serviceMocks.authorizePublicSkillPackageForSession.mockResolvedValue(null);

    const response = await app.request("/v1/public/skills/share-token/versions/0.9.0/package");

    expect(response.status).toBe(404);
    expect(storageMocks.getSkillArchive).not.toHaveBeenCalled();
  });

  it("refuses every byte when stored ZIP bytes do not match the pinned transport checksum", async () => {
    authMocks.getSession.mockResolvedValue({
      user: { ...actorA, emailVerified: true },
      session: { id: "session-1", userId: actorA.id },
    });
    serviceMocks.authorizePublicSkillPackageForSession.mockResolvedValue({
      ...descriptor,
      checksum: `sha256:${"f".repeat(64)}`,
    });

    const response = await app.request("/v1/public/skills/share-token/versions/1.0.0/package");

    expect(response.status).toBe(409);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("match") });
  });
});

describe("GET /v1/skills/:slug/versions/:version/package with Agent Auth transfer ticket", () => {
  let archive: Buffer;
  let checksum: string;
  let sizeBytes: number;

  beforeEach(async () => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    archive = await buildPackage([{ name: "SKILL.md", content: "# private demo\n" }]);
    const zip = await tarGzToZip(archive);
    checksum = `sha256:${createHash("sha256").update(zip).digest("hex")}`;
    sizeBytes = zip.length;
    storageMocks.getSkillArchive.mockResolvedValue(archive);
    serviceMocks.getDownloadVersion.mockResolvedValue({ version: "1.0.0", storagePath: "skills/private-demo.tar.gz" });
    serviceMocks.getSkillBySlug.mockResolvedValue({ id: "skill-1", slug: "private-demo" });
    serviceMocks.listSkillVersions.mockResolvedValue([{ id: "version-1", version: "1.0.0" }]);
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValue({
      ticketId: "ticket-1",
      orgId: "org-1",
      actor: actorA,
      agentId: "agent-1",
      agentGrantId: "grant-1",
      action: "skill_package.download",
      expectedSkillId: "skill-1",
      expectedSkillVersionId: "version-1",
      slug: "private-demo",
      version: "1.0.0",
      checksum,
      sizeBytes,
    });
  });

  it("re-enters the normal visibility service and serves only the ticket-bound ZIP bytes", async () => {
    const response = await app.request("/v1/skills/private-demo/versions/1.0.0/package", {
      headers: { "x-companion-transfer-ticket": "cmp_xfer_private-download" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-companion-package-checksum")).toBe(checksum);
    expect(response.headers.get("x-companion-package-size")).toBe(String(sizeBytes));
    expect(serviceMocks.consumeSkillPackageTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_private-download",
      action: "skill_package.download",
      slug: "private-demo",
      version: "1.0.0",
    });
    expect(serviceMocks.getDownloadVersion).toHaveBeenCalledWith(
      expect.objectContaining({ actor: actorA, orgId: "org-1", slug: "private-demo", version: "1.0.0" }),
    );
    expect(serviceMocks.revalidateAgentTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_private-download",
    });
  });

  it("withholds private package bytes when the Agent Auth grant is revoked after conversion", async () => {
    serviceMocks.revalidateAgentTransferTicket.mockResolvedValueOnce(false);

    const response = await app.request("/v1/skills/private-demo/versions/1.0.0/package", {
      headers: { "x-companion-transfer-ticket": "cmp_xfer_private-revoked" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(storageMocks.getSkillArchive).toHaveBeenCalledOnce();
    expect(serviceMocks.revalidateAgentTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_private-revoked",
    });
  });

  it("returns no package bytes for an invalid ticket or changed transport bytes", async () => {
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValueOnce(null);
    const invalid = await app.request("/v1/skills/private-demo/versions/1.0.0/package", {
      headers: { "x-companion-transfer-ticket": "cmp_xfer_invalid" },
    });
    expect(invalid.status).toBe(401);
    expect(storageMocks.getSkillArchive).not.toHaveBeenCalled();

    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValueOnce({
      ticketId: "ticket-2",
      orgId: "org-1",
      actor: actorA,
      agentId: "agent-1",
      agentGrantId: "grant-1",
      action: "skill_package.download",
      expectedSkillId: "skill-1",
      expectedSkillVersionId: "version-1",
      slug: "private-demo",
      version: "1.0.0",
      checksum: `sha256:${"0".repeat(64)}`,
      sizeBytes,
    });
    const changed = await app.request("/v1/skills/private-demo/versions/1.0.0/package", {
      headers: { "x-companion-transfer-ticket": "cmp_xfer_changed" },
    });
    expect(changed.status).toBe(409);
    expect(changed.headers.get("content-type")).toContain("application/json");
  });
});

describe("Agent Auth binary capability executors", () => {
  const workspaceId = "11111111-1111-4111-8111-111111111111";
  const session = {
    user: { ...actorA },
    agentId: "agent-1",
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    const archive = await buildPackage([{ name: "SKILL.md", content: "# capability package\n" }]);
    storageMocks.getSkillArchive.mockResolvedValue(archive);
    serviceMocks.getDownloadVersion.mockResolvedValue({
      version: "1.0.0",
      storagePath: "skills/capability.tar.gz",
    });
    serviceMocks.createSkillDownloadTransferTicket.mockResolvedValue({
      ticket: "cmp_xfer_download",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      slug: "capability-skill",
      version: "1.0.0",
      checksum: `sha256:${"a".repeat(64)}`,
      size_bytes: 100,
    });
    serviceMocks.createSkillFileDownloadTransferTicket.mockResolvedValue({
      ticket: "cmp_xfer_file",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      slug: "capability-skill",
      version: "1.0.0",
      checksum: `sha256:${"d".repeat(64)}`,
      size_bytes: Buffer.byteLength("# capability package\n"),
    });
    serviceMocks.createSkillUploadTransferTicket.mockResolvedValue({
      ticket: "cmp_xfer_upload",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      slug: "capability-skill",
      version: "1.0.1",
      checksum: `sha256:${"b".repeat(64)}`,
      size_bytes: 200,
    });
    serviceMocks.createLocalSkillDownloadTransferTicket.mockResolvedValue({
      ticket: "cmp_xfer_local",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      slug: "companion",
      version: "1.26.0",
      checksum: `sha256:${"c".repeat(64)}`,
      size_bytes: 300,
    });
    localPackageMocks.getCompanionSkillPackage.mockResolvedValue({
      key: "companion",
      zip: Buffer.from("local-skill-zip"),
      checksum: `sha256:${"f".repeat(64)}`,
      sizeBytes: Buffer.byteLength("local-skill-zip"),
      version: "1.26.0",
      integrity: { packageChecksum: `sha256:${"f".repeat(64)}`, files: {} },
    });
  });

  it("turns skills:read execution into a one-use ticket for deterministic ZIP bytes", async () => {
    const executor = authMocks.executors.get("skills:read");
    expect(executor).toBeTypeOf("function");
    const result = await executor!({
      arguments: {
        workspaceId,
        transfer: { action: "download", slug: "capability-skill", version: "1.0.0" },
      },
      session,
      grant: { id: "grant-read", constraints: { workspaceId: { eq: workspaceId } } },
    });

    expect(result).toMatchObject({ ticket: "cmp_xfer_download" });
    expect(serviceMocks.createSkillDownloadTransferTicket).toHaveBeenCalledWith(expect.objectContaining({
      actor: actorA,
      orgId: workspaceId,
      slug: "capability-skill",
      version: "1.0.0",
      storagePath: "skills/capability.tar.gz",
      packageChecksum: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
      packageSizeBytes: expect.any(Number),
      agentId: "agent-1",
      agentGrantId: "grant-read",
      database: expect.any(Object),
    }));
  });

  it("turns a previewable file read into a path/checksum/size-bound ticket", async () => {
    const executor = authMocks.executors.get("skills:read");
    await expect(executor!({
      arguments: {
        workspaceId,
        transfer: {
          action: "download-file",
          slug: "capability-skill",
          version: "1.0.0",
          path: "SKILL.md",
        },
      },
      session,
      grant: { id: "grant-file", constraints: { workspaceId: { eq: workspaceId } } },
    })).resolves.toMatchObject({ ticket: "cmp_xfer_file" });
    const bytes = Buffer.from("# capability package\n");
    expect(serviceMocks.createSkillFileDownloadTransferTicket).toHaveBeenCalledWith(expect.objectContaining({
      actor: actorA,
      orgId: workspaceId,
      slug: "capability-skill",
      version: "1.0.0",
      filePath: "SKILL.md",
      storagePath: "skills/capability.tar.gz",
      fileChecksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      fileSizeBytes: bytes.length,
      agentId: "agent-1",
      agentGrantId: "grant-file",
      database: expect.any(Object),
    }));
  });

  it("binds skills:write execution to the declared upload checksum/size and exact workspace grant", async () => {
    const executor = authMocks.executors.get("skills:write");
    expect(executor).toBeTypeOf("function");
    const checksum = `sha256:${"b".repeat(64)}`;
    await expect(executor!({
      arguments: {
        workspaceId,
        transfer: {
          action: "upload",
          slug: "capability-skill",
          version: "1.0.1",
          checksum,
          sizeBytes: 200,
        },
      },
      session,
      grant: { id: "grant-write", constraints: { workspaceId } },
    })).resolves.toMatchObject({ ticket: "cmp_xfer_upload" });
    expect(serviceMocks.createSkillUploadTransferTicket).toHaveBeenCalledWith(expect.objectContaining({
      actor: actorA,
      orgId: workspaceId,
      slug: "capability-skill",
      version: "1.0.1",
      packageChecksum: checksum,
      packageSizeBytes: 200,
      agentId: "agent-1",
      agentGrantId: "grant-write",
    }));

    await expect(executor!({
      arguments: {
        workspaceId,
        transfer: { action: "upload", slug: "capability-skill", version: "1.0.1", checksum, sizeBytes: 200 },
      },
      session,
      grant: { id: "grant-wrong", constraints: { workspaceId: "22222222-2222-4222-8222-222222222222" } },
    })).rejects.toThrow("does not allow this workspace");
  });

  it("issues a local-skill ticket instead of authorizing its binary route with a JWT", async () => {
    const executor = authMocks.executors.get("skills:read");
    await expect(executor!({
      arguments: {
        workspaceId,
        transfer: { action: "download-local", slug: "companion", version: "1.26.0" },
      },
      session,
      grant: { id: "grant-local", constraints: { workspaceId: { eq: workspaceId } } },
    })).resolves.toMatchObject({ ticket: "cmp_xfer_local" });
    expect(serviceMocks.createLocalSkillDownloadTransferTicket).toHaveBeenCalledWith(expect.objectContaining({
      actor: actorA,
      orgId: workspaceId,
      key: "companion",
      version: "1.26.0",
      packageChecksum: `sha256:${createHash("sha256").update("local-skill-zip").digest("hex")}`,
      packageSizeBytes: Buffer.byteLength("local-skill-zip"),
      agentId: "agent-1",
      agentGrantId: "grant-local",
    }));
  });
});

describe("GET /v1/local-skills/:key/package with Agent Auth transfer ticket", () => {
  const zip = Buffer.from("trusted-local-skill-zip");
  const checksum = `sha256:${createHash("sha256").update(zip).digest("hex")}`;

  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue(null);
    localPackageMocks.getCompanionSkillPackage.mockResolvedValue({
      key: "companion",
      zip,
      checksum: `sha256:${"f".repeat(64)}`,
      sizeBytes: zip.length,
      version: "1.26.0",
      integrity: { packageChecksum: `sha256:${"f".repeat(64)}`, files: {} },
    });
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValue({
      ticketId: "ticket-local",
      orgId: "org-1",
      actor: actorA,
      agentId: "agent-1",
      agentGrantId: "grant-local",
      action: "local_skill.download",
      expectedSkillId: null,
      expectedSkillVersionId: null,
      slug: "companion",
      version: "1.26.0",
      checksum,
      sizeBytes: zip.length,
    });
  });

  it("serves the exact bundled ZIP after consuming the key/version/checksum-bound ticket", async () => {
    const response = await app.request("/v1/local-skills/companion/package", {
      headers: { "x-companion-transfer-ticket": "cmp_xfer_local" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-companion-package-checksum")).toBe(checksum);
    expect(response.headers.get("x-companion-package-size")).toBe(String(zip.length));
    expect(Buffer.from(await response.arrayBuffer())).toEqual(zip);
    expect(serviceMocks.consumeSkillPackageTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_local",
      action: "local_skill.download",
      slug: "companion",
      version: "1.26.0",
      checksum,
      sizeBytes: zip.length,
    });
    expect(serviceMocks.revalidateAgentTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_local",
    });
  });

  it("withholds bundled package bytes when the Agent Auth grant is revoked after consumption", async () => {
    serviceMocks.revalidateAgentTransferTicket.mockResolvedValueOnce(false);

    const response = await app.request("/v1/local-skills/companion/package", {
      headers: { "x-companion-transfer-ticket": "cmp_xfer_local-revoked" },
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(serviceMocks.revalidateAgentTransferTicket).toHaveBeenCalledWith({
      ticket: "cmp_xfer_local-revoked",
    });
  });

  it("returns no bundled bytes for a replayed/revoked ticket", async () => {
    serviceMocks.consumeSkillPackageTransferTicket.mockResolvedValue(null);
    const response = await app.request("/v1/local-skills/companion/package", {
      headers: { "x-companion-transfer-ticket": "cmp_xfer_replay" },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});
