import { describe, expect, it } from "vitest";
import {
  connectedProviderIds,
  deleteProviderConnection,
  generateSecretsKey,
  getDecryptedProviderKey,
  listProviderConnections,
  parseSecretsKey,
  setProviderConnection,
  type ActorContext,
} from "../src/services";
import { emptyStore, fakeAgentsDb } from "./agentsFakeDb";

const ORG = "00000000-0000-0000-0000-0000000000cc";
const me: ActorContext = { id: "user-me", email: "me@example.com", name: "Me" };
const other: ActorContext = { id: "user-other", email: "o@example.com", name: "Other" };
const KEK = parseSecretsKey(generateSecretsKey());

describe("provider connections", () => {
  it("saves, lists and round-trips a connection write-only (never returns the key)", async () => {
    const store = emptyStore();
    const database = fakeAgentsDb(store);

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
    const database = fakeAgentsDb(store);
    await setProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", key: "old", secretsKey: KEK, database });
    await setProviderConnection({ actor: me, orgId: ORG, provider: "anthropic", keyName: "ANTHROPIC_API_KEY", key: "new", secretsKey: KEK, database });
    expect(store.providerConnections).toHaveLength(1);
    const decrypted = await getDecryptedProviderKey({ database, orgId: ORG, userId: me.id, provider: "anthropic", secretsKey: KEK });
    expect(decrypted?.value).toBe("new");
  });

  it("scopes connections per user (one user cannot see another's)", async () => {
    const store = emptyStore();
    const database = fakeAgentsDb(store);
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
    const database = fakeAgentsDb(store);
    await setProviderConnection({ actor: me, orgId: ORG, provider: "openai", keyName: "OPENAI_API_KEY", key: "k", secretsKey: KEK, database });
    await deleteProviderConnection({ actor: me, orgId: ORG, provider: "openai", database });
    expect(await listProviderConnections({ actor: me, orgId: ORG, database })).toEqual([]);
  });

  it("rejects non-members", async () => {
    const database = fakeAgentsDb(emptyStore({ role: null }));
    await expect(listProviderConnections({ actor: me, orgId: ORG, database })).rejects.toThrow("not a member");
  });
});
