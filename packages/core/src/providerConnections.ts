import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema, type Db } from "@companion/db";
import type { ModelProviderConnectionRow, ModelProviderConnectionScope } from "@companion/contracts";
import { canManageOrg } from "./authz";
import { decryptOpaqueValue, encryptOpaqueValue, type OpaqueCiphertext } from "./secretsCrypto";
import { assertMember, type ActorContext } from "./services";

const PROVIDER_CREDENTIAL_PURPOSE = "model-provider-credential";

export interface ProviderCredentialPin {
  connectionId: string;
  credentialVersion: number;
  provider: string;
  keyName: string;
  scope: ModelProviderConnectionScope;
}

type Connection = typeof schema.modelProviderConnections.$inferSelect;

function credentialSubject(connectionId: string, version: number): string {
  return `${connectionId}:${version}`;
}

function row(connection: Connection): ModelProviderConnectionRow {
  return {
    id: connection.id,
    provider: connection.provider,
    key_name: connection.keyName,
    scope: connection.scope,
    credential_version: connection.currentVersion,
    set: true,
    created_at: connection.createdAt.toISOString(),
    updated_at: connection.updatedAt.toISOString(),
  };
}

function pin(connection: Connection): ProviderCredentialPin {
  return {
    connectionId: connection.id,
    credentialVersion: connection.currentVersion,
    provider: connection.provider,
    keyName: connection.keyName,
    scope: connection.scope,
  };
}

function encryptedColumns(encrypted: OpaqueCiphertext) {
  return {
    ciphertext: encrypted.ciphertext,
    iv: encrypted.iv,
    authTag: encrypted.authTag,
    wrappedDek: encrypted.wrappedDek,
    wrapIv: encrypted.wrapIv,
    wrapAuthTag: encrypted.wrapAuthTag,
    keyId: encrypted.keyId,
  };
}

async function listScope(input: {
  database: Db;
  orgId: string;
  scope: ModelProviderConnectionScope;
  userId?: string;
}): Promise<ModelProviderConnectionRow[]> {
  const conditions = [
    eq(schema.modelProviderConnections.orgId, input.orgId),
    eq(schema.modelProviderConnections.scope, input.scope),
  ];
  if (input.scope === "personal") conditions.push(eq(schema.modelProviderConnections.userId, input.userId!));
  const rows = await input.database
    .select()
    .from(schema.modelProviderConnections)
    .where(and(...conditions));
  return rows.map(row).sort((left, right) => left.provider.localeCompare(right.provider));
}

export async function listProviderConnections(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<ModelProviderConnectionRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return listScope({ database, orgId: input.orgId, scope: "personal", userId: input.actor.id });
}

export async function listOrgProviderConnections(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<ModelProviderConnectionRow[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return listScope({ database, orgId: input.orgId, scope: "organization" });
}

export async function connectedProviderIds(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<Set<string>> {
  return new Set((await listProviderConnections(input)).map((connection) => connection.provider));
}

export async function connectedOrgProviderIds(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<Set<string>> {
  return new Set((await listOrgProviderConnections(input)).map((connection) => connection.provider));
}

async function saveConnection(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  provider: string;
  keyName: string;
  apiKey: string;
  scope: ModelProviderConnectionScope;
  masterKey?: Buffer;
}): Promise<ModelProviderConnectionRow> {
  if (
    !input.apiKey.trim() ||
    input.apiKey.includes("\0") ||
    Buffer.byteLength(input.apiKey, "utf8") > 65_536
  ) {
    throw new Error("provider key is invalid");
  }
  const now = new Date();
  return input.database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:provider-credential:${input.orgId}:${input.provider}`}))`);
    const connectionId = randomUUID();
    const target = input.scope === "personal"
      ? [schema.modelProviderConnections.orgId, schema.modelProviderConnections.userId, schema.modelProviderConnections.provider]
      : [schema.modelProviderConnections.orgId, schema.modelProviderConnections.provider];
    const targetWhere = input.scope === "personal"
      ? sql`${schema.modelProviderConnections.scope} = 'personal'`
      : sql`${schema.modelProviderConnections.scope} = 'organization'`;
    const [connection] = await tx
      .insert(schema.modelProviderConnections)
      .values({
        id: connectionId,
        orgId: input.orgId,
        scope: input.scope,
        userId: input.scope === "personal" ? input.actor.id : null,
        provider: input.provider,
        keyName: input.keyName,
        currentVersion: 1,
        createdBy: input.actor.id,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target,
        targetWhere,
        set: {
          keyName: input.keyName,
          currentVersion: sql`${schema.modelProviderConnections.currentVersion} + 1`,
          createdBy: input.actor.id,
          updatedAt: now,
        },
      })
      .returning();
    if (!connection) throw new Error("provider connection could not be saved");

    const encrypted = encryptOpaqueValue(
      {
        orgId: input.orgId,
        purpose: PROVIDER_CREDENTIAL_PURPOSE,
        subjectId: credentialSubject(connection.id, connection.currentVersion),
        value: input.apiKey,
      },
      input.masterKey,
    );
    await tx.insert(schema.modelProviderCredentialVersions).values({
      orgId: input.orgId,
      connectionId: connection.id,
      version: connection.currentVersion,
      keyName: input.keyName,
      ...encryptedColumns(encrypted),
    });
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: input.scope === "personal" ? "provider.connect" : "provider.connect.org",
      targetType: "provider",
      targetId: input.provider,
      metadata: {
        provider: input.provider,
        key_name: input.keyName,
        connection_id: connection.id,
        credential_version: connection.currentVersion,
        scope: input.scope,
      },
    });
    return row(connection);
  }) as Promise<ModelProviderConnectionRow>;
}

export async function setProviderConnection(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  keyName: string;
  apiKey: string;
  masterKey?: Buffer;
  database?: Db;
}): Promise<ModelProviderConnectionRow> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return saveConnection({ ...input, database, scope: "personal" });
}

export async function setOrgProviderConnection(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  keyName: string;
  apiKey: string;
  masterKey?: Buffer;
  database?: Db;
}): Promise<ModelProviderConnectionRow> {
  const database = input.database ?? db;
  const role = await assertMember(database, input.actor, input.orgId);
  if (!canManageOrg(role)) throw new Error("only workspace owners and admins can manage shared providers");
  return saveConnection({ ...input, database, scope: "organization" });
}

async function removeConnection(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  provider: string;
  scope: ModelProviderConnectionScope;
}): Promise<void> {
  const conditions = [
    eq(schema.modelProviderConnections.orgId, input.orgId),
    eq(schema.modelProviderConnections.scope, input.scope),
    eq(schema.modelProviderConnections.provider, input.provider),
  ];
  if (input.scope === "personal") conditions.push(eq(schema.modelProviderConnections.userId, input.actor.id));
  await input.database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:provider-credential:${input.orgId}:${input.provider}`}))`);
    await tx.delete(schema.modelProviderConnections).where(and(...conditions));
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: input.scope === "personal" ? "provider.disconnect" : "provider.disconnect.org",
      targetType: "provider",
      targetId: input.provider,
      metadata: { provider: input.provider, scope: input.scope },
    });
  });
}

export async function deleteProviderConnection(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  return removeConnection({ ...input, database, scope: "personal" });
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
  return removeConnection({ ...input, database, scope: "organization" });
}

/** Resolve personal-then-workspace current credential without decrypting it. */
export async function resolveProviderCredentialPin(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  provider: string;
}): Promise<ProviderCredentialPin | null> {
  const [personal] = await input.database
    .select()
    .from(schema.modelProviderConnections)
    .where(and(
      eq(schema.modelProviderConnections.orgId, input.orgId),
      eq(schema.modelProviderConnections.scope, "personal"),
      eq(schema.modelProviderConnections.userId, input.actor.id),
      eq(schema.modelProviderConnections.provider, input.provider),
    ))
    .limit(1);
  if (personal) return pin(personal);
  const [shared] = await input.database
    .select()
    .from(schema.modelProviderConnections)
    .where(and(
      eq(schema.modelProviderConnections.orgId, input.orgId),
      eq(schema.modelProviderConnections.scope, "organization"),
      eq(schema.modelProviderConnections.provider, input.provider),
    ))
    .limit(1);
  return shared ? pin(shared) : null;
}

/** Last-moment resolver for an exact pinned version. Access is revalidated through RLS. */
export async function getDecryptedProviderKey(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  provider: string;
  connectionId?: string;
  credentialVersion?: number;
  keyName?: string;
  masterKey?: Buffer;
}): Promise<(ProviderCredentialPin & { value: string }) | null> {
  const resolved = input.connectionId && input.credentialVersion && input.keyName
    ? {
        connectionId: input.connectionId,
        credentialVersion: input.credentialVersion,
        provider: input.provider,
        keyName: input.keyName,
      }
    : await resolveProviderCredentialPin(input);
  if (!resolved) return null;
  const [connection] = await input.database
    .select()
    .from(schema.modelProviderConnections)
    .where(and(
      eq(schema.modelProviderConnections.orgId, input.orgId),
      eq(schema.modelProviderConnections.id, resolved.connectionId),
      eq(schema.modelProviderConnections.provider, input.provider),
    ))
    .limit(1);
  if (!connection) return null;
  const [version] = await input.database
    .select()
    .from(schema.modelProviderCredentialVersions)
    .where(and(
      eq(schema.modelProviderCredentialVersions.orgId, input.orgId),
      eq(schema.modelProviderCredentialVersions.connectionId, connection.id),
      eq(schema.modelProviderCredentialVersions.version, resolved.credentialVersion),
    ))
    .limit(1);
  if (!version) return null;
  if (version.keyName !== resolved.keyName) return null;
  const value = decryptOpaqueValue(
    {
      orgId: input.orgId,
      purpose: PROVIDER_CREDENTIAL_PURPOSE,
      subjectId: credentialSubject(connection.id, version.version),
      ciphertext: version.ciphertext,
      iv: version.iv,
      authTag: version.authTag,
      wrappedDek: version.wrappedDek,
      wrapIv: version.wrapIv,
      wrapAuthTag: version.wrapAuthTag,
      keyId: version.keyId,
    },
    input.masterKey,
  );
  return {
    connectionId: connection.id,
    credentialVersion: version.version,
    provider: connection.provider,
    keyName: version.keyName,
    scope: connection.scope,
    value,
  };
}

export async function getDecryptedOrgProviderKey(input: {
  database: Db;
  actor: ActorContext;
  orgId: string;
  provider: string;
  masterKey?: Buffer;
}): Promise<(ProviderCredentialPin & { value: string }) | null> {
  const [connection] = await input.database
    .select()
    .from(schema.modelProviderConnections)
    .where(and(
      eq(schema.modelProviderConnections.orgId, input.orgId),
      eq(schema.modelProviderConnections.scope, "organization"),
      eq(schema.modelProviderConnections.provider, input.provider),
    ))
    .limit(1);
  if (!connection) return null;
  return getDecryptedProviderKey({
    ...input,
    connectionId: connection.id,
    credentialVersion: connection.currentVersion,
    keyName: connection.keyName,
  });
}
