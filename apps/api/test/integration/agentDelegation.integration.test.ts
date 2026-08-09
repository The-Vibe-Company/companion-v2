/**
 * Product promise:
 * An already-authenticated Agent Auth identity can mint only the exact live grant snapshot for the
 * selected Companion workspace, with no second approval and no caller-selected scopes.
 *
 * Regression caught:
 * Weakening the ownership/status joins, workspace constraint decoder, expiry cap, or HTTP-to-Core
 * composition could persist a child PAT with foreign, inactive, expired, or cross-workspace rights.
 *
 * Why this test is integrated:
 * The security boundary spans the Hono route, tenant transaction, real Agent Auth tables, grant
 * query, token hashing/provenance columns, audit row, and pre-tenant resolver.
 *
 * Failure proof:
 * Removing the exact-workspace predicate adds skills:write; accepting inactive/expired grants adds
 * secrets:read; dropping database implication removes database:read; bypassing the source cap makes
 * the stored expiry exceed the earliest live grant.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { schema } from "@companion/db";
import { resolveApiToken } from "@companion/core/services";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
} from "./testDatabase";

process.env.COMPANION_BILLING_MODE = "off";
process.env.COMPANION_SECRETS_MASTER_KEY ??= Buffer.alloc(32, 11).toString("base64");

const authState = vi.hoisted(() => ({ result: null as unknown }));

vi.mock("@hono/node-server", () => ({ serve: vi.fn() }));
vi.mock("@companion/auth", () => ({
  auth: {
    api: { getSession: vi.fn(async () => null) },
    handler: vi.fn(),
    $Infer: {},
  },
  registerAgentCapabilityExecutor: vi.fn(() => () => undefined),
  authenticateAgentRequest: vi.fn(async () => authState.result),
}));

import { app } from "../../src/index";

describe("Agent Auth child PAT inheritance", () => {
  let fixture: IntegrationFixture;
  let agentId: string;
  let earliestSourceExpiry: Date;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
    agentId = `delegation-agent-${fixture.suffix}`;
    const hostId = `delegation-host-${fixture.suffix}`;
    earliestSourceExpiry = new Date(Date.now() + 10 * 60_000);

    await integrationDb.insert(schema.agentHost).values({
      id: hostId,
      name: "Delegation integration host",
      userId: fixture.developer.id,
      publicKey: "integration-delegation-host-key",
      status: "active",
    });
    await integrationDb.insert(schema.agent).values({
      id: agentId,
      name: "Delegation integration agent",
      userId: fixture.developer.id,
      hostId,
      publicKey: "integration-delegation-agent-key",
      status: "active",
      mode: "delegated",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    await integrationDb.insert(schema.agentCapabilityGrant).values([
      {
        id: `delegation-read-${fixture.suffix}`,
        agentId,
        capability: "skills:read",
        status: "active",
        constraints: JSON.stringify({ workspaceId: { eq: fixture.orgA } }),
        expiresAt: earliestSourceExpiry,
      },
      {
        id: `delegation-database-${fixture.suffix}`,
        agentId,
        capability: "database:write",
        status: "active",
        constraints: JSON.stringify({ workspaceId: fixture.orgA }),
        expiresAt: new Date(Date.now() + 30 * 60_000),
      },
      {
        id: `delegation-public-${fixture.suffix}`,
        agentId,
        capability: "public-skills:install",
        status: "active",
        constraints: null,
        expiresAt: new Date(Date.now() + 20 * 60_000),
      },
      {
        id: `delegation-wrong-workspace-${fixture.suffix}`,
        agentId,
        capability: "skills:write",
        status: "active",
        constraints: JSON.stringify({ workspaceId: { eq: fixture.orgB } }),
      },
      {
        id: `delegation-inactive-${fixture.suffix}`,
        agentId,
        capability: "secrets:read",
        status: "revoked",
        constraints: JSON.stringify({ workspaceId: { eq: fixture.orgA } }),
      },
      {
        id: `delegation-expired-${fixture.suffix}`,
        agentId,
        capability: "secrets:write",
        status: "active",
        constraints: JSON.stringify({ workspaceId: { eq: fixture.orgA } }),
        expiresAt: new Date(Date.now() - 60_000),
      },
    ]);

    authState.result = {
      actor: fixture.developer,
      workspaceId: fixture.orgA,
      capability: "skills:read",
      session: {
        agentId,
        agent: { capabilityGrants: [] },
        user: fixture.developer,
      },
    };
  });

  afterAll(async () => {
    await fixture.cleanup();
    await integrationSql.end();
  });

  it("persists and resolves only the exact live workspace snapshot with bounded provenance", async () => {
    const response = await app.request("/v1/tokens", {
      method: "POST",
      headers: {
        authorization: "Bearer synthetic.agent.jwt",
        "x-companion-workspace-id": fixture.orgA,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        inherit_agent_grants: true,
        ttl_seconds: 3600,
        target_workspace_id: "conductor-integration-workspace",
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as {
      id: string;
      token?: unknown;
      scopes: string[];
      expires_at: string;
      target_workspace_id: string;
    };
    expect(typeof body.token).toBe("string");
    expect(body.scopes).toEqual([
      "skills:read",
      "database:read",
      "database:write",
      "public-skills:install",
    ]);
    expect(body.target_workspace_id).toBe("conductor-integration-workspace");
    expect(new Date(body.expires_at).getTime()).toBeLessThanOrEqual(earliestSourceExpiry.getTime());

    const stored = await integrationDb.query.apiTokens.findFirst({
      where: and(
        eq(schema.apiTokens.orgId, fixture.orgA),
        eq(schema.apiTokens.id, body.id),
      ),
    });
    expect(stored).toMatchObject({
      userId: fixture.developer.id,
      sourceType: "agent_auth",
      sourceAgentId: agentId,
      targetWorkspaceId: "conductor-integration-workspace",
      scopes: body.scopes,
    });
    expect(stored?.expiresAt.getTime()).toBeLessThanOrEqual(earliestSourceExpiry.getTime());
    expect(stored?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.tokenHash.startsWith("cmp_pat_")).toBe(false);

    const rawToken = body.token as string;
    await expect(resolveApiToken(rawToken, integrationDb)).resolves.toBeNull();
    await expect(
      resolveApiToken(rawToken, integrationDb, "conductor-integration-workspace"),
    ).resolves.toMatchObject({
      orgId: fixture.orgA,
      actor: { id: fixture.developer.id },
      scopes: body.scopes,
    });

    const audit = await integrationDb.query.auditLog.findFirst({
      where: and(
        eq(schema.auditLog.orgId, fixture.orgA),
        eq(schema.auditLog.action, "api_token.issue_agent_delegation"),
        eq(schema.auditLog.targetId, body.id),
      ),
    });
    expect(audit?.metadata).toMatchObject({
      sourceAgentId: agentId,
      targetWorkspaceId: "conductor-integration-workspace",
      scopes: body.scopes,
    });
    expect(JSON.stringify(audit).includes(rawToken)).toBe(false);
  });
});
