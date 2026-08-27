import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import {
  assignCompanionSection,
  createCompanionSection,
  createCompanionV2,
  deleteCompanionSection,
  duplicateCompanionV2,
  listCompanionSections,
  reorderCompanionSections,
  saveCompanionProvider,
  setCompanionWorkspaceShareV2,
  updateCompanionMemberStateV2,
} from "@companion/core";
import { schema, withTenantContext, type Db } from "@companion/db";

import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
  type TestActor,
} from "./testDatabase";

type DatabaseFailure = Error & { code?: string };

function hasDatabaseCode(expected: string): (error: DatabaseFailure) => boolean {
  return (error) => error.code === expected || error.message.includes(expected);
}

/**
 * Sections organize an owner's roster without changing access or runtime ownership. These tests
 * cross the real tenant GUC and SECURITY DEFINER boundary so same-org admin override, cross-tenant
 * assignment, delete cascades, and reorder drift all fail visibly.
 */
describe("Companion sections", () => {
  let fixture: IntegrationFixture;
  let companionId: string;
  const masterKey = Buffer.alloc(32, 73);
  const apiDatabaseUrl = process.env.DATABASE_API_URL;
  const apiSql = apiDatabaseUrl ? postgres(apiDatabaseUrl, { max: 2 }) : null;
  const apiDb: Db | null = apiSql ? drizzle(apiSql, { schema }) : null;

  async function asActor<T>(actor: TestActor, action: (database: Db) => Promise<T>): Promise<T> {
    return withTenantContext({ orgId: fixture.orgA, userId: actor.id }, action);
  }

  async function asApiActor<T>(actor: TestActor, action: (database: Db) => Promise<T>): Promise<T> {
    if (!apiDb || !apiSql) throw new Error("Companion section integration requires DATABASE_API_URL");
    return apiDb.transaction(async (transaction) => {
      await transaction.execute(sql`select
        set_config('app.org_id', ${fixture.orgA}, true),
        set_config('app.user_id', ${actor.id}, true)`);
      return action(Object.assign(transaction, { $client: apiSql }));
    });
  }

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "section-provider-secret",
      masterKey,
      database: integrationDb,
    });
    companionId = (await asActor(fixture.developer, (database) => createCompanionV2({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Luna",
      providerId: "anthropic",
      modelId: "claude-opus-4-8",
      database,
    }))).id;
    await asActor(fixture.developer, (database) => setCompanionWorkspaceShareV2({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      role: "viewer",
      database,
    }));
  });

  afterEach(async () => {
    await integrationDb.delete(schema.companions).where(
      // The fixture cleanup removes the organization too; this explicit delete keeps runtime
      // cleanup deterministic if an assertion fails between section operations.
      eq(schema.companions.orgId, fixture.orgA),
    );
    await fixture.cleanup();
  });

  afterAll(async () => {
    await apiSql?.end();
    await integrationSql.end();
  });

  it("grants the API role only the section capability functions", async () => {
    const section = await asApiActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "API owned",
      database,
    }));
    expect((await asApiActor(fixture.developer, (database) => listCompanionSections({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database,
    }))).map((value) => value.id)).toContain(section.id);

    expect(await apiDb!.select().from(schema.companionSections)).toEqual([]);
    await expect(apiDb!.insert(schema.companionSections).values({
      orgId: fixture.orgA,
      ownerId: fixture.developer.id,
      name: "Bypass",
      position: 9,
    })).rejects.toSatisfy(hasDatabaseCode("42501"));
  });

  it("creates, assigns, lists, reorders, duplicates, and deletes without deleting Companions", async () => {
    const work = await asActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Work",
      database,
    }));
    const personal = await asActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Personal",
      database,
    }));
    const assigned = await asActor(fixture.developer, (database) => assignCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      sectionId: work.id,
      database,
    }));
    expect(assigned.section_id).toBe(work.id);

    const viewerSections = await asActor(fixture.admin, (database) => listCompanionSections({
      actor: fixture.admin,
      orgId: fixture.orgA,
      database,
    }));
    expect(viewerSections.map((section) => section.id)).toEqual([work.id]);

    const reordered = await asActor(fixture.developer, (database) => reorderCompanionSections({
      actor: fixture.developer,
      orgId: fixture.orgA,
      sectionIds: [personal.id, work.id],
      database,
    }));
    expect(reordered.filter((section) => section.owner_id === fixture.developer.id).map((section) => section.id))
      .toEqual([personal.id, work.id]);

    const duplicate = await asActor(fixture.developer, (database) => duplicateCompanionV2({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database,
    }));
    expect(duplicate.section_id).toBe(work.id);

    const unassigned = await asActor(fixture.developer, (database) => deleteCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      sectionId: work.id,
      database,
    }));
    expect(unassigned).toBe(2);
    const survivors = await integrationDb.query.companions.findMany({
      where: (row, { inArray }) => inArray(row.id, [companionId, duplicate.id]),
    });
    expect(survivors).toHaveLength(2);
    expect(survivors.every((row) => row.sectionId === null)).toBe(true);
  });

  it("keeps names unique per owner and rejects admin and cross-tenant assignment", async () => {
    const section = await asActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "Research",
      database,
    }));
    await expect(asActor(fixture.developer, (database) => createCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      name: "research",
      database,
    }))).rejects.toSatisfy(hasDatabaseCode("23505"));

    await expect(asActor(fixture.admin, (database) => assignCompanionSection({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      sectionId: section.id,
      database,
    }))).rejects.toSatisfy(hasDatabaseCode("42501"));

    const foreignSection = await withTenantContext(
      { orgId: fixture.orgB, userId: fixture.outsider.id },
      (database) => createCompanionSection({
        actor: fixture.outsider,
        orgId: fixture.orgB,
        name: "Foreign",
        database,
      }),
    );
    await expect(asActor(fixture.developer, (database) => assignCompanionSection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      sectionId: foreignSection.id,
      database,
    }))).rejects.toSatisfy(hasDatabaseCode("P0002"));
    await expect(integrationSql`
      update public.companions set section_id = ${foreignSection.id}::uuid
      where id = ${companionId}::uuid
    `).rejects.toSatisfy(hasDatabaseCode("23503"));

    await expect(asActor(fixture.developer, (database) => reorderCompanionSections({
      actor: fixture.developer,
      orgId: fixture.orgA,
      sectionIds: [],
      database,
    }))).rejects.toSatisfy(hasDatabaseCode("22023"));
  });

  it("keeps mute member-private and suppresses future notification deliveries", async () => {
    const deviceToken = "7".repeat(64);
    await integrationSql`
      insert into public.companion_notification_devices(
        org_id, installation_id, user_id, device_token, environment, bundle_id
      ) values (
        ${fixture.orgA}::uuid, gen_random_uuid(), ${fixture.developer.id}, ${deviceToken},
        'sandbox', 'dev.companion.mobile.dev'
      )
    `;
    const before = await integrationSql<{ inserted: number }[]>`
      select public.companion_notification_enqueue(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${fixture.developer.id},
        'before-mute', 'reply', 'Luna replied', 'Before mute'
      )::int as inserted
    `;
    expect(before[0]?.inserted).toBe(1);

    const muted = await asApiActor(fixture.developer, (database) => updateCompanionMemberStateV2({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { muted: true },
      database,
    }));
    expect(muted.muted).toBe(true);
    expect(await integrationSql`
      select id from public.companion_notification_deliveries
      where org_id = ${fixture.orgA}::uuid and companion_id = ${companionId}::uuid
    `).toHaveLength(0);

    const after = await integrationSql<{ inserted: number }[]>`
      select public.companion_notification_enqueue(
        ${fixture.orgA}::uuid, ${companionId}::uuid, ${fixture.developer.id},
        'after-mute', 'reply', 'Luna replied', 'After mute'
      )::int as inserted
    `;
    expect(after[0]?.inserted).toBe(0);

    const viewer = await asActor(fixture.admin, (database) => updateCompanionMemberStateV2({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      patch: { muted: false },
      database,
    }));
    expect(viewer.muted).toBe(false);
    expect((await asActor(fixture.developer, (database) => updateCompanionMemberStateV2({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { muted: true },
      database,
    }))).muted).toBe(true);
  });
});
