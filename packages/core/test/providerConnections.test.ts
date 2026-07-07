import { describe, expect, it } from "vitest";
import {
  connectedOrgProviderIds,
  connectedProviderIds,
  deleteOrgProviderConnection,
  deleteProviderConnection,
  generateSecretsKey,
  getDecryptedProviderKey,
  listOrgProviderConnections,
  listProviderConnections,
  parseSecretsKey,
  setOrgProviderConnection,
  setProviderConnection,
  type ActorContext,
} from "../src/services";
import { emptyStore, fakeRunsDb } from "./runsFakeDb";

const ORG = "00000000-0000-0000-0000-0000000000cc";
const me: ActorContext = { id: "user-me", email: "me@example.com", name: "Me" };
const other: ActorContext = { id: "user-other", email: "o@example.com", name: "Other" };
const KEK = parseSecretsKey(generateSecretsKey());

describe("provider connections", () => {
  it("saves, lists and round-trips a connection write-only (never returns the key)", async () => {
    const store = emptyStore();
    const database = fakeRunsDb(store);

    const saved = await setProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      keyName: "ANTHROPIC_API_KEY",
      key: "sk-my-secret",
      secretsKey: KEK,
      database,
    });
    expect(saved).toMatchObject({ provider: "anthropic", key_name: "ANTHROPIC_API_KEY", set: true });

    const list = await listProviderConnections({ actor: me, orgId: ORG, database });
    expect(list).toEqual([expect.objectContaining({ provider: "anthropic", key_name: "ANTHROPIC_API_KEY" })]);
    expect(JSON.stringify(list)).not.toContain("sk-my-secret");
    // The stored ciphertext is not the plaintext.
    expect(store.providerConnections[0]?.ciphertext).not.toContain("sk-my-secret");

    const decrypted = await getDecryptedProviderKey({
      database,
      orgId: ORG,
      userId: me.id,
      provider: "anthropic",
      secretsKey: KEK,
    });
    expect(decrypted).toEqual({ keyName: "ANTHROPIC_API_KEY", value: "sk-my-secret" });

    expect(await connectedProviderIds({ actor: me, orgId: ORG, database })).toEqual(new Set(["anthropic"]));
  });

  it("upserts (replaces) an existing connection for the same provider", async () => {
    const store = emptyStore();
    const database = fakeRunsDb(store);
    await setProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", key: "old", secretsKey: KEK, database });
    await setProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", key: "new", secretsKey: KEK, database });
    expect(store.providerConnections).toHaveLength(1);
    const decrypted = await getDecryptedProviderKey({ database, orgId: ORG, userId: me.id, provider: "anthropic", secretsKey: KEK });
    expect(decrypted?.value).toBe("new");
  });

  it("scopes connections per user (one user cannot see another's)", async () => {
    const store = emptyStore();
    const database = fakeRunsDb(store);
    // Seed BOTH users so `user_id` is a distinguishing column the fakeDb WHERE can filter on.
    await setProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", key: "mine", secretsKey: KEK, database });
    await setProviderConnection({ actor: other, orgId: ORG, provider: "openai", keyName: "OPENAI_API_KEY", key: "theirs", secretsKey: KEK, database });
    // list filters on a single distinguishing column (user_id) — the fakeDb models this correctly.
    // (A precise multi-column negative lookup is a fakeDb-unmodelable case — the real query uses
    // and(eq(orgId), eq(userId), eq(provider)) + RLS; cross-user isolation is verified structurally.)
    expect((await listProviderConnections({ actor: me, orgId: ORG, database })).map((c) => c.provider)).toEqual(["anthropic"]);
    expect((await listProviderConnections({ actor: other, orgId: ORG, database })).map((c) => c.provider)).toEqual(["openai"]);
  });

  it("deletes a connection", async () => {
    const store = emptyStore();
    const database = fakeRunsDb(store);
    await setProviderConnection({ actor: me, orgId: ORG, provider: "openai", keyName: "OPENAI_API_KEY", key: "k", secretsKey: KEK, database });
    await deleteProviderConnection({ actor: me, orgId: ORG, provider: "openai", database });
    expect(await listProviderConnections({ actor: me, orgId: ORG, database })).toEqual([]);
  });

  it("rejects non-members", async () => {
    const database = fakeRunsDb(emptyStore({ role: null }));
    await expect(listProviderConnections({ actor: me, orgId: ORG, database })).rejects.toThrow("not a member");
  });
});

describe("workspace-shared provider connections", () => {
  it("an admin can set/list/delete a shared connection (any member can read it)", async () => {
    const store = emptyStore({ role: "admin" });
    const database = fakeRunsDb(store);

    await setOrgProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      keyName: "ANTHROPIC_API_KEY",
      key: "sk-shared",
      secretsKey: KEK,
      database,
    });
    // Write-only: the list never returns the value.
    const list = await listOrgProviderConnections({ actor: me, orgId: ORG, database });
    expect(list).toEqual([{ provider: "anthropic", key_name: "ANTHROPIC_API_KEY", set: true, created_at: expect.any(String) }]);
    expect(JSON.stringify(list)).not.toContain("sk-shared");
    expect([...(await connectedOrgProviderIds({ actor: me, orgId: ORG, database }))]).toEqual(["anthropic"]);

    await deleteOrgProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", database });
    expect(await listOrgProviderConnections({ actor: me, orgId: ORG, database })).toEqual([]);
  });

  it("rejects a non-admin trying to set or delete a shared connection", async () => {
    const database = fakeRunsDb(emptyStore({ role: "developer" }));
    await expect(
      setOrgProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", key: "x", secretsKey: KEK, database }),
    ).rejects.toThrow(/owners and admins/);
    await expect(deleteOrgProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", database })).rejects.toThrow(/owners and admins/);
  });

  it("resolves a provider key personal-first, then falls back to the workspace-shared key", async () => {
    const store = emptyStore({ role: "admin" });
    const database = fakeRunsDb(store);
    // Only a workspace-shared key exists → a member with no personal key resolves to it.
    await setOrgProviderConnection({
      actor: me,
      orgId: ORG,
      provider: "anthropic",
      keyName: "ANTHROPIC_API_KEY",
      key: "sk-workspace",
      secretsKey: KEK,
      database,
    });
    const shared = await getDecryptedProviderKey({ database, orgId: ORG, userId: other.id, provider: "anthropic", secretsKey: KEK });
    expect(shared).toEqual({ keyName: "ANTHROPIC_API_KEY", value: "sk-workspace" });

    // A personal key for `other` overrides the shared one.
    await setProviderConnection({ actor: other, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", key: "sk-personal", secretsKey: KEK, database });
    const resolved = await getDecryptedProviderKey({ database, orgId: ORG, userId: other.id, provider: "anthropic", secretsKey: KEK });
    expect(resolved).toEqual({ keyName: "ANTHROPIC_API_KEY", value: "sk-personal" });
  });
});
