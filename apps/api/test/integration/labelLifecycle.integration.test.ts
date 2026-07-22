import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
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
        return {
          user: { id, email: `${id}@example.test`, name: id.split("-")[0] },
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

async function mutate(actor: TestActor, orgId: string, path: string, method: string, body: object) {
  const response = await request(actor, orgId, path, { method, body: JSON.stringify(body) });
  expect(response.status, await response.text()).toBe(200);
}

/**
 * Product promise:
 * Organization labels are one shared tree for every member, while personal labels and assignments
 * belong only to their owner, with no admin override and no cross-tenant bleed.
 *
 * Regression caught:
 * Missing org_id/owner_id predicates or a non-transactional subtree rename could expose private
 * folders, move another member's skill, or leave labels and assignments on different paths.
 *
 * Why this test is integrated:
 * The former fake Drizzle builders implemented their own query semantics. HTTP against migrated
 * Postgres is required to prove route parsing, service predicates, cascades, and constraints agree.
 *
 * Failure proof:
 * Removing tenant/owner predicates, empty-folder persistence, or destructive-rename guards must
 * reveal, mutate, merge, or corrupt a protected tree and make the corresponding scenario fail.
 */
describe("shared and personal label lifecycle", () => {
  let fixture: IntegrationFixture;
  let short: string;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    short = fixture.suffix.slice(0, 8);
  });

  afterAll(async () => fixture.cleanup());

  it("lets any member manage the shared org tree without crossing tenant boundaries", async () => {
    const skill = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `org-label-${short}`,
      scope: "org",
    });
    const from = `engineering-${short}`;
    const childFrom = `${from}/tools`;
    const to = `platform-${short}`;
    const childTo = `${to}/tools`;

    await mutate(fixture.developer, fixture.orgA, "/v1/labels", "POST", { path: from });
    const emptyTree = await request(fixture.owner, fixture.orgA, "/v1/labels");
    const emptyLabels = (await emptyTree.json()) as { tree: Array<{ path: string; count: number }> };
    expect(emptyLabels.tree).toContainEqual(expect.objectContaining({ path: from, count: 0 }));

    await mutate(fixture.developer, fixture.orgA, "/v1/labels", "POST", { path: childFrom });
    await mutate(fixture.developer, fixture.orgA, `/v1/skills/${skill.slug}/labels`, "POST", { path: childFrom });
    await mutate(fixture.outsider, fixture.orgB, "/v1/labels", "POST", { path: from });
    await mutate(fixture.outsider, fixture.orgB, "/v1/labels", "POST", { path: childFrom });

    const ownerTree = await request(fixture.owner, fixture.orgA, "/v1/labels");
    expect(ownerTree.status).toBe(200);
    expect(JSON.stringify(await ownerTree.json())).toContain(childFrom);

    await mutate(fixture.owner, fixture.orgA, "/v1/labels/rename", "PUT", { from, to });
    const detailAfterRename = await request(fixture.admin, fixture.orgA, `/v1/skills/${skill.slug}`);
    expect(detailAfterRename.status).toBe(200);
    await expect(detailAfterRename.json()).resolves.toMatchObject({ labels: [childTo] });
    await expect(
      integrationDb.query.labels.findMany({
        where: and(eq(schema.labels.orgId, fixture.orgB), eq(schema.labels.path, childFrom)),
      }),
    ).resolves.toHaveLength(1);

    const outsiderTree = await request(fixture.outsider, fixture.orgA, "/v1/labels");
    expect(outsiderTree.status).toBeGreaterThanOrEqual(400);
    expect(await outsiderTree.text()).not.toContain(childTo);

    await mutate(fixture.admin, fixture.orgA, "/v1/labels", "DELETE", { path: to });
    const detailAfterDelete = await request(fixture.developer, fixture.orgA, `/v1/skills/${skill.slug}`);
    await expect(detailAfterDelete.json()).resolves.toMatchObject({ labels: [] });
    await expect(
      integrationDb.query.labels.findMany({
        where: and(eq(schema.labels.orgId, fixture.orgB), eq(schema.labels.path, childFrom)),
      }),
    ).resolves.toHaveLength(1);
  });

  it("keeps personal trees owner-only through assignment, subtree rename, and deletion", async () => {
    const skill = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `personal-label-${short}`,
      scope: "personal",
    });
    const from = `private-${short}`;
    const childFrom = `${from}/research`;
    const to = `drafts-${short}`;
    const childTo = `${to}/research`;

    await mutate(fixture.owner, fixture.orgA, "/v1/personal-labels", "POST", { path: from });
    const emptyTree = await request(fixture.owner, fixture.orgA, "/v1/personal-labels");
    const emptyLabels = (await emptyTree.json()) as { tree: Array<{ path: string; count: number }> };
    expect(emptyLabels.tree).toContainEqual(expect.objectContaining({ path: from, count: 0 }));

    await mutate(fixture.owner, fixture.orgA, "/v1/personal-labels", "POST", { path: childFrom });
    await mutate(fixture.owner, fixture.orgA, `/v1/skills/${skill.slug}/personal-labels`, "POST", { path: childFrom });

    const ownerTree = await request(fixture.owner, fixture.orgA, "/v1/personal-labels");
    expect(JSON.stringify(await ownerTree.json())).toContain(childFrom);
    const adminTree = await request(fixture.admin, fixture.orgA, "/v1/personal-labels");
    expect(JSON.stringify(await adminTree.json())).not.toContain(childFrom);
    await mutate(fixture.admin, fixture.orgA, "/v1/personal-labels", "POST", { path: from });
    await mutate(fixture.admin, fixture.orgA, "/v1/personal-labels", "POST", { path: childFrom });

    const adminAssignment = await request(fixture.admin, fixture.orgA, `/v1/skills/${skill.slug}/personal-labels`, {
      method: "POST",
      body: JSON.stringify({ path: childFrom }),
    });
    expect(adminAssignment.status).toBeGreaterThanOrEqual(400);
    expect(await adminAssignment.text()).not.toContain(skill.id);

    await mutate(fixture.owner, fixture.orgA, "/v1/personal-labels/rename", "PUT", { from, to });
    const persisted = await integrationDb.query.personalSkillLabels.findMany({
      where: and(
        eq(schema.personalSkillLabels.orgId, fixture.orgA),
        eq(schema.personalSkillLabels.ownerId, fixture.owner.id),
        eq(schema.personalSkillLabels.skillId, skill.id),
      ),
    });
    expect(persisted).toEqual([expect.objectContaining({ path: childTo })]);
    await expect(
      integrationDb.query.personalLabels.findMany({
        where: and(
          eq(schema.personalLabels.orgId, fixture.orgA),
          eq(schema.personalLabels.ownerId, fixture.admin.id),
          eq(schema.personalLabels.path, childFrom),
        ),
      }),
    ).resolves.toHaveLength(1);
    const ownerTreeAfterAdminCreate = await request(fixture.owner, fixture.orgA, "/v1/personal-labels");
    const ownerLabels = (await ownerTreeAfterAdminCreate.json()) as { flat: Array<{ path: string }> };
    expect(ownerLabels.flat.filter((label) => label.path === childTo)).toHaveLength(1);

    await mutate(fixture.owner, fixture.orgA, "/v1/personal-labels", "DELETE", { path: to });
    await expect(
      integrationDb.query.personalSkillLabels.findMany({
        where: and(
          eq(schema.personalSkillLabels.orgId, fixture.orgA),
          eq(schema.personalSkillLabels.ownerId, fixture.owner.id),
          eq(schema.personalSkillLabels.skillId, skill.id),
        ),
      }),
    ).resolves.toHaveLength(0);
    await expect(
      integrationDb.query.personalLabels.findMany({
        where: and(
          eq(schema.personalLabels.orgId, fixture.orgA),
          eq(schema.personalLabels.ownerId, fixture.admin.id),
          eq(schema.personalLabels.path, childFrom),
        ),
      }),
    ).resolves.toHaveLength(1);
  });

  it("rejects renaming an org folder onto an existing target or into its own subtree without mutation", async () => {
    const skill = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `rename-guard-${short}`,
      scope: "org",
    });
    const source = `rename-source-${short}`;
    const sourceChild = `${source}/child`;
    const target = `rename-target-${short}`;
    await mutate(fixture.owner, fixture.orgA, "/v1/labels", "POST", { path: source });
    await mutate(fixture.owner, fixture.orgA, "/v1/labels", "POST", { path: sourceChild });
    await mutate(fixture.owner, fixture.orgA, "/v1/labels", "POST", { path: target });
    await mutate(fixture.owner, fixture.orgA, `/v1/skills/${skill.slug}/labels`, "POST", { path: sourceChild });

    const collision = await request(fixture.owner, fixture.orgA, "/v1/labels/rename", {
      method: "PUT",
      body: JSON.stringify({ from: source, to: target }),
    });
    expect(collision.status).toBeGreaterThanOrEqual(400);
    await expect(collision.json()).resolves.toMatchObject({ error: expect.stringContaining("already exists") });

    const selfSubtree = await request(fixture.owner, fixture.orgA, "/v1/labels/rename", {
      method: "PUT",
      body: JSON.stringify({ from: source, to: `${source}/nested` }),
    });
    expect(selfSubtree.status).toBeGreaterThanOrEqual(400);
    await expect(selfSubtree.json()).resolves.toMatchObject({ error: expect.stringContaining("own subtree") });

    const paths = await integrationDb.query.labels.findMany({
      where: eq(schema.labels.orgId, fixture.orgA),
    });
    expect(paths.map((label) => label.path)).toEqual(expect.arrayContaining([source, sourceChild, target]));
    expect(paths.map((label) => label.path)).not.toContain(`${target}/child`);
    expect(paths.map((label) => label.path)).not.toContain(`${source}/nested`);
    const detail = await request(fixture.developer, fixture.orgA, `/v1/skills/${skill.slug}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({ labels: [sourceChild] });
  });
});
