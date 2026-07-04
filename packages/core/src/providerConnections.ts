import { and, eq } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type { ProviderConnectionRow } from "@companion/contracts";
import { canManageOrg } from "./authz";
import { openSecret, orgProviderConnectionAad, providerConnectionAad, sealSecret } from "./secretbox";
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
 * Decrypt the key that should reach an agent for a provider: the OWNER's personal connection wins,
 * else the workspace-shared connection (personal overrides workspace). Internal helper used at serve
 * time to inject the model provider key; never surfaced over the API.
 */
export async function getDecryptedProviderKey(input: {
  database: Db;
  orgId: string;
  userId: string;
  provider: string;
  secretsKey: Buffer;
}): Promise<{ keyName: string; value: string } | null> {
  const personal = await input.database
    .select()
    .from(schema.userProviderConnections)
    .where(
      and(
        eq(schema.userProviderConnections.orgId, input.orgId),
        eq(schema.userProviderConnections.userId, input.userId),
        eq(schema.userProviderConnections.provider, input.provider),
      ),
    );
  const own = personal[0];
  if (own) {
    return {
      keyName: own.keyName,
      value: openSecret({
        kek: input.secretsKey,
        sealed: { wrappedDek: own.wrappedDek, ciphertext: own.ciphertext },
        aad: providerConnectionAad(input.orgId, input.userId, input.provider),
      }),
    };
  }
  return getDecryptedOrgProviderKey({ database: input.database, orgId: input.orgId, provider: input.provider, secretsKey: input.secretsKey });
}

/* ------------------------------------ workspace-shared connections -------------------------------- */

/** List the workspace-shared provider connections. Any member may read (to see what the org shares). */
export async function listOrgProviderConnections(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<ProviderConnectionRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const rows = await database
    .select({
      provider: schema.orgProviderConnections.provider,
      keyName: schema.orgProviderConnections.keyName,
      createdAt: schema.orgProviderConnections.createdAt,
    })
    .from(schema.orgProviderConnections)
    .where(eq(schema.orgProviderConnections.orgId, input.orgId));
  return rows
    .map((row) => ({
      provider: row.provider,
      key_name: row.keyName,
      set: true as const,
      created_at: row.createdAt.toISOString(),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** Providers the workspace shares (for marking the model catalog as usable by any member). */
export async function connectedOrgProviderIds(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<Set<string>> {
  const connections = await listOrgProviderConnections(input);
  return new Set(connections.map((c) => c.provider));
}

/** Connect a provider for the whole workspace — owner/admin only. */
export async function setOrgProviderConnection(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  keyName: string;
  key: string;
  secretsKey: Buffer;
  database?: Db;
}): Promise<ProviderConnectionRow> {
  const database = input.database ?? db;
  const role = await assertMember(database, input.actor, input.orgId);
  if (!canManageOrg(role)) throw new Error("only workspace owners and admins can manage shared providers");
  const sealed = sealSecret({
    kek: input.secretsKey,
    plaintext: input.key,
    aad: orgProviderConnectionAad(input.orgId, input.provider),
  });
  await database
    .insert(schema.orgProviderConnections)
    .values({
      orgId: input.orgId,
      provider: input.provider,
      keyName: input.keyName,
      wrappedDek: sealed.wrappedDek,
      ciphertext: sealed.ciphertext,
      createdBy: input.actor.id,
    })
    .onConflictDoUpdate({
      target: [schema.orgProviderConnections.orgId, schema.orgProviderConnections.provider],
      set: {
        keyName: input.keyName,
        wrappedDek: sealed.wrappedDek,
        ciphertext: sealed.ciphertext,
        createdBy: input.actor.id,
        updatedAt: new Date(),
      },
    });
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "provider.connect.org",
    targetType: "provider",
    targetId: input.provider,
    metadata: { provider: input.provider, key_name: input.keyName }, // name only, never the key
  });
  return { provider: input.provider, key_name: input.keyName, set: true, created_at: new Date().toISOString() };
}

/** Disconnect a workspace-shared provider — owner/admin only. */
export async function deleteOrgProviderConnection(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const role = await assertMember(database, input.actor, input.orgId);
  if (!canManageOrg(role)) throw new Error("only workspace owners and admins can manage shared providers");
  await database
    .delete(schema.orgProviderConnections)
    .where(
      and(
        eq(schema.orgProviderConnections.orgId, input.orgId),
        eq(schema.orgProviderConnections.provider, input.provider),
      ),
    );
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "provider.disconnect.org",
    targetType: "provider",
    targetId: input.provider,
    metadata: { provider: input.provider },
  });
}

/** Decrypt the workspace-shared key for a provider, if any. Internal (never surfaced over the API). */
export async function getDecryptedOrgProviderKey(input: {
  database: Db;
  orgId: string;
  provider: string;
  secretsKey: Buffer;
}): Promise<{ keyName: string; value: string } | null> {
  const rows = await input.database
    .select()
    .from(schema.orgProviderConnections)
    .where(and(eq(schema.orgProviderConnections.orgId, input.orgId), eq(schema.orgProviderConnections.provider, input.provider)));
  const row = rows[0];
  if (!row) return null;
  return {
    keyName: row.keyName,
    value: openSecret({
      kek: input.secretsKey,
      sealed: { wrappedDek: row.wrappedDek, ciphertext: row.ciphertext },
      aad: orgProviderConnectionAad(input.orgId, input.provider),
    }),
  };
}
