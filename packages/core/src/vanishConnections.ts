import { and, eq } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type { VanishConnectionRow } from "@companion/contracts";
import { canManageOrg } from "./authz";
import { decryptPinnedSecret, pinAccessibleSecret, type AccessibleSecretPin } from "./secrets";
import { assertMember, type ActorContext } from "./services";

export const VANISH_SECRET_KEY = "VANISH_API_KEY";

type VanishBinding = {
  keyName: string;
  secretId: string;
  createdAt: Date;
  updatedAt: Date;
};

function isUnavailableSecret(error: unknown): boolean {
  return error instanceof Error && error.message === "secret not found";
}

async function visibleConnection(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  scope: "personal" | "organization";
  binding: VanishBinding;
}): Promise<VanishConnectionRow | null> {
  try {
    const secret = await pinAccessibleSecret({
      actor: input.actor,
      orgId: input.orgId,
      secretId: input.binding.secretId,
      database: input.database,
    });
    if (secret.key !== VANISH_SECRET_KEY) return null;
    if (input.scope === "organization" && secret.audience !== "organization") return null;
    return {
      key_name: VANISH_SECRET_KEY,
      secret_id: secret.secretId,
      secret_name: secret.name,
      secret_audience: secret.audience,
      secret_owner_name: secret.ownerName,
      scope: input.scope,
      set: true,
      created_at: input.binding.createdAt.toISOString(),
      updated_at: input.binding.updatedAt.toISOString(),
    };
  } catch (error) {
    if (isUnavailableSecret(error)) return null;
    throw error;
  }
}

export async function getVanishConnection(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<VanishConnectionRow | null> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const [binding] = await database
    .select()
    .from(schema.userVanishConnections)
    .where(and(
      eq(schema.userVanishConnections.orgId, input.orgId),
      eq(schema.userVanishConnections.userId, input.actor.id),
    ))
    .limit(1);
  return binding
    ? visibleConnection({ database, actor: input.actor, orgId: input.orgId, scope: "personal", binding })
    : null;
}

export async function getOrgVanishConnection(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<VanishConnectionRow | null> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const [binding] = await database
    .select()
    .from(schema.orgVanishConnections)
    .where(eq(schema.orgVanishConnections.orgId, input.orgId))
    .limit(1);
  return binding
    ? visibleConnection({ database, actor: input.actor, orgId: input.orgId, scope: "organization", binding })
    : null;
}

export async function setVanishConnection(input: {
  actor: ActorContext;
  orgId: string;
  secretId: string;
  database?: Db;
}): Promise<VanishConnectionRow> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const secret = await pinAccessibleSecret({ actor: input.actor, orgId: input.orgId, secretId: input.secretId, database });
  if (secret.key !== VANISH_SECRET_KEY) throw new Error("Vanish requires a VANISH_API_KEY secret");
  const now = new Date();
  const [binding] = await database
    .insert(schema.userVanishConnections)
    .values({ orgId: input.orgId, userId: input.actor.id, keyName: VANISH_SECRET_KEY, secretId: input.secretId })
    .onConflictDoUpdate({
      target: [schema.userVanishConnections.orgId, schema.userVanishConnections.userId],
      set: { secretId: input.secretId, updatedAt: now },
    })
    .returning();
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "vanish.connect",
    targetType: "vanish",
    targetId: input.actor.id,
    metadata: { secret_id: input.secretId, scope: "personal" },
  });
  const result = binding
    ? await visibleConnection({ database, actor: input.actor, orgId: input.orgId, scope: "personal", binding })
    : null;
  if (!result) throw new Error("secret not found");
  return result;
}

export async function setOrgVanishConnection(input: {
  actor: ActorContext;
  orgId: string;
  secretId: string;
  database?: Db;
}): Promise<VanishConnectionRow> {
  const database = input.database ?? db;
  const role = await assertMember(database, input.actor, input.orgId);
  if (!canManageOrg(role)) throw new Error("only workspace owners and admins can manage shared Vanish");
  const secret = await pinAccessibleSecret({ actor: input.actor, orgId: input.orgId, secretId: input.secretId, database });
  if (secret.key !== VANISH_SECRET_KEY || secret.audience !== "organization") {
    throw new Error("workspace Vanish connections require an organization VANISH_API_KEY secret");
  }
  const now = new Date();
  const [binding] = await database
    .insert(schema.orgVanishConnections)
    .values({
      orgId: input.orgId,
      keyName: VANISH_SECRET_KEY,
      secretId: input.secretId,
      createdBy: input.actor.id,
    })
    .onConflictDoUpdate({
      target: [schema.orgVanishConnections.orgId],
      set: { secretId: input.secretId, createdBy: input.actor.id, updatedAt: now },
    })
    .returning();
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "vanish.connect.org",
    targetType: "vanish",
    targetId: input.orgId,
    metadata: { secret_id: input.secretId, scope: "organization" },
  });
  const result = binding
    ? await visibleConnection({ database, actor: input.actor, orgId: input.orgId, scope: "organization", binding })
    : null;
  if (!result) throw new Error("secret not found");
  return result;
}

export async function deleteVanishConnection(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  await database.delete(schema.userVanishConnections).where(and(
    eq(schema.userVanishConnections.orgId, input.orgId),
    eq(schema.userVanishConnections.userId, input.actor.id),
  ));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "vanish.disconnect",
    targetType: "vanish",
    targetId: input.actor.id,
    metadata: { scope: "personal" },
  });
}

export async function deleteOrgVanishConnection(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const role = await assertMember(database, input.actor, input.orgId);
  if (!canManageOrg(role)) throw new Error("only workspace owners and admins can manage shared Vanish");
  await database.delete(schema.orgVanishConnections).where(eq(schema.orgVanishConnections.orgId, input.orgId));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "vanish.disconnect.org",
    targetType: "vanish",
    targetId: input.orgId,
    metadata: { scope: "organization" },
  });
}

/** Resolve the current personal-then-workspace Vanish vault pin without decrypting it. */
export async function resolveVanishSecretPin(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
}): Promise<{ keyName: typeof VANISH_SECRET_KEY; secret: AccessibleSecretPin } | null> {
  const [personal] = await input.database
    .select()
    .from(schema.userVanishConnections)
    .where(and(
      eq(schema.userVanishConnections.orgId, input.orgId),
      eq(schema.userVanishConnections.userId, input.actor.id),
    ))
    .limit(1);
  if (personal) {
    try {
      const secret = await pinAccessibleSecret({ actor: input.actor, orgId: input.orgId, secretId: personal.secretId, database: input.database });
      if (secret.key === VANISH_SECRET_KEY) return { keyName: VANISH_SECRET_KEY, secret };
    } catch (error) {
      if (!isUnavailableSecret(error)) throw error;
    }
  }
  const [shared] = await input.database
    .select()
    .from(schema.orgVanishConnections)
    .where(eq(schema.orgVanishConnections.orgId, input.orgId))
    .limit(1);
  if (!shared) return null;
  try {
    const secret = await pinAccessibleSecret({ actor: input.actor, orgId: input.orgId, secretId: shared.secretId, database: input.database });
    return secret.key === VANISH_SECRET_KEY && secret.audience === "organization"
      ? { keyName: VANISH_SECRET_KEY, secret }
      : null;
  } catch (error) {
    if (isUnavailableSecret(error)) return null;
    throw error;
  }
}

export async function getDecryptedVanishKey(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  masterKey?: Buffer;
}): Promise<{ keyName: typeof VANISH_SECRET_KEY; value: string; secretId: string; secretVersion: number } | null> {
  const resolved = await resolveVanishSecretPin(input);
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
    keyName: VANISH_SECRET_KEY,
    value: opened.value,
    secretId: opened.pin.secretId,
    secretVersion: opened.pin.version,
  };
}
