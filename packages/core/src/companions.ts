import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, max, notInArray, or, sql } from "drizzle-orm";
import type {
  Companion,
  CompanionAccess,
  CompanionDaemonState,
  CompanionDecision,
  CompanionLastMessage,
  CompanionMcpAccount,
  CompanionMcpCredential,
  CompanionPluginAccount,
  CompanionProviderAuthMethod,
  CompanionProviderConnection,
  CompanionProviderDefinition,
  CompanionProvidersResponse,
  CompanionRuntimeState,
  DecideCompanionDecisionInput,
  SaveCompanionPluginInput,
  CompanionShareRole,
  CompanionShares,
  CompanionThread,
  CompanionTranscriptEntry,
  UpdateCompanionMemberStateInput,
} from "@companion/contracts";
import {
  COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS,
  COMPANION_LAST_MESSAGE_PREVIEW_MAX_CHARACTERS,
  COMPANION_PROVIDER_CATALOG,
  COMPANION_TOOL_RUN_TIMEOUT_MS,
  companionProviderDefaultModel,
  companionMcpAccountSchema,
  companionMcpCredentialSchema,
  companionMessageEventId,
} from "@companion/contracts";
import { db, schema, type Db } from "@companion/db";
import { canManageOrg } from "./authz";
import type { CompanionPiEntry, CompanionPiToolCompletion } from "./companionPiEvents";
import { matchCompanionToolCompletions } from "./companionPiEvents";
import {
  COMPANION_SKILLS_SYNC_ERROR_VIEWER_MESSAGE,
  companionRuntimeErrorForAccess,
  sanitizeCompanionRuntimeError,
} from "./companionRuntimeErrors";
import { decryptOpaqueValue, encryptOpaqueValue, type OpaqueCiphertext } from "./secretsCrypto";
import { assertMember, getOrgRole, listSkills, type ActorContext } from "./services";
import {
  COMPANION_PLUGIN_OAUTH_SERVERS,
  refreshCompanionPluginOAuth,
  type CompanionPluginStoredOAuthCredential,
} from "./companionPluginOAuth";
import {
  companionCatalogModel,
  getCompanionProviderCatalog,
} from "./companionProviderCatalog";

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
const OAUTH_REFRESH_SKEW_MS = 5 * 60_000;

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

export class CompanionDecisionNotFoundError extends Error {
  constructor() {
    super("companion permission request not found");
    this.name = "CompanionDecisionNotFoundError";
  }
}

export class CompanionDecisionConflictError extends Error {
  constructor(message = "companion permission request is no longer pending") {
    super(message);
    this.name = "CompanionDecisionConflictError";
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
    | "provider_model_invalid"
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

export class CompanionSkillSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionSkillSelectionError";
  }
}

export class CompanionPluginSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanionPluginSelectionError";
  }
}

export class CompanionWriteSkillsForbiddenError extends Error {
  constructor() {
    super("this Companion is not allowed to create or update skills on your behalf");
    this.name = "CompanionWriteSkillsForbiddenError";
  }
}

export class CompanionDuplicateForbiddenError extends Error {
  constructor(message = "Only the Companion owner can duplicate this Companion") {
    super(message);
    this.name = "CompanionDuplicateForbiddenError";
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

/**
 * One line of a message, fit for a list row: the first line, whitespace collapsed, cut to the
 * contract's width. The cut is on characters rather than words because the alternative is a preview
 * that silently drops the end of a short message to keep a word whole.
 */
export function companionLastMessagePreview(content: string): string {
  const firstLine = content.split("\n").find((line) => line.trim().length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (collapsed.length <= COMPANION_LAST_MESSAGE_PREVIEW_MAX_CHARACTERS) return collapsed;
  // The bound is the contract's, and the contract counts what JavaScript counts, so the cut is on
  // code units — but never through a surrogate pair, which would leave half a character and render
  // as a replacement glyph at the end of every long preview containing an emoji.
  const cut = collapsed.slice(0, COMPANION_LAST_MESSAGE_PREVIEW_MAX_CHARACTERS);
  const last = cut.charCodeAt(cut.length - 1);
  const strandedHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return strandedHighSurrogate ? cut.slice(0, -1) : cut;
}

/**
 * Newest chat line per Companion, for the conversation list. Every write answers without one — a
 * mutation reports what it just wrote, not a scan of the thread — so a surface that keeps a list
 * merges the field rather than replacing the row; `last_message: null` means "not answered here".
 * `tool` and `decision` entries are
 * excluded in the query rather than filtered afterwards, so a Companion whose last activity was a
 * tool run still previews the last thing a person or Pi actually said — and no tool title or pending
 * permission question can reach a surface outside the thread.
 *
 * Callers pass only Companion ids the actor may already read, so this adds no visibility of its own.
 */
export async function loadCompanionLastMessages(
  database: Db,
  orgId: string,
  companionIds: string[],
): Promise<Map<string, CompanionLastMessage>> {
  if (companionIds.length === 0) return new Map();
  const rows = await database
    .selectDistinctOn([schema.companionTranscriptEntries.companionId], {
      companionId: schema.companionTranscriptEntries.companionId,
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
      inArray(schema.companionTranscriptEntries.companionId, companionIds),
      inArray(schema.companionTranscriptEntries.role, ["user", "assistant"]),
    ))
    .orderBy(
      asc(schema.companionTranscriptEntries.companionId),
      desc(schema.companionTranscriptEntries.ordinal),
    );
  const previews = new Map<string, CompanionLastMessage>();
  for (const row of rows) {
    if (row.role !== "user" && row.role !== "assistant") continue;
    previews.set(row.companionId, {
      preview: companionLastMessagePreview(row.content),
      role: row.role,
      author_id: row.authorId,
      author_name: row.authorName,
      created_at: row.createdAt.toISOString(),
    });
  }
  return previews;
}

function toCompanion(
  row: CompanionRow,
  access: CompanionAccess,
  member: { pinned: boolean; hidden: boolean; unread: boolean } = {
    pinned: false,
    hidden: false,
    unread: false,
  },
  lastMessage: CompanionLastMessage | null = null,
): Companion {
  const providerId = row.providerIds[0];
  const modelId = row.modelId ?? (providerId ? companionProviderDefaultModel(providerId) : undefined);
  return {
    id: row.id,
    name: row.name,
    persona: row.persona,
    model_id: modelId ?? null,
    selected_skill_ids: Array.isArray(row.selectedSkillIds) ? row.selectedSkillIds : [],
    can_write_skills: row.canWriteSkills === true,
    selected_mcp_account_ids: Array.isArray(row.selectedMcpAccountIds)
      ? row.selectedMcpAccountIds
      : [],
    owner_id: row.ownerId,
    access,
    pinned: member.pinned,
    hidden: member.hidden,
    unread: member.unread,
    last_message: lastMessage,
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
      skills_revision: row.skillsRevision,
      skills_applied_revision: row.skillsAppliedRevision,
      skills_applied_at: row.skillsAppliedAt?.toISOString() ?? null,
      skills_last_error: row.skillsLastError
        ? access === "viewer"
          ? COMPANION_SKILLS_SYNC_ERROR_VIEWER_MESSAGE
          : row.skillsLastError
        : null,
      last_observed_at: row.lastObservedAt?.toISOString() ?? null,
      last_started_at: row.lastStartedAt?.toISOString() ?? null,
      last_stopped_at: row.lastStoppedAt?.toISOString() ?? null,
    },
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

function memberFromCompanion(companion: Pick<Companion, "pinned" | "hidden" | "unread">): {
  pinned: boolean;
  hidden: boolean;
  unread: boolean;
} {
  return {
    pinned: companion.pinned,
    hidden: companion.hidden,
    unread: companion.unread,
  };
}

type MemberStateRow = {
  companionId: string;
  pinnedAt: Date | null;
  hidden: boolean;
  lastReadOrdinal: number | null;
};

function memberFlags(
  state: MemberStateRow | undefined,
  highestOrdinal: number | null,
): { pinned: boolean; hidden: boolean; unread: boolean } {
  const lastRead = state?.lastReadOrdinal ?? -1;
  const highest = highestOrdinal ?? -1;
  return {
    pinned: state?.pinnedAt != null,
    hidden: state?.hidden === true,
    unread: highest > lastRead,
  };
}

function sortCompanionsForMember(
  companions: Companion[],
  pinnedAtById: Map<string, Date>,
): Companion[] {
  return [...companions].sort((left, right) => {
    const leftPinned = left.pinned ? pinnedAtById.get(left.id)?.getTime() ?? 0 : null;
    const rightPinned = right.pinned ? pinnedAtById.get(right.id)?.getTime() ?? 0 : null;
    if (leftPinned !== null && rightPinned === null) return -1;
    if (leftPinned === null && rightPinned !== null) return 1;
    if (leftPinned !== null && rightPinned !== null && leftPinned !== rightPinned) {
      return leftPinned - rightPinned;
    }
    const updated = Date.parse(right.updated_at) - Date.parse(left.updated_at);
    if (updated !== 0) return updated;
    return left.name.localeCompare(right.name, "en-US");
  });
}

async function loadMemberStates(
  database: Db,
  orgId: string,
  actorId: string,
  companionIds: string[],
): Promise<Map<string, MemberStateRow>> {
  const states = new Map<string, MemberStateRow>();
  if (!companionIds.length) return states;
  const rows = await database
    .select({
      companionId: schema.companionMemberState.companionId,
      pinnedAt: schema.companionMemberState.pinnedAt,
      hidden: schema.companionMemberState.hidden,
      lastReadOrdinal: schema.companionMemberState.lastReadOrdinal,
    })
    .from(schema.companionMemberState)
    .where(and(
      eq(schema.companionMemberState.orgId, orgId),
      eq(schema.companionMemberState.userId, actorId),
      inArray(schema.companionMemberState.companionId, companionIds),
    ));
  for (const row of rows) states.set(row.companionId, row);
  return states;
}

async function loadHighestTranscriptOrdinals(
  database: Db,
  orgId: string,
  companionIds: string[],
): Promise<Map<string, number>> {
  const highest = new Map<string, number>();
  if (!companionIds.length) return highest;
  const rows = await database
    .select({
      companionId: schema.companionTranscriptEntries.companionId,
      highestOrdinal: max(schema.companionTranscriptEntries.ordinal),
    })
    .from(schema.companionTranscriptEntries)
    .where(and(
      eq(schema.companionTranscriptEntries.orgId, orgId),
      inArray(schema.companionTranscriptEntries.companionId, companionIds),
    ))
    .groupBy(schema.companionTranscriptEntries.companionId);
  for (const row of rows) {
    if (row.highestOrdinal != null) highest.set(row.companionId, row.highestOrdinal);
  }
  return highest;
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

async function companionWithMemberState(input: {
  database: Db;
  actorId: string;
  orgId: string;
  row: CompanionRow;
  access: CompanionAccess;
  /** Only a surface that draws a conversation row needs the preview; it is a scan of the thread. */
  withLastMessage?: boolean;
}): Promise<Companion> {
  const [states, highest, previews] = await Promise.all([
    loadMemberStates(input.database, input.orgId, input.actorId, [input.row.id]),
    loadHighestTranscriptOrdinals(input.database, input.orgId, [input.row.id]),
    input.withLastMessage
      ? loadCompanionLastMessages(input.database, input.orgId, [input.row.id])
      : Promise.resolve(new Map<string, CompanionLastMessage>()),
  ]);
  return toCompanion(
    input.row,
    input.access,
    memberFlags(states.get(input.row.id), highest.get(input.row.id) ?? null),
    previews.get(input.row.id) ?? null,
  );
}

export async function listCompanions(input: {
  actor: ActorContext;
  orgId: string;
  /**
   * Project each thread's newest chat line. On by default, because the list is the conversation
   * list. A caller that only needs names and attachments — the Skills page asking which Companions
   * stage a skill — turns it off, so private chat text never reaches a surface that shows none.
   */
  withLastMessage?: boolean;
  database?: Db;
}): Promise<Companion[]> {
  const database = input.database ?? db;
  await assertMember(database, input.actor, input.orgId);
  const rows = await database
    .select()
    .from(schema.companions)
    .where(eq(schema.companions.orgId, input.orgId))
    .orderBy(desc(schema.companions.updatedAt));
  const accessible: Array<{ row: CompanionRow; access: CompanionAccess }> = [];
  for (const row of rows) {
    const access = await loadCompanionAccess(database, row, input.actor.id);
    if (access) accessible.push({ row, access });
  }
  const companionIds = accessible.map((item) => item.row.id);
  // Only the Companions this actor may already read are previewed, and in one query rather than one
  // per row: the list is the surface that shows every thread's last word at once.
  const [states, highest, previews] = await Promise.all([
    loadMemberStates(database, input.orgId, input.actor.id, companionIds),
    loadHighestTranscriptOrdinals(database, input.orgId, companionIds),
    input.withLastMessage === false
      ? Promise.resolve(new Map<string, CompanionLastMessage>())
      : loadCompanionLastMessages(database, input.orgId, companionIds),
  ]);
  const pinnedAtById = new Map<string, Date>();
  const companions = accessible.map(({ row, access }) => {
    const state = states.get(row.id);
    if (state?.pinnedAt) pinnedAtById.set(row.id, state.pinnedAt);
    return toCompanion(
      row,
      access,
      memberFlags(state, highest.get(row.id) ?? null),
      previews.get(row.id) ?? null,
    );
  });
  return sortCompanionsForMember(companions, pinnedAtById);
}

export async function getCompanion(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  /**
   * Project this thread's newest chat line. Off by default: it is a scan of the transcript, and
   * `getCompanion` is the shared primitive behind sends, syncs, lifecycle claims, and the thread
   * read, none of which render a conversation row. On for the reads a row is drawn from.
   */
  withLastMessage?: boolean;
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
  return companionWithMemberState({
    database,
    actorId: input.actor.id,
    orgId: input.orgId,
    row,
    access,
    withLastMessage: input.withLastMessage,
  });
}

/**
 * Resolve and validate skill ids the actor may attach to a Companion: organization skills plus the
 * actor's own personal skills. Unknown, archived, or invisible ids fail closed. Ids already on the
 * Companion may be kept even when the current editor cannot see them, so an Owner's personal skills
 * survive an Editor saving other settings.
 */
export async function resolveCompanionSelectedSkillIds(input: {
  actor: ActorContext;
  orgId: string;
  selectedSkillIds: string[];
  previouslySelectedSkillIds?: string[];
  database?: Db;
}): Promise<string[]> {
  const database = input.database ?? db;
  const unique = [...new Set(input.selectedSkillIds)];
  if (!unique.length) return [];
  const visible = await listSkills({
    actor: input.actor,
    orgId: input.orgId,
    library: "accessible",
    database,
  });
  const allowed = new Set(
    visible
      .filter((skill) => !skill.archived && skill.validation === "valid" && skill.current_version)
      .map((skill) => skill.id),
  );
  for (const id of input.previouslySelectedSkillIds ?? []) {
    if (unique.includes(id)) allowed.add(id);
  }
  const rejected = unique.filter((id) => !allowed.has(id));
  if (rejected.length) {
    throw new CompanionSkillSelectionError(
      rejected.length === 1
        ? "One selected skill is not available in this workspace library."
        : `${rejected.length} selected skills are not available in this workspace library.`,
    );
  }
  return unique;
}

/**
 * Resolve and validate MCP account ids the actor may attach to a Companion: the member's already
 * connected Plugins accounts. Unknown or foreign ids fail closed. Ids already on the Companion may
 * be kept even when the current editor does not own them, so an Owner's connections survive an
 * Editor saving other settings.
 */
export async function resolveCompanionSelectedMcpAccountIds(input: {
  actor: ActorContext;
  orgId: string;
  selectedMcpAccountIds: string[];
  previouslySelectedMcpAccountIds?: string[];
  database?: Db;
}): Promise<string[]> {
  const database = input.database ?? db;
  const unique = [...new Set(input.selectedMcpAccountIds)];
  if (!unique.length) return [];
  const connected = await listCompanionPlugins({
    actor: input.actor,
    orgId: input.orgId,
    database,
  });
  const allowed = new Set(connected.map((account) => account.id));
  for (const id of input.previouslySelectedMcpAccountIds ?? []) {
    if (unique.includes(id)) allowed.add(id);
  }
  const rejected = unique.filter((id) => !allowed.has(id));
  if (rejected.length) {
    throw new CompanionPluginSelectionError(
      rejected.length === 1
        ? "One selected plugin is not connected in this workspace."
        : `${rejected.length} selected plugins are not connected in this workspace.`,
    );
  }
  return unique;
}

/**
 * Fail closed when a Companion-sourced PAT attempts skills:write after write-on-behalf was turned off.
 */
export async function assertCompanionCanWriteSkills(input: {
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const [row] = await database
    .select({ canWriteSkills: schema.companions.canWriteSkills })
    .from(schema.companions)
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
    ))
    .limit(1);
  if (!row?.canWriteSkills) throw new CompanionWriteSkillsForbiddenError();
}

export async function createCompanion(input: {
  actor: ActorContext;
  orgId: string;
  name: string;
  persona?: string;
  providerId?: string;
  modelId?: string;
  selectedSkillIds?: string[];
  canWriteSkills?: boolean;
  selectedMcpAccountIds?: string[];
  providerCatalog?: CompanionProviderDefinition[];
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
  const catalog = input.providerCatalog ?? await getCompanionProviderCatalog();
  const modelId = companionCatalogModel(catalog, providerId, input.modelId);
  if (!modelId) {
    throw new CompanionProviderError(
      "provider_model_invalid",
      `The model ${input.modelId ?? "(default)"} is not available for ${providerName(providerId)}.`,
      providerId,
    );
  }
  const selectedSkillIds = input.selectedSkillIds !== undefined
    ? await resolveCompanionSelectedSkillIds({
        actor: input.actor,
        orgId: input.orgId,
        selectedSkillIds: input.selectedSkillIds,
        database,
      })
    : [];
  const selectedMcpAccountIds = input.selectedMcpAccountIds !== undefined
    ? await resolveCompanionSelectedMcpAccountIds({
        actor: input.actor,
        orgId: input.orgId,
        selectedMcpAccountIds: input.selectedMcpAccountIds,
        database,
      })
    : [];
  const [row] = await database
    .insert(schema.companions)
    .values({
      orgId: input.orgId,
      ownerId: input.actor.id,
      name: input.name,
      persona: input.persona?.trim() || null,
      providerIds: [providerId],
      modelId,
      selectedSkillIds,
      canWriteSkills: input.canWriteSkills === true,
      selectedMcpAccountIds,
    })
    .returning();
  if (!row) throw new Error("failed to create companion");
  return toCompanion(row, "owner");
}

function duplicateCompanionName(name: string): string {
  const suffix = " (copy)";
  if (name.length + suffix.length <= 120) return `${name}${suffix}`;
  return `${name.slice(0, Math.max(1, 120 - suffix.length))}${suffix}`;
}

/**
 * Owner-only clone of name / instructions / model / skill selection / plugin selection into a new
 * Companion with a new Box. Workspace share is never copied (THE-329).
 */
export async function duplicateCompanion(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  providerCatalog?: CompanionProviderDefinition[];
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  const source = await getCompanion({ ...input, database });
  if (source.access !== "owner") throw new CompanionDuplicateForbiddenError();
  const providerId = source.runtime.provider_ids[0];
  if (!providerId || !source.model_id) {
    throw new CompanionProviderError(
      "provider_not_configured",
      "This Companion needs a connected provider and model before it can be duplicated.",
      providerId ?? null,
    );
  }
  const cloned = await createCompanion({
    actor: input.actor,
    orgId: input.orgId,
    name: duplicateCompanionName(source.name),
    persona: source.persona ?? undefined,
    providerId,
    modelId: source.model_id,
    selectedSkillIds: source.selected_skill_ids,
    canWriteSkills: source.can_write_skills,
    selectedMcpAccountIds: source.selected_mcp_account_ids,
    providerCatalog: input.providerCatalog,
    database,
  });
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "companion.duplicated",
    targetType: "companion",
    targetId: cloned.id,
    metadata: { source_companion_id: source.id },
  });
  return cloned;
}

async function upsertCompanionMemberState(input: {
  database: Db;
  orgId: string;
  companionId: string;
  userId: string;
  pinnedAt?: Date | null;
  hidden?: boolean;
  lastReadOrdinal?: number | null;
}): Promise<void> {
  const existing = await input.database.query.companionMemberState.findFirst({
    where: and(
      eq(schema.companionMemberState.companionId, input.companionId),
      eq(schema.companionMemberState.userId, input.userId),
    ),
    columns: {
      pinnedAt: true,
      hidden: true,
      lastReadOrdinal: true,
    },
  });
  const pinnedAt = input.pinnedAt !== undefined ? input.pinnedAt : (existing?.pinnedAt ?? null);
  const hidden = input.hidden !== undefined ? input.hidden : (existing?.hidden ?? false);
  const lastReadOrdinal = input.lastReadOrdinal !== undefined
    ? input.lastReadOrdinal
    : (existing?.lastReadOrdinal ?? null);
  await input.database
    .insert(schema.companionMemberState)
    .values({
      orgId: input.orgId,
      companionId: input.companionId,
      userId: input.userId,
      pinnedAt,
      hidden,
      lastReadOrdinal,
    })
    .onConflictDoUpdate({
      target: [
        schema.companionMemberState.companionId,
        schema.companionMemberState.userId,
      ],
      set: {
        pinnedAt,
        hidden,
        lastReadOrdinal,
        updatedAt: new Date(),
      },
    });
}

/**
 * Advance this member's unread watermark to the thread's highest ordinal. Opening or syncing the
 * thread clears the badge for Viewer and Owner alike.
 */
export async function markCompanionThreadRead(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await getCompanion({ ...input, database });
  const highest = await loadHighestTranscriptOrdinals(database, input.orgId, [input.companionId]);
  const ordinal = highest.get(input.companionId);
  if (ordinal == null) return;
  await upsertCompanionMemberState({
    database,
    orgId: input.orgId,
    companionId: input.companionId,
    userId: input.actor.id,
    lastReadOrdinal: ordinal,
  });
}

/**
 * Persist pin / hide / mark-unread for the current member. Any member who can see the Companion may
 * change these preferences; they never alter the Companion row, Box, or workspace share.
 */
export async function updateCompanionMemberState(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  patch: UpdateCompanionMemberStateInput;
  database?: Db;
}): Promise<Companion> {
  const database = input.database ?? db;
  const companion = await getCompanion({ ...input, database });
  const highest = await loadHighestTranscriptOrdinals(database, input.orgId, [input.companionId]);
  const highestOrdinal = highest.get(input.companionId) ?? null;

  let pinnedAt: Date | null | undefined;
  if (input.patch.pinned === true) {
    pinnedAt = companion.pinned
      ? (await loadMemberStates(database, input.orgId, input.actor.id, [input.companionId]))
        .get(input.companionId)?.pinnedAt ?? new Date()
      : new Date();
  } else if (input.patch.pinned === false) {
    pinnedAt = null;
  }

  let lastReadOrdinal: number | null | undefined;
  if (input.patch.unread === true) {
    // Push the watermark behind the latest entry so the badge returns until the member opens again.
    lastReadOrdinal = highestOrdinal == null || highestOrdinal === 0
      ? null
      : highestOrdinal - 1;
  } else if (input.patch.unread === false) {
    lastReadOrdinal = highestOrdinal;
  }

  await upsertCompanionMemberState({
    database,
    orgId: input.orgId,
    companionId: input.companionId,
    userId: input.actor.id,
    ...(pinnedAt !== undefined ? { pinnedAt } : {}),
    ...(input.patch.hidden !== undefined ? { hidden: input.patch.hidden } : {}),
    ...(lastReadOrdinal !== undefined ? { lastReadOrdinal } : {}),
  });

  return getCompanion({ ...input, database });
}

export async function updateCompanion(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  name?: string;
  persona?: string | null;
  providerId?: string;
  modelId?: string;
  selectedSkillIds?: string[];
  canWriteSkills?: boolean;
  selectedMcpAccountIds?: string[];
  providerCatalog?: CompanionProviderDefinition[];
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

  const currentProviderId = companion.runtime.provider_ids[0];
  const providerChanged = input.providerId !== undefined
    && currentProviderId !== input.providerId;
  const providerId = input.providerId ?? currentProviderId;
  const providerOrModelChanged = input.providerId !== undefined || input.modelId !== undefined;
  const requestedModelId = input.modelId
    ?? (input.providerId !== undefined && (providerChanged || !companion.model_id)
      ? undefined
      : companion.model_id ?? undefined);
  const modelId = providerOrModelChanged && providerId
    ? companionCatalogModel(
        input.providerCatalog ?? await getCompanionProviderCatalog(),
        providerId,
        requestedModelId,
      )
    : companion.model_id;
  if (
    providerOrModelChanged
    && (!providerId || !modelId)
  ) {
    throw new CompanionProviderError(
      "provider_model_invalid",
      `The model ${requestedModelId ?? "(default)"} is not available for ${providerName(providerId ?? "unknown")}.`,
      providerId ?? null,
    );
  }
  const selectedSkillIds = input.selectedSkillIds !== undefined
    ? await resolveCompanionSelectedSkillIds({
        actor: input.actor,
        orgId: input.orgId,
        selectedSkillIds: input.selectedSkillIds,
        previouslySelectedSkillIds: companion.selected_skill_ids,
        database,
      })
    : undefined;
  const selectedMcpAccountIds = input.selectedMcpAccountIds !== undefined
    ? await resolveCompanionSelectedMcpAccountIds({
        actor: input.actor,
        orgId: input.orgId,
        selectedMcpAccountIds: input.selectedMcpAccountIds,
        previouslySelectedMcpAccountIds: companion.selected_mcp_account_ids,
        database,
      })
    : undefined;
  // Same-transaction desired-revision bump: the Box does not have this skill set yet. A no-op save
  // (identical resolved array) must not bump, or the sync line would show a pending apply forever
  // on an asleep Box that has nothing new to receive.
  const skillsChanged = selectedSkillIds !== undefined
    && (
      selectedSkillIds.length !== companion.selected_skill_ids.length
      || selectedSkillIds.some((id, index) => id !== companion.selected_skill_ids[index])
    );
  const [row] = await database
    .update(schema.companions)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.persona !== undefined ? { persona: input.persona?.trim() || null } : {}),
      ...(input.providerId !== undefined ? { providerIds: [input.providerId] } : {}),
      ...(
        input.modelId !== undefined
        || providerChanged
        || (input.providerId !== undefined && !companion.model_id)
          ? { modelId }
          : {}
      ),
      ...(selectedSkillIds !== undefined ? { selectedSkillIds } : {}),
      ...(skillsChanged
        ? {
            skillsRevision: sql`${schema.companions.skillsRevision} + 1`,
            skillsLastError: null,
          }
        : {}),
      ...(input.canWriteSkills !== undefined ? { canWriteSkills: input.canWriteSkills } : {}),
      ...(selectedMcpAccountIds !== undefined ? { selectedMcpAccountIds } : {}),
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
      model: input.modelId !== undefined || providerChanged,
      selected_skills: selectedSkillIds !== undefined,
      can_write_skills: input.canWriteSkills !== undefined,
      selected_mcp_accounts: selectedMcpAccountIds !== undefined,
    },
  });
  return toCompanion(row, companion.access, memberFromCompanion(companion));
}

/**
 * Companions that have selected a skill and currently look Online, so a Skills Hub publish can
 * push the new package onto the Box without recreating it. Asleep Companions pick it up on wake.
 */
export async function listOnlineCompanionsForSkillSync(input: {
  orgId: string;
  skillId: string;
  database?: Db;
}): Promise<Array<{ id: string; ownerId: string; boxId: string }>> {
  const database = input.database ?? db;
  const rows = await database
    .select({
      id: schema.companions.id,
      ownerId: schema.companions.ownerId,
      boxId: schema.companions.boxId,
      selectedSkillIds: schema.companions.selectedSkillIds,
      runtimeState: schema.companions.runtimeState,
      daemonState: schema.companions.daemonState,
    })
    .from(schema.companions)
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.runtimeState, "running"),
      eq(schema.companions.daemonState, "running"),
    ));
  return rows
    .filter((row) =>
      !!row.boxId
      && Array.isArray(row.selectedSkillIds)
      && row.selectedSkillIds.includes(input.skillId))
    .map((row) => ({ id: row.id, ownerId: row.ownerId, boxId: row.boxId! }));
}

/**
 * Mark every Companion selecting this skill as needing a restage — including asleep ones, which is
 * what makes "published while the Box slept" honestly read as pending until the next wake. One
 * org-scoped UPDATE; the jsonb containment matches the exact skill id inside selected_skill_ids.
 */
export async function bumpCompanionSkillsRevisionForSkill(input: {
  orgId: string;
  skillId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  // `updatedAt` is deliberately left alone: it orders other members' conversation lists and feeds
  // the stale-claim recovery clock, and a background publish must not reshuffle either.
  await database
    .update(schema.companions)
    .set({
      skillsRevision: sql`${schema.companions.skillsRevision} + 1`,
      skillsLastError: null,
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      sql`${schema.companions.selectedSkillIds} @> jsonb_build_array(${input.skillId}::text)`,
    ));
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
      // A deletion lock must never retain either archive-wake marker. `unknown` is deliberately
      // distinct from `starting` (automatic continuation) and `stopped` (explicit Wake allowed),
      // so the Owner's delete remains authoritative while the route archives the Box.
      daemonState: "unknown",
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
      eq(schema.companions.runtimeState, companion.runtime.state),
      eq(schema.companions.daemonState, companion.runtime.daemon_state),
    ))
    .returning();
  if (!row) {
    throw new CompanionRuntimeTransitionError("Companion deletion state changed; retry");
  }
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
      reasoning: schema.companionTranscriptEntries.reasoning,
      tool: schema.companionTranscriptEntries.tool,
      decision: schema.companionTranscriptEntries.decision,
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
    reasoning: row.reasoning ?? null,
    author_id: row.authorId,
    author_name: row.authorName,
    tool: row.tool ?? null,
    decision: row.decision ?? null,
    created_at: row.createdAt.toISOString(),
  }));
}

function toThread(input: {
  actor: ActorContext;
  companion: Companion;
  row: CompanionThreadRow | undefined;
  entries: CompanionTranscriptEntry[];
  lastReadOrdinal?: number | null;
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
    accepted_delivery_ordinal: input.row?.acceptedDeliveryOrdinal ?? null,
    last_message_at: input.row?.lastMessageAt?.toISOString()
      ?? input.entries.at(-1)?.created_at
      ?? null,
    last_read_ordinal: input.lastReadOrdinal ?? null,
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
  const [row, entries, states] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
    // Read where this member left off before the read below advances it: that watermark is the only
    // thing that can say where their unread run starts, and opening the thread is what clears it.
    loadMemberStates(database, input.orgId, input.actor.id, [input.companionId]),
  ]);
  const lastReadOrdinal = states.get(input.companionId)?.lastReadOrdinal ?? null;
  await markCompanionThreadRead({ ...input, database });
  return toThread({ actor: input.actor, companion, row, entries, lastReadOrdinal });
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
  await markCompanionThreadRead({
    actor: input.actor,
    orgId: input.orgId,
    companionId: input.companionId,
    database,
  });
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
  /**
   * The pending tail follows a timed-out tool with no evidence that Pi began a later turn. Pi may
   * still be blocked inside the aborted tool even though its FIFO accepts more follow-ups, so
   * delivery must begin on a fresh Pi process rather than watermarking another command behind the
   * dead turn.
   */
  timeoutRecoveryPending: boolean;
  /** The unresolved timeout still needs its one Pi-only recycle before delivery. */
  timeoutRestartPending: boolean;
  /** Timed-out tool ordinal whose one-shot Pi recycle is still required. */
  timeoutRecoveryOrdinal: number | null;
}> {
  const database = input.database ?? db;
  await getCompanionForRuntime({ ...input, database });
  const [row, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  const deliveredOrdinal = row?.deliveredOrdinal ?? null;
  const latestStartedTurnOrdinal = entries.reduce((latest, entry) => {
    const provesTurnStarted = entry.role === "assistant"
      || entry.role === "decision"
      || (entry.role === "tool" && entry.tool?.status !== "timeout");
    return provesTurnStarted ? Math.max(latest, entry.ordinal) : latest;
  }, -1);
  const latestTimeoutOrdinal = entries.reduce((latest, entry) =>
    entry.role === "tool" && entry.tool?.status === "timeout"
      ? Math.max(latest, entry.ordinal)
      : latest, -1);
  const timeoutRestartOrdinal = row?.timeoutRestartOrdinal ?? -1;
  const timeoutDeliveryOrdinal = row?.timeoutDeliveryOrdinal ?? -1;
  const acceptedDeliveryOrdinal = row?.acceptedDeliveryOrdinal ?? -1;
  const protectedTailStart = Math.max(latestTimeoutOrdinal, timeoutDeliveryOrdinal);
  // Only the correlated acceptance that was recorded together with this timeout boundary retires
  // recovery. An ordinary accepted follow-up can precede a still-running tool that later times out;
  // using that generic acceptance would misclassify the newly abandoned turn as healthy.
  const timeoutRecoveryAccepted = timeoutDeliveryOrdinal > latestTimeoutOrdinal
    && acceptedDeliveryOrdinal >= timeoutDeliveryOrdinal;
  const timeoutRecoveryOrdinal = latestTimeoutOrdinal > latestStartedTurnOrdinal
    && !timeoutRecoveryAccepted
    && entries.some((entry) => entry.role === "user" && entry.ordinal > protectedTailStart)
    ? latestTimeoutOrdinal
    : null;
  // Until the fresh Pi process records its own delivery progress, its post-timeout tail stays
  // pending regardless of the ordinary delivery watermark. A concurrent or pre-deploy writer can
  // advance that watermark after settlement rewinds it; treating the watermark as proof here would
  // silently lose the same tail this recovery boundary exists to protect.
  const pending = entries.filter((entry) => entry.role === "user" && (
    deliveredOrdinal === null
    || entry.ordinal > deliveredOrdinal
    || (timeoutRecoveryOrdinal !== null && entry.ordinal > protectedTailStart)
  ));
  return {
    pending,
    piLogOffset: row?.piLogOffset ?? 0,
    deliveredOrdinal,
    timeoutRecoveryPending: timeoutRecoveryOrdinal !== null,
    timeoutRestartPending: timeoutRecoveryOrdinal !== null
      && latestTimeoutOrdinal > timeoutRestartOrdinal,
    timeoutRecoveryOrdinal,
  };
}

/**
 * Remember that delivery after one timed-out tool reached a fresh Pi process. This is written only
 * after the Pi-only restart returned running, before its pending tail is handed over. If delivery
 * later fails, retrying on that same fresh process remains safe; a newer timeout can still advance
 * the marker and require its own recycle.
 */
export async function recordCompanionTimeoutRestart(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  timeoutOrdinal: number;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await getCompanionForRuntime({ ...input, database });
  const [updated] = await database
    .update(schema.companionThreads)
    .set({
      timeoutRestartOrdinal: sql`greatest(
        coalesce(${schema.companionThreads.timeoutRestartOrdinal}, -1),
        ${input.timeoutOrdinal}
      )`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(schema.companionThreads.orgId, input.orgId),
      eq(schema.companionThreads.companionId, input.companionId),
    ))
    .returning({ companionId: schema.companionThreads.companionId });
  if (!updated) throw new CompanionNotFoundError();
}

/**
 * Claim the one per-Companion delivery lease shared with the reconciler. The caller already passed
 * runtime authorization; the database function repeats that tenant/editor boundary and performs the
 * conditional upsert that makes overlapping sends and syncs mutually exclusive.
 */
export async function claimCompanionDelivery(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  claimId: string;
  leaseSeconds?: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  await getCompanionForRuntime({ ...input, database });
  const result = await database.execute(sql`
    select public.companion_claim_delivery_lease(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.claimId}::uuid,
      ${input.leaseSeconds ?? 600}::integer
    ) as claimed
  `);
  const [row] = Array.from(result as unknown as Iterable<{ claimed: boolean }>);
  return row?.claimed ?? false;
}

/** Release only the delivery lease carrying this request's unguessable claim id. */
export async function releaseCompanionDelivery(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  claimId: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select public.companion_release_delivery_lease(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.claimId}::uuid
    ) as released
  `);
  const [row] = Array.from(result as unknown as Iterable<{ released: boolean }>);
  return row?.released ?? false;
}

/** Extend only an unexpired delivery lease still carrying this request's exact claim id. */
export async function renewCompanionDelivery(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  claimId: string;
  leaseSeconds?: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select public.companion_renew_delivery_lease(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.claimId}::uuid,
      ${input.leaseSeconds ?? 600}::integer
    ) as renewed
  `);
  const [row] = Array.from(result as unknown as Iterable<{ renewed: boolean }>);
  return row?.renewed ?? false;
}

/**
 * Advance delivery only while the exact live lease still owns this turn. The database locks the
 * lease through the watermark update, so an expired producer cannot commit after its replacement
 * has claimed and resent the same durable message.
 */
export async function acceptCompanionDelivery(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  claimId: string;
  deliveredOrdinal: number;
  timeoutDeliveryOrdinal?: number;
  database?: Db;
}): Promise<CompanionThread | null> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select public.companion_accept_delivery_lease(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.claimId}::uuid,
      ${input.deliveredOrdinal}::integer,
      ${input.timeoutDeliveryOrdinal ?? null}::integer
    ) as accepted
  `);
  const [accepted] = Array.from(result as unknown as Iterable<{ accepted: boolean }>);
  if (!accepted?.accepted) return null;
  const companion = await getCompanionForRuntime({ ...input, database });
  const [row, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  return toThread({ actor: input.actor, companion, row, entries });
}

type CompanionStoredToolRun = NonNullable<
  typeof schema.companionTranscriptEntries.$inferSelect["tool"]
>;

export interface CompanionSettledToolRun {
  eventId: string;
  kind: CompanionStoredToolRun["kind"];
}

/** Tool entries whose chip is still spinning, oldest first: the queue a result is matched against. */
async function readRunningCompanionToolRuns(
  database: Db,
  orgId: string,
  companionId: string,
): Promise<Array<{
  eventId: string;
  ordinal: number;
  tool: CompanionStoredToolRun;
  createdAt: Date;
}>> {
  const rows = await database
    .select({
      eventId: schema.companionTranscriptEntries.eventId,
      ordinal: schema.companionTranscriptEntries.ordinal,
      tool: schema.companionTranscriptEntries.tool,
      createdAt: schema.companionTranscriptEntries.createdAt,
    })
    .from(schema.companionTranscriptEntries)
    .where(and(
      eq(schema.companionTranscriptEntries.orgId, orgId),
      eq(schema.companionTranscriptEntries.companionId, companionId),
      eq(schema.companionTranscriptEntries.role, "tool"),
      sql`${schema.companionTranscriptEntries.tool}->>'status' = 'running'`,
    ))
    .orderBy(asc(schema.companionTranscriptEntries.ordinal));
  return rows.flatMap((row) => (row.tool
    ? [{
      eventId: row.eventId,
      ordinal: row.ordinal,
      tool: row.tool,
      createdAt: row.createdAt,
    }]
    : []));
}

/** Write the results Pi reported onto the chips still running for them. */
async function completeCompanionToolRuns(input: {
  database: Db;
  orgId: string;
  companionId: string;
  completions: CompanionPiToolCompletion[];
}): Promise<CompanionSettledToolRun[]> {
  if (!input.completions.length) return [];
  const open = await readRunningCompanionToolRuns(
    input.database,
    input.orgId,
    input.companionId,
  );
  const settled = matchCompanionToolCompletions(open, input.completions);
  const completed: CompanionSettledToolRun[] = [];
  for (const run of settled) {
    const updated = await input.database
      .update(schema.companionTranscriptEntries)
      .set({ tool: run.tool })
      .where(and(
        eq(schema.companionTranscriptEntries.orgId, input.orgId),
        eq(schema.companionTranscriptEntries.companionId, input.companionId),
        eq(schema.companionTranscriptEntries.eventId, run.eventId),
        sql`${schema.companionTranscriptEntries.tool}->>'status' = 'running'`,
      ))
      .returning({ eventId: schema.companionTranscriptEntries.eventId });
    if (updated.length) {
      const source = open.find((entry) => entry.eventId === run.eventId);
      if (source) completed.push({ eventId: run.eventId, kind: source.tool.kind });
    }
  }
  return completed;
}

function positiveMsEnv(value: string | undefined, fallback: number): number {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Deadline for a non-shell tool result, env-overridable so operators can tune without a deploy. */
export function companionToolRunTimeoutMs(env: NodeJS.ProcessEnv): number {
  return positiveMsEnv(env.COMPANION_TOOL_RUN_TIMEOUT_MS, COMPANION_TOOL_RUN_TIMEOUT_MS);
}

/** Deadline for a shell run: builds and test sweeps legitimately outlive the default ceiling. */
export function companionExecToolRunTimeoutMs(env: NodeJS.ProcessEnv): number {
  return positiveMsEnv(env.COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS, COMPANION_EXEC_TOOL_RUN_TIMEOUT_MS);
}

/**
 * Fail closed any tool result Pi has owed for too long. This changes only the durable transcript
 * projection. The staged Pi extension owns cancellation of the active operation, so this operation
 * never sends an unscoped FIFO abort and never changes Box lifecycle state.
 */
export async function expireCompanionToolRuns(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  now?: Date;
  database?: Db;
}): Promise<{
  thread: CompanionThread;
  timedOut: CompanionSettledToolRun[];
}> {
  const database = input.database ?? db;
  // Settlement is transcript-only and is safe for read-only viewers to trigger. It must not inherit
  // runtime authorization because the viewer fallback is precisely where a Box must not be touched.
  const companion = await getCompanion({ ...input, database });
  // The narrow definer lets a read-only Viewer trigger deadline housekeeping without receiving
  // general transcript/thread write access under FORCE RLS. It also assesses timeout rows written
  // by older versions once, so #305-era tails are recovered without repeated prompts.
  const expiredResult = await database.execute(sql`
    select * from public.companion_expire_tool_runs(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${(input.now ?? new Date()).toISOString()}::timestamp with time zone,
      ${Math.round(companionToolRunTimeoutMs(process.env) / 1000)}::integer,
      ${Math.round(companionExecToolRunTimeoutMs(process.env) / 1000)}::integer
    )
  `);
  const expired = Array.from(expiredResult as unknown as Iterable<{
    event_id: string;
    kind: CompanionStoredToolRun["kind"];
  }>);
  const timedOut = expired.map((run) => ({ eventId: run.event_id, kind: run.kind }));
  const [row, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  return {
    thread: toThread({ actor: input.actor, companion, row, entries }),
    timedOut,
  };
}

/**
 * Attach one Box desktop frame to a finished run. It is written only while the run still has no
 * frame, so a retried sync cannot replace the picture of the desktop as the run left it with a
 * picture of whatever is on screen now.
 */
export async function attachCompanionToolRunScreenshot(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  eventId: string;
  screenshot: string;
  database?: Db;
}): Promise<CompanionThread> {
  const database = input.database ?? db;
  const companion = await getCompanionForRuntime({ ...input, database });
  await database
    .update(schema.companionTranscriptEntries)
    .set({
      tool: sql`jsonb_set(${schema.companionTranscriptEntries.tool}, '{screenshot}', to_jsonb(${input.screenshot}::text))`,
    })
    .where(and(
      eq(schema.companionTranscriptEntries.orgId, input.orgId),
      eq(schema.companionTranscriptEntries.companionId, input.companionId),
      eq(schema.companionTranscriptEntries.eventId, input.eventId),
      eq(schema.companionTranscriptEntries.role, "tool"),
      sql`${schema.companionTranscriptEntries.tool}->>'screenshot' is null`,
    ));
  const [row, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  return toThread({ actor: input.actor, companion, row, entries });
}

interface RecordCompanionPiProjectionInput {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  entries: CompanionPiEntry[];
  /** Results for runs this projection — or an earlier one — already stored as running chips. */
  toolCompletions?: CompanionPiToolCompletion[];
  piLogOffset?: number;
  /** Set when the caller reread a shrunken log from its start, so the offset may move backwards. */
  piLogRewound?: boolean;
  deliveredOrdinal?: number;
  /** Highest user message whose correlated protocol-2 prompt response was successful. */
  acceptedDeliveryOrdinal?: number;
  /** Highest post-timeout user message this fresh Pi process actually accepted. */
  timeoutDeliveryOrdinal?: number;
  database?: Db;
}

export interface CompanionPiProjectionResult {
  thread: CompanionThread;
  /** Runs this call actually changed from running to a Pi-reported terminal result. */
  settledToolRuns: CompanionSettledToolRun[];
}

async function recordCompanionPiProjectionResult(
  input: RecordCompanionPiProjectionInput,
): Promise<CompanionPiProjectionResult> {
  const database = input.database ?? db;
  const companion = await getCompanionForRuntime({ ...input, database });
  if (input.entries.length) {
    const ordinal = await allocateThreadOrdinals({
      database,
      orgId: input.orgId,
      companionId: input.companionId,
      count: input.entries.length,
      lastMessageAt: input.entries.length ? new Date() : undefined,
    });
    // Rows deliberately take the database clock, not Pi's `entry.createdAt`: tool-run deadlines are
    // measured against `created_at` in PostgreSQL, and a skewed Box clock would move them both ways.
    // Ordering is owned by `ordinal`, so the projection timestamp only has to be honest, not Pi's.
    await database
      .insert(schema.companionTranscriptEntries)
      .values(input.entries.map((entry, index) => ({
        orgId: input.orgId,
        companionId: input.companionId,
        eventId: entry.eventId,
        ordinal: ordinal + index,
        role: entry.role,
        content: entry.content,
        reasoning: entry.reasoning ?? null,
        tool: entry.tool ?? null,
        decision: entry.decision ?? null,
      })))
      .onConflictDoNothing();
  }
  // Results are applied after the inserts above, so a call and its result arriving in one chunk
  // settle in that one sync instead of leaving a chip spinning until the next one.
  const settledToolRuns = await completeCompanionToolRuns({
    database,
    orgId: input.orgId,
    companionId: input.companionId,
    completions: input.toolCompletions ?? [],
  });
  if (input.piLogOffset !== undefined
    || input.deliveredOrdinal !== undefined
    || input.acceptedDeliveryOrdinal !== undefined
    || input.timeoutDeliveryOrdinal !== undefined) {
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
        ...(input.acceptedDeliveryOrdinal !== undefined
          ? { acceptedDeliveryOrdinal: sql`greatest(coalesce(${schema.companionThreads.acceptedDeliveryOrdinal}, -1), ${input.acceptedDeliveryOrdinal})` }
          : {}),
        ...(input.timeoutDeliveryOrdinal !== undefined
          ? { timeoutDeliveryOrdinal: sql`greatest(coalesce(${schema.companionThreads.timeoutDeliveryOrdinal}, -1), ${input.timeoutDeliveryOrdinal})` }
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
  return {
    thread: toThread({ actor: input.actor, companion, row, entries }),
    settledToolRuns,
  };
}

/**
 * Append entries projected from the Pi RPC log and advance both watermarks. Pi is authoritative
 * while it runs; this idempotent sink only mirrors what it already produced and never wakes Box.
 */
export async function recordCompanionPiProjection(
  input: RecordCompanionPiProjectionInput,
): Promise<CompanionThread> {
  return (await recordCompanionPiProjectionResult(input)).thread;
}

/** The same projection plus the exact run ids this call settled, for run-local frame capture. */
export async function recordCompanionPiProjectionWithEffects(
  input: RecordCompanionPiProjectionInput,
): Promise<CompanionPiProjectionResult> {
  return recordCompanionPiProjectionResult(input);
}

/** What the Box FIFO must receive so Pi unblocks a pending extension UI dialog. */
export type CompanionExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; cancelled: true };

function extensionUiResponseFor(
  decision: CompanionDecision,
  action: DecideCompanionDecisionInput["action"] | "expire",
  answer?: string,
): CompanionExtensionUiResponse {
  if (decision.kind === "question") {
    if (action === "answer" && answer) {
      return { type: "extension_ui_response", id: decision.request_id, value: answer };
    }
    return { type: "extension_ui_response", id: decision.request_id, cancelled: true };
  }
  if (action === "allow") {
    return { type: "extension_ui_response", id: decision.request_id, confirmed: true };
  }
  return { type: "extension_ui_response", id: decision.request_id, confirmed: false };
}

function settleDecision(
  current: CompanionDecision,
  next: Pick<CompanionDecision, "status" | "answer"> & {
    decided_by_id: string | null;
    decided_by_name: string | null;
    decided_at: string;
  },
): CompanionDecision {
  return {
    ...current,
    status: next.status,
    answer: next.answer,
    decided_by_id: next.decided_by_id,
    decided_by_name: next.decided_by_name,
    decided_at: next.decided_at,
  };
}

/**
 * Expire pending permission cards whose timeout has passed. Fail-closed: each expired card becomes
 * a Deny (or a cancelled question), and the caller writes the matching FIFO response so Pi unblocks.
 */
export async function expireCompanionDecisions(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  now?: Date;
  database?: Db;
}): Promise<{
  thread: CompanionThread;
  responses: CompanionExtensionUiResponse[];
}> {
  const database = input.database ?? db;
  const companion = await getCompanion({ ...input, database });
  const responses = await settleExpiredCompanionDecisions({ ...input, database });
  const [threadRow, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  return {
    thread: toThread({ actor: input.actor, companion, row: threadRow, entries }),
    responses,
  };
}

/**
 * The settlement half alone: flip pending cards past their deadline to `expired` and return the
 * FIFO cancellations. The hot read paths call this — they already read the thread themselves, and
 * rebuilding a full transcript per poll tick just to discard it tripled the read cost of a poll.
 */
export async function settleExpiredCompanionDecisions(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  now?: Date;
  database?: Db;
}): Promise<CompanionExtensionUiResponse[]> {
  const database = input.database ?? db;
  // Expiry is deadline housekeeping, not a decision: like expireCompanionToolRuns it must be safe
  // to trigger from any thread read. A Viewer's session still cannot write the settlement rows —
  // RLS admits only Owner/Editor updates — so for them the sweep is a no-op, never an error.
  await getCompanion({ ...input, database });
  const now = input.now ?? new Date();
  const pending = await database
    .select({
      eventId: schema.companionTranscriptEntries.eventId,
      decision: schema.companionTranscriptEntries.decision,
    })
    .from(schema.companionTranscriptEntries)
    .where(and(
      eq(schema.companionTranscriptEntries.orgId, input.orgId),
      eq(schema.companionTranscriptEntries.companionId, input.companionId),
      eq(schema.companionTranscriptEntries.role, "decision"),
      sql`${schema.companionTranscriptEntries.decision}->>'status' = 'pending'`,
      sql`(${schema.companionTranscriptEntries.decision}->>'expires_at')::timestamptz <= ${now.toISOString()}::timestamptz`,
    ));
  const responses: CompanionExtensionUiResponse[] = [];
  for (const row of pending) {
    if (!row.decision) continue;
    const settled = settleDecision(row.decision, {
      status: "expired",
      answer: null,
      decided_by_id: null,
      decided_by_name: null,
      decided_at: now.toISOString(),
    });
    await database
      .update(schema.companionTranscriptEntries)
      .set({
        decision: settled,
        content: settled.title,
      })
      .where(and(
        eq(schema.companionTranscriptEntries.orgId, input.orgId),
        eq(schema.companionTranscriptEntries.companionId, input.companionId),
        eq(schema.companionTranscriptEntries.eventId, row.eventId),
        sql`${schema.companionTranscriptEntries.decision}->>'status' = 'pending'`,
      ));
    responses.push(extensionUiResponseFor(row.decision, "expire"));
  }
  return responses;
}

/**
 * Allow, Deny, or answer a pending permission card. Owner/Editor only; Viewers are refused by
 * `getCompanionForRuntime` before any row is touched. The returned FIFO payload is what unblocks Pi.
 */
export async function decideCompanionDecision(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  requestId: string;
  decision: DecideCompanionDecisionInput;
  now?: Date;
  database?: Db;
}): Promise<{
  thread: CompanionThread;
  response: CompanionExtensionUiResponse;
}> {
  const database = input.database ?? db;
  const companion = await getCompanionForRuntime({ ...input, database });
  const now = input.now ?? new Date();
  const eventId = `decision:${input.requestId}`.slice(0, 200);
  const [row] = await database
    .select({
      eventId: schema.companionTranscriptEntries.eventId,
      decision: schema.companionTranscriptEntries.decision,
    })
    .from(schema.companionTranscriptEntries)
    .where(and(
      eq(schema.companionTranscriptEntries.orgId, input.orgId),
      eq(schema.companionTranscriptEntries.companionId, input.companionId),
      eq(schema.companionTranscriptEntries.eventId, eventId),
      eq(schema.companionTranscriptEntries.role, "decision"),
    ))
    .limit(1);
  if (!row?.decision) throw new CompanionDecisionNotFoundError();
  if (row.decision.status !== "pending") throw new CompanionDecisionConflictError();
  if (Date.parse(row.decision.expires_at) <= now.getTime()) {
    throw new CompanionDecisionConflictError("companion permission request expired");
  }

  const action = input.decision.action;
  if (row.decision.kind === "question") {
    if (action === "allow") {
      throw new CompanionDecisionConflictError("question cards require an answer or deny");
    }
  } else if (action === "answer") {
    throw new CompanionDecisionConflictError("shell and file cards accept allow or deny only");
  }

  const answer = action === "answer" ? input.decision.answer : null;
  const status = action === "allow"
    ? "allowed" as const
    : action === "answer"
      ? "answered" as const
      : "denied" as const;
  const settled = settleDecision(row.decision, {
    status,
    answer,
    decided_by_id: input.actor.id,
    decided_by_name: input.actor.name || input.actor.email,
    decided_at: now.toISOString(),
  });
  const updated = await database
    .update(schema.companionTranscriptEntries)
    .set({
      decision: settled,
      content: settled.title,
    })
    .where(and(
      eq(schema.companionTranscriptEntries.orgId, input.orgId),
      eq(schema.companionTranscriptEntries.companionId, input.companionId),
      eq(schema.companionTranscriptEntries.eventId, eventId),
      sql`${schema.companionTranscriptEntries.decision}->>'status' = 'pending'`,
    ))
    .returning({ eventId: schema.companionTranscriptEntries.eventId });
  if (!updated.length) throw new CompanionDecisionConflictError();

  const [threadRow, entries] = await Promise.all([
    readCompanionThreadRow(database, input.orgId, input.companionId),
    readCompanionTranscript(database, input.orgId, input.companionId),
  ]);
  return {
    thread: toThread({ actor: input.actor, companion, row: threadRow, entries }),
    response: extensionUiResponseFor(row.decision, action, answer ?? undefined),
  };
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
  /** Callback-only OAuth grant. The public token/header route never accepts this field. */
  oauthCredential?: CompanionPluginStoredOAuthCredential;
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
    value: JSON.stringify(input.oauthCredential ?? credentials),
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

/** Complete a brokered OAuth callback through the same encrypted account insert as THE-321. */
export async function saveCompanionOAuthPlugin(input: {
  actor: ActorContext;
  orgId: string;
  provider: string;
  label: string;
  remoteUrl: string;
  credential: CompanionPluginStoredOAuthCredential;
  masterKey?: Buffer;
  database?: Db;
}): Promise<CompanionPluginAccount> {
  return saveCompanionPlugin({
    actor: input.actor,
    orgId: input.orgId,
    plugin: {
      provider: input.provider,
      label: input.label,
      transport: "http",
      url: input.remoteUrl,
      args: [],
      credential_name: "Authorization",
      credential_value: `Bearer ${input.credential.accessToken}`,
    },
    oauthCredential: input.credential,
    masterKey: input.masterKey,
    database: input.database,
  });
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
 * Resolve the Companion's attached MCP accounts after Owner/Editor runtime authorization.
 * Only `selected_mcp_account_ids` are staged; empty means no member MCP pins (adapter binary only).
 * Accounts owned by the waking member or the Companion owner may be included so an Editor wake
 * still receives the Owner's attached connectors. Detach never deletes the member connection.
 * The caller passes the resulting values straight to THE-325's transient environment channel.
 */
export async function resolveCompanionPluginInjection(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  masterKey?: Buffer;
  database?: Db;
  fetchImpl?: typeof fetch;
}): Promise<{ accounts: CompanionMcpAccount[]; credentials: CompanionMcpCredential[] }> {
  const database = input.database ?? db;
  const companion = await getCompanionForRuntime({ ...input, database });
  const selected = companion.selected_mcp_account_ids;
  if (!selected.length) return { accounts: [], credentials: [] };

  const rows = await database
    .select()
    .from(schema.companionMcpAccounts)
    .where(and(
      eq(schema.companionMcpAccounts.orgId, input.orgId),
      inArray(schema.companionMcpAccounts.id, selected),
      // Member-private accounts: waking actor's own connections, or the Companion owner's
      // attached set so an Editor wake keeps Owner-selected pins (mirrors personal skills).
      or(
        eq(schema.companionMcpAccounts.ownerId, input.actor.id),
        eq(schema.companionMcpAccounts.ownerId, companion.owner_id),
      ),
    ));
  const order = new Map(selected.map((id, index) => [id, index]));
  rows.sort((left, right) => (order.get(left.id) ?? 0) - (order.get(right.id) ?? 0));
  const accounts: CompanionMcpAccount[] = [];
  const credentials: CompanionMcpCredential[] = [];
  for (const row of rows) {
    try {
      const account = companionMcpAccountSchema.parse(row.accountConfig);
      accounts.push(account);
      const plaintext = decryptOpaqueValue({
        orgId: input.orgId,
        purpose: MCP_CREDENTIAL_PURPOSE,
        subjectId: `${row.id}:${row.credentialGeneration}`,
        ...mcpCiphertext(row),
      }, input.masterKey);
      const parsed = JSON.parse(plaintext);
      if (Array.isArray(parsed)) {
        credentials.push(...parsed.map((value) => companionMcpCredentialSchema.parse(value)));
        continue;
      }
      const oauth = parsed as CompanionPluginStoredOAuthCredential;
      if (
        oauth?.kind !== "oauth"
        || oauth.version !== 1
        || !(oauth.serverName in COMPANION_PLUGIN_OAUTH_SERVERS)
        || typeof oauth.accessToken !== "string"
        || !oauth.accessToken
        || typeof oauth.tokenEndpoint !== "string"
        || typeof oauth.resource !== "string"
        || !oauth.client
      ) {
        throw new Error("invalid MCP OAuth credential payload");
      }
      let active = oauth;
      const expiresAt = active.accessExpiresAt ? new Date(active.accessExpiresAt).getTime() : null;
      if (expiresAt !== null && expiresAt <= Date.now() + OAUTH_REFRESH_SKEW_MS) {
        active = await refreshCompanionPluginOAuth({
          credential: active,
          fetchImpl: input.fetchImpl,
        });
        const generation = randomUUID();
        const encrypted = encryptOpaqueValue({
          orgId: input.orgId,
          purpose: MCP_CREDENTIAL_PURPOSE,
          subjectId: `${row.id}:${generation}`,
          value: JSON.stringify(active),
        }, input.masterKey);
        const [updated] = await database
          .update(schema.companionMcpAccounts)
          .set({ credentialGeneration: generation, ...encrypted, updatedAt: new Date() })
          .where(and(
            eq(schema.companionMcpAccounts.orgId, input.orgId),
            eq(schema.companionMcpAccounts.ownerId, row.ownerId),
            eq(schema.companionMcpAccounts.id, row.id),
            eq(schema.companionMcpAccounts.credentialGeneration, row.credentialGeneration),
          ))
          .returning({ id: schema.companionMcpAccounts.id });
        if (!updated) {
          throw new CompanionProviderError(
            "provider_unavailable",
            `Authentication for ${row.provider} (${row.label}) changed while refreshing. Try again.`,
          );
        }
      }
      const envKey = account.transport === "http"
        ? Object.values(account.headers)[0]
        : undefined;
      credentials.push(companionMcpCredentialSchema.parse({
        env_key: envKey,
        value: `Bearer ${active.accessToken}`,
      }));
    } catch (error) {
      if (error instanceof CompanionProviderError) throw error;
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
  providerCatalog?: CompanionProviderDefinition[];
  database?: Db;
}): Promise<CompanionProvidersResponse> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  const [org, connections, catalog] = await Promise.all([
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
    input.providerCatalog ?? getCompanionProviderCatalog(),
  ]);
  return {
    catalog,
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
  providerCatalog?: CompanionProviderDefinition[];
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
  const modelId = companionCatalogModel(
    input.providerCatalog ?? await getCompanionProviderCatalog(),
    input.providerId,
  );
  if (!modelId) {
    throw new CompanionProviderError(
      "provider_model_invalid",
      `No model is available for ${providerName(input.providerId)}.`,
      input.providerId,
    );
  }
  const [row] = await database
    .update(schema.companions)
    .set({
      providerIds: [input.providerId],
      modelId,
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
  return toCompanion(row, "owner", memberFromCompanion(companion));
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

/**
 * Read the selected workspace provider generation without decrypting its credential. Runtime callers
 * use this to decide whether an already-running Pi can safely stay on the prompt-only path.
 */
export async function getCompanionProviderCredentialGeneration(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database?: Db;
}): Promise<{ providerId: string | null; credentialGeneration: string | null }> {
  const database = input.database ?? db;
  const companion = await getCompanionForRuntime({ ...input, database });
  const providerId = companion.runtime.provider_ids[0] ?? null;
  if (!providerId) return { providerId: null, credentialGeneration: null };
  const row = await database.query.companionProviderConnections.findFirst({
    where: and(
      eq(schema.companionProviderConnections.orgId, input.orgId),
      eq(schema.companionProviderConnections.providerId, providerId),
    ),
    columns: { credentialGeneration: true },
  });
  return {
    providerId,
    credentialGeneration: row?.credentialGeneration ?? null,
  };
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
  withLastMessage?: boolean;
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
    /**
     * The skills revision the just-finished stage carried. Written monotonically and never above
     * the current desired revision, so a stage that raced a newer selection change stays pending.
     */
    skillsAppliedRevision?: number;
    skillsAppliedAt?: Date;
    /** Sanitized before it is stored. Null clears a stale line after a successful restage. */
    skillsLastError?: string | null;
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
      ...(input.patch.skillsAppliedRevision !== undefined
        ? {
            skillsAppliedRevision: sql`least(${schema.companions.skillsRevision}, greatest(${schema.companions.skillsAppliedRevision}, ${input.patch.skillsAppliedRevision}))`,
            skillsAppliedAt: input.patch.skillsAppliedAt ?? now,
          }
        : {}),
      ...(input.patch.skillsLastError !== undefined
        ? {
            skillsLastError: input.patch.skillsLastError
              ? sanitizeCompanionRuntimeError(input.patch.skillsLastError) || null
              : null,
          }
        : {}),
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
  return toCompanion(row, current.access, memberFromCompanion(current));
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
  if (row) return toCompanion(row, current.access, memberFromCompanion(current));
  return getCompanionForRuntime({ ...input, database });
}

export async function claimCompanionRuntimeStart(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  /** Resume an archive wait, except the `stopping`/`unknown` Owner-deletion lock. */
  allowArchiveResume?: boolean;
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
  if (row) return toCompanion(row, currentAccess.access, memberFromCompanion(currentAccess));

  const current = await getCompanionForRuntime({ ...input, database });
  const archiveResume = input.allowArchiveResume === true
    && current.runtime.state === "stopping"
    && (
      current.runtime.daemon_state === "starting"
      || current.runtime.daemon_state === "stopped"
    );
  const deletionLocked = current.runtime.state === "stopping"
    && current.runtime.daemon_state === "unknown";
  const transitional =
    current.runtime.state === "provisioning" || current.runtime.state === "stopping";
  const staleBefore = new Date(Date.now() - COMPANION_RUNTIME_CLAIM_STALE_MS);
  if (deletionLocked) {
    throw new CompanionRuntimeTransitionError("companion is being deleted");
  }
  if (!archiveResume && transitional && new Date(current.updated_at) >= staleBefore) {
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
      // An archive continuation uses this write as its atomic handoff. Advance the timestamp even
      // when two requests land inside the same driver millisecond so a later guarded finalizer cannot
      // mistake the winner's claim for the older waiting projection.
      updatedAt: archiveResume
        ? sql<Date>`greatest(
            clock_timestamp(),
            ${schema.companions.updatedAt} + interval '1 millisecond'
          )`
        : new Date(),
    })
    .where(and(
      eq(schema.companions.orgId, input.orgId),
      eq(schema.companions.id, input.companionId),
      eq(schema.companions.runtimeState, current.runtime.state),
      archiveResume ? eq(schema.companions.daemonState, current.runtime.daemon_state) : undefined,
      archiveResume
        ? eq(schema.companions.updatedAt, new Date(current.updated_at))
        : transitional ? lt(schema.companions.updatedAt, staleBefore) : undefined,
    ))
    .returning();
  if (!claimed) throw new CompanionRuntimeTransitionError("companion runtime state changed; retry");
  return toCompanion(claimed, current.access, memberFromCompanion(current));
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
  const deletionLocked = current.runtime.state === "stopping"
    && current.runtime.daemon_state === "unknown";
  if (deletionLocked) {
    throw new CompanionRuntimeTransitionError("companion is being deleted");
  }
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
      runtimeState: "stopping",
      // An explicit Stop cancels any stale auto-resume intent before contacting Box.
      daemonState: "stopped",
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
  return toCompanion(claimed, current.access, memberFromCompanion(current));
}

export type CompanionReconcileReason =
  | "stale_start"
  | "archive_resume"
  | "deletion_stuck"
  | "redelivery"
  | "liveness"
  | "expiry_sweep";

export interface CompanionReconcileCandidate {
  orgId: string;
  companionId: string;
  /** The Companion's owner; the worker runs every org-scoped service as this member. */
  owner: { id: string; email: string; name: string };
  reason: CompanionReconcileReason;
  boxId: string | null;
  attempts: number;
}

/**
 * Claim Companions that need reconciler attention, most urgent first. Worker-only: the SECURITY
 * DEFINER function is granted to the worker role alone and is cross-tenant by design — the lease
 * upsert inside it is what keeps two ticking workers on disjoint sets.
 */
export async function claimCompanionReconcileCandidates(input: {
  workerId: string;
  limit?: number;
  leaseSeconds?: number;
  database?: Db;
}): Promise<CompanionReconcileCandidate[]> {
  const database = input.database ?? db;
  // The sweep the claim leads to runs env-aware deadlines; the claim detects with the same ones so
  // an operator override cannot make the worker claim a run the sweep then refuses to expire.
  const result = await database.execute(sql`
    select * from public.companion_claim_reconcile_candidates(
      ${input.workerId},
      ${input.limit ?? 5}::integer,
      ${input.leaseSeconds ?? 300}::integer,
      ${Math.round(companionToolRunTimeoutMs(process.env) / 1000)}::integer,
      ${Math.round(companionExecToolRunTimeoutMs(process.env) / 1000)}::integer
    )
  `);
  const rows = Array.from(result as unknown as Iterable<{
    org_id: string;
    companion_id: string;
    owner_id: string;
    owner_email: string;
    owner_name: string | null;
    reason: CompanionReconcileReason;
    box_id: string | null;
    attempts: number;
  }>);
  return rows.map((row) => ({
    orgId: row.org_id,
    companionId: row.companion_id,
    owner: { id: row.owner_id, email: row.owner_email, name: row.owner_name ?? row.owner_email },
    reason: row.reason,
    boxId: row.box_id,
    attempts: row.attempts,
  }));
}

/**
 * Release one claimed lease. A positive backoff records a failed attempt and gates the Companion
 * until the moment passes; zero records success and clears the attempt counter. Returns false when
 * this worker no longer held the lease — a stale claim another worker has since taken over.
 */
export async function settleCompanionReconcileLease(input: {
  orgId: string;
  companionId: string;
  workerId: string;
  outcome: string;
  backoffSeconds?: number;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const result = await database.execute(sql`
    select public.companion_settle_reconcile_lease(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.workerId},
      ${input.outcome},
      ${input.backoffSeconds ?? 0}::integer
    ) as settled
  `);
  const [row] = Array.from(result as unknown as Iterable<{ settled: boolean }>);
  return row?.settled ?? false;
}
