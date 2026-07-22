import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { consumeSkillPackageTransferTicket } from "@companion/core/services";
import { schema } from "@companion/db";
import { findDeviceApprovalWorkspace, revokeExactConnectedGrant } from "../../src/agentAuthRoutes";
import {
  createIntegrationFixture,
  integrationDb,
  type IntegrationFixture,
} from "./testDatabase";

/**
 * Product promise:
 * A user approving `skills:write` for workspace A can never accidentally
 * approve a concurrent same-name grant constrained to workspace B.
 *
 * Regression caught:
 * Agent Auth 0.6.2 stores only capability names in approval_request, so two
 * pending same-name grants are otherwise indistinguishable to its handler.
 *
 * Why integrated:
 * The race is closed by a PostgreSQL partial unique index, not an in-process
 * check, and must hold across API replicas.
 *
 * Failure proof:
 * Removing agent_capability_grant_one_pending_capability_idx lets the second
 * insert below succeed while both differently constrained grants are pending.
 */
describe("Agent Auth concurrent constrained approvals", () => {
  let fixture: IntegrationFixture;
  const agentId = `approval-agent-${randomUUID()}`;
  const hostId = `approval-host-${randomUUID()}`;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    await integrationDb.insert(schema.agentHost).values({
      id: hostId,
      name: "Approval integration host",
      userId: fixture.developer.id,
      publicKey: "integration-host-key",
      status: "active",
    });
    await integrationDb.insert(schema.agent).values({
      id: agentId,
      name: "Approval integration agent",
      userId: fixture.developer.id,
      hostId,
      publicKey: "integration-agent-key",
      status: "active",
      mode: "delegated",
    });
  });

  afterAll(async () => fixture.cleanup());

  it("serializes same-capability requests while allowing a later workspace grant", async () => {
    const firstId = `grant-a-${randomUUID()}`;
    await integrationDb.insert(schema.agentCapabilityGrant).values({
      id: firstId,
      agentId,
      capability: "skills:write",
      status: "pending",
      constraints: JSON.stringify({ workspaceId: { eq: fixture.orgA } }),
    });

    await expect(
      integrationDb.insert(schema.agentCapabilityGrant).values({
        id: `grant-b-racing-${randomUUID()}`,
        agentId,
        capability: "skills:write",
        status: "pending",
        constraints: JSON.stringify({ workspaceId: { eq: fixture.orgB } }),
      }),
    ).rejects.toMatchObject({
      cause: {
        constraint_name: "agent_capability_grant_one_pending_capability_idx",
      },
    });

    await integrationDb
      .update(schema.agentCapabilityGrant)
      .set({ status: "active" })
      .where(and(eq(schema.agentCapabilityGrant.agentId, agentId), eq(schema.agentCapabilityGrant.id, firstId)));

    await expect(
      integrationDb.insert(schema.agentCapabilityGrant).values({
        id: `grant-b-sequential-${randomUUID()}`,
        agentId,
        capability: "skills:write",
        status: "pending",
        constraints: JSON.stringify({ workspaceId: { eq: fixture.orgB } }),
      }),
    ).resolves.toBeDefined();
  });
});

/**
 * Product promise:
 * Device consent names a requested workspace only when the approving user is a current member.
 *
 * Regression caught:
 * Looking up the organization by id alone could disclose another tenant's name and let an unrelated
 * signed-in user continue a stolen device approval link.
 *
 * Why integrated:
 * The safety boundary is the persisted membership join, so a real PostgreSQL query must prove it.
 *
 * Failure proof:
 * Removing the memberships.user_id predicate makes the second lookup return workspace B's name.
 */
describe("Agent Auth approval workspace identity", () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
  });

  afterAll(async () => fixture.cleanup());

  it("returns a recognizable name only for the approving user's workspace", async () => {
    await expect(findDeviceApprovalWorkspace({
      actor: fixture.developer,
      workspaceId: fixture.orgA,
    })).resolves.toEqual({
      id: fixture.orgA,
      name: `Integration A ${fixture.suffix}`,
    });
    await expect(findDeviceApprovalWorkspace({
      actor: fixture.developer,
      workspaceId: fixture.orgB,
    })).resolves.toBeNull();
  });
});

/**
 * Product promise:
 * Revoking one workspace-constrained grant leaves a same-name sibling grant active while every
 * unconsumed transfer ticket issued by the revoked grant becomes unusable immediately.
 *
 * Regression caught:
 * Agent Auth 0.6.2's native revoke endpoint revokes all grants matching a capability name. Calling it
 * from Settings would therefore revoke `skills:read` in every workspace and invalidate unrelated
 * work. Conversely, changing only the grant without the eager ticket hook leaves a bearer usable
 * until the consumption-time authorization check runs.
 *
 * Why integrated:
 * Exact grant identity and ticket revocation are persisted PostgreSQL state shared across API replicas.
 *
 * Failure proof:
 * Replacing the exact update with `revokeCapability(agent, name)` flips both grants; omitting
 * `agentGrantId` from the ticket hook either revokes both tickets or leaves the target row unrevoked.
 */
describe("Agent Auth exact grant revocation", () => {
  let fixture: IntegrationFixture;
  const agentId = `revoke-agent-${randomUUID()}`;
  const hostId = `revoke-host-${randomUUID()}`;
  const grantAId = `revoke-grant-a-${randomUUID()}`;
  const grantBId = `revoke-grant-b-${randomUUID()}`;
  const ticketA = `cmp_xfer_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
  const ticketB = `cmp_xfer_${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    await integrationDb.insert(schema.agentHost).values({
      id: hostId,
      name: "Exact revoke host",
      userId: fixture.developer.id,
      publicKey: "integration-host-key",
      status: "active",
    });
    await integrationDb.insert(schema.agent).values({
      id: agentId,
      name: "Exact revoke agent",
      userId: fixture.developer.id,
      hostId,
      publicKey: "integration-agent-key",
      status: "active",
      mode: "delegated",
    });
    await integrationDb.insert(schema.agentCapabilityGrant).values([
      {
        id: grantAId,
        agentId,
        capability: "skills:read",
        status: "active",
        constraints: JSON.stringify({ workspaceId: { eq: fixture.orgA } }),
      },
      {
        id: grantBId,
        agentId,
        capability: "skills:read",
        status: "active",
        constraints: JSON.stringify({ workspaceId: { eq: fixture.orgB } }),
      },
    ]);
    const commonTicket = {
      userId: fixture.developer.id,
      agentId,
      action: "local_skill.download",
      skillSlug: "companion",
      version: "1.26.0",
      checksum: `sha256:${"c".repeat(64)}`,
      sizeBytes: 1,
      expiresAt: new Date(Date.now() + 60_000),
    };
    await integrationDb.insert(schema.agentTransferTickets).values([
      {
        ...commonTicket,
        orgId: fixture.orgA,
        agentGrantId: grantAId,
        tokenHash: createHash("sha256").update(ticketA).digest("hex"),
      },
      {
        ...commonTicket,
        orgId: fixture.orgB,
        agentGrantId: grantBId,
        tokenHash: createHash("sha256").update(ticketB).digest("hex"),
      },
    ]);
  });

  afterAll(async () => fixture.cleanup());

  it("revokes only the selected grant id and its tickets", async () => {
    await expect(revokeExactConnectedGrant({
      userId: fixture.developer.id,
      grantId: grantAId,
    })).resolves.toMatchObject({ id: grantAId, status: "revoked" });

    const [grantA, grantB] = await Promise.all([
      integrationDb.query.agentCapabilityGrant.findFirst({ where: eq(schema.agentCapabilityGrant.id, grantAId) }),
      integrationDb.query.agentCapabilityGrant.findFirst({ where: eq(schema.agentCapabilityGrant.id, grantBId) }),
    ]);
    expect(grantA?.status).toBe("revoked");
    expect(grantB?.status).toBe("active");

    const [persistedTicketA, persistedTicketB] = await Promise.all([
      integrationDb.query.agentTransferTickets.findFirst({ where: eq(schema.agentTransferTickets.agentGrantId, grantAId) }),
      integrationDb.query.agentTransferTickets.findFirst({ where: eq(schema.agentTransferTickets.agentGrantId, grantBId) }),
    ]);
    expect(persistedTicketA?.revokedAt).toBeInstanceOf(Date);
    expect(persistedTicketB?.revokedAt).toBeNull();
    await expect(consumeSkillPackageTransferTicket({
      ticket: ticketA,
      action: "local_skill.download",
      slug: "companion",
      version: "1.26.0",
    })).resolves.toBeNull();
  });
});
