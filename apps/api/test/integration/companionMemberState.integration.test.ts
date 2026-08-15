import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompanionDeleteForbiddenError,
  CompanionDuplicateForbiddenError,
  deleteCompanion,
  duplicateCompanion,
  getCompanion,
  getCompanionThread,
  listCompanions,
  saveCompanionProvider,
  sendCompanionMessage,
  updateCompanionMemberState,
} from "@companion/core";
import {
  COMPANION_PROVIDER_CATALOG,
  type CompanionProviderDefinition,
} from "@companion/contracts";
import { schema } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise (THE-351): pin order, unread clear-on-open, hide/unhide, and Owner-only
 * duplicate stay member-scoped and never archive the Box.
 *
 * Why integrated: member-state rows, transcript ordinals, and Companion create/delete are database
 * facts that route mocks cannot prove across Viewer and Owner.
 */
describe("Companion member list preferences", () => {
  let fixture: IntegrationFixture;
  let companionId: string;
  let secondId: string;
  const masterKey = Buffer.alloc(32, 51);
  const providerCatalog: CompanionProviderDefinition[] = COMPANION_PROVIDER_CATALOG.map(
    (provider) => ({
      ...provider,
      auth_methods: [...provider.auth_methods],
      models: provider.models.map((model) => ({ ...model })),
    }),
  );

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
    companionId = randomUUID();
    secondId = randomUUID();
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "integration-secret",
      masterKey,
      database: integrationDb,
    });
    await integrationDb.insert(schema.companions).values([
      {
        id: companionId,
        orgId: fixture.orgA,
        ownerId: fixture.developer.id,
        name: "Alpha",
        persona: "First",
        providerIds: ["anthropic"],
        modelId: "claude-opus-4-8",
        selectedSkillIds: [],
        selectedMcpAccountIds: [],
        updatedAt: new Date("2026-08-12T12:00:00.000Z"),
      },
      {
        id: secondId,
        orgId: fixture.orgA,
        ownerId: fixture.developer.id,
        name: "Beta",
        persona: "Second",
        providerIds: ["anthropic"],
        modelId: "claude-opus-4-8",
        selectedSkillIds: [],
        selectedMcpAccountIds: [],
        updatedAt: new Date("2026-08-12T13:00:00.000Z"),
      },
    ]);
    await integrationDb.insert(schema.companionWorkspaceAccess).values({
      orgId: fixture.orgA,
      companionId,
      ownerId: fixture.developer.id,
      role: "viewer",
      grantedBy: fixture.developer.id,
    });
    await integrationDb.insert(schema.companionWorkspaceAccess).values({
      orgId: fixture.orgA,
      companionId: secondId,
      ownerId: fixture.developer.id,
      role: "viewer",
      grantedBy: fixture.developer.id,
    });
  });

  afterEach(async () => {
    await integrationDb.delete(schema.companions).where(eq(schema.companions.orgId, fixture.orgA));
    await fixture.cleanup();
  });

  afterAll(async () => {
    await integrationSql.end();
  });

  it("keeps pinned Companions stable above unpinned ones for each member", async () => {
    const ownerListBefore = await listCompanions({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database: integrationDb,
    });
    expect(ownerListBefore.map((item) => item.name)).toEqual(["Beta", "Alpha"]);

    await updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { pinned: true },
      database: integrationDb,
    });
    await updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId: secondId,
      patch: { pinned: true },
      database: integrationDb,
    });

    const ownerPinned = await listCompanions({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database: integrationDb,
    });
    // Earlier pin stays above later pin.
    expect(ownerPinned.map((item) => item.id)).toEqual([companionId, secondId]);
    expect(ownerPinned.every((item) => item.pinned)).toBe(true);

    // Viewer pin is independent.
    await updateCompanionMemberState({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId: secondId,
      patch: { pinned: true },
      database: integrationDb,
    });
    const viewerList = await listCompanions({
      actor: fixture.admin,
      orgId: fixture.orgA,
      database: integrationDb,
    });
    expect(viewerList.map((item) => item.id)).toEqual([secondId, companionId]);
    expect(viewerList.find((item) => item.id === companionId)?.pinned).toBe(false);
  });

  it("shows unread until the member opens the thread, including for Viewer", async () => {
    await sendCompanionMessage({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      content: "Hello from owner",
      database: integrationDb,
    });
    // Owner's own send clears unread for the sender.
    const ownerAfterSend = await getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(ownerAfterSend.unread).toBe(false);

    const viewerBefore = await getCompanion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(viewerBefore.unread).toBe(true);

    await getCompanionThread({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    const viewerAfterOpen = await getCompanion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(viewerAfterOpen.unread).toBe(false);

    await updateCompanionMemberState({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      patch: { unread: true },
      database: integrationDb,
    });
    expect((await getCompanion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    })).unread).toBe(true);
  });

  it("hides without deleting and unhides from member state", async () => {
    await updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { hidden: true },
      database: integrationDb,
    });
    const hidden = await getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(hidden.hidden).toBe(true);
    expect(hidden.runtime.box_id).toBeNull();

    const row = await integrationDb.query.companions.findFirst({
      where: and(
        eq(schema.companions.orgId, fixture.orgA),
        eq(schema.companions.id, companionId),
      ),
    });
    expect(row).toBeTruthy();

    await updateCompanionMemberState({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { hidden: false },
      database: integrationDb,
    });
    expect((await getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    })).hidden).toBe(false);
  });

  it("duplicates into a new Companion and Box selection for Owner only", async () => {
    await integrationDb.update(schema.companions).set({
      selectedSkillIds: [],
      canWriteSkills: true,
      selectedMcpAccountIds: [],
    }).where(eq(schema.companions.id, companionId));

    const cloned = await duplicateCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      providerCatalog,
      database: integrationDb,
    });
    expect(cloned.id).not.toBe(companionId);
    expect(cloned.name).toBe("Alpha (copy)");
    expect(cloned.persona).toBe("First");
    expect(cloned.model_id).toBe("claude-opus-4-8");
    expect(cloned.can_write_skills).toBe(true);
    expect(cloned.runtime.box_id).toBeNull();
    expect(cloned.runtime.state).toBe("not_created");
    expect(cloned.owner_id).toBe(fixture.developer.id);

    const sourceShare = await integrationDb.query.companionWorkspaceAccess.findFirst({
      where: eq(schema.companionWorkspaceAccess.companionId, companionId),
    });
    const cloneShare = await integrationDb.query.companionWorkspaceAccess.findFirst({
      where: eq(schema.companionWorkspaceAccess.companionId, cloned.id),
    });
    expect(sourceShare?.role).toBe("viewer");
    expect(cloneShare).toBeUndefined();

    await expect(duplicateCompanion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      providerCatalog,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionDuplicateForbiddenError);

    await expect(deleteCompanion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionDeleteForbiddenError);
  });
});
