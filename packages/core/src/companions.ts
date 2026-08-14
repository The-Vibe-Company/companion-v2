import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, lt, notInArray, sql } from "drizzle-orm";
import type {
  Companion,
  CompanionAccess,
  CompanionDaemonState,
  CompanionMcpAccount,
  CompanionMcpCredential,
  CompanionPluginAccount,
  CompanionProviderAuthMethod,
  CompanionProviderConnection,
  CompanionProvidersResponse,
  CompanionRuntimeState,
  SaveCompanionPluginInput,
  CompanionShareRole,
  CompanionShares,
  CompanionThread,
  CompanionTranscriptEntry,
} from "@companion/contracts";
import {
  COMPANION_PROVIDER_CATALOG,
  companionMcpAccountSchema,
  companionMcpCredentialSchema,
  companionMessageEventId,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import { canManageOrg } from "./authz";
import type { CompanionPiEntry } from "./companionPiEvents";
import {
  companionRuntimeErrorForAccess,
  sanitizeCompanionRuntimeError,
} from "./companionRuntimeErrors";
import { decryptOpaqueValue, encryptOpaqueValue, type OpaqueCiphertext } from "./secretsCrypto";
import { assertMember, getOrgRole, type ActorContext } from "./services";

type CompanionRow = typeof schema.companions.$inferSelect;
/**
 * How long one wake may hold its `provisioning` claim. The lifecycle caller stops waiting at this
 * deadline and records why, so a wake that hangs — an object-storage read that never answers, a Box
 * call that never returns — becomes a retryable `error` instead of a Companion that says Starting
 * for as long as nobody looks at it.
 *
 * It is sized to cover a cold start's own two long waits — the Box becoming ready and Pi becoming
 * active — with room for the commands between them, and deliberately not to cover their sum with
 * every per-command timeout on top: that sum is minutes, which is how a wake outlived every deadline
 * it had while each individual call stayed inside its own. A slow start it does cut off fails
 * retryably against a Box that is now warm, so the wake after it is the fast one.
 */
export const COMPANION_RUNTIME_START_BUDGET_MS = 3 * 60_000;
/**
 * When a claim may be taken over. A wake that is still inside its budget owns the lifecycle, so the
 * window is that budget plus room for the failure it records on the way out; past it the claim can
 * only belong to an attempt whose process died without writing anything, and the next send or Wake
 * is allowed to take it.
 */
const COMPANION_RUNTIME_CLAIM_STALE_MS = COMPANION_RUNTIME_START_BUDGET_MS + 30_000;
const PROVIDER_CREDENTIAL_PURPOSE = "companion-provider-credential";
const MCP_CREDENTIAL_PURPOSE = "companion-mcp-credential";

/** Drizzle query errors nest postgres.js SQLSTATE on `cause`; check both layers. */
function isPostgresUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  if ("code" in error && (error as { code?: unknown }).code === "23505") return true;
  if (
    "cause" in error
    && error.cause
    && typeof error.cause === "object"
    && "code" in error.cause
    && (error.cause as { code?: unknown }).code === "23505"
  ) {
    return true;
  }
  return false;
}

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

export class CompanionPluginConflictError extends Error {
  constructor() {
    super("this MCP provider already has an account with that label");
    this.name = "CompanionPluginConflictError";
  }
}

export class CompanionShareForbiddenError extends Error {
  constructor() {
    super("only the Companion owner can manage sharing");
    this.name = "CompanionShareForbiddenError";
  }
}

export class CompanionSettingsForbiddenError extends Error {
  constructor() {
    super("Companion settings require owner or editor access");
    this.name = "CompanionSettingsForbiddenError";
  }
}

export class CompanionDeleteForbiddenError extends Error {
  constructor() {
    super("only the Companion owner can delete it");
    this.name = "CompanionDeleteForbiddenError";
  }
}

/**
 * Access is the owner, otherwise the workspace-wide grant. Per-member grants were cut in THE-329, so
 * authorization ignores any that a not-yet-run migration left behind: a stale row can never open a
 * Companion.
 */
export function companionAccessForActor(
  row: Pick<CompanionRow, "ownerId">,
  actorId: string,
  workspaceRole: CompanionShareRole | null = null,
): CompanionAccess | null {
  if (row.ownerId === actorId) return "owner";
  return workspaceRole;
}

export function canWakeCompanion(access: CompanionAccess): boolean {
  return access === "owner" || access === "editor";
}

function toCompanion(row: CompanionRow, access: CompanionAccess): Companion {
  return {
    id: row.id,
    name: row.name,
    persona: row.persona,
    owner_id: row.ownerId,
    access,
    runtime: {
      state: row.runtimeState,
      daemon_state: row.daemonState,
      box_id: access === "viewer" ? null : row.boxId,
      provider_ids: row.providerIds,
      provider_credential_generation: row.providerCredentialGeneration,
      disk_layout_version: row.diskLayoutVersion,
      desktop_available: access === "viewer" ? false : row.desktopAvailable,
      last_error: companionRuntimeErrorForAccess({
        state: row.runtimeState,
        lastError: row.lastError,
        access,
      }),
      last_observed_at: row.lastObservedAt?.toISOString() ?? null,
      last_started_at: row.lastStartedAt?.toISOString() ?? null,
      last_stopped_at: row.lastStoppedAt?.toISOString() ?? null,
    },
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

async function loadCompanionAccess(
  database: Db,
  row: Pick<CompanionRow, "id" | "ownerId">,
  actorId: string,
): Promise<CompanionAccess | null> {
  if (row.ownerId === actorId) return "owner";
  const workspaceGrant = await database.query.companionWorkspaceAccess.findFirst({
    where: eq(schema.companionWorkspaceAccess.companionId, row.id),
    columns: { role: true },
  });
  return companionAccessForActor(row, actorId, workspaceGrant?.role ?? null);
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
  const visible = await Promise.all(rows.map(async (row) => {
    const access = await loadCompanionAccess(database, row, input.actor.id);
    return access ? toCompanion(row, access) : null;
  }));
  return visible.filter((item): item is Companion => item !== null);
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
  const access = await loadCompanionAccess(database, row, input.actor.id);
  if (!access) throw new CompanionNotFoundError();
  return toCompanion(row, access);
}

export async function createCompanion(input: {
  actor: ActorContext;
  orgId: string;
  name: string;
  persona?: string;
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
      persona: input.persona?.trim() || null,
      providerIds: [providerId],
    })
    .returning();
  if (!row) throw new Error("failed to create companion");
  return toCompanion(row, "owner");
}

export async function updateCompanion(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  name?: string;
  persona?: string | null;
  providerId?: string;
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  const companion = await getCompanion(input);
  if (companion.access === "viewer") throw new CompanionSettingsForbiddenError();

  if (input.providerId !== undefined) {
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
  }

  const providerChanged = input.providerId !== undefined
    && companion.runtime.provider_ids[0] !== input.providerId;
  const [row] = await database
    .update(schema.companions)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.persona !== undefined ? { persona: input.persona?.trim() || null } : {}),
      ...(input.providerId !== undefined ? { providerIds: [input.providerId] } : {}),
      ...(providerChanged ? { providerCredentialGeneration: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
    ))
    .returning();
  if (!row) throw new CompanionNotFoundError();
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "companion.settings.updated",
    targetType: "companion",
    targetId: input.companionId,
    metadata: {
      name: input.name !== undefined,
      persona: input.persona !== undefined,
      provider: input.providerId !== undefined,
    },
  });
  return toCompanion(row, companion.access);
}

/**
 * Lock the Companion against every wake before its Box is archived. Retrying a failed delete may
 * reclaim `stopping`; no other lifecycle transition can start while the external archive is pending.
 */
export async function claimCompanionDeletion(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  const companion = await getCompanion(input);
  if (companion.access !== "owner") throw new CompanionDeleteForbiddenError();
  if (companion.runtime.state === "provisioning") {
    throw new CompanionRuntimeTransitionError("Companion cannot be deleted while it is starting");
  }
  const [row] = await database
    .update(schema.companions)
    .set({
      runtimeState: "stopping",
      daemonState: companion.runtime.box_id ? companion.runtime.daemon_state : "stopped",
      lastError: null,
      // This timestamp is also the lifecycle compare-and-set token. `clock_timestamp()` alone can
      // equal a stop claim created in the same millisecond after the driver rounds it to a Date.
      updatedAt: sql<Date>`greatest(
        clock_timestamp(),
        ${schema.companions.updatedAt} + interval '1 millisecond'
      )`,
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.ownerId, input.actor.id),
    ))
    .returning();
  if (!row) throw new CompanionNotFoundError();
  return toCompanion(row, "owner");
}

export async function deleteCompanion(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const companion = await getCompanion(input);
  if (companion.access !== "owner") throw new CompanionDeleteForbiddenError();
  const [deleted] = await database
    .delete(schema.companions)
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.ownerId, input.actor.id),
      eq(schema.companions.runtimeState, "stopping"),
    ))
    .returning({ id: schema.companions.id });
  if (!deleted) {
    throw new CompanionRuntimeTransitionError("Companion deletion was not claimed");
  }
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "companion.deleted",
    targetType: "companion",
    targetId: input.companionId,
    metadata: {},
  });
}

async function assertCompanionOwner(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<Companion> {
  const companion = await getCompanion(input);
  if (companion.access !== "owner") throw new CompanionShareForbiddenError();
  return companion;
}

export async function listCompanionShares(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<CompanionShares> {
  const database = input.database ?? db;
  await assertCompanionOwner({ ...input, database });
  const workspaceGrant = await database.query.companionWorkspaceAccess.findFirst({
    where: and(
      eq(schema.companionWorkspaceAccess.orgId, input.orgId),
      eq(schema.companionWorkspaceAccess.companionId, input.companionId),
    ),
    columns: { role: true },
  });
  return {
    companion_id: input.companionId,
    workspace_role: workspaceGrant?.role ?? null,
  };
}

export async function setCompanionWorkspaceShare(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  role: CompanionShareRole | null;
  database?: Db;
}): Promise<CompanionShares> {
  const database = input.database ?? db;
  const companion = await assertCompanionOwner({ ...input, database });
  if (input.role) {
    await database
      .insert(schema.companionWorkspaceAccess)
      .values({
        orgId: input.orgId,
        companionId: input.companionId,
        ownerId: companion.owner_id,
        role: input.role,
        grantedBy: input.actor.id,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.companionWorkspaceAccess.companionId,
        set: { role: input.role, grantedBy: input.actor.id, updatedAt: new Date() },
      });
  } else {
    await database.delete(schema.companionWorkspaceAccess).where(and(
      eq(schema.companionWorkspaceAccess.orgId, input.orgId),
      eq(schema.companionWorkspaceAccess.companionId, input.companionId),
    ));
  }
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: input.role ? "companion.share.workspace.updated" : "companion.share.workspace.revoked",
    targetType: "companion",
    targetId: input.companionId,
    metadata: { role: input.role },
  });
  return listCompanionShares({ ...input, database });
}

type CompanionThreadRow = typeof schema.companionThreads.$inferSelect;

async function readCompanionThreadRow(
  database: Db,
  orgId: string,
  companionId: string,
): Promise<CompanionThreadRow | undefined> {
  const [row] = await database
    .select()
    .from(schema.companionThreads)
    .where(and(
      eq(schema.companionThreads.orgId, orgId),
      eq(schema.companionThreads.companionId, companionId),
    ))
    .limit(1);
  return row;
}

async function readCompanionTranscript(
  database: Db,
  orgId: string,
  companionId: string,
): Promise<CompanionTranscriptEntry[]> {
  const rows = await database
    .select({
      eventId: schema.companionTranscriptEntries.eventId,
      ordinal: schema.companionTranscriptEntries.ordinal,
      role: schema.companionTranscriptEntries.role,
      content: schema.companionTranscriptEntries.content,
      authorId: schema.companionTranscriptEntries.authorId,
      authorName: schema.profiles.name,
      createdAt: schema.companionTranscriptEntries.createdAt,
    })
    .from(schema.companionTranscriptEntries)
    .leftJoin(schema.profiles, eq(schema.profiles.id, schema.companionTranscriptEntries.authorId))
    .where(and(
      eq(schema.companionTranscriptEntries.orgId, orgId),
      eq(schema.companionTranscriptEntries.companionId, companionId),
    ))
    .orderBy(asc(schema.companionTranscriptEntries.ordinal));
  return rows.map((row) => ({
    event_id: row.eventId,
    ordinal: row.ordinal,
    role: row.role,
    content: row.content,
    author_id: row.authorId,
    author_name: row.authorName,
    created_at: row.createdAt.toISOString(),
  }));
}

function toThread(input: {
  actor: ActorContext;
  companion: Companion;
  row: CompanionThreadRow | undefined;
  entries: CompanionTranscriptEntry[];
}): CompanionThread {
  const deliveredOrdinal = input.row?.deliveredOrdinal ?? null;
  const pending = input.entries.filter((entry) =>
    entry.role === "user" && (deliveredOrdinal === null || entry.ordinal > deliveredOrdinal));
  return {
    companion_id: input.companion.id,
    viewer_id: input.actor.id,
    access: input.companion.access,
    read_only: input.companion.access === "viewer",
    can_send: canWakeCompanion(input.companion.access),
    entries: input.entries,
    pending_count: pending.length,
    last_message_at: input.row?.lastMessageAt?.toISOString()
      ?? input.entries.at(-1)?.created_at
      ?? null,
  };
}

/**
 * The one thread a Companion owns, read from PostgreSQL only. Every access level uses this path, so
 * opening a thread — including a Viewer's read-only thread — never contacts or wakes Box.
 */
export async function getCompanionThread(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<CompanionThread> {
  const database = input.database ?? db;
  const companion = await getCompanion({ ...input, database });
  const [row, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  return toThread({ actor: input.actor, companion, row, entries });
}

/**
 * Allocate `count` consecutive transcript ordinals for this Companion's thread, creating the thread
 * row on first use. The conditional update is the serialization point, so two concurrent sends can
 * never claim the same ordinal.
 */
async function allocateThreadOrdinals(input: {
  database: Db;
  orgId: string;
  companionId: string;
  count: number;
  lastMessageAt?: Date;
}): Promise<number> {
  const [created] = await input.database
    .insert(schema.companionThreads)
    .values({
      orgId: input.orgId,
      companionId: input.companionId,
      nextOrdinal: input.count,
      ...(input.lastMessageAt ? { lastMessageAt: input.lastMessageAt } : {}),
    })
    .onConflictDoNothing()
    .returning({ nextOrdinal: schema.companionThreads.nextOrdinal });
  if (created) return 0;
  const [updated] = await input.database
    .update(schema.companionThreads)
    .set({
      nextOrdinal: sql`${schema.companionThreads.nextOrdinal} + ${input.count}`,
      ...(input.lastMessageAt ? { lastMessageAt: input.lastMessageAt } : {}),
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.companionThreads.orgId, input.orgId),
      eq(schema.companionThreads.companionId, input.companionId),
    ))
    .returning({ nextOrdinal: schema.companionThreads.nextOrdinal });
  if (!updated) throw new CompanionNotFoundError();
  return updated.nextOrdinal - input.count;
}

/**
 * Persist one Owner/Editor message in the control plane. Persistence is deliberately independent of
 * the harness: the message survives a sleeping Box and is handed to Pi by the delivery path.
 *
 * One send is one turn. The event id comes from the sender's `clientMessageId`, so the same send
 * arriving twice — a retried request, a replayed one, a client that submitted twice — resolves to the
 * turn already stored rather than a second copy of it. The primary key `(companion_id, event_id)` is
 * what enforces it, so two requests racing each other settle the same way as two arriving in order.
 */
export async function sendCompanionMessage(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  content: string;
  clientMessageId?: string;
  database?: Db;
}): Promise<{ thread: CompanionThread; entry: CompanionTranscriptEntry }> {
  const database = input.database ?? db;
  const companion = await getCompanionForRuntime({ ...input, database });
  const eventId = companionMessageEventId(input.clientMessageId ?? randomUUID());
  await insertCompanionMessage({
    database,
    orgId: input.orgId,
    companionId: input.companionId,
    eventId,
    content: input.content,
    authorId: input.actor.id,
  });
  const [row, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  const thread = toThread({ actor: input.actor, companion, row, entries });
  const entry = entries.find((item) => item.event_id === eventId);
  if (!entry) throw new Error("failed to persist companion message");
  return { thread, entry };
}

/**
 * Store one user message unless this send is already in the transcript. The read comes first so a
 * resent send does not burn an ordinal, and the conflicting insert closes the window between that
 * read and the write for two requests that arrive at once.
 */
async function insertCompanionMessage(input: {
  database: Db;
  orgId: string;
  companionId: string;
  eventId: string;
  content: string;
  authorId: string;
}): Promise<void> {
  const [stored] = await input.database
    .select({ eventId: schema.companionTranscriptEntries.eventId })
    .from(schema.companionTranscriptEntries)
    .where(and(
      eq(schema.companionTranscriptEntries.orgId, input.orgId),
      eq(schema.companionTranscriptEntries.companionId, input.companionId),
      eq(schema.companionTranscriptEntries.eventId, input.eventId),
    ))
    .limit(1);
  if (stored) return;
  const createdAt = new Date();
  const ordinal = await allocateThreadOrdinals({
    database: input.database,
    orgId: input.orgId,
    companionId: input.companionId,
    count: 1,
    lastMessageAt: createdAt,
  });
  await input.database
    .insert(schema.companionTranscriptEntries)
    .values({
      orgId: input.orgId,
      companionId: input.companionId,
      eventId: input.eventId,
      ordinal,
      role: "user",
      content: input.content,
      authorId: input.authorId,
      createdAt,
    })
    .onConflictDoNothing();
}

/**
 * Messages Pi has not received yet, oldest first. The caller delivers them in this order and then
 * records the watermark, so a failed delivery is retried instead of silently dropped.
 */
export async function listPendingCompanionMessages(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<{
  pending: CompanionTranscriptEntry[];
  piLogOffset: number;
  /** How far delivery already reached, so a caller can tell a delivered message from a waiting one. */
  deliveredOrdinal: number | null;
}> {
  const database = input.database ?? db;
  await getCompanionForRuntime({ ...input, database });
  const [row, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  const deliveredOrdinal = row?.deliveredOrdinal ?? null;
  return {
    pending: entries.filter((entry) =>
      entry.role === "user" && (deliveredOrdinal === null || entry.ordinal > deliveredOrdinal)),
    piLogOffset: row?.piLogOffset ?? 0,
    deliveredOrdinal,
  };
}

/**
 * Append entries projected from the Pi RPC log and advance both watermarks. Pi is authoritative
 * while it runs; this idempotent sink only mirrors what it already produced and never wakes Box.
 */
export async function recordCompanionPiProjection(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  entries: CompanionPiEntry[];
  piLogOffset?: number;
  /** Set when the caller reread a shrunken log from its start, so the offset may move backwards. */
  piLogRewound?: boolean;
  deliveredOrdinal?: number;
  database?: Db;
}): Promise<CompanionThread> {
  const database = input.database ?? db;
  const companion = await getCompanionForRuntime({ ...input, database });
  if (input.entries.length) {
    const ordinal = await allocateThreadOrdinals({
      database,
      orgId: input.orgId,
      companionId: input.companionId,
      count: input.entries.length,
      lastMessageAt: input.entries.at(-1)?.createdAt,
    });
    await database
      .insert(schema.companionTranscriptEntries)
      .values(input.entries.map((entry, index) => ({
        orgId: input.orgId,
        companionId: input.companionId,
        eventId: entry.eventId,
        ordinal: ordinal + index,
        role: entry.role,
        content: entry.content,
        createdAt: entry.createdAt,
      })))
      .onConflictDoNothing();
  }
  if (input.piLogOffset !== undefined || input.deliveredOrdinal !== undefined) {
    await database
      .insert(schema.companionThreads)
      .values({ orgId: input.orgId, companionId: input.companionId })
      .onConflictDoNothing();
    await database
      .update(schema.companionThreads)
      .set({
        ...(input.piLogOffset !== undefined
          ? {
            // Two awake syncs can overlap, and the one that read less of the log must not pull the
            // offset back and make the next sync reproject what the other already stored.
            piLogOffset: input.piLogRewound
              ? input.piLogOffset
              : sql`greatest(${schema.companionThreads.piLogOffset}, ${input.piLogOffset})`,
          }
          : {}),
        ...(input.deliveredOrdinal !== undefined
          ? { deliveredOrdinal: sql`greatest(coalesce(${schema.companionThreads.deliveredOrdinal}, -1), ${input.deliveredOrdinal})` }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(
        eq(schema.companionThreads.orgId, input.orgId),
        eq(schema.companionThreads.companionId, input.companionId),
      ));
  }
  const [row, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  return toThread({ actor: input.actor, companion, row, entries });
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

function mcpCiphertext(row: typeof schema.companionMcpAccounts.$inferSelect): OpaqueCiphertext {
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

function toPluginAccount(
  row: typeof schema.companionMcpAccounts.$inferSelect,
): CompanionPluginAccount {
  const config = companionMcpAccountSchema.parse(row.accountConfig);
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    transport: config.transport,
    endpoint: config.transport === "http"
      ? config.url
      : [config.command, ...config.args].join(" "),
    connected: true,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** List only the current member's connector accounts; workspace admins have no override. */
export async function listCompanionPlugins(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<CompanionPluginAccount[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const rows = await database
    .select()
    .from(schema.companionMcpAccounts)
    .where(and(
      eq(schema.companionMcpAccounts.orgId, input.orgId),
      eq(schema.companionMcpAccounts.ownerId, input.actor.id),
    ))
    .orderBy(asc(schema.companionMcpAccounts.provider), asc(schema.companionMcpAccounts.label));
  return rows.map(toPluginAccount);
}

/**
 * Save one connector outside chat. Credential plaintext is accepted only on this write and stored
 * envelope-encrypted; reads expose transport metadata and the account label only.
 */
export async function saveCompanionPlugin(input: {
  actor: ActorContext;
  orgId: string;
  plugin: SaveCompanionPluginInput;
  masterKey?: Buffer;
  database?: Db;
}): Promise<CompanionPluginAccount> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const id = randomUUID();
  const generation = randomUUID();
  const envKey = `COMPANION_MCP_${id.replaceAll("-", "").toLocaleUpperCase("en-US")}`;
  const credentials: CompanionMcpCredential[] = input.plugin.credential_value
    ? [{ env_key: envKey, value: input.plugin.credential_value }]
    : [];
  const common = {
    id,
    label: input.plugin.label,
    lifecycle: "lazy" as const,
    direct_tools: false as const,
  };
  const account: CompanionMcpAccount = input.plugin.transport === "http"
    ? {
        ...common,
        transport: "http",
        url: input.plugin.url!,
        headers: input.plugin.credential_name
          ? { [input.plugin.credential_name]: envKey }
          : {},
      }
    : {
        ...common,
        transport: "stdio",
        command: input.plugin.command!,
        args: input.plugin.args,
        env: input.plugin.credential_name
          ? { [input.plugin.credential_name]: envKey }
          : {},
      };
  companionMcpAccountSchema.parse(account);
  const encrypted = encryptOpaqueValue({
    orgId: input.orgId,
    purpose: MCP_CREDENTIAL_PURPOSE,
    subjectId: `${id}:${generation}`,
    value: JSON.stringify(credentials),
  }, input.masterKey);
  try {
    const [row] = await database
      .insert(schema.companionMcpAccounts)
      .values({
        id,
        orgId: input.orgId,
        ownerId: input.actor.id,
        provider: input.plugin.provider,
        label: input.plugin.label,
        transport: input.plugin.transport,
        accountConfig: account,
        credentialGeneration: generation,
        ...encrypted,
      })
      .returning();
    if (!row) throw new Error("failed to save MCP account");
    await database.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      privateToUserId: input.actor.id,
      action: "companion.plugin.connected",
      targetType: "companion_mcp_account",
      targetId: id,
      metadata: {
        provider: input.plugin.provider,
        label: input.plugin.label,
        transport: input.plugin.transport,
      },
    });
    return toPluginAccount(row);
  } catch (error) {
    // Drizzle wraps postgres.js errors, so SQLSTATE lives on `cause` for unique conflicts.
    if (isPostgresUniqueViolation(error)) {
      throw new CompanionPluginConflictError();
    }
    throw error;
  }
}

export async function deleteCompanionPlugin(input: {
  actor: ActorContext;
  orgId: string;
  accountId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const [deleted] = await database
    .delete(schema.companionMcpAccounts)
    .where(and(
      eq(schema.companionMcpAccounts.id, input.accountId),
      eq(schema.companionMcpAccounts.orgId, input.orgId),
      eq(schema.companionMcpAccounts.ownerId, input.actor.id),
    ))
    .returning({ id: schema.companionMcpAccounts.id });
  if (!deleted) throw new CompanionNotFoundError();
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    privateToUserId: input.actor.id,
    action: "companion.plugin.disconnected",
    targetType: "companion_mcp_account",
    targetId: input.accountId,
    metadata: {},
  });
}

/**
 * Resolve the current member's saved accounts only after Owner/Editor runtime authorization. The
 * caller passes the resulting values straight to THE-325's transient environment channel.
 */
export async function resolveCompanionPluginInjection(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  masterKey?: Buffer;
  database?: Db;
}): Promise<{ accounts: CompanionMcpAccount[]; credentials: CompanionMcpCredential[] }> {
  const database = input.database ?? db;
  await getCompanionForRuntime({ ...input, database });
  const rows = await database
    .select()
    .from(schema.companionMcpAccounts)
    .where(and(
      eq(schema.companionMcpAccounts.orgId, input.orgId),
      eq(schema.companionMcpAccounts.ownerId, input.actor.id),
    ))
    .orderBy(asc(schema.companionMcpAccounts.provider), asc(schema.companionMcpAccounts.label));
  const accounts: CompanionMcpAccount[] = [];
  const credentials: CompanionMcpCredential[] = [];
  for (const row of rows) {
    try {
      accounts.push(companionMcpAccountSchema.parse(row.accountConfig));
      const plaintext = decryptOpaqueValue({
        orgId: input.orgId,
        purpose: MCP_CREDENTIAL_PURPOSE,
        subjectId: `${row.id}:${row.credentialGeneration}`,
        ...mcpCiphertext(row),
      }, input.masterKey);
      const parsed = JSON.parse(plaintext);
      if (!Array.isArray(parsed)) throw new Error("invalid MCP credential payload");
      credentials.push(...parsed.map((value) => companionMcpCredentialSchema.parse(value)));
    } catch {
      throw new CompanionProviderError(
        "provider_auth_invalid",
        `Authentication for ${row.provider} (${row.label}) is invalid. Reconnect it in Plugins.`,
        null,
      );
    }
  }
  return { accounts, credentials };
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
  const companion = await assertCompanionOwner({ ...input, database });
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
  return toCompanion(row, "owner");
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

/**
 * A recorded failure lives exactly as long as the `error` state it explains: any lifecycle write
 * that leaves `error` clears the line, so a successful retry cannot keep showing the old reason.
 */
function runtimeErrorPatch(patch: {
  runtimeState?: CompanionRuntimeState;
  lastError?: string | null;
}): { lastError?: string | null } {
  if (patch.lastError !== undefined) {
    return {
      lastError: patch.lastError ? sanitizeCompanionRuntimeError(patch.lastError) || null : null,
    };
  }
  if (patch.runtimeState && patch.runtimeState !== "error") return { lastError: null };
  return {};
}

export async function updateCompanionRuntime(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  /** Compare-and-set guard for a lifecycle finalizer that must not overwrite a newer claim. */
  expectedUpdatedAt?: Date;
  patch: {
    boxId?: string | null;
    runtimeState?: CompanionRuntimeState;
    daemonState?: CompanionDaemonState;
    providerIds?: string[];
    providerCredentialGeneration?: string | null;
    diskLayoutVersion?: number;
    desktopAvailable?: boolean;
    /** Sanitized before it is stored; any state other than `error` clears it instead. */
    lastError?: string | null;
    observedAt?: Date;
    startedAt?: Date;
    stoppedAt?: Date;
  };
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  const current = await getCompanionForRuntime({ ...input, database });
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
      ...runtimeErrorPatch(input.patch),
      ...(input.patch.observedAt ? { lastObservedAt: input.patch.observedAt } : {}),
      ...(input.patch.startedAt ? { lastStartedAt: input.patch.startedAt } : {}),
      ...(input.patch.stoppedAt ? { lastStoppedAt: input.patch.stoppedAt } : {}),
      updatedAt: now,
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      input.expectedUpdatedAt
        ? eq(schema.companions.updatedAt, input.expectedUpdatedAt)
        : undefined,
    ))
    .returning();
  if (!row && input.expectedUpdatedAt) {
    throw new CompanionRuntimeTransitionError("companion runtime state changed; retry");
  }
  if (!row) throw new CompanionNotFoundError();
  return toCompanion(row, current.access);
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
  const current = await getCompanionForRuntime({ ...input, database });
  const [row] = await database
    .update(schema.companions)
    .set({
      runtimeState: input.patch.runtimeState,
      daemonState: input.patch.daemonState,
      desktopAvailable: input.patch.desktopAvailable,
      ...runtimeErrorPatch({ runtimeState: input.patch.runtimeState }),
      lastObservedAt: input.patch.observedAt,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      notInArray(schema.companions.runtimeState, ["provisioning", "stopping"]),
    ))
    .returning();
  if (row) return toCompanion(row, current.access);
  return getCompanionForRuntime({ ...input, database });
}

export async function claimCompanionRuntimeStart(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  const currentAccess = await getCompanionForRuntime({ ...input, database });
  const [row] = await database
    .update(schema.companions)
    .set({
      runtimeState: "provisioning",
      daemonState: "starting",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.runtimeState, "not_created"),
    ))
    .returning();
  if (row) return toCompanion(row, currentAccess.access);

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
    .set({
      runtimeState: "provisioning",
      daemonState: "starting",
      lastError: null,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.runtimeState, current.runtime.state),
      transitional ? lt(schema.companions.updatedAt, staleBefore) : undefined,
    ))
    .returning();
  if (!claimed) throw new CompanionRuntimeTransitionError("companion runtime state changed; retry");
  return toCompanion(claimed, current.access);
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
    .set({ runtimeState: "stopping", lastError: null, updatedAt: new Date() })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.runtimeState, current.runtime.state),
      transitional ? lt(schema.companions.updatedAt, staleBefore) : undefined,
    ))
    .returning();
  if (!claimed) throw new CompanionRuntimeTransitionError("companion runtime state changed; retry");
  return toCompanion(claimed, current.access);
}

