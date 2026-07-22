import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { schema } from "@companion/db";
import {
  archiveSkill,
  authorizePublicSkillPackageForSession,
  clearSkillPublicVersion,
  consumePublicSkillTransferTicket,
  createPublicSkillTransferTicket,
  getSkillPublicPreviewByShareToken,
  renameSkill,
  revalidateAgentTransferTicket,
  restoreSkill,
  revokeAgentTransferTickets,
  setSkillPublicVersion,
  SkillPublicReleaseConflictError,
  SkillPublicReleaseForbiddenError,
} from "@companion/core/services";
import {
  createIntegrationFixture,
  integrationDb,
  seedAgentAuthIdentity,
  seedSkill,
  type IntegrationFixture,
  type SeededSkill,
} from "./testDatabase";

process.env.COMPANION_BILLING_MODE = "off";
const v1Transport = { packageChecksum: `sha256:${"c".repeat(64)}`, packageSizeBytes: 1_001 };
const v2Transport = { packageChecksum: `sha256:${"d".repeat(64)}`, packageSizeBytes: 2_002 };

/**
 * Product promise:
 * A stable public link exposes metadata anonymously, but only an explicitly pinned immutable
 * release is downloadable by a verified account or a one-use delegated-agent ticket.
 *
 * Regression caught:
 * Auto-promoting a new version, accepting an old version URL, allowing ordinary developers to
 * govern another creator's release, replaying a ticket, or serving an archived/withdrawn release.
 *
 * Why integrated:
 * The guarantee spans the pointer FK, SECURITY DEFINER pre-tenant seams, RLS-owned tickets,
 * transaction CAS, audit writes, and real PostgreSQL clock/replay semantics.
 *
 * Failure proof:
 * Removing any pointer/token/version/archive predicate from migration 0049, or making consumption a
 * SELECT instead of an atomic UPDATE, causes these assertions to fail.
 */
describe("authenticated public skill releases", () => {
  let fixture: IntegrationFixture;
  let skill: SeededSkill;
  let token: string;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    skill = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.developer,
      slug: `public-release-${fixture.suffix}`,
      scope: "org",
      description: "Pinned v1 description",
    });
    const row = await integrationDb.query.skills.findFirst({
      where: and(eq(schema.skills.orgId, fixture.orgA), eq(schema.skills.id, skill.id)),
    });
    if (!row) throw new Error("seeded skill missing");
    token = row.shareToken;
    await seedAgentAuthIdentity({
      user: fixture.outsider,
      agentId: "agent-integration",
      grantId: "grant-integration",
      capability: "public-skills:install",
    });
  });

  afterAll(async () => fixture.cleanup());

  it("keeps existing links metadata-only, pins v1, then leaves it pinned when v2 publishes", async () => {
    const metadataOnly = await getSkillPublicPreviewByShareToken({ token, database: integrationDb });
    expect(metadataOnly?.public_release).toBeNull();
    await expect(authorizePublicSkillPackageForSession({
      token,
      version: "1.0.0",
      userId: fixture.outsider.id,
      database: integrationDb,
    })).resolves.toBeNull();

    await expect(setSkillPublicVersion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: skill.slug,
      version: "1.0.0",
      ...v1Transport,
      database: integrationDb,
    })).resolves.toMatchObject({ public_version: "1.0.0", changed: true, share_token: token });

    const v1ForExternalAccount = await authorizePublicSkillPackageForSession({
      token,
      version: "1.0.0",
      userId: fixture.outsider.id,
      database: integrationDb,
    });
    expect(v1ForExternalAccount).toMatchObject({ slug: skill.slug, version: "1.0.0" });

    const version2Id = randomUUID();
    await integrationDb.insert(schema.skillVersions).values({
      id: version2Id,
      orgId: fixture.orgA,
      skillId: skill.id,
      version: "2.0.0",
      frontmatter: JSON.stringify({ name: skill.slug, description: "Internal v2 description", metadata: {} }),
      body: "# v2",
      sizeBytes: 256,
      checksum: `sha256:${"b".repeat(64)}`,
      storagePath: `integration/${fixture.orgA}/${skill.slug}/2.0.0.tar.gz`,
      createdBy: fixture.developer.id,
    });
    await integrationDb.update(schema.skills)
      .set({ currentVersionId: version2Id, description: "Internal v2 description", updatedAt: new Date() })
      .where(and(eq(schema.skills.orgId, fixture.orgA), eq(schema.skills.id, skill.id)));

    const stillPinned = await getSkillPublicPreviewByShareToken({ token, database: integrationDb });
    expect(stillPinned).toMatchObject({
      current_version: "2.0.0",
      description: "Pinned v1 description",
      public_release: { version: "1.0.0", checksum: v1Transport.packageChecksum, size_bytes: 1_001 },
    });
    expect(await authorizePublicSkillPackageForSession({
      token,
      version: "1.0.0",
      userId: fixture.outsider.id,
      database: integrationDb,
    })).not.toBeNull();
  });

  it("rejects promotion when the prepared version became non-current", async () => {
    const prepared = await integrationDb.query.skillVersions.findFirst({
      where: and(
        eq(schema.skillVersions.orgId, fixture.orgA),
        eq(schema.skillVersions.skillId, skill.id),
        eq(schema.skillVersions.version, "2.0.0"),
      ),
    });
    if (!prepared) throw new Error("prepared v2 missing");
    const replacementId = randomUUID();
    await integrationDb.insert(schema.skillVersions).values({
      id: replacementId,
      orgId: fixture.orgA,
      skillId: skill.id,
      version: "2.1.0",
      frontmatter: JSON.stringify({ name: skill.slug, description: "Concurrent version", metadata: {} }),
      body: "# concurrent",
      sizeBytes: 257,
      checksum: `sha256:${"e".repeat(64)}`,
      storagePath: `integration/${fixture.orgA}/${skill.slug}/2.1.0.tar.gz`,
      createdBy: fixture.admin.id,
    });
    await integrationDb.update(schema.skills)
      .set({ currentVersionId: replacementId, updatedAt: new Date() })
      .where(and(eq(schema.skills.orgId, fixture.orgA), eq(schema.skills.id, skill.id)));

    try {
      await expect(setSkillPublicVersion({
        actor: fixture.admin,
        orgId: fixture.orgA,
        slug: skill.slug,
        version: "2.0.0",
        expectedCurrentVersionId: prepared.id,
        ...v2Transport,
        database: integrationDb,
      })).rejects.toBeInstanceOf(SkillPublicReleaseConflictError);
      await expect(authorizePublicSkillPackageForSession({
        token,
        version: "1.0.0",
        userId: fixture.outsider.id,
        database: integrationDb,
      })).resolves.not.toBeNull();
    } finally {
      await integrationDb.update(schema.skills)
        .set({ currentVersionId: prepared.id, updatedAt: new Date() })
        .where(and(eq(schema.skills.orgId, fixture.orgA), eq(schema.skills.id, skill.id)));
      await integrationDb.delete(schema.skillVersions).where(and(
        eq(schema.skillVersions.orgId, fixture.orgA),
        eq(schema.skillVersions.id, replacementId),
      ));
    }
  });

  it("lets an Admin promote v2, revokes the old version URL, and blocks another Developer", async () => {
    await expect(setSkillPublicVersion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      slug: skill.slug,
      version: "2.0.0",
      ...v2Transport,
      database: integrationDb,
    })).resolves.toMatchObject({ public_version: "2.0.0", changed: true });

    // An Admin may promote another creator's skill. An unrelated Developer may not.
    const secondDeveloper = { ...fixture.owner, id: fixture.owner.id };
    await integrationDb.update(schema.memberships)
      .set({ orgRole: "developer" })
      .where(and(eq(schema.memberships.orgId, fixture.orgA), eq(schema.memberships.userId, secondDeveloper.id)));
    await expect(clearSkillPublicVersion({
      actor: secondDeveloper,
      orgId: fixture.orgA,
      slug: skill.slug,
      database: integrationDb,
    })).rejects.toBeInstanceOf(SkillPublicReleaseForbiddenError);
    await integrationDb.update(schema.memberships)
      .set({ orgRole: "owner" })
      .where(and(eq(schema.memberships.orgId, fixture.orgA), eq(schema.memberships.userId, fixture.owner.id)));

    expect(await authorizePublicSkillPackageForSession({
      token,
      version: "1.0.0",
      userId: fixture.outsider.id,
      database: integrationDb,
    })).toBeNull();
    expect(await authorizePublicSkillPackageForSession({
      token,
      version: "2.0.0",
      userId: fixture.outsider.id,
      database: integrationDb,
    })).toMatchObject({ version: "2.0.0" });

    await expect(setSkillPublicVersion({
      actor: fixture.outsider,
      orgId: fixture.orgA,
      slug: skill.slug,
      version: "2.0.0",
      ...v2Transport,
      database: integrationDb,
    })).rejects.toThrow("not a member");
  });

  it("makes tickets one-use and immediately observes expiry, grant revocation, withdrawal, and archive", async () => {
    const issue = () => createPublicSkillTransferTicket({
      token,
      version: "2.0.0",
      userId: fixture.outsider.id,
      agentId: "agent-integration",
      agentGrantId: "grant-integration",
      database: integrationDb,
    });

    const first = await issue();
    await expect(consumePublicSkillTransferTicket({ ticket: first.ticket, token, version: "2.0.0", database: integrationDb }))
      .resolves.toMatchObject({ version: "2.0.0", checksum: v2Transport.packageChecksum, sizeBytes: 2_002 });
    await expect(revalidateAgentTransferTicket({ ticket: first.ticket, database: integrationDb })).resolves.toBe(true);
    await expect(consumePublicSkillTransferTicket({ ticket: first.ticket, token, version: "2.0.0", database: integrationDb }))
      .resolves.toBeNull();

    const expired = await issue();
    await integrationDb.update(schema.agentTransferTickets)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.agentTransferTickets.tokenHash, createHash("sha256").update(expired.ticket).digest("hex")));
    await expect(consumePublicSkillTransferTicket({ ticket: expired.ticket, token, version: "2.0.0", database: integrationDb }))
      .resolves.toBeNull();

    const revoked = await issue();
    await expect(revokeAgentTransferTickets({
      userId: fixture.outsider.id,
      agentId: "agent-integration",
      agentGrantId: "grant-integration",
      database: integrationDb,
    })).resolves.toBeGreaterThan(0);
    await expect(consumePublicSkillTransferTicket({ ticket: revoked.ticket, token, version: "2.0.0", database: integrationDb }))
      .resolves.toBeNull();

    const revokedAfterConsume = await issue();
    await expect(consumePublicSkillTransferTicket({
      ticket: revokedAfterConsume.ticket,
      token,
      version: "2.0.0",
      database: integrationDb,
    })).resolves.not.toBeNull();
    await expect(revalidateAgentTransferTicket({ ticket: revokedAfterConsume.ticket, database: integrationDb }))
      .resolves.toBe(true);
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ status: "revoked" })
      .where(eq(schema.agentCapabilityGrant.id, "grant-integration"));
    await expect(revalidateAgentTransferTicket({ ticket: revokedAfterConsume.ticket, database: integrationDb }))
      .resolves.toBe(false);
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ status: "active" })
      .where(eq(schema.agentCapabilityGrant.id, "grant-integration"));
    await expect(revalidateAgentTransferTicket({ ticket: revokedAfterConsume.ticket, database: integrationDb }))
      .resolves.toBe(true);
    await integrationDb.update(schema.agent)
      .set({ status: "revoked" })
      .where(eq(schema.agent.id, "agent-integration"));
    await expect(revalidateAgentTransferTicket({ ticket: revokedAfterConsume.ticket, database: integrationDb }))
      .resolves.toBe(false);
    await integrationDb.update(schema.agent)
      .set({ status: "active" })
      .where(eq(schema.agent.id, "agent-integration"));
    await integrationDb.update(schema.agentHost)
      .set({ status: "revoked" })
      .where(eq(schema.agentHost.id, "host-agent-integration"));
    await expect(revalidateAgentTransferTicket({ ticket: revokedAfterConsume.ticket, database: integrationDb }))
      .resolves.toBe(false);
    await integrationDb.update(schema.agentHost)
      .set({ status: "active" })
      .where(eq(schema.agentHost.id, "host-agent-integration"));

    await clearSkillPublicVersion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      slug: skill.slug,
      database: integrationDb,
    });
    await expect(revalidateAgentTransferTicket({ ticket: revokedAfterConsume.ticket, database: integrationDb }))
      .resolves.toBe(false);
    await setSkillPublicVersion({
      actor: fixture.admin,
      orgId: fixture.orgA,
      slug: skill.slug,
      version: "2.0.0",
      ...v2Transport,
      database: integrationDb,
    });
    await expect(revalidateAgentTransferTicket({ ticket: revokedAfterConsume.ticket, database: integrationDb }))
      .resolves.toBe(true);
    await archiveSkill({ actor: fixture.developer, orgId: fixture.orgA, slug: skill.slug, database: integrationDb });
    await expect(revalidateAgentTransferTicket({ ticket: revokedAfterConsume.ticket, database: integrationDb }))
      .resolves.toBe(false);
    await restoreSkill({ actor: fixture.developer, orgId: fixture.orgA, slug: skill.slug, database: integrationDb });
    await expect(revalidateAgentTransferTicket({ ticket: revokedAfterConsume.ticket, database: integrationDb }))
      .resolves.toBe(true);

    const nativeGrantRevoked = await issue();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ status: "revoked" })
      .where(eq(schema.agentCapabilityGrant.id, "grant-integration"));
    await expect(consumePublicSkillTransferTicket({
      ticket: nativeGrantRevoked.ticket,
      token,
      version: "2.0.0",
      database: integrationDb,
    })).resolves.toBeNull();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ status: "active" })
      .where(eq(schema.agentCapabilityGrant.id, "grant-integration"));

    const nativeAgentRevoked = await issue();
    await integrationDb.update(schema.agent)
      .set({ status: "revoked" })
      .where(eq(schema.agent.id, "agent-integration"));
    await expect(consumePublicSkillTransferTicket({
      ticket: nativeAgentRevoked.ticket,
      token,
      version: "2.0.0",
      database: integrationDb,
    })).resolves.toBeNull();
    await integrationDb.update(schema.agent)
      .set({ status: "active" })
      .where(eq(schema.agent.id, "agent-integration"));

    const nativeHostRevoked = await issue();
    await integrationDb.update(schema.agentHost)
      .set({ status: "revoked" })
      .where(eq(schema.agentHost.id, "host-agent-integration"));
    await expect(consumePublicSkillTransferTicket({
      ticket: nativeHostRevoked.ticket,
      token,
      version: "2.0.0",
      database: integrationDb,
    })).resolves.toBeNull();
    await integrationDb.update(schema.agentHost)
      .set({ status: "active" })
      .where(eq(schema.agentHost.id, "host-agent-integration"));

    const withdrawn = await issue();
    await clearSkillPublicVersion({ actor: fixture.admin, orgId: fixture.orgA, slug: skill.slug, database: integrationDb });
    await expect(consumePublicSkillTransferTicket({ ticket: withdrawn.ticket, token, version: "2.0.0", database: integrationDb }))
      .resolves.toBeNull();
    expect((await getSkillPublicPreviewByShareToken({ token, database: integrationDb }))?.public_release).toBeNull();

    await setSkillPublicVersion({ actor: fixture.admin, orgId: fixture.orgA, slug: skill.slug, version: "2.0.0", ...v2Transport, database: integrationDb });
    const archivedTicket = await issue();
    await archiveSkill({ actor: fixture.developer, orgId: fixture.orgA, slug: skill.slug, database: integrationDb });
    expect(await getSkillPublicPreviewByShareToken({ token, database: integrationDb })).toBeNull();
    await expect(consumePublicSkillTransferTicket({ ticket: archivedTicket.ticket, token, version: "2.0.0", database: integrationDb }))
      .resolves.toBeNull();
    await restoreSkill({ actor: fixture.developer, orgId: fixture.orgA, slug: skill.slug, database: integrationDb });
    expect((await getSkillPublicPreviewByShareToken({ token, database: integrationDb }))?.public_release?.version).toBe("2.0.0");
  });

  it("requires personal skills to be shared before any public pointer can be set", async () => {
    const personal = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.owner,
      slug: `personal-public-${fixture.suffix}`,
      scope: "personal",
    });
    await expect(setSkillPublicVersion({
      actor: fixture.owner,
      orgId: fixture.orgA,
      slug: personal.slug,
      version: "1.0.0",
      ...v1Transport,
      database: integrationDb,
    })).rejects.toThrow("share this personal skill");
  });

  it("keeps the pinned identity stable across the explicit withdraw, rename, republish flow", async () => {
    const identitySkill = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.developer,
      slug: `public-identity-${fixture.suffix}`,
      scope: "org",
    });
    const seeded = await integrationDb.query.skills.findFirst({
      where: and(eq(schema.skills.orgId, fixture.orgA), eq(schema.skills.id, identitySkill.id)),
    });
    if (!seeded) throw new Error("identity skill missing");

    await setSkillPublicVersion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: identitySkill.slug,
      version: "1.0.0",
      ...v1Transport,
      database: integrationDb,
    });
    const renamedSlug = `${identitySkill.slug}-renamed`;
    await expect(renameSkill({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: identitySkill.slug,
      newSlug: renamedSlug,
      database: integrationDb,
    })).rejects.toBeInstanceOf(SkillPublicReleaseConflictError);
    await expect(getSkillPublicPreviewByShareToken({ token: seeded.shareToken, database: integrationDb }))
      .resolves.toMatchObject({ slug: identitySkill.slug, public_release: { version: "1.0.0" } });

    await clearSkillPublicVersion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: identitySkill.slug,
      database: integrationDb,
    });
    await renameSkill({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: identitySkill.slug,
      newSlug: renamedSlug,
      database: integrationDb,
    });
    await expect(setSkillPublicVersion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: renamedSlug,
      version: "1.0.0",
      ...v1Transport,
      database: integrationDb,
    })).rejects.toThrow(`publish a new current version named "${renamedSlug}"`);

    const renamedVersionId = randomUUID();
    await integrationDb.insert(schema.skillVersions).values({
      id: renamedVersionId,
      orgId: fixture.orgA,
      skillId: identitySkill.id,
      version: "2.0.0",
      frontmatter: JSON.stringify({ name: renamedSlug, description: "Renamed release", metadata: {} }),
      body: "# renamed release",
      sizeBytes: 333,
      checksum: `sha256:${"f".repeat(64)}`,
      storagePath: `integration/${fixture.orgA}/${renamedSlug}/2.0.0.tar.gz`,
      createdBy: fixture.developer.id,
    });
    await integrationDb.update(schema.skills)
      .set({ currentVersionId: renamedVersionId, description: "Renamed release", updatedAt: new Date() })
      .where(and(eq(schema.skills.orgId, fixture.orgA), eq(schema.skills.id, identitySkill.id)));
    await setSkillPublicVersion({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: renamedSlug,
      version: "2.0.0",
      ...v2Transport,
      database: integrationDb,
    });
    await expect(getSkillPublicPreviewByShareToken({ token: seeded.shareToken, database: integrationDb }))
      .resolves.toMatchObject({ slug: renamedSlug, public_release: { version: "2.0.0" } });
  });
});
