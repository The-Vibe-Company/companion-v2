import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { extractRuntimeRoleGrantBlock, resolveRuntimeRoleGrantsFile } from "../../src/migrate";
import {
  CompanionRuntimeTransitionError,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  updateCompanionObservation,
} from "@companion/core";
import { withTenantContext } from "@companion/db";
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
  const companionId = randomUUID();

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    personalSlug = `private-${fixture.suffix}`;
    orgSlug = `org-${fixture.suffix}`;
    otherOrgSlug = `other-${fixture.suffix}`;
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: personalSlug, scope: "personal" });
    await seedSkill({ orgId: fixture.orgA, creator: fixture.owner, slug: orgSlug, scope: "org" });
    await seedSkill({ orgId: fixture.orgB, creator: fixture.outsider, slug: otherOrgSlug, scope: "org" });
    await integrationSql`
      insert into companions (id, org_id, owner_id, name)
      values (${companionId}, ${fixture.orgA}, ${fixture.owner.id}, 'RLS companion')
    `;
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
    await integrationSql`delete from companions where id = ${companionId}`;
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

  it("lets members read Companion metadata but only the owner mutate its runtime projection", async () => {
    const visible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ id: string }>>`select id from companions`;
    });
    expect(visible.map((row) => row.id)).toContain(companionId);

    const adminUpdates = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgA}, true), set_config('app.user_id', ${fixture.admin.id}, true)`;
      return tx<Array<{ id: string }>>`
        update companions set runtime_state = 'running' where id = ${companionId} returning id
      `;
    });
    expect(adminUpdates).toEqual([]);

    const outsiderVisible = await integrationSql.begin(async (tx) => {
      await tx.unsafe(`set local role ${apiRole}`);
      await tx`select set_config('app.org_id', ${fixture.orgB}, true), set_config('app.user_id', ${fixture.outsider.id}, true)`;
      return tx<Array<{ id: string }>>`select id from companions`;
    });
    expect(outsiderVisible).toEqual([]);
  });

  it("CAS-claims lifecycle transitions and keeps live observations from clobbering them", async () => {
    await integrationSql`
      update companions
      set box_id = 'bx_23456789', runtime_state = 'stopped', daemon_state = 'stopped'
      where id = ${companionId}
    `;
    const input = {
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
    };

    const started = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStart({ ...input, database }),
    );
    expect(started.runtime.state).toBe("provisioning");
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStart({ ...input, database }),
    )).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);

    const observed = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => updateCompanionObservation({
        ...input,
        patch: {
          runtimeState: "stopped",
          daemonState: "stopped",
          desktopAvailable: false,
          observedAt: new Date(),
        },
        database,
      }),
    );
    expect(observed.runtime.state).toBe("provisioning");

    await integrationSql`
      update companions set runtime_state = 'running', daemon_state = 'running'
      where id = ${companionId}
    `;
    const stopped = await withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStop({ ...input, database }),
    );
    expect(stopped.runtime.state).toBe("stopping");
    await expect(withTenantContext(
      { orgId: fixture.orgA, userId: fixture.owner.id },
      (database) => claimCompanionRuntimeStop({ ...input, database }),
    )).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);
  });
});
