import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";
import {
  createIntegrationFixture,
  integrationSql,
  seedSkill,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise: PostgreSQL enforces organization isolation for the non-bypass API role, while
 * creator-only personal-skill access remains an additional service-layer gate.
 *
 * Regression caught: dropping FORCE RLS or the organization predicate.
 *
 * Why integrated: table owners and mocked query builders cannot prove PostgreSQL policy behavior.
 *
 * Failure proof: removing the org predicate makes the cross-tenant query return the outsider's skill.
 */
describe("Skills Hub PostgreSQL isolation", () => {
  const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
  const apiRole = `companion_api_${suffix}`;
  const workerRole = `companion_worker_${suffix}`;
  let fixture: IntegrationFixture;
  let personalSlug: string;
  let orgSlug: string;
  let otherOrgSlug: string;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    personalSlug = `private-${fixture.suffix}`;
    orgSlug = `org-${fixture.suffix}`;
    otherOrgSlug = `other-${fixture.suffix}`;
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: personalSlug, scope: "personal" });
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: orgSlug, scope: "org" });
    await seedSkill({ orgId: fixture.orgB, creator: fixture.outsider, slug: otherOrgSlug, scope: "org" });
    await integrationSql.unsafe(`create role ${apiRole} login nosuperuser nobypassrls noinherit`);
    await integrationSql.unsafe(`create role ${workerRole} login nosuperuser nobypassrls noinherit`);
    const grants = extractRuntimeRoleGrantBlock(await readFile(await resolveRuntimeRoleGrantsFile(), "utf8"));
    await integrationSql.begin(async (tx) => {
      await tx`select set_config('companion.api_role', ${apiRole}, true)`;
      await tx`select set_config('companion.worker_role', ${workerRole}, true)`;
      await tx.unsafe(grants);
    });
  });

  afterAll(async () => {
    await fixture.cleanup();
    await integrationSql.unsafe(`drop owned by ${apiRole}`);
    await integrationSql.unsafe(`drop owned by ${workerRole}`);
    await integrationSql.unsafe(`drop role ${apiRole}`);
    await integrationSql.unsafe(`drop role ${workerRole}`);
  });

  async function visibleSlugs(orgId: string, userId: string): Promise<string[]> {
    return integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${orgId}, true), set_config('app.user_id', ${userId}, true)`;
      const rows = await tx<Array<{ slug: string }>>`select slug from skills order by slug`;
      return rows.map((row) => row.slug);
    });
  }

  it("shows an owner their personal and org skills but hides both from other tenants", async () => {
    expect(await visibleSlugs(fixture.orgA, fixture.owner.id)).toEqual([orgSlug, personalSlug].sort());
    expect(await visibleSlugs(fixture.orgB, fixture.outsider.id)).toEqual([otherOrgSlug]);
  });
});
