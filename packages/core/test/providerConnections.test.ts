import { beforeEach, describe, expect, it, vi } from "vitest";
import { schema, type Db } from "@companion/db";

const vault = vi.hoisted(() => new Map<string, {
  id: string;
  orgId: string;
  key: string;
  name: string;
  ownerId: string;
  ownerName: string;
  audience: "personal" | "restricted" | "organization";
  recipients: string[];
  active: boolean;
  currentVersion: number;
  values: Map<number, string>;
}>());

vi.mock("../src/secrets", () => {
  function accessible(secretId: string, actorId: string, orgId: string) {
    const secret = vault.get(secretId);
    if (
      !secret ||
      secret.orgId !== orgId ||
      !secret.active ||
      (secret.ownerId !== actorId && secret.audience !== "organization" && !secret.recipients.includes(actorId))
    ) throw new Error("secret not found");
    return secret;
  }
  return {
    pinAccessibleSecret: vi.fn(async (input: { actor: { id: string }; orgId: string; secretId: string }) => {
      const secret = accessible(input.secretId, input.actor.id, input.orgId);
      return {
        secretId: secret.id,
        version: secret.currentVersion,
        key: secret.key,
        name: secret.name,
        ownerId: secret.ownerId,
        ownerName: secret.ownerName,
        audience: secret.audience,
      };
    }),
    decryptPinnedSecret: vi.fn(async (input: {
      actor: { id: string };
      orgId: string;
      secretId: string;
      version: number;
    }) => {
      const secret = accessible(input.secretId, input.actor.id, input.orgId);
      const value = secret.values.get(input.version);
      if (value === undefined) throw new Error("secret not found");
      return {
        pin: {
          secretId: secret.id,
          version: input.version,
          key: secret.key,
          name: secret.name,
          ownerId: secret.ownerId,
          ownerName: secret.ownerName,
          audience: secret.audience,
        },
        value,
      };
    }),
  };
});

import {
  connectedOrgProviderIds,
  connectedProviderIds,
  deleteOrgProviderConnection,
  deleteProviderConnection,
  getDecryptedProviderKey,
  listOrgProviderConnections,
  listProviderConnections,
  resolveProviderSecretPin,
  setOrgProviderConnection,
  setProviderConnection,
} from "../src/providerConnections";
import { pinAccessibleSecret } from "../src/secrets";

const ORG = "00000000-0000-0000-0000-0000000000cc";
const OTHER_ORG = "00000000-0000-0000-0000-0000000000dd";
const PERSONAL_SECRET = "00000000-0000-0000-0000-000000000101";
const SHARED_SECRET = "00000000-0000-0000-0000-000000000102";
const RESTRICTED_SECRET = "00000000-0000-0000-0000-000000000103";
const me = { id: "user-me", email: "me@example.com", name: "Me" };
const other = { id: "user-other", email: "o@example.com", name: "Other" };

type Binding = {
  orgId: string;
  userId?: string;
  provider: string;
  keyName: string;
  secretId: string;
  createdBy?: string | null;
  createdAt: Date;
  updatedAt: Date;
};

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
  const personal: Binding[] = [];
  const shared: Binding[] = [];
  const audit: Record<string, unknown>[] = [];
  const knownFilterValues = new Set<unknown>([
    ORG,
    OTHER_ORG,
    me.id,
    other.id,
    "anthropic",
    "openai",
    "vanish",
    PERSONAL_SECRET,
    SHARED_SECRET,
    RESTRICTED_SECRET,
  ]);

  const matches = (row: Binding, condition: unknown) =>
    conditionParams(condition)
      .filter((value) => knownFilterValues.has(value))
      .every((value) => (Object.values(row) as unknown[]).includes(value));

  const project = (row: Binding, projection?: Record<string, unknown>) => {
    if (!projection) return row;
    return Object.fromEntries(Object.keys(projection).map((key) => [key, row[key as keyof Binding]]));
  };

  const database = {
    query: { memberships: { findFirst: async () => (role ? { orgRole: role } : undefined) } },
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: (condition: unknown) => {
          const source = table === schema.userProviderConnections
            ? personal
            : table === schema.orgProviderConnections
              ? shared
              : [];
          const result = Promise.resolve(source.filter((row) => matches(row, condition)).map((row) => project(row, projection)));
          return Object.assign(result, { limit: async (limit: number) => (await result).slice(0, limit) });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        if (table === schema.auditLog) {
          audit.push(value);
          return Promise.resolve();
        }
        const source = table === schema.userProviderConnections ? personal : shared;
        return {
          onConflictDoUpdate: async (input: { set: Record<string, unknown> }) => {
            const secret = vault.get(String(value.secretId));
            if (!secret || secret.key !== value.keyName) throw new Error("provider key must match the bound secret key");
            const existing = source.find((row) =>
              row.orgId === value.orgId &&
              row.provider === value.provider &&
              (table !== schema.userProviderConnections || row.userId === value.userId),
            );
            if (existing) Object.assign(existing, input.set);
            else source.push({
              ...(value as Omit<Binding, "createdAt" | "updatedAt">),
              createdAt: new Date("2026-07-13T12:00:00Z"),
              updatedAt: new Date("2026-07-13T12:00:00Z"),
            });
          },
        };
      },
    }),
    delete: (table: unknown) => ({
      where: async (condition: unknown) => {
        const source = table === schema.userProviderConnections ? personal : shared;
        const doomed = new Set(source.filter((row) => matches(row, condition)));
        if (table === schema.userProviderConnections) personal.splice(0, personal.length, ...personal.filter((row) => !doomed.has(row)));
        else shared.splice(0, shared.length, ...shared.filter((row) => !doomed.has(row)));
      },
    }),
  } as unknown as Db;

  return { database, personal, shared, audit };
}

function seedVault(): void {
  vault.clear();
  vault.set(PERSONAL_SECRET, {
    id: PERSONAL_SECRET,
    orgId: ORG,
    key: "ANTHROPIC_API_KEY",
    name: "My Anthropic key",
    ownerId: me.id,
    ownerName: me.name,
    audience: "personal",
    recipients: [],
    active: true,
    currentVersion: 1,
    values: new Map([[1, "sk-personal-v1"]]),
  });
  vault.set(SHARED_SECRET, {
    id: SHARED_SECRET,
    orgId: ORG,
    key: "ANTHROPIC_API_KEY",
    name: "Workspace Anthropic key",
    ownerId: me.id,
    ownerName: me.name,
    audience: "organization",
    recipients: [],
    active: true,
    currentVersion: 1,
    values: new Map([[1, "sk-workspace-v1"]]),
  });
  vault.set(RESTRICTED_SECRET, {
    id: RESTRICTED_SECRET,
    orgId: ORG,
    key: "OPENAI_API_KEY",
    name: "Restricted OpenAI key",
    ownerId: me.id,
    ownerName: me.name,
    audience: "restricted",
    recipients: [other.id],
    active: true,
    currentVersion: 1,
    values: new Map([[1, "sk-restricted-v1"]]),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  seedVault();
});

describe("personal provider vault bindings", () => {
  it("stores and returns only a secret reference, then decrypts the pinned version at the last moment", async () => {
    const store = providerDatabase();
    const saved = await setProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      keyName: "ANTHROPIC_API_KEY",
      secretId: PERSONAL_SECRET,
      database: store.database,
    });

    expect(saved).toMatchObject({ provider: "anthropic", secret_id: PERSONAL_SECRET, secret_name: "My Anthropic key" });
    expect(JSON.stringify(saved)).not.toContain("sk-personal-v1");
    expect(store.personal).toEqual([expect.objectContaining({ secretId: PERSONAL_SECRET })]);
    expect(JSON.stringify(store.personal)).not.toContain("sk-personal-v1");
    expect(await connectedProviderIds({ actor: me, orgId: ORG, database: store.database })).toEqual(new Set(["anthropic"]));

    const pin = await resolveProviderSecretPin({ database: store.database, actor: me, orgId: ORG, provider: "anthropic" });
    expect(pin?.secret.version).toBe(1);
    vault.get(PERSONAL_SECRET)!.currentVersion = 2;
    vault.get(PERSONAL_SECRET)!.values.set(2, "sk-personal-v2");
    expect(await getDecryptedProviderKey({
      database: store.database,
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      secretId: pin!.secret.secretId,
      secretVersion: pin!.secret.version,
      keyName: pin!.keyName,
    })).toMatchObject({ value: "sk-personal-v1", secretVersion: 1 });
  });

  it("hides a binding after access is revoked and disconnect never deletes the vault secret", async () => {
    const store = providerDatabase();
    await setProviderConnection({ actor: other, orgId: ORG, provider: "openai", keyName: "OPENAI_API_KEY", secretId: RESTRICTED_SECRET, database: store.database });
    expect(await listProviderConnections({ actor: other, orgId: ORG, database: store.database })).toHaveLength(1);
    vault.get(RESTRICTED_SECRET)!.recipients = [];
    expect(await listProviderConnections({ actor: other, orgId: ORG, database: store.database })).toEqual([]);
    await deleteProviderConnection({ actor: other, orgId: ORG, provider: "openai", database: store.database });
    expect(vault.has(RESTRICTED_SECRET)).toBe(true);
  });

  it("does not turn infrastructure failures into a misleading disconnected state", async () => {
    const store = providerDatabase();
    await setProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", secretId: PERSONAL_SECRET, database: store.database });
    vi.mocked(pinAccessibleSecret).mockRejectedValueOnce(new Error("database unavailable"));

    await expect(listProviderConnections({ actor: me, orgId: ORG, database: store.database })).rejects.toThrow(
      "database unavailable",
    );
  });

  it("rejects non-members", async () => {
    await expect(listProviderConnections({ actor: me, orgId: ORG, database: providerDatabase(null).database })).rejects.toThrow("not a member");
  });
});

describe("workspace provider vault bindings", () => {
  it("requires an organization secret and resolves personal before workspace", async () => {
    const store = providerDatabase("admin");
    await expect(setOrgProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", secretId: PERSONAL_SECRET, database: store.database })).rejects.toThrow(/organization secret/);
    await setOrgProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", secretId: SHARED_SECRET, database: store.database });
    expect(await connectedOrgProviderIds({ actor: other, orgId: ORG, database: store.database })).toEqual(new Set(["anthropic"]));
    expect((await getDecryptedProviderKey({ database: store.database, actor: other, orgId: ORG, provider: "anthropic" }))?.value).toBe("sk-workspace-v1");

    vault.get(PERSONAL_SECRET)!.audience = "restricted";
    vault.get(PERSONAL_SECRET)!.recipients = [other.id];
    await setProviderConnection({ actor: other, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", secretId: PERSONAL_SECRET, database: store.database });
    expect((await getDecryptedProviderKey({ database: store.database, actor: other, orgId: ORG, provider: "anthropic" }))?.value).toBe("sk-personal-v1");

    await deleteOrgProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", database: store.database });
    expect(await listOrgProviderConnections({ actor: me, orgId: ORG, database: store.database })).toEqual([]);
    expect(vault.has(SHARED_SECRET)).toBe(true);
  });

  it("rejects non-admin workspace mutations", async () => {
    const store = providerDatabase("developer");
    await expect(setOrgProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", secretId: SHARED_SECRET, database: store.database })).rejects.toThrow(/owners and admins/);
    await expect(deleteOrgProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", database: store.database })).rejects.toThrow(/owners and admins/);
  });
});
