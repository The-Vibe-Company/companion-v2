import { and, eq } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type { ProviderConnectionRow } from "@companion/contracts";
import { canManageOrg } from "./authz";
import {
  decryptPinnedSecret,
  pinAccessibleSecret,
  type AccessibleSecretPin,
} from "./secrets";
import { assertMember, type ActorContext } from "./services";

type ProviderBinding = {
  provider: string;
  keyName: string;
  secretId: string;
  createdAt: Date;
};

async function visibleConnection(
  database: Db,
  actor: ActorContext,
  orgId: string,
  binding: ProviderBinding,
): Promise<ProviderConnectionRow | null> {
  try {
    const secret = await pinAccessibleSecret({ actor, orgId, secretId: binding.secretId, database });
    return {
      provider: binding.provider,
      key_name: binding.keyName,
      secret_id: secret.secretId,
      secret_name: secret.name,
      secret_audience: secret.audience,
      secret_owner_name: secret.ownerName,
      set: true,
      created_at: binding.createdAt.toISOString(),
    };
  } catch (error) {
    // A revoked binding is intentionally indistinguishable from no connection. Its former secret
    // metadata must not leak after access changes.
    if (error instanceof Error && error.message === "secret not found") return null;
    throw error;
  }
}

export async function listProviderConnections(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<ProviderConnectionRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const bindings = await database
    .select({
      provider: schema.userProviderConnections.provider,
      keyName: schema.userProviderConnections.keyName,
      secretId: schema.userProviderConnections.secretId,
      createdAt: schema.userProviderConnections.createdAt,
    })
    .from(schema.userProviderConnections)
    .where(
      and(
        eq(schema.userProviderConnections.orgId, input.orgId),
        eq(schema.userProviderConnections.userId, input.actor.id),
      ),
    );
  const rows = await Promise.all(bindings.map((binding) => visibleConnection(database, input.actor, input.orgId, binding)));
  return rows.filter((row): row is ProviderConnectionRow => row !== null).sort((a, b) => a.provider.localeCompare(b.provider));
}

export async function connectedProviderIds(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<Set<string>> {
  return new Set((await listProviderConnections(input)).map((connection) => connection.provider));
}

export async function setProviderConnection(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  keyName: string;
  secretId: string;
  database?: Db;
}): Promise<ProviderConnectionRow> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await pinAccessibleSecret({ actor: input.actor, orgId: input.orgId, secretId: input.secretId, database });
  const now = new Date();
  await database
    .insert(schema.userProviderConnections)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      provider: input.provider,
      keyName: input.keyName,
      secretId: input.secretId,
    })
    .onConflictDoUpdate({
      target: [
        schema.userProviderConnections.orgId,
        schema.userProviderConnections.userId,
        schema.userProviderConnections.provider,
      ],
      set: { keyName: input.keyName, secretId: input.secretId, updatedAt: now },
    });
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "provider.connect",
    targetType: "provider",
    targetId: input.provider,
    metadata: { provider: input.provider, key_name: input.keyName, secret_id: input.secretId },
  });
  const row = await visibleConnection(database, input.actor, input.orgId, {
    provider: input.provider,
    keyName: input.keyName,
    secretId: input.secretId,
    createdAt: now,
  });
  if (!row) throw new Error("secret not found");
  return row;
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

export async function listOrgProviderConnections(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<ProviderConnectionRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const bindings = await database
    .select({
      provider: schema.orgProviderConnections.provider,
      keyName: schema.orgProviderConnections.keyName,
      secretId: schema.orgProviderConnections.secretId,
      createdAt: schema.orgProviderConnections.createdAt,
    })
    .from(schema.orgProviderConnections)
    .where(eq(schema.orgProviderConnections.orgId, input.orgId));
  const rows = await Promise.all(bindings.map((binding) => visibleConnection(database, input.actor, input.orgId, binding)));
  return rows.filter((row): row is ProviderConnectionRow => row !== null).sort((a, b) => a.provider.localeCompare(b.provider));
}

export async function connectedOrgProviderIds(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<Set<string>> {
  return new Set((await listOrgProviderConnections(input)).map((connection) => connection.provider));
}

export async function setOrgProviderConnection(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  keyName: string;
  secretId: string;
  database?: Db;
}): Promise<ProviderConnectionRow> {
  const database = input.database ?? db;
  const role = await assertMember(database, input.actor, input.orgId);
  if (!canManageOrg(role)) throw new Error("only workspace owners and admins can manage shared providers");
  const secret = await pinAccessibleSecret({ actor: input.actor, orgId: input.orgId, secretId: input.secretId, database });
  if (secret.audience !== "organization") {
    throw new Error("workspace provider connections require an organization secret");
  }
  const now = new Date();
  await database
    .insert(schema.orgProviderConnections)
    .values({
      orgId: input.orgId,
      provider: input.provider,
      keyName: input.keyName,
      secretId: input.secretId,
      createdBy: input.actor.id,
    })
    .onConflictDoUpdate({
      target: [schema.orgProviderConnections.orgId, schema.orgProviderConnections.provider],
      set: { keyName: input.keyName, secretId: input.secretId, createdBy: input.actor.id, updatedAt: now },
    });
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "provider.connect.org",
    targetType: "provider",
    targetId: input.provider,
    metadata: { provider: input.provider, key_name: input.keyName, secret_id: input.secretId },
  });
  const row = await visibleConnection(database, input.actor, input.orgId, {
    provider: input.provider,
    keyName: input.keyName,
    secretId: input.secretId,
    createdAt: now,
  });
  if (!row) throw new Error("secret not found");
  return row;
}

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

/** Resolve personal-then-workspace binding and pin the current version without decrypting it. */
export async function resolveProviderSecretPin(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  provider: string;
}): Promise<{ keyName: string; secret: AccessibleSecretPin } | null> {
  const [personal] = await input.database
    .select()
    .from(schema.userProviderConnections)
    .where(
      and(
        eq(schema.userProviderConnections.orgId, input.orgId),
        eq(schema.userProviderConnections.userId, input.actor.id),
        eq(schema.userProviderConnections.provider, input.provider),
      ),
    )
    .limit(1);
  if (personal) {
    const secret = await pinAccessibleSecret({
      actor: input.actor,
      orgId: input.orgId,
      secretId: personal.secretId,
      database: input.database,
    });
    return { keyName: personal.keyName, secret };
  }
  const [shared] = await input.database
    .select()
    .from(schema.orgProviderConnections)
    .where(
      and(
        eq(schema.orgProviderConnections.orgId, input.orgId),
        eq(schema.orgProviderConnections.provider, input.provider),
      ),
    )
    .limit(1);
  if (!shared) return null;
  const secret = await pinAccessibleSecret({
    actor: input.actor,
    orgId: input.orgId,
    secretId: shared.secretId,
    database: input.database,
  });
  if (secret.audience !== "organization") return null;
  return { keyName: shared.keyName, secret };
}

/** Last-moment provider resolver used by the worker after the pinned run ACL check. */
export async function getDecryptedProviderKey(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  provider: string;
  secretId?: string;
  secretVersion?: number;
  keyName?: string;
  masterKey?: Buffer;
}): Promise<{ keyName: string; value: string; secretId: string; secretVersion: number } | null> {
  const resolved = input.secretId && input.secretVersion && input.keyName
    ? { keyName: input.keyName, secret: { secretId: input.secretId, version: input.secretVersion } }
    : await resolveProviderSecretPin(input);
  if (!resolved) return null;
  const opened = await decryptPinnedSecret({
    actor: input.actor,
    orgId: input.orgId,
    secretId: resolved.secret.secretId,
    version: resolved.secret.version,
    masterKey: input.masterKey,
    database: input.database,
  });
  return {
    keyName: resolved.keyName,
    value: opened.value,
    secretId: resolved.secret.secretId,
    secretVersion: resolved.secret.version,
  };
}

export async function getDecryptedOrgProviderKey(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  provider: string;
  masterKey?: Buffer;
}): Promise<{ keyName: string; value: string; secretId: string; secretVersion: number } | null> {
  const [binding] = await input.database
    .select()
    .from(schema.orgProviderConnections)
    .where(
      and(
        eq(schema.orgProviderConnections.orgId, input.orgId),
        eq(schema.orgProviderConnections.provider, input.provider),
      ),
    )
    .limit(1);
  if (!binding) return null;
  const opened = await decryptPinnedSecret({
    actor: input.actor,
    orgId: input.orgId,
    secretId: binding.secretId,
    version: (await pinAccessibleSecret({ actor: input.actor, orgId: input.orgId, secretId: binding.secretId, database: input.database })).version,
    masterKey: input.masterKey,
    database: input.database,
  });
  if (opened.pin.audience !== "organization") return null;
  return {
    keyName: binding.keyName,
    value: opened.value,
    secretId: opened.pin.secretId,
    secretVersion: opened.pin.version,
  };
}
