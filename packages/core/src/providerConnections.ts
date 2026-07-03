import { and, eq } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type { ProviderConnectionRow } from "@companion/contracts";
import { openSecret, providerConnectionAad, sealSecret } from "./secretbox";
import { assertMember, type ActorContext } from "./services";

/**
 * Saved per-user model-provider connections: a member stores their own API key for a provider once
 * (envelope-encrypted, write-only), which enables that provider's models in the create-agent picker
 * and is copied into new agents' own secrets at create time. Same load-order reasoning as
 * `./labels`: this only imports `assertMember` (hoisted) + the `ActorContext` type from `./services`.
 */

export async function listProviderConnections(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<ProviderConnectionRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const rows = await database
    .select({
      provider: schema.userProviderConnections.provider,
      keyName: schema.userProviderConnections.keyName,
      createdAt: schema.userProviderConnections.createdAt,
    })
    .from(schema.userProviderConnections)
    .where(
      and(
        eq(schema.userProviderConnections.orgId, input.orgId),
        eq(schema.userProviderConnections.userId, input.actor.id),
      ),
    );
  return rows
    .map((row) => ({
      provider: row.provider,
      key_name: row.keyName,
      set: true as const,
      created_at: row.createdAt.toISOString(),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Providers the actor has connected (for marking the model catalog). */
export async function connectedProviderIds(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<Set<string>> {
  const connections = await listProviderConnections(input);
  return new Set(connections.map((c) => c.provider));
}

export async function setProviderConnection(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  keyName: string;
  key: string;
  secretsKey: Buffer;
  database?: Db;
}): Promise<ProviderConnectionRow> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const sealed = sealSecret({
    kek: input.secretsKey,
    plaintext: input.key,
    aad: providerConnectionAad(input.orgId, input.actor.id, input.provider),
  });
  await database
    .insert(schema.userProviderConnections)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      provider: input.provider,
      keyName: input.keyName,
      wrappedDek: sealed.wrappedDek,
      ciphertext: sealed.ciphertext,
    })
    .onConflictDoUpdate({
      target: [
        schema.userProviderConnections.orgId,
        schema.userProviderConnections.userId,
        schema.userProviderConnections.provider,
      ],
      set: {
        keyName: input.keyName,
        wrappedDek: sealed.wrappedDek,
        ciphertext: sealed.ciphertext,
        updatedAt: new Date(),
      },
    });
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "provider.connect",
    targetType: "provider",
    targetId: input.provider,
    metadata: { provider: input.provider, key_name: input.keyName }, // name only, never the key
  });
  return { provider: input.provider, key_name: input.keyName, set: true, created_at: new Date().toISOString() };
}

export async function deleteProviderConnection(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await database
    .delete(schema.userProviderConnections)
    .where(
      and(
        eq(schema.userProviderConnections.orgId, input.orgId),
        eq(schema.userProviderConnections.userId, input.actor.id),
        eq(schema.userProviderConnections.provider, input.provider),
      ),
    );
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "provider.disconnect",
    targetType: "provider",
    targetId: input.provider,
    metadata: { provider: input.provider },
  });
}

/**
 * Decrypt the user's saved key for a provider, if any. Internal helper used by agent creation to
 * seed a new agent's secrets from the owner's saved connection. Never surfaced over the API.
 */
export async function getDecryptedProviderKey(input: {
  database: Db;
  orgId: string;
  userId: string;
  provider: string;
  secretsKey: Buffer;
}): Promise<{ keyName: string; value: string } | null> {
  const rows = await input.database
    .select()
    .from(schema.userProviderConnections)
    .where(
      and(
        eq(schema.userProviderConnections.orgId, input.orgId),
        eq(schema.userProviderConnections.userId, input.userId),
        eq(schema.userProviderConnections.provider, input.provider),
      ),
    );
  const row = rows[0];
  if (!row) return null;
  const value = openSecret({
    kek: input.secretsKey,
    sealed: { wrappedDek: row.wrappedDek, ciphertext: row.ciphertext },
    aad: providerConnectionAad(input.orgId, input.userId, input.provider),
  });
  return { keyName: row.keyName, value };
}
