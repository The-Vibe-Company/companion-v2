import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { schema } from "@companion/db";
import {
  consumeSkillPackageTransferTicket,
  createLocalSkillDownloadTransferTicket,
  createSkillDownloadTransferTicket,
  createSkillFileDownloadTransferTicket,
  createSkillUploadTransferTicket,
  preflightSkillPackageTransferTicket,
  revalidateAgentTransferTicket,
  revokeAgentTransferTickets,
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

/**
 * Product promise:
 * Agent Auth never puts binary package bytes into a capability execution. It returns a hash-at-rest,
 * 60-second ticket bound to one user, agent, workspace, action, slug, version, optional exact file
 * path, checksum, and size.
 *
 * Regression caught:
 * Replay, cross-workspace use, changed membership, file-path substitution, upload byte substitution,
 * personal-skill admin override, or reusing a download ticket as an upload ticket.
 *
 * Why integrated:
 * Issuance uses ordinary tenant services/RBAC while consumption crosses the pre-tenant RLS seam and
 * atomically locks/burns the ticket in PostgreSQL.
 *
 * Failure proof:
 * Removing a binding predicate, membership check, row lock, or failed/consumed timestamp from
 * migration 0049 makes at least one assertion below accept a ticket that must be rejected.
 */
describe("private Agent Auth skill transfer tickets", () => {
  let fixture: IntegrationFixture;
  let orgSkill: SeededSkill;
  let personalSkill: SeededSkill;

  const downloadTransport = {
    packageChecksum: `sha256:${"d".repeat(64)}`,
    packageSizeBytes: 4_321,
  };
  const uploadTransport = {
    packageChecksum: `sha256:${"e".repeat(64)}`,
    packageSizeBytes: 1_234,
  };

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    orgSkill = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.developer,
      slug: `agent-org-${fixture.suffix}`,
      scope: "org",
    });
    personalSkill = await seedSkill({
      orgId: fixture.orgA,
      creator: fixture.developer,
      slug: `agent-personal-${fixture.suffix}`,
      scope: "personal",
    });
    await Promise.all([
      ["agent-download", "grant-download", "skills:read"],
      ["agent-file", "grant-file", "skills:read"],
      ["agent-mismatch", "grant-mismatch", "skills:read"],
      ["agent-revoked", "grant-revoked", "skills:read"],
      ["agent-departure", "grant-departure", "skills:read"],
      ["agent-native", "grant-native", "skills:read"],
      ["agent-upload", "grant-upload", "skills:write"],
      ["agent-upload-exact", "grant-upload-exact", "skills:write"],
      ["agent-fresh-upload", "grant-fresh-upload", "skills:write"],
      ["agent-local", "grant-local", "skills:read"],
    ].map(([agentId, grantId, capability]) => seedAgentAuthIdentity({
      user: fixture.developer,
      agentId: agentId!,
      grantId: grantId!,
      capability: capability as "skills:read" | "skills:write",
      workspaceId: fixture.orgA,
    })));
  });

  afterAll(async () => fixture.cleanup());

  it("downloads an exact immutable version once and stores no plaintext ticket", async () => {
    const issued = await createSkillDownloadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: orgSkill.slug,
      version: "1.0.0",
      storagePath: `integration/${fixture.orgA}/${orgSkill.slug}/1.0.0.tar.gz`,
      ...downloadTransport,
      agentId: "agent-download",
      agentGrantId: "grant-download",
      database: integrationDb,
    });

    const hash = createHash("sha256").update(issued.ticket).digest("hex");
    const persisted = await integrationDb.query.agentTransferTickets.findFirst({
      where: eq(schema.agentTransferTickets.tokenHash, hash),
    });
    expect(persisted).toMatchObject({
      action: "skill_package.download",
      skillId: orgSkill.id,
      skillVersionId: orgSkill.versionId,
      skillSlug: orgSkill.slug,
      version: "1.0.0",
      checksum: downloadTransport.packageChecksum,
      sizeBytes: downloadTransport.packageSizeBytes,
    });
    expect(persisted).not.toHaveProperty("tokenPrefix");
    expect(JSON.stringify(persisted)).not.toContain(issued.ticket);
    const storageShape = Array.from(await integrationDb.execute(sql<{ has_token_prefix: boolean }>`
      select exists (
        select 1
        from information_schema.columns
        where table_schema = 'public'
          and table_name = 'agent_transfer_tickets'
          and column_name = 'token_prefix'
      ) as has_token_prefix
    `));
    expect(storageShape[0]?.has_token_prefix).toBe(false);

    await expect(consumeSkillPackageTransferTicket({
      ticket: issued.ticket,
      action: "skill_package.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      database: integrationDb,
    })).resolves.toMatchObject({
      orgId: fixture.orgA,
      actor: fixture.developer,
      expectedSkillId: orgSkill.id,
      expectedSkillVersionId: orgSkill.versionId,
      checksum: downloadTransport.packageChecksum,
      sizeBytes: downloadTransport.packageSizeBytes,
    });
    await expect(consumeSkillPackageTransferTicket({
      ticket: issued.ticket,
      action: "skill_package.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      database: integrationDb,
    })).resolves.toBeNull();
  });

  it("burns a ticket on action/path mismatch and observes grant revocation", async () => {
    const mismatched = await createSkillDownloadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: orgSkill.slug,
      version: "1.0.0",
      storagePath: `integration/${fixture.orgA}/${orgSkill.slug}/1.0.0.tar.gz`,
      ...downloadTransport,
      agentId: "agent-mismatch",
      agentGrantId: "grant-mismatch",
      database: integrationDb,
    });
    await expect(consumeSkillPackageTransferTicket({
      ticket: mismatched.ticket,
      action: "skill_package.upload",
      slug: orgSkill.slug,
      version: "1.0.0",
      checksum: downloadTransport.packageChecksum,
      sizeBytes: downloadTransport.packageSizeBytes,
      database: integrationDb,
    })).resolves.toBeNull();
    await expect(consumeSkillPackageTransferTicket({
      ticket: mismatched.ticket,
      action: "skill_package.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      database: integrationDb,
    })).resolves.toBeNull();

    const revoked = await createSkillDownloadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: orgSkill.slug,
      version: "1.0.0",
      storagePath: `integration/${fixture.orgA}/${orgSkill.slug}/1.0.0.tar.gz`,
      ...downloadTransport,
      agentId: "agent-revoked",
      agentGrantId: "grant-revoked",
      database: integrationDb,
    });
    await revokeAgentTransferTickets({
      userId: fixture.developer.id,
      agentId: "agent-revoked",
      agentGrantId: "grant-revoked",
      database: integrationDb,
    });
    await expect(consumeSkillPackageTransferTicket({
      ticket: revoked.ticket,
      action: "skill_package.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      database: integrationDb,
    })).resolves.toBeNull();
  });

  it("binds a one-use file ticket to its exact path, bytes, version, and live read grant", async () => {
    const fileTransport = {
      filePath: "assets/logo.png",
      fileChecksum: `sha256:${"7".repeat(64)}`,
      fileSizeBytes: 8,
    };
    const issue = () => createSkillFileDownloadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: orgSkill.slug,
      version: "1.0.0",
      storagePath: `integration/${fixture.orgA}/${orgSkill.slug}/1.0.0.tar.gz`,
      ...fileTransport,
      agentId: "agent-file",
      agentGrantId: "grant-file",
      database: integrationDb,
    });

    const mismatched = await issue();
    const persisted = await integrationDb.query.agentTransferTickets.findFirst({
      where: eq(
        schema.agentTransferTickets.tokenHash,
        createHash("sha256").update(mismatched.ticket).digest("hex"),
      ),
    });
    expect(persisted).toMatchObject({
      action: "skill_file.download",
      skillId: orgSkill.id,
      skillVersionId: orgSkill.versionId,
      skillSlug: orgSkill.slug,
      version: "1.0.0",
      filePath: fileTransport.filePath,
      checksum: fileTransport.fileChecksum,
      sizeBytes: fileTransport.fileSizeBytes,
    });
    await expect(consumeSkillPackageTransferTicket({
      ticket: mismatched.ticket,
      action: "skill_file.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      filePath: "assets/other.png",
      database: integrationDb,
    })).resolves.toBeNull();
    await expect(consumeSkillPackageTransferTicket({
      ticket: mismatched.ticket,
      action: "skill_file.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      filePath: fileTransport.filePath,
      database: integrationDb,
    })).resolves.toBeNull();

    const exact = await issue();
    await expect(consumeSkillPackageTransferTicket({
      ticket: exact.ticket,
      action: "skill_file.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      filePath: fileTransport.filePath,
      database: integrationDb,
    })).resolves.toMatchObject({
      action: "skill_file.download",
      expectedSkillId: orgSkill.id,
      expectedSkillVersionId: orgSkill.versionId,
      filePath: fileTransport.filePath,
      checksum: fileTransport.fileChecksum,
      sizeBytes: fileTransport.fileSizeBytes,
    });
    await expect(consumeSkillPackageTransferTicket({
      ticket: exact.ticket,
      action: "skill_file.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      filePath: fileTransport.filePath,
      database: integrationDb,
    })).resolves.toBeNull();

    const wrongLiveGrant = await issue();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ capability: "skills:write" })
      .where(eq(schema.agentCapabilityGrant.id, "grant-file"));
    await expect(consumeSkillPackageTransferTicket({
      ticket: wrongLiveGrant.ticket,
      action: "skill_file.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      filePath: fileTransport.filePath,
      database: integrationDb,
    })).resolves.toBeNull();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ capability: "skills:read" })
      .where(eq(schema.agentCapabilityGrant.id, "grant-file"));
  });

  it("invalidates pending and consumed tickets when the delegated user leaves the workspace", async () => {
    const issue = () => createSkillDownloadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: orgSkill.slug,
      version: "1.0.0",
      storagePath: `integration/${fixture.orgA}/${orgSkill.slug}/1.0.0.tar.gz`,
      ...downloadTransport,
      agentId: "agent-departure",
      agentGrantId: "grant-departure",
      database: integrationDb,
    });
    const issued = await issue();
    await integrationDb.delete(schema.memberships).where(and(
      eq(schema.memberships.orgId, fixture.orgA),
      eq(schema.memberships.userId, fixture.developer.id),
    ));
    await expect(consumeSkillPackageTransferTicket({
      ticket: issued.ticket,
      action: "skill_package.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      database: integrationDb,
    })).resolves.toBeNull();
    await integrationDb.insert(schema.memberships).values({
      orgId: fixture.orgA,
      userId: fixture.developer.id,
      orgRole: "developer",
    });

    const consumed = await issue();
    await expect(consumeSkillPackageTransferTicket({
      ticket: consumed.ticket,
      action: "skill_package.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      database: integrationDb,
    })).resolves.not.toBeNull();
    await integrationDb.delete(schema.memberships).where(and(
      eq(schema.memberships.orgId, fixture.orgA),
      eq(schema.memberships.userId, fixture.developer.id),
    ));
    await expect(revalidateAgentTransferTicket({ ticket: consumed.ticket, database: integrationDb }))
      .resolves.toBe(false);
    await integrationDb.insert(schema.memberships).values({
      orgId: fixture.orgA,
      userId: fixture.developer.id,
      orgRole: "developer",
    });
    await expect(revalidateAgentTransferTicket({ ticket: consumed.ticket, database: integrationDb }))
      .resolves.toBe(true);
  });

  it("revalidates native Better Auth host, agent, grant capability, constraint, and expiry state", async () => {
    const issue = () => createSkillDownloadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: orgSkill.slug,
      version: "1.0.0",
      storagePath: `integration/${fixture.orgA}/${orgSkill.slug}/1.0.0.tar.gz`,
      ...downloadTransport,
      agentId: "agent-native",
      agentGrantId: "grant-native",
      database: integrationDb,
    });
    const consume = (ticket: string) => consumeSkillPackageTransferTicket({
      ticket,
      action: "skill_package.download",
      slug: orgSkill.slug,
      version: "1.0.0",
      database: integrationDb,
    });

    const wrongCapability = await issue();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ capability: "skills:write" })
      .where(eq(schema.agentCapabilityGrant.id, "grant-native"));
    await expect(consume(wrongCapability.ticket)).resolves.toBeNull();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ capability: "skills:read" })
      .where(eq(schema.agentCapabilityGrant.id, "grant-native"));

    const wrongConstraint = await issue();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ constraints: JSON.stringify({ workspaceId: { eq: fixture.orgB } }) })
      .where(eq(schema.agentCapabilityGrant.id, "grant-native"));
    await expect(consume(wrongConstraint.ticket)).resolves.toBeNull();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ constraints: JSON.stringify({ workspaceId: { eq: fixture.orgA } }) })
      .where(eq(schema.agentCapabilityGrant.id, "grant-native"));

    const expiredGrant = await issue();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.agentCapabilityGrant.id, "grant-native"));
    await expect(consume(expiredGrant.ticket)).resolves.toBeNull();
    await integrationDb.update(schema.agentCapabilityGrant)
      .set({ expiresAt: null })
      .where(eq(schema.agentCapabilityGrant.id, "grant-native"));

    const revokedAgent = await issue();
    await integrationDb.update(schema.agent)
      .set({ status: "revoked" })
      .where(eq(schema.agent.id, "agent-native"));
    await expect(consume(revokedAgent.ticket)).resolves.toBeNull();
    await integrationDb.update(schema.agent)
      .set({ status: "active" })
      .where(eq(schema.agent.id, "agent-native"));

    const revokedHost = await issue();
    await integrationDb.update(schema.agentHost)
      .set({ status: "revoked" })
      .where(eq(schema.agentHost.id, "host-agent-native"));
    await expect(consume(revokedHost.ticket)).resolves.toBeNull();
    await integrationDb.update(schema.agentHost)
      .set({ status: "active" })
      .where(eq(schema.agentHost.id, "host-agent-native"));

    const expiredAgent = await issue();
    await integrationDb.update(schema.agent)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.agent.id, "agent-native"));
    await expect(consume(expiredAgent.ticket)).resolves.toBeNull();
    await integrationDb.update(schema.agent)
      .set({ expiresAt: null })
      .where(eq(schema.agent.id, "agent-native"));

    const expiredHost = await issue();
    await integrationDb.update(schema.agentHost)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.agentHost.id, "host-agent-native"));
    await expect(consume(expiredHost.ticket)).resolves.toBeNull();
    await integrationDb.update(schema.agentHost)
      .set({ expiresAt: null })
      .where(eq(schema.agentHost.id, "host-agent-native"));

    const reboundUser = await issue();
    await integrationDb.update(schema.agent)
      .set({ userId: fixture.admin.id })
      .where(eq(schema.agent.id, "agent-native"));
    await expect(consume(reboundUser.ticket)).resolves.toBeNull();
    await integrationDb.update(schema.agent)
      .set({ userId: fixture.developer.id })
      .where(eq(schema.agent.id, "agent-native"));
  });

  it("binds uploads to raw bytes and target while preserving personal-skill privacy", async () => {
    await expect(createSkillUploadTransferTicket({
      actor: fixture.admin,
      orgId: fixture.orgA,
      slug: personalSkill.slug,
      version: "1.0.1",
      ...uploadTransport,
      agentId: "agent-admin",
      database: integrationDb,
    })).rejects.toThrow("skill not found");

    const issued = await createSkillUploadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: personalSkill.slug,
      version: "1.0.1",
      ...uploadTransport,
      agentId: "agent-upload",
      agentGrantId: "grant-upload",
      database: integrationDb,
    });
    await expect(preflightSkillPackageTransferTicket({
      ticket: issued.ticket,
      action: "skill_package.upload",
      slug: personalSkill.slug,
      version: "1.0.1",
      database: integrationDb,
    })).resolves.toBe(true);
    await expect(preflightSkillPackageTransferTicket({
      ticket: "cmp_xfer_not-issued",
      action: "skill_package.upload",
      slug: personalSkill.slug,
      version: "1.0.1",
      database: integrationDb,
    })).resolves.toBe(false);
    await expect(consumeSkillPackageTransferTicket({
      ticket: issued.ticket,
      action: "skill_package.upload",
      slug: personalSkill.slug,
      version: "1.0.1",
      checksum: `sha256:${"f".repeat(64)}`,
      sizeBytes: uploadTransport.packageSizeBytes,
      database: integrationDb,
    })).resolves.toBeNull();
    // A bad byte binding burns the ticket, so the originally declared bytes cannot be retried.
    await expect(consumeSkillPackageTransferTicket({
      ticket: issued.ticket,
      action: "skill_package.upload",
      slug: personalSkill.slug,
      version: "1.0.1",
      checksum: uploadTransport.packageChecksum,
      sizeBytes: uploadTransport.packageSizeBytes,
      database: integrationDb,
    })).resolves.toBeNull();

    const exact = await createSkillUploadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug: personalSkill.slug,
      version: "1.0.1",
      ...uploadTransport,
      agentId: "agent-upload-exact",
      agentGrantId: "grant-upload-exact",
      database: integrationDb,
    });
    await expect(consumeSkillPackageTransferTicket({
      ticket: exact.ticket,
      action: "skill_package.upload",
      slug: personalSkill.slug,
      version: "1.0.1",
      checksum: uploadTransport.packageChecksum,
      sizeBytes: uploadTransport.packageSizeBytes,
      database: integrationDb,
    })).resolves.toMatchObject({
      action: "skill_package.upload",
      expectedSkillId: personalSkill.id,
      expectedSkillVersionId: null,
      slug: personalSkill.slug,
      version: "1.0.1",
    });
  });

  it("allows a fresh target but rejects cross-tenant ticket issuance", async () => {
    const slug = `fresh-agent-upload-${fixture.suffix}`;
    await expect(createSkillUploadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgB,
      slug,
      version: "1.0.0",
      ...uploadTransport,
      agentId: "agent-cross-tenant",
      database: integrationDb,
    })).rejects.toThrow("not a member");

    const issued = await createSkillUploadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      slug,
      version: "1.0.0",
      ...uploadTransport,
      agentId: "agent-fresh-upload",
      agentGrantId: "grant-fresh-upload",
      database: integrationDb,
    });
    await expect(consumeSkillPackageTransferTicket({
      ticket: issued.ticket,
      action: "skill_package.upload",
      slug,
      version: "1.0.0",
      checksum: uploadTransport.packageChecksum,
      sizeBytes: uploadTransport.packageSizeBytes,
      database: integrationDb,
    })).resolves.toMatchObject({ expectedSkillId: null, expectedSkillVersionId: null });
  });

  it("uses the same one-use, tenant-bound transport for the bundled Companion skill", async () => {
    const issued = await createLocalSkillDownloadTransferTicket({
      actor: fixture.developer,
      orgId: fixture.orgA,
      key: "companion",
      version: "1.26.0",
      packageChecksum: `sha256:${"9".repeat(64)}`,
      packageSizeBytes: 9_876,
      agentId: "agent-local",
      agentGrantId: "grant-local",
      database: integrationDb,
    });
    await expect(consumeSkillPackageTransferTicket({
      ticket: issued.ticket,
      action: "local_skill.download",
      slug: "companion",
      version: "1.26.0",
      checksum: `sha256:${"9".repeat(64)}`,
      sizeBytes: 9_876,
      database: integrationDb,
    })).resolves.toMatchObject({
      action: "local_skill.download",
      expectedSkillId: null,
      expectedSkillVersionId: null,
      slug: "companion",
      version: "1.26.0",
    });
  });
});
