import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CompanionPluginConflictError,
  deleteCompanionPlugin,
  listCompanionPlugins,
  resolveCompanionPluginInjection,
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
    });
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
});
