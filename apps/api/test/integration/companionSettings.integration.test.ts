import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompanionDeleteForbiddenError,
  CompanionNotFoundError,
  CompanionRuntimeTransitionError,
  CompanionSettingsForbiddenError,
  claimCompanionDeletion,
  claimCompanionRuntimeStop,
  deleteCompanion,
  getCompanion,
  saveCompanionProvider,
  updateCompanion,
  updateCompanionRuntime,
} from "@companion/core";
import { schema } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise (THE-338): Companion Owner and Editor settings persist in PostgreSQL, Viewer and
 * cross-tenant writes fail closed, and an Owner deletion leaves no row that a later wake can load.
 *
 * Why integrated: the workspace grant, tenant predicates, provider connection, persisted fields,
 * and cascading delete are database facts that route mocks cannot prove.
 */
describe("Companion settings persistence and roles", () => {
  let fixture: IntegrationFixture;
  let companionId: string;
  const masterKey = Buffer.alloc(32, 38);

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
    companionId = randomUUID();
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "anthropic",
      authMethod: "api_key",
      credential: "integration-secret",
      masterKey,
      database: integrationDb,
    });
    await saveCompanionProvider({
      actor: fixture.owner,
      orgId: fixture.orgA,
      providerId: "openai-codex",
      authMethod: "subscription",
      credential: { type: "oauth", access: "integration-token" },
      masterKey,
      database: integrationDb,
    });
    await integrationDb.insert(schema.companions).values({
      id: companionId,
      orgId: fixture.orgA,
      ownerId: fixture.developer.id,
      name: "Research",
      persona: "Check the incident.",
      providerIds: ["anthropic"],
      modelId: "claude-opus-4-8",
      boxId: "bx_23456789",
      runtimeState: "stopped",
      daemonState: "stopped",
    });
  });

  afterEach(async () => {
    await integrationDb.delete(schema.companions).where(eq(schema.companions.orgId, fixture.orgA));
    await fixture.cleanup();
  });

  afterAll(async () => {
    await integrationSql.end();
  });

  it("persists Owner and Editor changes while Viewer and cross-tenant writes fail closed", async () => {
    const ownerEdit = await updateCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      name: "Evidence desk",
      persona: "Challenge every source.",
      providerId: "openai-codex",
      database: integrationDb,
    });
    expect(ownerEdit).toMatchObject({
      name: "Evidence desk",
      persona: "Challenge every source.",
      access: "owner",
    });
    expect(ownerEdit.runtime.provider_ids).toEqual(["openai-codex"]);
    expect(ownerEdit.model_id).toBe("gpt-5.5");
    expect(ownerEdit.runtime.provider_credential_generation).toBeNull();

    await integrationDb.insert(schema.companionWorkspaceAccess).values({
      orgId: fixture.orgA,
      companionId,
      ownerId: fixture.developer.id,
      role: "editor",
      grantedBy: fixture.developer.id,
    });
    const editorEdit = await updateCompanion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      name: "Evidence editor",
      database: integrationDb,
    });
    expect(editorEdit).toMatchObject({ name: "Evidence editor", access: "editor" });

    await integrationDb
      .update(schema.companionWorkspaceAccess)
      .set({ role: "viewer" })
      .where(and(
        eq(schema.companionWorkspaceAccess.orgId, fixture.orgA),
        eq(schema.companionWorkspaceAccess.companionId, companionId),
      ));
    await expect(updateCompanion({
      actor: fixture.owner,
      orgId: fixture.orgA,
      companionId,
      name: "Viewer cannot write",
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionSettingsForbiddenError);
    await expect(updateCompanion({
      actor: fixture.outsider,
      orgId: fixture.orgA,
      companionId,
      name: "Cross tenant",
      database: integrationDb,
    })).rejects.toThrow("not a member");

    const reloaded = await getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(reloaded).toMatchObject({
      name: "Evidence editor",
      persona: "Challenge every source.",
    });
    expect(reloaded.runtime.provider_ids).toEqual(["openai-codex"]);
    expect(reloaded.model_id).toBe("gpt-5.5");
  });

  it("persists only a catalog model for the selected provider", async () => {
    const updated = await updateCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      modelId: "claude-sonnet-4-6",
      database: integrationDb,
    });
    expect(updated.model_id).toBe("claude-sonnet-4-6");

    await expect(updateCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      modelId: "glm-4.7",
      database: integrationDb,
    })).rejects.toMatchObject({
      code: "provider_model_invalid",
      providerId: "anthropic",
    });
  });

  it("keeps legacy provider-less Companions editable until a provider is selected", async () => {
    const legacyCompanionId = randomUUID();
    await integrationDb.insert(schema.companions).values({
      id: legacyCompanionId,
      orgId: fixture.orgA,
      ownerId: fixture.developer.id,
      name: "Legacy Companion",
    });

    const updated = await updateCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId: legacyCompanionId,
      name: "Renamed legacy Companion",
      persona: "Keep existing setup readable.",
      database: integrationDb,
    });

    expect(updated).toMatchObject({
      name: "Renamed legacy Companion",
      persona: "Keep existing setup readable.",
      model_id: null,
    });
    expect(updated.runtime.provider_ids).toEqual([]);
  });

  it("allows only the Companion Owner to claim and finish permanent deletion", async () => {
    await integrationDb.insert(schema.companionWorkspaceAccess).values({
      orgId: fixture.orgA,
      companionId,
      ownerId: fixture.developer.id,
      role: "editor",
      grantedBy: fixture.developer.id,
    });
    await expect(claimCompanionDeletion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionDeleteForbiddenError);

    const claimed = await claimCompanionDeletion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(claimed.runtime.state).toBe("stopping");

    await deleteCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    await expect(getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionNotFoundError);
  });

  it("keeps a deletion claim authoritative over an older stop completion", async () => {
    const stopClaim = await claimCompanionRuntimeStop({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    const deletionClaim = await claimCompanionDeletion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(new Date(deletionClaim.updated_at).getTime())
      .toBeGreaterThan(new Date(stopClaim.updated_at).getTime());

    await expect(updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      expectedUpdatedAt: new Date(stopClaim.updated_at),
      patch: {
        runtimeState: "stopped",
        daemonState: "stopped",
        stoppedAt: new Date(),
      },
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);

    await deleteCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    await expect(getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionNotFoundError);
  });
});
