import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  seedPersonalLabel,
  seedSkill,
  type IntegrationFixture,
  type TestActor,
} from "./testDatabase";

process.env.COMPANION_BILLING_MODE = "off";
process.env.COMPANION_SECRETS_MASTER_KEY ??= Buffer.alloc(32, 7).toString("base64");

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async ({ headers }: { headers: Headers }) => {
        const id = headers.get("x-integration-user");
        if (!id) return null;
        const prefix = id.split("-")[0] ?? "member";
        return {
          user: { id, email: `${id}@example.test`, name: prefix[0]!.toUpperCase() + prefix.slice(1) },
          session: { id: `session-${id}`, userId: id },
        };
      }),
    },
    handler: vi.fn(),
    $Infer: {},
  },
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
}));

import { app } from "../../src/index";

function request(actor: TestActor, orgId: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("x-integration-user", actor.id);
  headers.set("x-companion-org", orgId);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  return app.request(path, { ...init, headers });
}

/**
 * Product promise:
 * A personal skill is private to its creator, and Share atomically moves the existing skill into
 * the organization library without leaking personal folders or half-sharing dependencies.
 *
 * Regression caught:
 * Missing org/creator/scope predicates, copying instead of moving on Share, or mutating before the
 * dependency closure is validated could disclose data or leave a corrupt library.
 *
 * Why this test is integrated:
 * The former fake Drizzle builders reimplemented query behavior and could not prove the HTTP,
 * service, transaction, constraints, and real Postgres query agree.
 *
 * Failure proof:
 * Removing the creator predicate, moving the scope update before dependency validation, or inserting
 * a second row during Share must make this suite fail.
 */
describe("tenant-safe personal skill lifecycle", () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
  });

  afterAll(async () => fixture.cleanup());

  it("hides a personal skill from same-org admins and cross-tenant actors until its owner shares it", async () => {
    const slug = `private-${fixture.suffix}`;
    const personal = await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug, scope: "personal" });
    const otherTenant = await seedSkill({ orgId: fixture.orgB, creator: fixture.outsider, slug, scope: "org" });
    await seedPersonalLabel({
      orgId: fixture.orgA,
      owner: fixture.owner,
      skillId: personal.id,
      path: "private/research",
    });

    const ownerMine = await request(fixture.owner, fixture.orgA, "/v1/skills?lib=mine");
    expect(ownerMine.status).toBe(200);
    expect(await ownerMine.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: personal.id, slug, scope: "personal" })]));

    for (const actor of [fixture.admin, fixture.developer]) {
      const mine = await request(actor, fixture.orgA, "/v1/skills?lib=mine");
      expect(mine.status).toBe(200);
      expect(JSON.stringify(await mine.json())).not.toContain(slug);
      const search = await request(actor, fixture.orgA, `/v1/skills?lib=mine&q=${encodeURIComponent(slug)}`);
      expect(search.status).toBe(200);
      expect(await search.json()).toEqual([]);
    }

    const outsiderMine = await request(fixture.outsider, fixture.orgA, "/v1/skills?lib=mine");
    expect(outsiderMine.status).toBeGreaterThanOrEqual(400);
    expect(await outsiderMine.text()).not.toContain(slug);

    for (const path of [
      `/v1/skills/${slug}`,
      `/v1/skills/${slug}/versions`,
      `/v1/skills/${slug}/download`,
    ]) {
      const hidden = await request(fixture.admin, fixture.orgA, path);
      const unknown = await request(fixture.admin, fixture.orgA, `${path.split(slug).join(`unknown-${fixture.suffix}`)}`);
      expect({ status: hidden.status, body: await hidden.text() }).toEqual({ status: unknown.status, body: await unknown.text() });

      const outsiderHidden = await request(fixture.outsider, fixture.orgA, path);
      const outsiderUnknown = await request(
        fixture.outsider,
        fixture.orgA,
        `${path.split(slug).join(`unknown-${fixture.suffix}`)}`,
      );
      expect({ status: outsiderHidden.status, body: await outsiderHidden.text() }).toEqual({
        status: outsiderUnknown.status,
        body: await outsiderUnknown.text(),
      });
    }

    const outsiderDetail = await request(fixture.outsider, fixture.orgB, `/v1/skills/${slug}`);
    expect(outsiderDetail.status).toBe(200);
    await expect(outsiderDetail.json()).resolves.toMatchObject({ id: otherTenant.id, org_id: fixture.orgB });

    const shared = await request(fixture.owner, fixture.orgA, `/v1/skills/${slug}/share`, { method: "POST" });
    expect(shared.status).toBe(200);
    await expect(shared.json()).resolves.toMatchObject({ ok: true, slug, scope: "org", shared_dependencies: [] });

    const persisted = await integrationDb.query.skills.findFirst({
      where: and(eq(schema.skills.orgId, fixture.orgA), eq(schema.skills.slug, slug)),
    });
    expect(persisted).toMatchObject({ id: personal.id, currentVersionId: personal.versionId, scope: "org" });
    await expect(
      integrationDb.query.personalSkillLabels.findMany({
        where: and(eq(schema.personalSkillLabels.orgId, fixture.orgA), eq(schema.personalSkillLabels.skillId, personal.id)),
      }),
    ).resolves.toHaveLength(0);
    await expect(
      integrationDb.query.auditLog.findFirst({
        where: and(eq(schema.auditLog.orgId, fixture.orgA), eq(schema.auditLog.targetId, personal.id)),
      }),
    ).resolves.toMatchObject({ action: "skill.share", metadata: { slug, shared_dependencies: [] } });

    const adminDetail = await request(fixture.admin, fixture.orgA, `/v1/skills/${slug}`);
    expect(adminDetail.status).toBe(200);
    await expect(adminDetail.json()).resolves.toMatchObject({ id: personal.id, scope: "org" });

    const renamedSlug = `${slug}-shared`;
    const renamed = await request(fixture.admin, fixture.orgA, `/v1/skills/${slug}/rename`, {
      method: "POST",
      body: JSON.stringify({ newSlug: renamedSlug }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({ slug: renamedSlug });

    const developerDetail = await request(fixture.developer, fixture.orgA, `/v1/skills/${renamedSlug}`);
    expect(developerDetail.status).toBe(200);
    const developerRenamedSlug = `${renamedSlug}-member`;
    const developerRename = await request(fixture.developer, fixture.orgA, `/v1/skills/${renamedSlug}/rename`, {
      method: "POST",
      body: JSON.stringify({ newSlug: developerRenamedSlug }),
    });
    expect(developerRename.status).toBe(200);

    const reverseShare = await request(fixture.owner, fixture.orgA, `/v1/skills/${developerRenamedSlug}/share`, { method: "POST" });
    expect(reverseShare.status).toBeGreaterThanOrEqual(400);
    await expect(
      integrationDb.query.skills.findFirst({ where: eq(schema.skills.id, personal.id) }),
    ).resolves.toMatchObject({ scope: "org" });
  });

  it("keeps Share atomic when a dependency belongs to another member", async () => {
    const root = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `root-${fixture.suffix}`,
      scope: "personal",
    });
    const hiddenDependency = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.developer,
      slug: `hidden-dependency-${fixture.suffix}`,
      scope: "personal",
    });
    await seedPersonalLabel({ orgId: fixture.orgA, owner: fixture.owner, skillId: root.id, path: "private/atomic" });
    await integrationDb.insert(schema.skillVersionDependencies).values({
      orgId: fixture.orgA,
      skillVersionId: root.versionId,
      skillId: root.id,
      dependsOnSlug: hiddenDependency.slug,
      dependsOnSkillId: hiddenDependency.id,
    });

    const response = await request(fixture.owner, fixture.orgA, `/v1/skills/${root.slug}/share`, { method: "POST" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: expect.stringContaining("resolved") });

    const rows = await integrationDb
      .select({ id: schema.skills.id, scope: schema.skills.scope })
      .from(schema.skills)
      .where(eq(schema.skills.orgId, fixture.orgA));
    expect(rows.find((row) => row.id === root.id)?.scope).toBe("personal");
    expect(rows.find((row) => row.id === hiddenDependency.id)?.scope).toBe("personal");
    await expect(
      integrationDb.query.personalSkillLabels.findMany({
        where: and(eq(schema.personalSkillLabels.orgId, fixture.orgA), eq(schema.personalSkillLabels.skillId, root.id)),
      }),
    ).resolves.toHaveLength(1);
    await expect(
      integrationDb.query.auditLog.findFirst({
        where: and(eq(schema.auditLog.orgId, fixture.orgA), eq(schema.auditLog.targetId, root.id)),
      }),
    ).resolves.toBeUndefined();
  });

  it("shares the complete direct and transitive dependency closure as one migration", async () => {
    const root = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `closure-root-${fixture.suffix}`,
      scope: "personal",
    });
    const direct = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `closure-direct-${fixture.suffix}`,
      scope: "personal",
    });
    const transitive = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `closure-transitive-${fixture.suffix}`,
      scope: "personal",
    });
    const alreadyShared = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.admin,
      slug: `closure-org-${fixture.suffix}`,
      scope: "org",
    });
    for (const skill of [root, direct, transitive]) {
      await seedPersonalLabel({
        orgId: fixture.orgA,
        owner: fixture.owner,
        skillId: skill.id,
        path: `private/closure-${fixture.suffix}/${skill.slug}`,
      });
    }
    await integrationDb.insert(schema.skillVersionDependencies).values([
      {
        orgId: fixture.orgA,
        skillVersionId: root.versionId,
        skillId: root.id,
        dependsOnSlug: direct.slug,
        dependsOnSkillId: direct.id,
      },
      {
        orgId: fixture.orgA,
        skillVersionId: direct.versionId,
        skillId: direct.id,
        dependsOnSlug: transitive.slug,
        dependsOnSkillId: transitive.id,
      },
      {
        orgId: fixture.orgA,
        skillVersionId: direct.versionId,
        skillId: direct.id,
        dependsOnSlug: alreadyShared.slug,
        dependsOnSkillId: alreadyShared.id,
      },
    ]);

    const response = await request(fixture.owner, fixture.orgA, `/v1/skills/${root.slug}/share`, { method: "POST" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      scope: "org",
      shared_dependencies: [direct.slug, transitive.slug].sort(),
    });

    const migrated = await integrationDb
      .select({ id: schema.skills.id, scope: schema.skills.scope, currentVersionId: schema.skills.currentVersionId })
      .from(schema.skills)
      .where(eq(schema.skills.orgId, fixture.orgA));
    for (const skill of [root, direct, transitive]) {
      expect(migrated.find((row) => row.id === skill.id)).toMatchObject({
        scope: "org",
        currentVersionId: skill.versionId,
      });
    }
    expect(migrated.find((row) => row.id === alreadyShared.id)).toMatchObject({
      scope: "org",
      currentVersionId: alreadyShared.versionId,
    });
    await expect(
      integrationDb.query.personalSkillLabels.findMany({
        where: and(
          eq(schema.personalSkillLabels.orgId, fixture.orgA),
          eq(schema.personalSkillLabels.ownerId, fixture.owner.id),
          inArray(schema.personalSkillLabels.skillId, [root.id, direct.id, transitive.id]),
        ),
      }),
    ).resolves.toHaveLength(0);

    for (const skill of [root, direct, transitive]) {
      const visible = await request(fixture.developer, fixture.orgA, `/v1/skills/${skill.slug}`);
      expect(visible.status).toBe(200);
      await expect(visible.json()).resolves.toMatchObject({ id: skill.id, scope: "org" });
    }
  });

  it("enforces one slug across personal and org libraries while allowing the same slug in another tenant", async () => {
    const slug = `workspace-unique-${fixture.suffix}`;
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug, scope: "personal" });
    await expect(seedSkill({ orgId: fixture.orgA, creator: fixture.admin, slug, scope: "org" })).rejects.toThrow();
    await expect(seedSkill({ orgId: fixture.orgB, creator: fixture.outsider, slug, scope: "org" })).resolves.toMatchObject({ slug });
  });
});
