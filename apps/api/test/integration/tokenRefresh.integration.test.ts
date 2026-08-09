/**
 * Product promise:
 * An expired Companion PAT can be recovered once within 30 days without widening its scopes.
 *
 * Regression caught:
 * Parallel bootstraps could mint multiple successors, leave the expired token refreshable, or
 * persist a replacement outside the caller's workspace.
 *
 * Why this test is integrated:
 * Eligibility, the pre-tenant row lock, tenant GUCs, replacement, revocation, and audit must share
 * one real PostgreSQL transaction.
 *
 * Failure proof:
 * Removing the row lock or old-token revocation allows both concurrent calls to succeed.
 */
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { schema } from "@companion/db";
import {
  ApiTokenRefreshError,
  issueApiToken,
  refreshApiToken,
  resolveApiToken,
  revokeApiToken,
} from "@companion/core/services";
import { createIntegrationFixture, integrationDb, integrationSql, type IntegrationFixture } from "./testDatabase";

describe("expired API token refresh", () => {
  let fixture: IntegrationFixture;

  beforeAll(async () => {
    fixture = await createIntegrationFixture();
  });

  afterAll(async () => {
    await fixture.cleanup();
    await integrationSql.end();
  });

  it("mints exactly one same-scope successor and revokes the expired token atomically", async () => {
    const raw = `cmp_pat_${"a".repeat(48)}`;
    const hash = createHash("sha256").update(raw).digest("hex");
    const [old] = await integrationDb
      .insert(schema.apiTokens)
      .values({
        orgId: fixture.orgA,
        userId: fixture.developer.id,
        name: "Companion bootstrap token",
        tokenPrefix: raw.slice(0, 14),
        tokenHash: hash,
        scopes: ["skills:read", "skills:write"],
        expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      })
      .returning({ id: schema.apiTokens.id });
    if (!old) throw new Error("failed to seed expired token");

    const attempts = await Promise.allSettled([
      refreshApiToken(raw, integrationDb),
      refreshApiToken(raw, integrationDb),
    ]);
    const successes = attempts.filter((attempt) => attempt.status === "fulfilled");
    const failures = attempts.filter((attempt) => attempt.status === "rejected");
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect((failures[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApiTokenRefreshError);

    const result = (successes[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof refreshApiToken>>>).value;
    expect(result.status).toBe("rotated");
    if (result.status !== "rotated") throw new Error("expected rotated token");
    expect(result.scopes).toEqual(["skills:read", "skills:write"]);
    await expect(resolveApiToken(raw, integrationDb)).resolves.toBeNull();
    await expect(resolveApiToken(result.token, integrationDb)).resolves.toMatchObject({
      orgId: fixture.orgA,
      actor: { id: fixture.developer.id },
      scopes: ["skills:read", "skills:write"],
    });

    const rows = await integrationDb
      .select({ id: schema.apiTokens.id, revokedAt: schema.apiTokens.revokedAt, scopes: schema.apiTokens.scopes })
      .from(schema.apiTokens)
      .where(and(eq(schema.apiTokens.orgId, fixture.orgA), eq(schema.apiTokens.userId, fixture.developer.id)));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === old.id)?.revokedAt).toBeInstanceOf(Date);
    expect(rows.find((row) => row.id === result.id)?.scopes).toEqual(["skills:read", "skills:write"]);

    const audit = await integrationDb.query.auditLog.findFirst({
      where: and(
        eq(schema.auditLog.orgId, fixture.orgA),
        eq(schema.auditLog.action, "api_token.refresh"),
        eq(schema.auditLog.targetId, old.id),
      ),
    });
    expect(audit?.metadata).toEqual({ replacementTokenId: result.id });
    expect(JSON.stringify(audit)).not.toContain(result.token);
  });

  it("enforces delegated target binding, expiry, revocation, and no PAT refresh successor", async () => {
    const issued = await issueApiToken({
      actor: fixture.developer,
      orgId: fixture.orgA,
      scopes: ["skills:read", "database:write", "public-skills:install"],
      ttlMs: 5 * 60_000,
      source: {
        type: "agent_auth",
        agentId: "agent-delegation-integration",
        targetWorkspaceId: "conductor-workspace-1",
      },
      database: integrationDb,
    });

    await expect(resolveApiToken(issued.token, integrationDb)).resolves.toBeNull();
    await expect(resolveApiToken(issued.token, integrationDb, "conductor-workspace-2")).resolves.toBeNull();
    await expect(resolveApiToken(issued.token, integrationDb, "conductor-workspace-1")).resolves.toMatchObject({
      orgId: fixture.orgA,
      scopes: ["skills:read", "database:read", "database:write", "public-skills:install"],
    });

    const issuedHash = createHash("sha256").update(issued.token).digest("hex");
    const legacyResolution = await integrationSql`
      SELECT * FROM companion_resolve_api_token(${issuedHash})
    `;
    expect(legacyResolution).toHaveLength(0);

    await revokeApiToken({
      actor: fixture.developer,
      orgId: fixture.orgA,
      tokenId: issued.id,
      database: integrationDb,
    });
    await expect(resolveApiToken(issued.token, integrationDb, "conductor-workspace-1")).resolves.toBeNull();

    const expiredRaw = `cmp_pat_${"d".repeat(48)}`;
    await integrationDb.insert(schema.apiTokens).values({
      orgId: fixture.orgA,
      userId: fixture.developer.id,
      name: "Expired delegated token",
      tokenPrefix: expiredRaw.slice(0, 14),
      tokenHash: createHash("sha256").update(expiredRaw).digest("hex"),
      scopes: ["skills:read"],
      sourceType: "agent_auth",
      sourceAgentId: "agent-delegation-integration",
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(resolveApiToken(expiredRaw, integrationDb)).resolves.toBeNull();
    await expect(refreshApiToken(expiredRaw, integrationDb)).rejects.toBeInstanceOf(ApiTokenRefreshError);

    const audit = await integrationDb.query.auditLog.findFirst({
      where: and(
        eq(schema.auditLog.orgId, fixture.orgA),
        eq(schema.auditLog.action, "api_token.issue_agent_delegation"),
        eq(schema.auditLog.targetId, issued.id),
      ),
    });
    expect(audit?.metadata).toMatchObject({
      sourceAgentId: "agent-delegation-integration",
      targetWorkspaceId: "conductor-workspace-1",
    });
    expect(JSON.stringify(audit)).not.toContain(issued.token);
  });
});
