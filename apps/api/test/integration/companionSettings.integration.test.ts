import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompanionDeleteForbiddenError,
  CompanionNotFoundError,
  CompanionRuntimeTransitionError,
  CompanionSettingsForbiddenError,
  bumpCompanionSkillsRevisionForSkill,
  claimCompanionDeletion,
  claimCompanionRuntimeStart,
  claimCompanionRuntimeStop,
  deleteCompanion,
  getCompanion,
  saveCompanionProvider,
  updateCompanion,
  updateCompanionRuntime,
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
  seedSkill,
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
      providerCatalog,
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
      providerCatalog,
      database: integrationDb,
    });
    expect(updated.model_id).toBe("claude-sonnet-4-6");

    await expect(updateCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      modelId: "glm-4.7",
      providerCatalog,
      database: integrationDb,
    })).rejects.toMatchObject({
      code: "provider_model_invalid",
      providerId: "anthropic",
      message: "The model glm-4.7 is not available for Claude.",
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

  it("tracks the skill list from saved to applied through the revision pair", async () => {
    const skill = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.developer,
      slug: `sync-skill-${fixture.suffix.slice(0, 8)}`,
      scope: "org",
    });
    const before = await getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(before.runtime.skills_revision).toBe(1);
    expect(before.runtime.skills_applied_revision).toBe(0);

    // A selection change bumps desired in the same write; a no-op save must not.
    const changed = await updateCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      selectedSkillIds: [skill.id],
      database: integrationDb,
    });
    expect(changed.runtime.skills_revision).toBe(2);
    const noop = await updateCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      selectedSkillIds: [skill.id],
      database: integrationDb,
    });
    expect(noop.runtime.skills_revision).toBe(2);

    // Applying is monotonic and capped by desired: a stale write cannot regress it and a runaway
    // value cannot claim a revision nobody asked for yet.
    const applied = await updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { skillsAppliedRevision: 2 },
      database: integrationDb,
    });
    expect(applied.runtime.skills_applied_revision).toBe(2);
    expect(applied.runtime.skills_applied_at).not.toBeNull();
    const stale = await updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { skillsAppliedRevision: 1 },
      database: integrationDb,
    });
    expect(stale.runtime.skills_applied_revision).toBe(2);
    const ahead = await updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { skillsAppliedRevision: 99 },
      database: integrationDb,
    });
    expect(ahead.runtime.skills_applied_revision).toBe(2);

    // A publish-style bump reaches every selector in the org — and only in this org, and only
    // Companions actually selecting the skill.
    const bystanderId = randomUUID();
    await integrationDb.insert(schema.companions).values({
      id: bystanderId,
      orgId: fixture.orgA,
      ownerId: fixture.developer.id,
      name: "No selection",
    });
    const foreignId = randomUUID();
    await integrationDb.insert(schema.companions).values({
      id: foreignId,
      orgId: fixture.orgB,
      ownerId: fixture.outsider.id,
      name: "Foreign selector",
      selectedSkillIds: [skill.id],
    });
    await bumpCompanionSkillsRevisionForSkill({
      orgId: fixture.orgA,
      skillId: skill.id,
      database: integrationDb,
    });
    const bumped = await getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(bumped.runtime.skills_revision).toBe(3);
    expect(bumped.runtime.skills_applied_revision).toBe(2);
    const [bystander] = await integrationDb
      .select({ skillsRevision: schema.companions.skillsRevision })
      .from(schema.companions)
      .where(eq(schema.companions.id, bystanderId));
    expect(bystander!.skillsRevision).toBe(1);
    const [foreign] = await integrationDb
      .select({ skillsRevision: schema.companions.skillsRevision })
      .from(schema.companions)
      .where(eq(schema.companions.id, foreignId));
    expect(foreign!.skillsRevision).toBe(1);
    await integrationDb.delete(schema.companions).where(eq(schema.companions.id, foreignId));

    // A recorded restage failure survives sanitized, and the next bump clears it.
    const failed = await updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { skillsLastError: "Box exec timed out" },
      database: integrationDb,
    });
    expect(failed.runtime.skills_last_error).toBe("Box exec timed out");
    const cleared = await updateCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      selectedSkillIds: [],
      database: integrationDb,
    });
    expect(cleared.runtime.skills_revision).toBe(4);
    expect(cleared.runtime.skills_last_error).toBeNull();
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

  it("claims archive waits once and never mistakes the Owner-deletion lock for one", async () => {
    await updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { runtimeState: "stopping", daemonState: "unknown" },
      database: integrationDb,
    });
    await expect(claimCompanionRuntimeStart({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      allowArchiveResume: true,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);

    await updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { runtimeState: "stopping", daemonState: "starting" },
      database: integrationDb,
    });
    const claims = await Promise.allSettled([
      claimCompanionRuntimeStart({
        actor: fixture.developer,
        orgId: fixture.orgA,
        companionId,
        allowArchiveResume: true,
        database: integrationDb,
      }),
      claimCompanionRuntimeStart({
        actor: fixture.developer,
        orgId: fixture.orgA,
        companionId,
        allowArchiveResume: true,
        database: integrationDb,
      }),
    ]);

    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
    const current = await getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect(current.runtime).toMatchObject({ state: "provisioning", daemon_state: "starting" });
  });

  it("lets an explicit Wake reclaim a no-wake archive wait", async () => {
    await updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { runtimeState: "stopping", daemonState: "stopped" },
      database: integrationDb,
    });

    const claimed = await claimCompanionRuntimeStart({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      allowArchiveResume: true,
      database: integrationDb,
    });

    expect(claimed.runtime).toMatchObject({ state: "provisioning", daemon_state: "starting" });
  });

  it("never lets a stale Owner-deletion lock become a Wake or Stop takeover", async () => {
    await updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { runtimeState: "stopping", daemonState: "unknown" },
      database: integrationDb,
    });
    await integrationDb
      .update(schema.companions)
      .set({ updatedAt: new Date("2020-01-01T00:00:00.000Z") })
      .where(and(
        eq(schema.companions.orgId, fixture.orgA),
        eq(schema.companions.id, companionId),
      ));

    await expect(claimCompanionRuntimeStart({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      allowArchiveResume: true,
      database: integrationDb,
    })).rejects.toThrow("companion is being deleted");
    await expect(claimCompanionRuntimeStop({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    })).rejects.toThrow("companion is being deleted");
  });

  it("lets either deletion or archive resume win atomically without preserving both intents", async () => {
    await updateCompanionRuntime({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      patch: { runtimeState: "stopping", daemonState: "starting" },
      database: integrationDb,
    });

    const claims = await Promise.allSettled([
      claimCompanionDeletion({
        actor: fixture.developer,
        orgId: fixture.orgA,
        companionId,
        database: integrationDb,
      }),
      claimCompanionRuntimeStart({
        actor: fixture.developer,
        orgId: fixture.orgA,
        companionId,
        allowArchiveResume: true,
        database: integrationDb,
      }),
    ]);

    expect(claims.filter((claim) => claim.status === "fulfilled")).toHaveLength(1);
    expect(claims.filter((claim) => claim.status === "rejected")).toHaveLength(1);
    const current = await getCompanion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      database: integrationDb,
    });
    expect([
      "provisioning/starting",
      "stopping/unknown",
    ]).toContain(`${current.runtime.state}/${current.runtime.daemon_state}`);

    if (current.runtime.state === "stopping") {
      await expect(claimCompanionRuntimeStart({
        actor: fixture.developer,
        orgId: fixture.orgA,
        companionId,
        allowArchiveResume: true,
        database: integrationDb,
      })).rejects.toBeInstanceOf(CompanionRuntimeTransitionError);
    }
  });
});
