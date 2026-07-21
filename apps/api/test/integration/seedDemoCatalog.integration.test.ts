import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@companion/db";
import { extractArchiveEntryBuffers, toTar } from "@companion/skills";
import { createIntegrationFixture, integrationDb, type IntegrationFixture } from "./testDatabase";

const storage = vi.hoisted(() => ({ archives: new Map<string, Buffer>() }));

vi.mock("@companion/storage", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@companion/storage")>();
  return {
    ...actual,
    putSkillArchive: vi.fn(async ({ key, body }: { key: string; body: Uint8Array }) => {
      if (storage.archives.has(key)) {
        const error = new Error("archive already exists");
        error.name = "PreconditionFailed";
        throw error;
      }
      storage.archives.set(key, Buffer.from(body));
      return null;
    }),
    getSkillArchive: vi.fn(async ({ key }: { key: string }) => {
      const archive = storage.archives.get(key);
      if (!archive) throw new Error(`missing test archive: ${key}`);
      return archive;
    }),
  };
});

process.env.S3_ENDPOINT = "http://127.0.0.1:1";
process.env.S3_ACCESS_KEY_ID = "integration";
process.env.S3_SECRET_ACCESS_KEY = "integration";
process.env.S3_BUCKET_SKILL_ARCHIVES = "integration";

import { seedDemoContent } from "../../src/seed-test-user";

/**
 * Product promise: a fresh local workspace gets the complete stable demo matrix, and restarting the
 * stack neither duplicates fixture state nor overwrites an install choice the developer already made.
 *
 * Regression caught: the declarative contract alone cannot detect skipped publications, broken
 * personal scopes, missing direct showcase mutations, install cascades, or second-run audit noise.
 *
 * Why this level: this orchestration spans real service transactions and PostgreSQL constraints;
 * storage is stubbed only at the S3 boundary so package bytes remain observable without MinIO.
 *
 * Failure proof: omitting a fixture mutation, removing the existing-version checks, or allowing the
 * email-digest cascade to upsert an existing markdown-report install makes the assertions fail.
 */
describe("seeded demo catalog persistence", () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
    storage.archives.clear();
  });

  it("persists the complete matrix twice and preserves a pre-existing dependency install", async () => {
    await seedDemoContent(fixture.owner);
    await seedDemoContent(fixture.owner);

    const skills = await integrationDb.query.skills.findMany({
      where: eq(schema.skills.orgId, fixture.orgA),
    });
    expect(skills.filter((skill) => skill.scope === "org")).toHaveLength(15);
    expect(skills.filter((skill) => skill.scope === "personal")).toHaveLength(3);

    const versions = await integrationDb.query.skillVersions.findMany({
      where: eq(schema.skillVersions.orgId, fixture.orgA),
    });
    expect(versions).toHaveLength(19);
    expect(new Set(versions.map((version) => `${version.skillId}:${version.version}`)).size).toBe(19);
    const release = skills.find((skill) => skill.slug === "release-notes")!;
    expect(
      versions.filter((version) => version.skillId === release.id).map((version) => version.version).sort(),
    ).toEqual(["1.0.0", "1.1.0"]);

    const installs = await integrationDb.query.skillInstalls.findMany({
      where: and(eq(schema.skillInstalls.orgId, fixture.orgA), eq(schema.skillInstalls.userId, fixture.owner.id)),
    });
    const slugById = new Map(skills.map((skill) => [skill.id, skill.slug] as const));
    expect(
      installs.map((install) => [slugById.get(install.skillId), install.installedVersion]).sort(),
    ).toEqual([
      ["email-digest", "1.2.0"],
      ["markdown-report", "2.1.0"],
      ["release-notes", "1.0.0"],
      ["slack-notify", null],
    ]);
    expect(installs.map((install) => install.skillId)).not.toContain(
      skills.find((skill) => skill.slug === "incident-summary")?.id,
    );

    expect(skills.filter((skill) => skill.archivedAt).map((skill) => skill.slug).sort()).toEqual([
      "html-export",
      "screenshot-grab",
    ]);
    expect(skills.find((skill) => skill.slug === "manifest-invalid")).toMatchObject({
      validation: "invalid",
      validationError: expect.stringContaining("intentionally invalid"),
    });

    const edges = await integrationDb.query.skillVersionDependencies.findMany({
      where: eq(schema.skillVersionDependencies.orgId, fixture.orgA),
    });
    const currentSlugByVersion = new Map(
      skills.filter((skill) => skill.currentVersionId).map((skill) => [skill.currentVersionId!, skill.slug] as const),
    );
    expect(edges.map((edge) => `${currentSlugByVersion.get(edge.skillVersionId)}->${edge.dependsOnSlug}`)).toEqual(
      expect.arrayContaining([
        "postmortem-review->incident-summary",
        "browser-check->screenshot-grab",
        "legacy-import->html-sanitize",
        "vault-index->granite-recall",
        "granite-recall->vault-index",
        "private-brief->private-source",
      ]),
    );

    const labels = await integrationDb.query.labels.findMany({ where: eq(schema.labels.orgId, fixture.orgA) });
    const personalLabels = await integrationDb.query.personalLabels.findMany({
      where: and(eq(schema.personalLabels.orgId, fixture.orgA), eq(schema.personalLabels.ownerId, fixture.owner.id)),
    });
    expect(labels.map((label) => label.path)).toContain("growth");
    expect(personalLabels.map((label) => label.path)).toEqual(expect.arrayContaining(["ideas", "research/sources", "drafts/briefs"]));

    const richArchive = storage.archives.get(`${fixture.orgA}/release-notes/1.1.0.tar.gz`)!;
    const richFiles = await extractArchiveEntryBuffers(toTar(richArchive));
    expect(richFiles.violations).toEqual([]);
    expect(richFiles.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "companion.json",
      "examples/input.json",
      "references/template.md",
      "scripts/format.ts",
    ]);

    const auditBeforeChoice = await integrationDb.query.auditLog.findMany({
      where: eq(schema.auditLog.orgId, fixture.orgA),
    });
    expect(auditBeforeChoice.filter((entry) => entry.action === "skill.publish")).toHaveLength(19);
    expect(auditBeforeChoice.filter((entry) => entry.action === "skill.install")).toHaveLength(3);

    const markdown = skills.find((skill) => skill.slug === "markdown-report")!;
    const email = skills.find((skill) => skill.slug === "email-digest")!;
    await integrationDb
      .update(schema.skillInstalls)
      .set({ installedVersion: "1.0.0", agentLabel: "Developer choice", source: "agent" })
      .where(
        and(
          eq(schema.skillInstalls.orgId, fixture.orgA),
          eq(schema.skillInstalls.userId, fixture.owner.id),
          eq(schema.skillInstalls.skillId, markdown.id),
        ),
      );
    await integrationDb
      .update(schema.skills)
      .set({ slug: "markdown-report-custom" })
      .where(and(eq(schema.skills.orgId, fixture.orgA), eq(schema.skills.id, markdown.id)));
    await integrationDb
      .delete(schema.skillInstalls)
      .where(
        and(
          eq(schema.skillInstalls.orgId, fixture.orgA),
          eq(schema.skillInstalls.userId, fixture.owner.id),
          eq(schema.skillInstalls.skillId, email.id),
        ),
      );

    await seedDemoContent(fixture.owner);

    await expect(
      integrationDb.query.skillInstalls.findFirst({
        where: and(
          eq(schema.skillInstalls.orgId, fixture.orgA),
          eq(schema.skillInstalls.userId, fixture.owner.id),
          eq(schema.skillInstalls.skillId, markdown.id),
        ),
      }),
    ).resolves.toMatchObject({ installedVersion: "1.0.0", agentLabel: "Developer choice", source: "agent" });
    await expect(
      integrationDb.query.skillInstalls.findFirst({
        where: and(
          eq(schema.skillInstalls.orgId, fixture.orgA),
          eq(schema.skillInstalls.userId, fixture.owner.id),
          eq(schema.skillInstalls.skillId, email.id),
        ),
      }),
    ).resolves.toBeUndefined();
    const auditAfterChoice = await integrationDb.query.auditLog.findMany({
      where: eq(schema.auditLog.orgId, fixture.orgA),
    });
    expect(auditAfterChoice.filter((entry) => entry.action === "skill.install")).toHaveLength(3);
    expect(auditAfterChoice.filter((entry) => entry.action === "skill.publish")).toHaveLength(20);
  });
});
