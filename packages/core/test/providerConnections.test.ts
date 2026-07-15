import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import {
  deleteOrgProviderConnection,
  deleteProviderConnection,
  getDecryptedProviderKey,
  listOrgProviderConnections,
  listProviderConnections,
  resolveProviderCredentialPin,
  setOrgProviderConnection,
  setProviderConnection,
} from "../src/providerConnections";

const ORG = "00000000-0000-0000-0000-0000000000cc";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000dd";
const me = { id: "user-me", email: "me@example.com", name: "Me" };
const other = { id: "user-other", email: "other@example.com", name: "Other" };
const MASTER_KEY = Buffer.alloc(32, 7);

type Connection = typeof schema.modelProviderConnections.$inferSelect;
type Version = typeof schema.modelProviderCredentialVersions.$inferSelect;

function conditionParams(condition: unknown, output: unknown[] = [], seen = new Set<unknown>()): unknown[] {
  if (condition === null || typeof condition !== "object" || seen.has(condition)) return output;
  seen.add(condition);
  const record = condition as Record<string, unknown>;
  if ("value" in record && "encoder" in record) {
    output.push(record.value);
    return output;
  }
  if ("table" in record && "name" in record && "columnType" in record) return output;
  for (const value of Object.values(record)) conditionParams(value, output, seen);
  return output;
}

function providerDatabase(role: "owner" | "admin" | "developer" | null = "developer") {
  const connections: Connection[] = [];
  const versions: Version[] = [];
  const audit: Record<string, unknown>[] = [];

  const matches = (record: Record<string, unknown>, condition: unknown) =>
    conditionParams(condition)
      .filter((value) => typeof value === "string" || typeof value === "number")
      .every((value) => Object.values(record).includes(value));

  const database = {
    query: { memberships: { findFirst: async () => (role ? { orgRole: role } : undefined) } },
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(database as unknown as Db),
    execute: async () => [],
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const source = table === schema.modelProviderConnections ? connections : versions;
          const result = Promise.resolve(source.filter((item) => matches(item as unknown as Record<string, unknown>, condition)));
          return Object.assign(result, { limit: async (limit: number) => (await result).slice(0, limit) });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (raw: Record<string, unknown>) => {
        if (table === schema.auditLog) {
          audit.push(raw);
          return Promise.resolve();
        }
        if (table === schema.modelProviderCredentialVersions) {
          versions.push({
            ...(raw as unknown as Version),
            createdAt: new Date("2026-07-13T12:00:00Z"),
          });
          return Promise.resolve();
        }
        return {
          onConflictDoUpdate: () => ({
            returning: async () => {
              const existing = connections.find((candidate) =>
                candidate.orgId === raw.orgId &&
                candidate.scope === raw.scope &&
                candidate.provider === raw.provider &&
                (raw.scope === "organization" || candidate.userId === raw.userId),
              );
              const now = raw.updatedAt as Date;
              if (existing) {
                existing.keyName = String(raw.keyName);
                existing.currentVersion += 1;
                existing.createdBy = String(raw.createdBy);
                existing.updatedAt = now;
                return [existing];
              }
              const connection = {
                ...(raw as unknown as Connection),
                createdAt: new Date("2026-07-13T12:00:00Z"),
                updatedAt: now,
              };
              connections.push(connection);
              return [connection];
            },
          }),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        if (table !== schema.modelProviderConnections) return;
        const removed = connections.filter((item) => matches(item as unknown as Record<string, unknown>, condition));
        const removedIds = new Set(removed.map((item) => item.id));
        connections.splice(0, connections.length, ...connections.filter((item) => !removedIds.has(item.id)));
        versions.splice(0, versions.length, ...versions.filter((item) => !removedIds.has(item.connectionId)));
      },
    }),
  } as unknown as Db;

  return { database, connections, versions, audit };
}

describe("dedicated model-provider credentials", () => {
  it("stores encrypted immutable versions and never returns or audits plaintext", async () => {
    const store = providerDatabase();
    const saved = await setProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      keyName: "ANTHROPIC_API_KEY",
      apiKey: "sk-provider-v1",
      masterKey: MASTER_KEY,
      database: store.database,
    });

    expect(saved).toMatchObject({ provider: "anthropic", scope: "personal", credential_version: 1, set: true });
    expect(JSON.stringify(saved)).not.toContain("sk-provider-v1");
    expect(JSON.stringify(store.versions)).not.toContain("sk-provider-v1");
    expect(JSON.stringify(store.audit)).not.toContain("sk-provider-v1");
    expect(JSON.stringify(store.audit)).not.toContain("api_key");

    const firstPin = await resolveProviderCredentialPin({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      database: store.database,
    });
    expect(firstPin).toMatchObject({ connectionId: saved.id, credentialVersion: 1, scope: "personal" });

    await setProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      keyName: "ANTHROPIC_AUTH_TOKEN",
      apiKey: "sk-provider-v2",
      masterKey: MASTER_KEY,
      database: store.database,
    });
    expect(store.versions.map((version) => version.version)).toEqual([1, 2]);
    expect(store.versions.map((version) => version.keyName)).toEqual([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
    ]);
    const pinnedFirstVersion = await getDecryptedProviderKey({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      connectionId: firstPin!.connectionId,
      credentialVersion: firstPin!.credentialVersion,
      keyName: firstPin!.keyName,
      masterKey: MASTER_KEY,
      database: store.database,
    });
    expect(pinnedFirstVersion).toMatchObject({
      keyName: "ANTHROPIC_API_KEY",
      credentialVersion: 1,
      value: "sk-provider-v1",
    });
    await expect(getDecryptedProviderKey({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      connectionId: firstPin!.connectionId,
      credentialVersion: firstPin!.credentialVersion,
      keyName: "ANTHROPIC_AUTH_TOKEN",
      masterKey: MASTER_KEY,
      database: store.database,
    })).resolves.toBeNull();
    expect(await resolveProviderCredentialPin({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      database: store.database,
    })).toMatchObject({ keyName: "ANTHROPIC_AUTH_TOKEN", credentialVersion: 2 });
  });

  it("resolves personal before workspace and exposes workspace metadata to members", async () => {
    const store = providerDatabase("admin");
    await setOrgProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      keyName: "ANTHROPIC_API_KEY",
      apiKey: "sk-workspace",
      masterKey: MASTER_KEY,
      database: store.database,
    });
    expect(await listOrgProviderConnections({ actor: other, orgId: ORG, database: store.database })).toHaveLength(1);
    expect((await resolveProviderCredentialPin({ actor: other, orgId: ORG, provider: "anthropic", database: store.database }))?.scope).toBe("organization");

    await setProviderConnection({
      actor: other,
      orgId: ORG,
      provider: "anthropic",
      keyName: "ANTHROPIC_API_KEY",
      apiKey: "sk-personal",
      masterKey: MASTER_KEY,
      database: store.database,
    });
    expect((await resolveProviderCredentialPin({ actor: other, orgId: ORG, provider: "anthropic", database: store.database }))?.scope).toBe("personal");
    expect(await listProviderConnections({ actor: other, orgId: ORG, database: store.database })).toHaveLength(1);
  });

  it("disconnect deletes ciphertext while an already-persisted redacted run pin remains", async () => {
    const store = providerDatabase();
    const saved = await setProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "openai",
      keyName: "OPENAI_API_KEY",
      apiKey: "sk-delete-me",
      masterKey: MASTER_KEY,
      database: store.database,
    });
    const runSnapshot = { connectionId: saved.id, credentialVersion: 1, provider: "openai", keyName: "OPENAI_API_KEY" };
    await deleteProviderConnection({ actor: me, orgId: ORG, provider: "openai", database: store.database });

    expect(runSnapshot).toMatchObject({ connectionId: saved.id, credentialVersion: 1 });
    expect(store.connections).toEqual([]);
    expect(store.versions).toEqual([]);
    expect(await getDecryptedProviderKey({
      actor: me,
      orgId: ORG,
      ...runSnapshot,
      masterKey: MASTER_KEY,
      database: store.database,
    })).toBeNull();
  });

  it("validates credentials and protects workspace mutations with role checks", async () => {
    const developerStore = providerDatabase("developer");
    await expect(setProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "openai",
      keyName: "OPENAI_API_KEY",
      apiKey: "   ",
      masterKey: MASTER_KEY,
      database: developerStore.database,
    })).rejects.toThrow(/invalid/);
    await expect(setOrgProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "openai",
      keyName: "OPENAI_API_KEY",
      apiKey: "key",
      masterKey: MASTER_KEY,
      database: developerStore.database,
    })).rejects.toThrow(/owners and admins/);
    await expect(deleteOrgProviderConnection({ actor: me, orgId: ORG, provider: "openai", database: developerStore.database })).rejects.toThrow(/owners and admins/);
    await expect(listProviderConnections({ actor: me, orgId: OTHER_ORG, database: providerDatabase(null).database })).rejects.toThrow(/not a member/);
  });
});
