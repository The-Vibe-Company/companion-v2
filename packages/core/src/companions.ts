import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, notInArray } from "drizzle-orm";
import type {
  Companion,
  CompanionAccess,
  CompanionDaemonState,
  CompanionProviderAuthMethod,
  CompanionProviderConnection,
  CompanionProvidersResponse,
  CompanionRuntimeState,
} from "@companion/contracts";
import { COMPANION_PROVIDER_CATALOG } from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import { canManageOrg } from "./authz";
import { decryptOpaqueValue, encryptOpaqueValue, type OpaqueCiphertext } from "./secretsCrypto";
import { assertMember, getOrgRole, type ActorContext } from "./services";

type CompanionRow = typeof schema.companions.$inferSelect;
const COMPANION_RUNTIME_CLAIM_STALE_MS = 5 * 60_000;
const PROVIDER_CREDENTIAL_PURPOSE = "companion-provider-credential";

export class CompanionNotFoundError extends Error {
  constructor() {
    super("companion not found");
    this.name = "CompanionNotFoundError";
  }
}

export class CompanionRuntimeForbiddenError extends Error {
  constructor() {
    super("companion runtime access requires owner or editor");
    this.name = "CompanionRuntimeForbiddenError";
  }
}

export class CompanionRuntimeTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionRuntimeTransitionError";
  }
}

export class CompanionProviderError extends Error {
  readonly code:
    | "provider_not_configured"
    | "provider_auth_invalid"
    | "provider_auth_expired"
    | "provider_unavailable";
  readonly providerId: string | null;

  constructor(
    code: CompanionProviderError["code"],
    message: string,
    providerId: string | null = null,
  ) {
    super(message);
    this.name = "CompanionProviderError";
    this.code = code;
    this.providerId = providerId;
  }
}

export class CompanionProviderForbiddenError extends Error {
  constructor() {
    super("provider management requires workspace Owner or Admin access");
    this.name = "CompanionProviderForbiddenError";
  }
}

/** THE-322 can replace this owner/viewer projection with persisted share grants. */
export function companionAccessForActor(row: Pick<CompanionRow, "ownerId">, actorId: string): CompanionAccess {
  return row.ownerId === actorId ? "owner" : "viewer";
}

export function canWakeCompanion(access: CompanionAccess): boolean {
  return access === "owner" || access === "editor";
}

function toCompanion(row: CompanionRow, actorId: string): Companion {
  return {
    id: row.id,
    name: row.name,
    owner_id: row.ownerId,
    access: companionAccessForActor(row, actorId),
    runtime: {
      state: row.runtimeState,
      daemon_state: row.daemonState,
      box_id: row.boxId,
      provider_ids: row.providerIds,
      provider_credential_generation: row.providerCredentialGeneration,
      disk_layout_version: row.diskLayoutVersion,
      desktop_available: row.desktopAvailable,
      last_observed_at: row.lastObservedAt?.toISOString() ?? null,
      last_started_at: row.lastStartedAt?.toISOString() ?? null,
      last_stopped_at: row.lastStoppedAt?.toISOString() ?? null,
    },
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function listCompanions(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<Companion[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const rows = await database
    .select()
    .from(schema.companions)
    .where(eq(schema.companions.orgId, input.orgId))
    .orderBy(desc(schema.companions.updatedAt));
  return rows.map((row) => toCompanion(row, input.actor.id));
}

export async function getCompanion(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const [row] = await database
    .select()
    .from(schema.companions)
    .where(and(eq(schema.companions.orgId, input.orgId), eq(schema.companions.id, input.companionId)))
    .limit(1);
  if (!row) throw new CompanionNotFoundError();
  return toCompanion(row, input.actor.id);
}

export async function createCompanion(input: {
  actor: ActorContext;
  orgId: string;
  name: string;
  providerId?: string;
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const org = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, input.orgId),
    columns: { defaultCompanionProviderId: true },
  });
  const providerId = input.providerId ?? org?.defaultCompanionProviderId ?? null;
  if (!providerId) {
    throw new CompanionProviderError(
      "provider_not_configured",
      "Choose a connected provider before creating this Companion.",
    );
  }
  const connection = await database.query.companionProviderConnections.findFirst({
    where: and(
      eq(schema.companionProviderConnections.orgId, input.orgId),
      eq(schema.companionProviderConnections.providerId, providerId),
    ),
    columns: { providerId: true },
  });
  if (!connection) {
    throw new CompanionProviderError(
      "provider_not_configured",
      `The ${providerName(providerId)} provider is not connected in this workspace.`,
      providerId,
    );
  }
  const [row] = await database
    .insert(schema.companions)
    .values({
      orgId: input.orgId,
      ownerId: input.actor.id,
      name: input.name,
      providerIds: [providerId],
    })
    .returning();
  if (!row) throw new Error("failed to create companion");
  return toCompanion(row, input.actor.id);
}

function providerName(providerId: string): string {
  return COMPANION_PROVIDER_CATALOG.find((provider) => provider.id === providerId)?.name ?? providerId;
}

function providerCiphertext(
  row: typeof schema.companionProviderConnections.$inferSelect,
): OpaqueCiphertext {
  return {
    ciphertext: row.ciphertext,
    iv: row.iv,
    authTag: row.authTag,
    wrappedDek: row.wrappedDek,
    wrapIv: row.wrapIv,
    wrapAuthTag: row.wrapAuthTag,
    keyId: row.keyId,
  };
}

async function assertProviderAdmin(database: Db, actor: ActorContext, orgId: string): Promise<void> {
  const role = await getOrgRole(orgId, actor.id, database);
  if (!role || !canManageOrg(role)) {
    throw new CompanionProviderForbiddenError();
  }
}

function toProviderConnection(
  row: Pick<
    typeof schema.companionProviderConnections.$inferSelect,
    "providerId" | "authMethod" | "connectedBy" | "createdAt" | "updatedAt"
  >,
): CompanionProviderConnection {
  return {
    provider_id: row.providerId,
    auth_method: row.authMethod,
    connected_by: row.connectedBy,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export async function listCompanionProviders(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<CompanionProvidersResponse> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  const [org, connections] = await Promise.all([
    database.query.organizations.findFirst({
      where: eq(schema.organizations.id, input.orgId),
      columns: { defaultCompanionProviderId: true },
    }),
    database
      .select({
        providerId: schema.companionProviderConnections.providerId,
        authMethod: schema.companionProviderConnections.authMethod,
        connectedBy: schema.companionProviderConnections.connectedBy,
        createdAt: schema.companionProviderConnections.createdAt,
        updatedAt: schema.companionProviderConnections.updatedAt,
      })
      .from(schema.companionProviderConnections)
      .where(eq(schema.companionProviderConnections.orgId, input.orgId))
      .orderBy(asc(schema.companionProviderConnections.providerId)),
  ]);
  return {
    catalog: COMPANION_PROVIDER_CATALOG.map((provider) => ({
      ...provider,
      auth_methods: [...provider.auth_methods],
    })),
    connections: connections.map(toProviderConnection),
    default_provider_id: org?.defaultCompanionProviderId ?? null,
    can_manage: canManageOrg(role),
  };
}

export async function setCompanionProvider(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  providerId: string;
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  const companion = await getCompanionForRuntime({ ...input, database });
  if (companion.runtime.provider_ids.length) {
    throw new CompanionRuntimeTransitionError(
      "this Companion already has a provider; create another Companion to use a different one",
    );
  }
  const connection = await database.query.companionProviderConnections.findFirst({
    where: and(
      eq(schema.companionProviderConnections.orgId, input.orgId),
      eq(schema.companionProviderConnections.providerId, input.providerId),
    ),
    columns: { providerId: true },
  });
  if (!connection) {
    throw new CompanionProviderError(
      "provider_not_configured",
      `The ${providerName(input.providerId)} provider is not connected in this workspace.`,
      input.providerId,
    );
  }
  const [row] = await database
    .update(schema.companions)
    .set({
      providerIds: [input.providerId],
      providerCredentialGeneration: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.ownerId, input.actor.id),
      eq(schema.companions.providerIds, []),
    ))
    .returning();
  if (!row) {
    throw new CompanionRuntimeTransitionError(
      "this Companion provider was already configured",
    );
  }
  return toCompanion(row, input.actor.id);
}

export async function saveCompanionProvider(input: {
  actor: ActorContext;
  orgId: string;
  providerId: string;
  authMethod: CompanionProviderAuthMethod;
  credential: string | Record<string, unknown>;
  masterKey?: Buffer;
  database?: Db;
}): Promise<CompanionProviderConnection> {
  const database = input.database ?? db;
  await assertProviderAdmin(database, input.actor, input.orgId);
  const catalogProvider = COMPANION_PROVIDER_CATALOG.find(
    (provider) => provider.id === input.providerId,
  );
  if (catalogProvider && !catalogProvider.auth_methods.includes(input.authMethod as never)) {
    throw new CompanionProviderError(
      "provider_auth_invalid",
      `${catalogProvider.name} does not support ${input.authMethod === "api_key" ? "API key" : "subscription"} authentication in Companion.`,
      input.providerId,
    );
  }
  const authEntry = input.authMethod === "api_key"
    ? { type: "api_key", key: input.credential }
    : input.credential;
  const generation = randomUUID();
  const encrypted = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: PROVIDER_CREDENTIAL_PURPOSE,
    subjectId: `${input.providerId}:${generation}`,
    value: JSON.stringify(authEntry),
  }, input.masterKey);
  const [existing] = await database
    .select({ credentialVersion: schema.companionProviderConnections.credentialVersion })
    .from(schema.companionProviderConnections)
    .where(and(
      eq(schema.companionProviderConnections.orgId, input.orgId),
      eq(schema.companionProviderConnections.providerId, input.providerId),
    ))
    .limit(1);
  const [row] = await database
    .insert(schema.companionProviderConnections)
    .values({
      orgId: input.orgId,
      providerId: input.providerId,
      authMethod: input.authMethod,
      credentialGeneration: generation,
      credentialVersion: (existing?.credentialVersion ?? 0) + 1,
      ...encrypted,
      connectedBy: input.actor.id,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [
        schema.companionProviderConnections.orgId,
        schema.companionProviderConnections.providerId,
      ],
      set: {
        authMethod: input.authMethod,
        credentialGeneration: generation,
        credentialVersion: (existing?.credentialVersion ?? 0) + 1,
        ...encrypted,
        connectedBy: input.actor.id,
        updatedAt: new Date(),
      },
    })
    .returning();
  if (!row) throw new Error("failed to save provider");
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "companion.provider.connected",
    targetType: "companion_provider",
    targetId: input.providerId,
    metadata: { auth_method: input.authMethod },
  });
  return toProviderConnection(row);
}

export async function deleteCompanionProvider(input: {
  actor: ActorContext;
  orgId: string;
  providerId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertProviderAdmin(database, input.actor, input.orgId);
  await database.transaction(async (tx) => {
    await tx
      .update(schema.organizations)
      .set({ defaultCompanionProviderId: null, updatedAt: new Date() })
      .where(and(
        eq(schema.organizations.id, input.orgId),
        eq(schema.organizations.defaultCompanionProviderId, input.providerId),
      ));
    await tx
      .delete(schema.companionProviderConnections)
      .where(and(
        eq(schema.companionProviderConnections.orgId, input.orgId),
        eq(schema.companionProviderConnections.providerId, input.providerId),
      ));
    await tx.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "companion.provider.disconnected",
      targetType: "companion_provider",
      targetId: input.providerId,
      metadata: {},
    });
  });
}

export async function setDefaultCompanionProvider(input: {
  actor: ActorContext;
  orgId: string;
  providerId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertProviderAdmin(database, input.actor, input.orgId);
  const connection = await database.query.companionProviderConnections.findFirst({
    where: and(
      eq(schema.companionProviderConnections.orgId, input.orgId),
      eq(schema.companionProviderConnections.providerId, input.providerId),
    ),
    columns: { providerId: true },
  });
  if (!connection) {
    throw new CompanionProviderError(
      "provider_not_configured",
      `Connect ${providerName(input.providerId)} before making it the workspace default.`,
      input.providerId,
    );
  }
  await database
    .update(schema.organizations)
    .set({ defaultCompanionProviderId: input.providerId, updatedAt: new Date() })
    .where(eq(schema.organizations.id, input.orgId));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "companion.provider.defaulted",
    targetType: "companion_provider",
    targetId: input.providerId,
    metadata: {},
  });
}

export async function resolveCompanionProviderAuth(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  masterKey?: Buffer;
  database?: Db;
}): Promise<{
  providerId: string;
  credentialGeneration: string;
  authEntry: Record<string, unknown>;
}> {
  const database = input.database ?? db;
  const companion = await getCompanionForRuntime({ ...input, database });
  const providerId = companion.runtime.provider_ids[0];
  if (!providerId) {
    throw new CompanionProviderError(
      "provider_not_configured",
      "Choose a provider for this Companion before starting it.",
    );
  }
  const row = await database.query.companionProviderConnections.findFirst({
    where: and(
      eq(schema.companionProviderConnections.orgId, input.orgId),
      eq(schema.companionProviderConnections.providerId, providerId),
    ),
  });
  if (!row) {
    throw new CompanionProviderError(
      "provider_not_configured",
      `${providerName(providerId)} is no longer connected. Ask a workspace admin to reconnect it.`,
      providerId,
    );
  }
  try {
    const plaintext = decryptOpaqueValue({
      orgId: input.orgId,
      purpose: PROVIDER_CREDENTIAL_PURPOSE,
      subjectId: `${providerId}:${row.credentialGeneration}`,
      ...providerCiphertext(row),
    }, input.masterKey);
    const authEntry = JSON.parse(plaintext) as Record<string, unknown>;
    if (!authEntry || typeof authEntry !== "object" || !["api_key", "oauth"].includes(String(authEntry.type))) {
      throw new Error("invalid provider credential");
    }
    return {
      providerId,
      credentialGeneration: row.credentialGeneration,
      authEntry,
    };
  } catch {
    throw new CompanionProviderError(
      "provider_auth_invalid",
      `${providerName(providerId)} authentication is invalid. Ask a workspace admin to reconnect it.`,
      providerId,
    );
  }
}

export async function getCompanionForRuntime(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<Companion> {
  const companion = await getCompanion(input);
  if (!canWakeCompanion(companion.access)) throw new CompanionRuntimeForbiddenError();
  return companion;
}

export async function updateCompanionRuntime(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  patch: {
    boxId?: string | null;
    runtimeState?: CompanionRuntimeState;
    daemonState?: CompanionDaemonState;
    providerIds?: string[];
    providerCredentialGeneration?: string | null;
    diskLayoutVersion?: number;
    desktopAvailable?: boolean;
    observedAt?: Date;
    startedAt?: Date;
    stoppedAt?: Date;
  };
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  await getCompanionForRuntime({ ...input, database });
  const now = new Date();
  const [row] = await database
    .update(schema.companions)
    .set({
      ...(input.patch.boxId !== undefined ? { boxId: input.patch.boxId } : {}),
      ...(input.patch.runtimeState ? { runtimeState: input.patch.runtimeState } : {}),
      ...(input.patch.daemonState ? { daemonState: input.patch.daemonState } : {}),
      ...(input.patch.providerIds ? { providerIds: input.patch.providerIds } : {}),
      ...(input.patch.providerCredentialGeneration !== undefined
        ? { providerCredentialGeneration: input.patch.providerCredentialGeneration }
        : {}),
      ...(input.patch.diskLayoutVersion !== undefined
        ? { diskLayoutVersion: input.patch.diskLayoutVersion }
        : {}),
      ...(input.patch.desktopAvailable !== undefined
        ? { desktopAvailable: input.patch.desktopAvailable }
        : {}),
      ...(input.patch.observedAt ? { lastObservedAt: input.patch.observedAt } : {}),
      ...(input.patch.startedAt ? { lastStartedAt: input.patch.startedAt } : {}),
      ...(input.patch.stoppedAt ? { lastStoppedAt: input.patch.stoppedAt } : {}),
      updatedAt: now,
    })
    .where(and(eq(schema.companions.orgId, input.orgId), eq(schema.companions.id, input.companionId)))
    .returning();
  if (!row) throw new CompanionNotFoundError();
  return toCompanion(row, input.actor.id);
}

/**
 * Record a live Box observation without overwriting a lifecycle claim. A status poll that races a
 * start/stop returns the claimed control-plane state and lets that mutation remain authoritative.
 */
export async function updateCompanionObservation(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  patch: {
    runtimeState: CompanionRuntimeState;
    daemonState: CompanionDaemonState;
    desktopAvailable: boolean;
    observedAt: Date;
  };
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  await getCompanionForRuntime({ ...input, database });
  const [row] = await database
    .update(schema.companions)
    .set({
      runtimeState: input.patch.runtimeState,
      daemonState: input.patch.daemonState,
      desktopAvailable: input.patch.desktopAvailable,
      lastObservedAt: input.patch.observedAt,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      notInArray(schema.companions.runtimeState, ["provisioning", "stopping"]),
    ))
    .returning();
  if (row) return toCompanion(row, input.actor.id);
  return getCompanionForRuntime({ ...input, database });
}

export async function claimCompanionRuntimeStart(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  await getCompanionForRuntime({ ...input, database });
  const [row] = await database
    .update(schema.companions)
    .set({ runtimeState: "provisioning", daemonState: "starting", updatedAt: new Date() })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.runtimeState, "not_created"),
    ))
    .returning();
  if (row) return toCompanion(row, input.actor.id);

  const current = await getCompanionForRuntime({ ...input, database });
  const transitional =
    current.runtime.state === "provisioning" || current.runtime.state === "stopping";
  const staleBefore = new Date(Date.now() - COMPANION_RUNTIME_CLAIM_STALE_MS);
  if (transitional && new Date(current.updated_at) >= staleBefore) {
    throw new CompanionRuntimeTransitionError(
      `companion runtime is already ${current.runtime.state}`,
    );
  }
  const [claimed] = await database
    .update(schema.companions)
    .set({ runtimeState: "provisioning", daemonState: "starting", updatedAt: new Date() })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.runtimeState, current.runtime.state),
      transitional ? lt(schema.companions.updatedAt, staleBefore) : undefined,
    ))
    .returning();
  if (!claimed) throw new CompanionRuntimeTransitionError("companion runtime state changed; retry");
  return toCompanion(claimed, input.actor.id);
}

export async function claimCompanionRuntimeStop(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  const current = await getCompanionForRuntime({ ...input, database });
  if (!current.runtime.box_id) throw new CompanionRuntimeTransitionError("companion has no Box to stop");
  const transitional =
    current.runtime.state === "provisioning" || current.runtime.state === "stopping";
  const staleBefore = new Date(Date.now() - COMPANION_RUNTIME_CLAIM_STALE_MS);
  if (transitional && new Date(current.updated_at) >= staleBefore) {
    throw new CompanionRuntimeTransitionError(
      `companion runtime is already ${current.runtime.state}`,
    );
  }
  const [claimed] = await database
    .update(schema.companions)
    .set({ runtimeState: "stopping", updatedAt: new Date() })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.runtimeState, current.runtime.state),
      transitional ? lt(schema.companions.updatedAt, staleBefore) : undefined,
    ))
    .returning();
  if (!claimed) throw new CompanionRuntimeTransitionError("companion runtime state changed; retry");
  return toCompanion(claimed, input.actor.id);
}

