import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@companion/db";

const vault = vi.hoisted(() => new Map<string, {
  id: string;
  key: string;
  audience: "personal" | "restricted" | "organization";
  ownerId: string;
  recipients: string[];
  active: boolean;
  value: string;
}>());

vi.mock("../src/secrets", () => ({
  pinAccessibleSecret: vi.fn(async (input: { actor: { id: string }; secretId: string }) => {
    const secret = vault.get(input.secretId);
    if (!secret || !secret.active || (secret.ownerId !== input.actor.id && secret.audience !== "organization" && !secret.recipients.includes(input.actor.id))) {
      throw new Error("secret not found");
    }
    return {
      secretId: secret.id,
      version: 1,
      key: secret.key,
      name: "Vanish credential",
      ownerId: secret.ownerId,
      ownerName: "Owner",
      audience: secret.audience,
    };
  }),
  decryptPinnedSecret: vi.fn(async (input: { actor: { id: string }; secretId: string }) => {
    const secret = vault.get(input.secretId);
    if (!secret || !secret.active || (secret.ownerId !== input.actor.id && secret.audience !== "organization" && !secret.recipients.includes(input.actor.id))) {
      throw new Error("secret not found");
    }
    return {
      pin: { secretId: secret.id, version: 1 },
      value: secret.value,
    };
  }),
}));

import {
  deleteVanishConnection,
  getDecryptedVanishKey,
  getVanishConnection,
  resolveVanishSecretPin,
  setOrgVanishConnection,
  setVanishConnection,
} from "../src/vanishConnections";

const ORG = "00000000-0000-0000-0000-0000000000cc";
const PERSONAL = "00000000-0000-0000-0000-000000000101";
const SHARED = "00000000-0000-0000-0000-000000000102";
const WRONG_KEY = "00000000-0000-0000-0000-000000000103";
const me = { id: "user-me", email: "me@example.com", name: "Me" };
const other = { id: "user-other", email: "other@example.com", name: "Other" };

type PersonalBinding = typeof schema.userVanishConnections.$inferSelect;
type OrgBinding = typeof schema.orgVanishConnections.$inferSelect;

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

function vanishDatabase(role: "owner" | "admin" | "developer" | null = "developer") {
  const personal: PersonalBinding[] = [];
  const shared: OrgBinding[] = [];
  const audit: Record<string, unknown>[] = [];
  const matches = (row: Record<string, unknown>, condition: unknown) =>
    conditionParams(condition)
      .filter((value) => typeof value === "string")
      .every((value) => Object.values(row).includes(value));

  const database = {
    query: { memberships: { findFirst: async () => (role ? { orgRole: role } : undefined) } },
    select: () => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const source = table === schema.userVanishConnections ? personal : shared;
          const result = Promise.resolve(source.filter((row) => matches(row as unknown as Record<string, unknown>, condition)));
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
        const source = table === schema.userVanishConnections ? personal : shared;
        return {
          onConflictDoUpdate: () => ({
            returning: async () => {
              const existing = source[0];
              if (existing) {
                existing.secretId = String(raw.secretId);
                existing.updatedAt = new Date("2026-07-13T13:00:00Z");
                return [existing];
              }
              const created = {
                ...raw,
                createdAt: new Date("2026-07-13T12:00:00Z"),
                updatedAt: new Date("2026-07-13T12:00:00Z"),
              } as unknown as PersonalBinding & OrgBinding;
              source.push(created);
              return [created];
            },
          }),
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        const source = table === schema.userVanishConnections ? personal : shared;
        const kept = source.filter((row) => !matches(row as unknown as Record<string, unknown>, condition));
        source.splice(0, source.length, ...(kept as never[]));
      },
    }),
  } as unknown as Db;
  return { database, personal, shared, audit };
}

beforeEach(() => {
  vault.clear();
  vault.set(PERSONAL, { id: PERSONAL, key: "VANISH_API_KEY", audience: "personal", ownerId: me.id, recipients: [], active: true, value: "vanish-personal" });
  vault.set(SHARED, { id: SHARED, key: "VANISH_API_KEY", audience: "organization", ownerId: me.id, recipients: [], active: true, value: "vanish-shared" });
  vault.set(WRONG_KEY, { id: WRONG_KEY, key: "OPENAI_API_KEY", audience: "personal", ownerId: me.id, recipients: [], active: true, value: "not-vanish" });
});

describe("dedicated Vanish vault bindings", () => {
  it("binds only VANISH_API_KEY metadata and disconnect preserves the vault secret", async () => {
    const store = vanishDatabase();
    const saved = await setVanishConnection({ actor: me, orgId: ORG, secretId: PERSONAL, database: store.database });
    expect(saved).toMatchObject({ secret_id: PERSONAL, key_name: "VANISH_API_KEY", scope: "personal" });
    expect(JSON.stringify(saved)).not.toContain("vanish-personal");
    expect((await getDecryptedVanishKey({ actor: me, orgId: ORG, database: store.database }))?.value).toBe("vanish-personal");
    await deleteVanishConnection({ actor: me, orgId: ORG, database: store.database });
    expect(await getVanishConnection({ actor: me, orgId: ORG, database: store.database })).toBeNull();
    expect(vault.has(PERSONAL)).toBe(true);
  });

  it("rejects wrong keys and requires organization audience plus manager role for workspace", async () => {
    const adminStore = vanishDatabase("admin");
    await expect(setVanishConnection({ actor: me, orgId: ORG, secretId: WRONG_KEY, database: adminStore.database })).rejects.toThrow(/VANISH_API_KEY/);
    await expect(setOrgVanishConnection({ actor: me, orgId: ORG, secretId: PERSONAL, database: adminStore.database })).rejects.toThrow(/organization/);
    await setOrgVanishConnection({ actor: me, orgId: ORG, secretId: SHARED, database: adminStore.database });
    expect((await resolveVanishSecretPin({ actor: other, orgId: ORG, database: adminStore.database }))?.secret.secretId).toBe(SHARED);
    await expect(setOrgVanishConnection({ actor: me, orgId: ORG, secretId: SHARED, database: vanishDatabase("developer").database })).rejects.toThrow(/owners and admins/);
  });

  it("falls back to workspace after personal access is revoked", async () => {
    const store = vanishDatabase("admin");
    await setOrgVanishConnection({ actor: me, orgId: ORG, secretId: SHARED, database: store.database });
    vault.get(PERSONAL)!.audience = "restricted";
    vault.get(PERSONAL)!.recipients = [other.id];
    await setVanishConnection({ actor: other, orgId: ORG, secretId: PERSONAL, database: store.database });
    expect((await resolveVanishSecretPin({ actor: other, orgId: ORG, database: store.database }))?.secret.secretId).toBe(PERSONAL);
    vault.get(PERSONAL)!.recipients = [];
    expect((await resolveVanishSecretPin({ actor: other, orgId: ORG, database: store.database }))?.secret.secretId).toBe(SHARED);
  });
});
