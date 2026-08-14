import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CompanionPluginConflictError,
  deleteCompanionPlugin,
  listCompanionPlugins,
  resolveCompanionPluginInjection,
  saveCompanionOAuthPlugin,
  saveCompanionPlugin,
} from "@companion/core";
import { schema } from "@companion/db";
import {
  createIntegrationFixture,
  integrationDb,
  integrationSql,
  type IntegrationFixture,
} from "./testDatabase";

describe("member-private Companion Plugins", () => {
  let fixture: IntegrationFixture;
  const masterKey = Buffer.alloc(32, 17);

  beforeEach(async () => {
    fixture = await createIntegrationFixture();
  });

  afterEach(async () => {
    await integrationDb
      .delete(schema.companions)
      .where(eq(schema.companions.orgId, fixture.orgA));
    await fixture.cleanup();
  });

  afterAll(async () => {
    await integrationSql.end();
  });

  it("encrypts labeled accounts, denies admin/cross-tenant reads, and resolves only after runtime access", async () => {
    const account = await saveCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      plugin: {
        provider: "github",
        label: "work",
        transport: "http",
        url: "https://mcp.example.test/github",
        args: [],
        credential_name: "Authorization",
        credential_value: "Bearer plugin-secret-value",
      },
      masterKey,
      database: integrationDb,
    });
    expect(account).toMatchObject({
      provider: "github",
      label: "work",
      connected: true,
    });
    expect(JSON.stringify(account)).not.toContain("plugin-secret-value");

    const stored = await integrationDb.query.companionMcpAccounts.findFirst({
      where: and(
        eq(schema.companionMcpAccounts.orgId, fixture.orgA),
        eq(schema.companionMcpAccounts.id, account.id),
      ),
    });
    expect(stored).toBeDefined();
    expect(JSON.stringify(stored)).not.toContain("plugin-secret-value");
    expect(JSON.stringify(stored?.accountConfig)).toContain("COMPANION_MCP_");

    await expect(listCompanionPlugins({
      actor: fixture.admin,
      orgId: fixture.orgA,
      database: integrationDb,
    })).resolves.toEqual([]);
    await expect(listCompanionPlugins({
      actor: fixture.outsider,
      orgId: fixture.orgA,
      database: integrationDb,
    })).rejects.toThrow("not a member");

    const companionId = randomUUID();
    await integrationDb.insert(schema.companions).values({
      id: companionId,
      orgId: fixture.orgA,
      ownerId: fixture.developer.id,
      name: "Developer Companion",
      selectedMcpAccountIds: [account.id],
    });
    const emptyCompanionId = randomUUID();
    await integrationDb.insert(schema.companions).values({
      id: emptyCompanionId,
      orgId: fixture.orgA,
      ownerId: fixture.developer.id,
      name: "Empty Plugins Companion",
      selectedMcpAccountIds: [],
    });
    await expect(resolveCompanionPluginInjection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId: emptyCompanionId,
      masterKey,
      database: integrationDb,
    })).resolves.toEqual({ accounts: [], credentials: [] });
    const injection = await resolveCompanionPluginInjection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      masterKey,
      database: integrationDb,
    });
    expect(injection.accounts).toHaveLength(1);
    expect(injection.accounts[0]).toMatchObject({ id: account.id, label: "work" });
    expect(injection.credentials).toEqual([
      expect.objectContaining({ value: "Bearer plugin-secret-value" }),
    ]);

    // Detach from the Companion without disconnecting the member Plugins connection.
    await integrationDb
      .update(schema.companions)
      .set({ selectedMcpAccountIds: [] })
      .where(eq(schema.companions.id, companionId));
    await expect(resolveCompanionPluginInjection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      masterKey,
      database: integrationDb,
    })).resolves.toEqual({ accounts: [], credentials: [] });
    await expect(listCompanionPlugins({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database: integrationDb,
    })).resolves.toEqual([expect.objectContaining({ id: account.id })]);

    await deleteCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      accountId: account.id,
      database: integrationDb,
    });
    await expect(listCompanionPlugins({
      actor: fixture.developer,
      orgId: fixture.orgA,
      database: integrationDb,
    })).resolves.toEqual([]);
  });

  it("stores authless HTTP accounts and maps duplicate labels to a conflict", async () => {
    const account = await saveCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      plugin: {
        provider: "github",
        label: "work",
        transport: "http",
        url: "https://mcp.example.test/github/work",
        args: [],
      },
      masterKey,
      database: integrationDb,
    });
    expect(account).toMatchObject({
      provider: "github",
      label: "work",
      transport: "http",
      endpoint: "https://mcp.example.test/github/work",
      connected: true,
    });

    await expect(saveCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      plugin: {
        provider: "github",
        label: "work",
        transport: "http",
        url: "https://mcp.example.test/github/work",
        args: [],
      },
      masterKey,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionPluginConflictError);

    await deleteCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      accountId: account.id,
      database: integrationDb,
    });
  });

  it("keeps OAuth grants encrypted and refreshes them before the next Box injection", async () => {
    const credential = {
      kind: "oauth" as const,
      version: 1 as const,
      serverName: "app.linear/linear" as const,
      accessToken: "oauth-access-old",
      refreshToken: "oauth-refresh-secret",
      accessExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      scope: "read write",
      tokenType: "Bearer" as const,
      tokenEndpoint: "https://mcp.linear.app/token",
      resource: "https://mcp.linear.app/mcp",
      client: {
        clientId: "dynamic-client",
        clientSecret: null,
        tokenEndpointAuthMethod: "none" as const,
      },
    };
    const account = await saveCompanionOAuthPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      provider: "linear",
      label: "work",
      remoteUrl: "https://mcp.linear.app/mcp",
      credential,
      masterKey,
      database: integrationDb,
    });

    const stored = await integrationDb.query.companionMcpAccounts.findFirst({
      where: and(
        eq(schema.companionMcpAccounts.orgId, fixture.orgA),
        eq(schema.companionMcpAccounts.id, account.id),
      ),
    });
    expect(JSON.stringify(stored)).not.toContain("oauth-access-old");
    expect(JSON.stringify(stored)).not.toContain("oauth-refresh-secret");
    expect(JSON.stringify(account)).not.toContain("oauth-");

    const companionId = randomUUID();
    await integrationDb.insert(schema.companions).values({
      id: companionId,
      orgId: fixture.orgA,
      ownerId: fixture.developer.id,
      name: "OAuth Companion",
      selectedMcpAccountIds: [account.id],
    });
    await integrationDb.insert(schema.companionWorkspaceAccess).values({
      orgId: fixture.orgA,
      companionId,
      ownerId: fixture.developer.id,
      role: "viewer",
      grantedBy: fixture.developer.id,
    });
    const viewerFetch = vi.fn();
    await expect(resolveCompanionPluginInjection({
      actor: fixture.admin,
      orgId: fixture.orgA,
      companionId,
      masterKey,
      database: integrationDb,
      fetchImpl: viewerFetch as unknown as typeof fetch,
    })).rejects.toThrow("runtime access requires owner or editor");
    expect(viewerFetch).not.toHaveBeenCalled();

    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("refresh_token")).toBe("oauth-refresh-secret");
      return Response.json({
        access_token: "oauth-access-new",
        refresh_token: "oauth-refresh-rotated",
        expires_in: 3600,
      });
    }) as typeof fetch;
    const injection = await resolveCompanionPluginInjection({
      actor: fixture.developer,
      orgId: fixture.orgA,
      companionId,
      masterKey,
      database: integrationDb,
      fetchImpl,
    });
    expect(injection.accounts).toEqual([
      expect.objectContaining({
        id: account.id,
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: expect.stringMatching(/^COMPANION_MCP_/) },
      }),
    ]);
    expect(injection.credentials).toEqual([
      expect.objectContaining({ value: "Bearer oauth-access-new" }),
    ]);

    const refreshed = await integrationDb.query.companionMcpAccounts.findFirst({
      where: eq(schema.companionMcpAccounts.id, account.id),
    });
    expect(refreshed?.credentialGeneration).not.toBe(stored?.credentialGeneration);
    expect(JSON.stringify(refreshed)).not.toContain("oauth-access-new");
    expect(JSON.stringify(refreshed)).not.toContain("oauth-refresh-rotated");

    await expect(saveCompanionOAuthPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      provider: "linear",
      label: "WORK",
      remoteUrl: "https://mcp.linear.app/mcp",
      credential,
      masterKey,
      database: integrationDb,
    })).rejects.toBeInstanceOf(CompanionPluginConflictError);

    await deleteCompanionPlugin({
      actor: fixture.developer,
      orgId: fixture.orgA,
      accountId: account.id,
      database: integrationDb,
    });
  });
});
