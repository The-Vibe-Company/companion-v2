import { eq, sql } from "drizzle-orm";
import { z } from "zod";

import type {
  Companion,
  CompanionAccess,
  CompanionAttachmentUpload,
  CompanionClientSurface,
  CompanionOperation,
  CompanionOperationKind,
  CompanionShareRole,
  CompanionThread,
  CompanionTranscriptEntry,
  CompanionTurn,
} from "@companion/contracts";
import {
  companionAttachmentUploadSchema,
  companionDecisionProposalSchema,
  companionOperationSchema,
  companionSelectedMcpAccountIdsSchema,
  companionSelectedSkillIdsSchema,
  companionTranscriptEntrySchema,
  companionTurnSchema,
  type CompanionDecisionProposal,
} from "@companion/contracts";
import { schema, type Db } from "@companion/db";

import type { ActorContext } from "./services";
import {
  CompanionDecisionNotFoundError,
  CompanionDuplicateForbiddenError,
  CompanionProviderError,
  CompanionRuntimeTransitionError,
  CompanionSettingsForbiddenError,
  getCompanion,
  listCompanionShares,
  listCompanions,
} from "./companions";
import { companionCatalogModel, getCompanionProviderCatalog } from "./companionProviderCatalog";
import { COMPANION_SKILLS_SYNC_ERROR_VIEWER_MESSAGE } from "./companionRuntimeErrors";

function rows<T>(result: unknown): T[] {
  return Array.from(result as Iterable<T>);
}

function hasDatabaseErrorCode(error: unknown, expected: string): boolean {
  const seen = new Set<unknown>();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === expected) return true;
    current = "cause" in current ? current.cause : null;
  }
  return false;
}

function integer(value: number | string | bigint | null | undefined): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return 0;
}

function positiveInteger(value: number | string | bigint | null | undefined): number {
  const parsed = integer(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error("Companion runtime generation is invalid");
  }
  return parsed;
}

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type RuntimeReadRow = {
  access_role: CompanionAccess;
  generation: number | string | bigint;
  selected_skill_ids: unknown;
  selected_mcp_account_ids: unknown;
  box_id: string | null;
  box_state: "absent" | "initializing" | "provisioning" | "ready" | "idle" | "running"
    | "archiving" | "archived" | "error" | "unknown";
  pi_state: "absent" | "starting" | "idle" | "running" | "stopped" | "error" | "unknown";
  pi_invocation_id: string | null;
  disk_layout_version: number | string;
  desired_settings_revision: number | string | bigint;
  applied_settings_revision: number | string | bigint;
  applied_skills_revision: number | string;
  retirement_state: "active" | "requested" | "pending" | "blocked" | "retired";
  last_error_code: string | null;
  last_error_message: string | null;
  last_error_action: string | null;
  active_turn: unknown;
  queued_count: number | string;
  interrupted_turn: unknown;
  latest_operation: unknown;
  is_replying: boolean;
  last_observed_at?: Date | string | null;
};

export type CompanionRuntimeApiProjection = RuntimeReadRow;

function parseTurn(value: unknown): CompanionTurn | null {
  if (value === null || value === undefined) return null;
  return companionTurnSchema.parse(value);
}

function parseOperation(value: unknown): CompanionOperation | null {
  if (value === null || value === undefined) return null;
  return companionOperationSchema.parse(value);
}

function projectedOperation(
  operation: CompanionOperation | null,
  viewer: boolean,
): Companion["runtime"]["latest_operation"] {
  if (!operation) return null;
  return {
    id: operation.id,
    source_turn_id: operation.source_turn_id,
    kind: operation.kind,
    status: operation.status,
    error: operation.error
      ? viewer
        ? {
            code: "runtime_unavailable",
            message: "Companion runtime needs attention.",
            action: "none",
          }
        : operation.error
      : null,
  };
}

function projectedRuntimeState(
  row: RuntimeReadRow,
  latestOperation: CompanionOperation | null,
): Companion["runtime"]["state"] {
  if (row.retirement_state === "retired") return "stopped";
  if (["requested", "pending", "blocked"].includes(row.retirement_state)) return "stopping";

  if (latestOperation && ["pending", "running"].includes(latestOperation.status)) {
    if (["delete", "stop", "restart_box"].includes(latestOperation.kind)) return "stopping";
    return "provisioning";
  }

  if (
    row.box_state === "error"
    || row.pi_state === "error"
    || latestOperation?.status === "failed"
    || latestOperation?.status === "interrupted"
  ) return "error";

  if (row.box_state === "absent") {
    return latestOperation?.kind === "stop" && latestOperation.status === "succeeded"
      ? "stopped"
      : "not_created";
  }
  if (row.box_state === "archived") return "stopped";
  if (row.box_state === "archiving") return "stopping";
  if (row.box_state === "initializing" || row.box_state === "provisioning") return "provisioning";
  if (["ready", "idle", "running"].includes(row.box_state)) {
    return row.pi_state === "starting" || row.pi_state === "absent" ? "provisioning" : "running";
  }
  return row.last_error_code ? "error" : "not_created";
}

function projectedDaemonState(row: RuntimeReadRow): Companion["runtime"]["daemon_state"] {
  switch (row.pi_state) {
    case "starting": return "starting";
    case "idle":
    case "running": return "running";
    case "absent":
    case "stopped": return "stopped";
    case "error": return "error";
    default: return "unknown";
  }
}

export function projectCompanionRuntimeV2(
  companion: Companion,
  row: RuntimeReadRow,
): Companion {
  const latestOperation = parseOperation(row.latest_operation);
  const lastObservedAt = iso(row.last_observed_at) ?? companion.runtime.last_observed_at;
  const runnableBox = ["ready", "idle", "running"].includes(row.box_state);
  const operationError = latestOperation
    && ["failed", "interrupted"].includes(latestOperation.status)
    ? latestOperation.error
    : null;
  const runtimeError = operationError?.message ?? row.last_error_message;
  return {
    ...companion,
    selected_skill_ids: companionSelectedSkillIdsSchema.parse(row.selected_skill_ids),
    selected_mcp_account_ids: companionSelectedMcpAccountIdsSchema.parse(
      row.selected_mcp_account_ids,
    ),
    runtime: {
      ...companion.runtime,
      generation: positiveInteger(row.generation),
      state: projectedRuntimeState(row, latestOperation),
      daemon_state: projectedDaemonState(row),
      box_id: row.access_role === "viewer" ? null : row.box_id,
      disk_layout_version: integer(row.disk_layout_version),
      desktop_available: row.access_role !== "viewer" && row.box_id !== null && runnableBox,
      last_error: runtimeError
        ? row.access_role === "viewer"
          ? "Companion runtime needs attention."
          : runtimeError
        : null,
      skills_applied_revision: integer(row.applied_skills_revision),
      // Runtime v2 deliberately stores the monotonic revision, not an approximate timestamp. The
      // UI can say "up to date" without mislabeling a later health observation as the apply time.
      skills_applied_at: null,
      skills_last_error: companion.runtime.skills_last_error
        ? row.access_role === "viewer"
          ? COMPANION_SKILLS_SYNC_ERROR_VIEWER_MESSAGE
          : companion.runtime.skills_last_error
        : null,
      last_observed_at: lastObservedAt,
      latest_operation: projectedOperation(latestOperation, row.access_role === "viewer"),
    },
  };
}

export async function readCompanionRuntimeV2(input: {
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<RuntimeReadRow> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_read_runtime(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid
    )
  `);
  const [row] = rows<RuntimeReadRow>(result);
  if (!row) throw new Error("companion runtime projection is unavailable");
  return row;
}

export async function getCompanionV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  withLastMessage?: boolean;
  database: Db;
}): Promise<Companion> {
  const companion = await getCompanion(input);
  const runtime = await readCompanionRuntimeV2(input);
  return projectCompanionRuntimeV2(companion, runtime);
}

export async function listCompanionsV2(input: {
  actor: ActorContext;
  orgId: string;
  withLastMessage?: boolean;
  database: Db;
}): Promise<Companion[]> {
  const companions = await listCompanions(input);
  if (companions.length === 0) return [];
  const result = await input.database.execute(sql`
    select * from public.companion_api_list_runtime(${input.orgId}::uuid)
  `);
  const runtimes = new Map(rows<RuntimeReadRow & { companion_id: string }>(result).map(
    (runtime) => [runtime.companion_id, runtime] as const,
  ));
  return companions.map((companion) => {
    const runtime = runtimes.get(companion.id);
    if (!runtime) throw new Error("companion runtime projection is unavailable");
    return projectCompanionRuntimeV2(companion, runtime);
  });
}

export async function createCompanionV2(input: {
  actor: ActorContext;
  orgId: string;
  name: string;
  persona?: string;
  providerId?: string;
  modelId?: string;
  selectedSkillIds?: string[];
  selectedMcpAccountIds?: string[];
  sourceCompanionId?: string;
  database: Db;
}): Promise<Companion> {
  const org = await input.database.query.organizations.findFirst({
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
  const modelId = companionCatalogModel(
    await getCompanionProviderCatalog(),
    providerId,
    input.modelId,
  );
  if (!modelId) {
    throw new CompanionProviderError(
      "provider_model_invalid",
      "The selected model is not available for this provider.",
      providerId,
    );
  }
  // Skills Hub access is unconditional, and the legacy flag is pinned true to match the token the
  // Box receives. Nobody chooses this per Companion any more.
  const result = await input.database.execute(sql`
    select * from public.companion_api_create_companion(
      ${input.orgId}::uuid,
      ${input.name}::text,
      ${input.persona ?? null}::text,
      ${providerId}::text,
      ${modelId}::text,
      ${JSON.stringify(input.selectedSkillIds ?? [])}::jsonb,
      true::boolean,
      ${JSON.stringify(input.selectedMcpAccountIds ?? [])}::jsonb,
      ${input.sourceCompanionId ?? null}::uuid
    )
  `);
  const [created] = rows<{ companion_id: string }>(result);
  if (!created) throw new Error("failed to create Companion runtime projection");
  return getCompanionV2({ ...input, companionId: created.companion_id });
}

export async function updateCompanionV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  patch: Record<string, unknown>;
  database: Db;
}): Promise<Companion> {
  const patch = { ...input.patch };
  if ("provider_id" in patch || "model_id" in patch) {
    const current = await getCompanionV2(input);
    if (current.access === "viewer") throw new CompanionSettingsForbiddenError();
    const currentProviderId = current.runtime.provider_ids[0];
    const providerId = typeof patch.provider_id === "string" ? patch.provider_id : currentProviderId;
    const providerChanged = typeof patch.provider_id === "string" && patch.provider_id !== currentProviderId;
    const requestedModel = typeof patch.model_id === "string"
      ? patch.model_id
      : providerChanged || !current.model_id
        ? undefined
        : current.model_id;
    const modelId = providerId
      ? companionCatalogModel(await getCompanionProviderCatalog(), providerId, requestedModel)
      : undefined;
    if (!providerId || !modelId) {
      throw new CompanionProviderError(
        "provider_model_invalid",
        "The selected model is not available for this provider.",
        providerId ?? null,
      );
    }
    patch.model_id = modelId;
  }
  await input.database.execute(sql`
    select * from public.companion_api_update_companion(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${JSON.stringify(patch)}::jsonb
    )
  `);
  return getCompanionV2(input);
}

export async function setCompanionProviderV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  providerId: string;
  database: Db;
}): Promise<Companion> {
  const current = await getCompanionV2(input);
  if (current.access !== "owner") throw new CompanionSettingsForbiddenError();
  if (current.runtime.provider_ids.length > 0) {
    throw new CompanionRuntimeTransitionError(
      "this Companion already has a provider; create another Companion to use a different one",
    );
  }
  const modelId = companionCatalogModel(
    await getCompanionProviderCatalog(),
    input.providerId,
  );
  if (!modelId) {
    throw new CompanionProviderError(
      "provider_model_invalid",
      "The selected provider has no available model.",
      input.providerId,
    );
  }
  try {
    await input.database.execute(sql`
      select * from public.companion_api_set_initial_provider(
        ${input.orgId}::uuid,
        ${input.companionId}::uuid,
        ${input.providerId}::text,
        ${modelId}::text
      )
    `);
  } catch (error) {
    if (hasDatabaseErrorCode(error, "55000")) {
      throw new CompanionRuntimeTransitionError(
        "this Companion can no longer accept an initial provider; reload its settings",
      );
    }
    throw error;
  }
  return getCompanionV2(input);
}

export async function duplicateCompanionV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<Companion> {
  const source = await getCompanionV2(input);
  if (source.access !== "owner") throw new CompanionDuplicateForbiddenError();
  const providerId = source.runtime.provider_ids[0];
  if (!providerId || !source.model_id) {
    throw new CompanionProviderError(
      "provider_not_configured",
      "This Companion needs a connected provider and model before it can be duplicated.",
      providerId ?? null,
    );
  }
  const suffix = " copy";
  const cloned = await createCompanionV2({
    actor: input.actor,
    orgId: input.orgId,
    name: `${source.name.slice(0, 120 - suffix.length).trimEnd()}${suffix}`,
    persona: source.persona ?? undefined,
    providerId,
    modelId: source.model_id,
    selectedSkillIds: source.selected_skill_ids,
    selectedMcpAccountIds: source.selected_mcp_account_ids,
    sourceCompanionId: source.id,
    database: input.database,
  });
  return cloned;
}

export async function updateCompanionMemberStateV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  patch: { pinned?: boolean; hidden?: boolean; unread?: boolean };
  database: Db;
}): Promise<Companion> {
  await input.database.execute(sql`
    select * from public.companion_api_update_member_state(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.patch.pinned ?? null}::boolean,
      ${input.patch.hidden ?? null}::boolean,
      ${input.patch.unread ?? null}::boolean
    )
  `);
  return getCompanionV2(input);
}

export async function setCompanionWorkspaceShareV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  role: CompanionShareRole | null;
  database: Db;
}) {
  await input.database.execute(sql`
    select * from public.companion_api_set_workspace_access(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.role ?? null}::companion_share_role
    )
  `);
  return listCompanionShares(input);
}

type ThreadReadRow = {
  access_role: CompanionAccess;
  entries: unknown;
  active_turn: unknown;
  queued_count: number | string;
  interrupted_turn: unknown;
  last_message_at: Date | string | null;
  previous_last_read_ordinal: number | string | null;
};

export async function readCompanionThreadV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  database: Db;
}): Promise<CompanionThread> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_read_thread(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid
    )
  `);
  const [row] = rows<ThreadReadRow>(result);
  if (!row) throw new Error("companion thread projection is unavailable");
  const entries = z.array(companionTranscriptEntrySchema).parse(row.entries) as CompanionTranscriptEntry[];
  const activeTurn = parseTurn(row.active_turn);
  const interruptedTurn = parseTurn(row.interrupted_turn);
  const queuedCount = integer(row.queued_count);
  return {
    companion_id: input.companionId,
    viewer_id: input.actor.id,
    access: row.access_role,
    read_only: row.access_role === "viewer",
    can_send: row.access_role !== "viewer",
    entries,
    active_turn: activeTurn?.status === "interrupted" ? null : activeTurn,
    queued_count: queuedCount,
    interrupted_turn: interruptedTurn?.status === "interrupted" ? interruptedTurn : null,
    last_message_at: iso(row.last_message_at),
    last_read_ordinal: row.previous_last_read_ordinal === null
      ? null
      : integer(row.previous_last_read_ordinal),
  };
}

export async function enqueueCompanionTurnV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  clientMessageId: string;
  content: string;
  clientSurface: CompanionClientSurface;
  /**
   * Files already stored in object storage under their content address. They land in the same
   * transaction as the message and the turn, so a claimable turn always finds every file the runtime
   * has to stage. A replay compares them by content, not by row id or key, which is what makes
   * re-uploading identical bytes the same intent rather than a conflict.
   */
  attachments?: CompanionAttachmentUpload[];
  database: Db;
}): Promise<{ turn: CompanionTurn; operation: CompanionOperation | null; replayed: boolean }> {
  const attachments = (input.attachments ?? []).map((attachment) =>
    companionAttachmentUploadSchema.parse(attachment));
  const result = await input.database.execute(sql`
    select * from public.companion_api_enqueue_turn(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.clientMessageId}::uuid,
      ${input.content},
      ${input.clientSurface}::companion_client_surface,
      ${JSON.stringify(attachments)}::jsonb
    )
  `);
  const [row] = rows<{ turn: unknown; operation: unknown; replayed: boolean }>(result);
  if (!row) throw new Error("failed to enqueue Companion turn");
  return {
    turn: companionTurnSchema.parse(row.turn),
    operation: parseOperation(row.operation),
    replayed: row.replayed,
  };
}

export interface CompanionAttachmentAsset {
  storageKey: string;
  contentType: string;
  byteSize: number;
  filename: string;
  kind: "user_upload" | "pi_output";
}

/**
 * Resolve one attachment's stored bytes for a reader who may read its thread.
 *
 * Access is decided on this call and no other: nothing signed or long-lived is ever handed out, so a
 * reader who loses access stops being able to fetch the file at the next request rather than at the
 * next cache expiry. The storage key never leaves the server.
 */
export async function readCompanionAttachmentV2(input: {
  actor: ActorContext;
  orgId: string;
  companionId: string;
  attachmentId: string;
  database: Db;
}): Promise<CompanionAttachmentAsset> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_read_attachment(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.attachmentId}::uuid
    )
  `);
  const [row] = rows<{
    storage_key: string;
    content_type: string;
    byte_size: number | string;
    filename: string;
    kind: "user_upload" | "pi_output";
  }>(result);
  if (!row) throw new Error("companion attachment is unavailable");
  return {
    storageKey: row.storage_key,
    contentType: row.content_type,
    byteSize: integer(row.byte_size),
    filename: row.filename,
    kind: row.kind,
  };
}

export async function enqueueCompanionOperationV2(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  kind: CompanionOperationKind;
  clientSurface: CompanionClientSurface;
  database: Db;
}): Promise<{ operation: CompanionOperation; replayed: boolean }> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_enqueue_operation(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.requestId}::uuid,
      ${input.kind}::companion_operation_kind,
      ${input.clientSurface}::companion_client_surface
    )
  `);
  const [row] = rows<{ operation: unknown; replayed: boolean }>(result);
  if (!row) throw new Error("failed to enqueue Companion operation");
  return { operation: companionOperationSchema.parse(row.operation), replayed: row.replayed };
}

export async function answerCompanionDecisionV2(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  decision: string;
  optionId?: string;
  text?: string;
  database: Db;
}): Promise<void> {
  await input.database.execute(sql`
    select * from public.companion_api_answer_decision(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.requestId},
      ${input.decision},
      ${input.optionId ?? input.text ?? null}
    )
  `);
}

export type CompanionDecisionRecord = {
  requestKey: string;
  requestKind: string;
  decisionStatus: string;
  proposal: CompanionDecisionProposal | null;
  expiresAt: string;
};

export async function getCompanionDecisionV2(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  database: Db;
}): Promise<CompanionDecisionRecord> {
  const result = await input.database.execute(sql`
    select request_key, request_kind::text as request_kind,
      decision_status::text as decision_status, proposal, expires_at
    from public.companion_api_get_decision(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.requestId}
    )
  `);
  const [row] = rows<{
    request_key: string;
    request_kind: string;
    decision_status: string;
    proposal: unknown;
    expires_at: Date | string;
  }>(result);
  if (!row) throw new CompanionDecisionNotFoundError();
  return {
    requestKey: row.request_key,
    requestKind: row.request_kind,
    decisionStatus: row.decision_status,
    proposal: row.proposal == null ? null : companionDecisionProposalSchema.parse(row.proposal),
    expiresAt: iso(row.expires_at) ?? new Date(row.expires_at).toISOString(),
  };
}

export async function answerCompanionConfigDecisionV2(input: {
  orgId: string;
  companionId: string;
  requestId: string;
  decision: "allow" | "deny";
  database: Db;
}): Promise<void> {
  await input.database.execute(sql`
    select * from public.companion_api_answer_config_decision(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.requestId},
      ${input.decision}
    )
  `);
}

export async function retryCompanionTurnV2(input: {
  orgId: string;
  companionId: string;
  turnId: string;
  retryId: string;
  clientSurface: CompanionClientSurface;
  database: Db;
}): Promise<{ operation: CompanionOperation; replayed: boolean }> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_retry_turn(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.turnId}::uuid,
      ${input.retryId}::uuid,
      ${input.clientSurface}::companion_client_surface
    )
  `);
  const [row] = rows<{ operation: unknown; replayed: boolean }>(result);
  if (!row) throw new Error("failed to enqueue Companion retry");
  return { operation: companionOperationSchema.parse(row.operation), replayed: row.replayed };
}

export async function cancelCompanionTurnV2(input: {
  orgId: string;
  companionId: string;
  turnId: string;
  database: Db;
}): Promise<CompanionTurn> {
  const result = await input.database.execute(sql`
    select * from public.companion_api_cancel_turn(
      ${input.orgId}::uuid,
      ${input.companionId}::uuid,
      ${input.turnId}::uuid
    )
  `);
  const [row] = rows<{ turn: unknown }>(result);
  if (!row) throw new Error("failed to cancel Companion turn");
  return companionTurnSchema.parse(row.turn);
}

export async function bumpCompanionSkillRevisionV2(input: {
  orgId: string;
  skillId: string;
  database: Db;
}): Promise<number> {
  const result = await input.database.execute(sql`
    select public.companion_api_bump_skill_revision(
      ${input.orgId}::uuid,
      ${input.skillId}::uuid
    ) as changed
  `);
  return integer(rows<{ changed: number | string }>(result)[0]?.changed);
}
