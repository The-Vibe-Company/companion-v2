import {
  decodeGateStatusRow,
  decodeRuntimeAuthorizationRow,
  decodeRuntimeClaimRow,
  RuntimeRowDecodeError,
  type GateStatus,
  type ClientSurface,
  type DuplicateCleanup,
  type DuplicateCleanupStatus,
  type LeaseFence,
  type McpOauthCasResult,
  type McpOauthEnvelope,
  type RuntimeAuthorization,
  type RuntimeCheckpointInput,
  type RuntimeClaim,
  type RuntimeObservationInput,
  type RuntimeAttachment,
  type RuntimeOutputAttachment,
  type RuntimeSettlementInput,
  type RuntimeConfigCatalog,
  type RuntimeWorkMaterial,
  type RuntimeSkillUpdateMaterial,
} from "./types";
import {
  COMPANION_ATTACHMENT_FILENAME_PATTERN,
  COMPANION_ATTACHMENT_MAX_BYTES,
  COMPANION_ATTACHMENT_MIME_TYPES,
  COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT,
} from "@companion/contracts";
import type { RuntimePiProjection } from "./piEvents";

export const RUNTIME_LEASE_SECONDS = 30 as const;

export interface RuntimeStore {
  ping(): Promise<void>;
  gateStatus(): Promise<GateStatus>;
  disable(expectedGateEpoch: bigint, actorId: string): Promise<GateStatus>;
  claimWork(input: {
    executorId: string;
    limit: number;
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS;
    gateEpoch: bigint;
  }): Promise<RuntimeClaim[]>;
  renewAndAuthorize(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeAuthorization | null>;
  checkpoint(fence: LeaseFence, input: RuntimeCheckpointInput): Promise<bigint | null>;
  observeInstance(fence: LeaseFence, input: RuntimeObservationInput): Promise<bigint | null>;
  getMaterial(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeWorkMaterial | null>;
  getSkillUpdateMaterial(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeSkillUpdateMaterial | null>;
  commitSkillUpdate(fence: LeaseFence, input: RuntimeSkillUpdateMaterial & {
    skillsDigest: string;
  }): Promise<true | null>;
  recordSkillUpdateError(fence: LeaseFence, input: {
    code: string;
    message: string;
  }): Promise<true | null>;
  getConfigCatalog(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeConfigCatalog | null>;
  mintHubToken(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<{ token: string; expiresAt: Date } | null>;
  recordMaterialSnapshot(fence: LeaseFence, input: {
    clientSurface: ClientSurface;
    materialExpiresAt: Date | null;
  }): Promise<true | null>;
  publishMaterialSnapshot(fence: LeaseFence, input: {
    piInvocationId: string;
  }): Promise<true | null>;
  getAttemptTerminalProjection(fence: LeaseFence): Promise<{
    checkpoint: "agent_settled" | "process_exited";
    eventCursor: bigint;
    hasVisibleOutput: boolean;
    /** True once this attempt's outbox harvest committed, so a takeover does not repeat it. */
    outputsHarvested: boolean;
  } | null>;
  /**
   * Record what Pi left in its outbox, atomically with the durable fact that the harvest happened.
   * Returns null when the fence is stale; the caller abandons rather than settling from stale state.
   */
  recordAttemptOutputs(fence: LeaseFence, input: {
    attachments: RuntimeOutputAttachment[];
    activityAt: Date;
  }): Promise<{ recorded: number; hasVisibleOutput: boolean } | null>;
  projectEventBatch(fence: LeaseFence, input: {
    expectedSequence: bigint;
    piInvocationId: string;
    events: RuntimePiProjection[];
    throughCursor: bigint;
    activityAt?: Date;
    unknownEventCount: number;
    malformedEventCount: number;
    oversizedEventCount: number;
  }): Promise<{
    checkpointSequence: bigint;
    eventCursor: bigint;
    hasVisibleOutput: boolean;
  } | null>;
  registerDuplicateCleanups(fence: LeaseFence, boxIds: string[]): Promise<DuplicateCleanup[]>;
  checkpointDuplicateCleanup(fence: LeaseFence, input: {
    boxId: string;
    expectedSequence: bigint;
    nextStatus: DuplicateCleanupStatus;
    providerOperationId?: string;
  }): Promise<DuplicateCleanup | null>;
  casMcpOauth(fence: LeaseFence, input: {
    accountId: string;
    expectedGeneration: string;
    nextGeneration: string;
    envelope: McpOauthEnvelope;
  }): Promise<McpOauthCasResult | null>;
  settle(fence: LeaseFence, input: RuntimeSettlementInput): Promise<boolean>;
  release(fence: LeaseFence): Promise<boolean>;
}

/** Structural subset of `postgres.Sql`; useful for tests and avoids owning connection lifecycle. */
export interface RuntimeSqlClient {
  unsafe<T extends Record<string, unknown>[]>(query: string, parameters?: unknown[]): Promise<T>;
}

export class RuntimeStoreSerializationError extends Error {
  constructor(cause?: unknown) {
    super("Runtime database serialization conflict", cause === undefined ? undefined : { cause });
    this.name = "RuntimeStoreSerializationError";
  }
}

export class RuntimeStoreContractError extends Error {
  constructor() {
    super("Runtime database contract rejected an operation");
    this.name = "RuntimeStoreContractError";
  }
}

export class RuntimeCredentialSnapshotChangedError extends Error {
  constructor() {
    super("Runtime credentials changed after Pi accepted the turn");
    this.name = "RuntimeCredentialSnapshotChangedError";
  }
}

/**
 * The database connection disappeared while invoking a mutating definer. The
 * transaction may have committed even though no result reached this process,
 * so callers must abandon the local fence and let a later claim inspect the
 * durable checkpoint. Retrying or settling from stale in-memory state is not
 * safe.
 */
export class RuntimeStoreIndeterminateError extends Error {
  constructor(cause?: unknown) {
    super(
      "Runtime database mutation outcome is indeterminate",
      cause === undefined ? undefined : { cause },
    );
    this.name = "RuntimeStoreIndeterminateError";
  }
}

function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = (error as { code?: unknown }).code;
  return typeof value === "string" ? value : undefined;
}

async function mapped<T>(operation: () => Promise<T>, mutating = false): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (
      error instanceof RuntimeStoreSerializationError
      || error instanceof RuntimeStoreContractError
      || error instanceof RuntimeStoreIndeterminateError
      || error instanceof RuntimeCredentialSnapshotChangedError
      || error instanceof RuntimeRowDecodeError
    ) throw error;
    if (sqlState(error) === "40001") throw new RuntimeStoreSerializationError(error);
    if (sqlState(error) === "22023") throw new RuntimeStoreContractError();
    if (mutating) throw new RuntimeStoreIndeterminateError(error);
    throw error;
  }
}

function one(rows: Record<string, unknown>[], name: string): Record<string, unknown> {
  if (rows.length !== 1 || !rows[0]) throw new RuntimeStoreContractError();
  return rows[0];
}

function nullableBigintResult(rows: Record<string, unknown>[], key: string): bigint | null {
  const row = one(rows, key);
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new RuntimeStoreContractError();
  }
  return BigInt(value);
}

function booleanResult(rows: Record<string, unknown>[], key: string): boolean {
  const value = one(rows, key)[key];
  if (typeof value !== "boolean") throw new RuntimeStoreContractError();
  return value;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MESSAGE_EVENT_ID_PATTERN = /^msg:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BOX_ID_PATTERN = /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ATTACHMENT_STORAGE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/._-]{0,511}$/;
/**
 * The decode boundary enforces the contract's own bounds rather than a copy of them: the runtime
 * writes these names into Box paths and into the prompt that tells Pi where to find them, so the
 * check has to be the same rule the API and the database CHECK apply, not a second one that can drift.
 */
const ATTACHMENT_CONTENT_TYPES = new Set<string>(COMPANION_ATTACHMENT_MIME_TYPES);

function nullableText(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== "string" || /[\r\n]/.test(value) || value.length === 0) {
    throw new RuntimeStoreContractError();
  }
  return value;
}

function nullableUuidText(row: Record<string, unknown>, key: string): string | null {
  const value = nullableText(row, key);
  if (value !== null && !UUID_PATTERN.test(value)) throw new RuntimeStoreContractError();
  return value;
}

function objectArray(row: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const value = row[key];
  if (!Array.isArray(value) || value.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    throw new RuntimeStoreContractError();
  }
  return value as Record<string, unknown>[];
}

/**
 * Decode the staging list. Every bound the database already enforces is re-checked here, because the
 * runtime writes these names into Box paths and into the prompt that tells Pi where to find them:
 * whatever crosses that boundary is validated on this side of it too, not merely trusted.
 */
function decodeAttachments(row: Record<string, unknown>): RuntimeAttachment[] {
  const value = row.attachments;
  if (!Array.isArray(value) || value.length > COMPANION_MESSAGE_ATTACHMENT_MAX_COUNT) {
    throw new RuntimeStoreContractError();
  }
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new RuntimeStoreContractError();
    }
    const attachment = entry as Record<string, unknown>;
    const id = nullableUuidText(attachment, "id");
    const storageKey = nullableText(attachment, "storage_key");
    const contentType = nullableText(attachment, "content_type");
    const sha256 = nullableText(attachment, "sha256");
    const filename = nullableText(attachment, "filename");
    const byteSize = attachment.byte_size;
    const position = attachment.position;
    if (
      id === null
      || storageKey === null
      || !ATTACHMENT_STORAGE_KEY_PATTERN.test(storageKey)
      || contentType === null
      || !ATTACHMENT_CONTENT_TYPES.has(contentType)
      || sha256 === null
      || !SHA256_PATTERN.test(sha256)
      || filename === null
      || !COMPANION_ATTACHMENT_FILENAME_PATTERN.test(filename)
      || !Number.isSafeInteger(byteSize)
      || (byteSize as number) < 1
      || (byteSize as number) > COMPANION_ATTACHMENT_MAX_BYTES
      || position !== index
    ) throw new RuntimeStoreContractError();
    return {
      id,
      storageKey,
      contentType,
      byteSize: byteSize as number,
      sha256,
      filename,
      position: index,
    };
  });
}

function decodeMaterial(row: Record<string, unknown>): RuntimeWorkMaterial {
  if (typeof row.credential_snapshot_matches !== "boolean") {
    throw new RuntimeStoreContractError();
  }
  if (!row.credential_snapshot_matches) {
    throw new RuntimeCredentialSnapshotChangedError();
  }
  const prompt = row.prompt_text;
  if (prompt !== null && (typeof prompt !== "string" || prompt.length > 1_000_000)) {
    throw new RuntimeStoreContractError();
  }
  const requestKind = row.decision_request_kind;
  if (
    requestKind !== null
    && requestKind !== "question"
    && requestKind !== "confirmation"
    && requestKind !== "config_proposal"
    && requestKind !== "routine_proposal"
  ) {
    throw new RuntimeStoreContractError();
  }
  const decisionPayload = row.decision_response_payload;
  if (decisionPayload !== null && (
    !decisionPayload
    || typeof decisionPayload !== "object"
    || Array.isArray(decisionPayload)
  )) throw new RuntimeStoreContractError();
  const modelInput = row.model_input;
  if (modelInput !== null && (
    !Array.isArray(modelInput)
    || modelInput.some((item) => item !== "text" && item !== "image")
  )) throw new RuntimeStoreContractError();
  if (typeof row.has_visible_output !== "boolean") throw new RuntimeStoreContractError();
  const messageEventId = nullableText(row, "message_event_id");
  if (messageEventId !== null && !MESSAGE_EVENT_ID_PATTERN.test(messageEventId)) {
    throw new RuntimeStoreContractError();
  }
  return {
    turnId: nullableUuidText(row, "turn_id"),
    attemptId: nullableUuidText(row, "attempt_id"),
    messageEventId,
    promptText: prompt as string | null,
    decisionRequestKind: requestKind as RuntimeWorkMaterial["decisionRequestKind"],
    decisionResponsePayload: decisionPayload as RuntimeWorkMaterial["decisionResponsePayload"],
    providerMaterial: objectArray(row, "provider_material"),
    skillMaterial: objectArray(row, "skill_material"),
    mcpMaterial: objectArray(row, "mcp_material"),
    modelInput: modelInput as RuntimeWorkMaterial["modelInput"],
    hasVisibleOutput: row.has_visible_output,
    attachments: decodeAttachments(row),
    configCatalog: null,
  };
}

function decodeSkillUpdateMaterial(row: Record<string, unknown>): RuntimeSkillUpdateMaterial {
  const revision = row.target_skills_revision;
  const requiredRevision = row.required_skills_revision;
  const selected = row.selected_skill_ids;
  const refs = objectArray(row, "skill_refs");
  if (
    !Number.isSafeInteger(revision)
    || (revision as number) < 1
    || !Number.isSafeInteger(requiredRevision)
    || (requiredRevision as number) < 1
    || (requiredRevision as number) > (revision as number)
    || !Array.isArray(selected)
    || selected.some((id) => typeof id !== "string" || !UUID_PATTERN.test(id))
  ) throw new RuntimeStoreContractError();
  const skillRefs = refs.map((ref) => {
    const skillId = nullableUuidText(ref, "skill_id");
    const versionId = nullableUuidText(ref, "current_version_id");
    if (skillId === null || versionId === null) throw new RuntimeStoreContractError();
    return { skill_id: skillId, current_version_id: versionId };
  });
  return {
    targetSkillsRevision: revision as number,
    requiredSkillsRevision: requiredRevision as number,
    selectedSkillIds: selected as string[],
    skillRefs,
    skillMaterial: objectArray(row, "skill_material"),
  };
}

function decodeConfigCatalog(row: Record<string, unknown>): RuntimeConfigCatalog {
  const catalog = row.catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new RuntimeStoreContractError();
  }
  const value = catalog as Record<string, unknown>;
  const companion = value.companion;
  const skills = value.skills;
  const plugins = value.plugins;
  const note = value.note;
  if (
    !companion || typeof companion !== "object" || Array.isArray(companion)
    || !Array.isArray(skills) || skills.length > 100
    || !Array.isArray(plugins) || plugins.length > 100
    || typeof note !== "string"
  ) {
    throw new RuntimeStoreContractError();
  }
  const companionRecord = companion as Record<string, unknown>;
  for (const skill of skills) {
    if (
      !skill || typeof skill !== "object" || Array.isArray(skill)
      || typeof (skill as Record<string, unknown>).id !== "string"
      || typeof (skill as Record<string, unknown>).slug !== "string"
      || typeof (skill as Record<string, unknown>).name !== "string"
      || typeof (skill as Record<string, unknown>).description !== "string"
      || typeof (skill as Record<string, unknown>).selected !== "boolean"
    ) throw new RuntimeStoreContractError();
  }
  for (const plugin of plugins) {
    if (
      !plugin || typeof plugin !== "object" || Array.isArray(plugin)
      || typeof (plugin as Record<string, unknown>).id !== "string"
      || typeof (plugin as Record<string, unknown>).label !== "string"
      || typeof (plugin as Record<string, unknown>).provider !== "string"
      || typeof (plugin as Record<string, unknown>).transport !== "string"
      || typeof (plugin as Record<string, unknown>).selected !== "boolean"
    ) throw new RuntimeStoreContractError();
  }
  return {
    companion: {
      model_id: typeof companionRecord.model_id === "string" ? companionRecord.model_id : null,
      provider_id: typeof companionRecord.provider_id === "string" ? companionRecord.provider_id : null,
      persona: typeof companionRecord.persona === "string" ? companionRecord.persona : null,
    },
    skills: skills as RuntimeConfigCatalog["skills"],
    plugins: plugins as RuntimeConfigCatalog["plugins"],
    note,
  };
}

function decodeHubToken(row: Record<string, unknown>): { token: string; expiresAt: Date } {
  const token = row.token;
  const expiresAt = row.expires_at;
  if (
    typeof token !== "string" || !token.startsWith("cmp_pat_") || token.length > 80
    || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())
  ) {
    throw new RuntimeStoreContractError();
  }
  return { token, expiresAt };
}

function decodeAttemptTerminalProjection(row: Record<string, unknown>): {
  checkpoint: "agent_settled" | "process_exited";
  eventCursor: bigint;
  hasVisibleOutput: boolean;
  outputsHarvested: boolean;
} {
  const checkpoint = row.checkpoint;
  const eventCursor = row.event_cursor;
  const hasVisibleOutput = row.has_visible_output;
  const outputsHarvested = row.outputs_harvested;
  if (
    (checkpoint !== "agent_settled" && checkpoint !== "process_exited")
    || typeof eventCursor !== "string"
    || !/^[1-9][0-9]*$/.test(eventCursor)
    || typeof hasVisibleOutput !== "boolean"
    || typeof outputsHarvested !== "boolean"
  ) throw new RuntimeStoreContractError();
  return { checkpoint, eventCursor: BigInt(eventCursor), hasVisibleOutput, outputsHarvested };
}

function duplicateCleanup(row: Record<string, unknown>): DuplicateCleanup {
  const boxId = row.box_id;
  const status = row.status;
  const sequence = row.checkpoint_sequence;
  if (
    typeof boxId !== "string"
    || !BOX_ID_PATTERN.test(boxId)
    || (
      status !== "pending"
      && status !== "delete_requested"
      && status !== "waiting_deleted"
      && status !== "deleted"
      && status !== "already_deleted"
      && status !== "blocked"
    )
    || typeof sequence !== "string"
    || !/^(0|[1-9][0-9]*)$/.test(sequence)
  ) throw new RuntimeStoreContractError();
  return {
    boxId,
    status,
    providerOperationId: nullableText(row, "provider_operation_id"),
    checkpointSequence: BigInt(sequence),
  };
}

function fenceParameters(fence: LeaseFence): unknown[] {
  return [
    fence.orgId,
    fence.companionId,
    fence.claimToken,
    fence.claimEpoch.toString(),
    fence.gateEpoch.toString(),
    fence.executorId,
    fence.workKind,
    fence.workId,
  ];
}

const CLAIM_COLUMNS = `
  org_id,
  companion_id,
  claim_token,
  claim_epoch::text AS claim_epoch,
  gate_epoch::text AS gate_epoch,
  work_kind,
  work_id,
  actor_id,
  client_surface,
  runtime_generation::text AS runtime_generation,
  checkpoint,
  checkpoint_sequence::text AS checkpoint_sequence,
  turn_id,
  turn_status,
  attempt_status,
  dispatch_state,
  event_cursor::text AS event_cursor,
  unknown_event_count,
  malformed_event_count,
  oversized_event_count,
  cold_start_deadline_at,
  inactivity_deadline_at,
  absolute_deadline_at,
  operation_kind,
  operation_started_at,
  operation_attempt_count,
  provider_operation_id,
  target_settings_revision::text AS target_settings_revision,
  target_skills_revision,
  decision_status,
  decision_delivery_state`;

const AUTHORIZATION_COLUMNS = `
  authorized,
  denial_code,
  lease_expires_at,
  authorization_actor_id,
  decision_actor_id,
  client_surface,
  runtime_generation::text AS runtime_generation,
  box_id,
  box_state,
  pi_state,
  pi_invocation_id,
  disk_layout_version,
  applied_settings_revision::text AS applied_settings_revision,
  applied_skills_revision,
  model_id,
  persona,
  can_write_skills,
  provider_refs,
  skill_refs,
  mcp_refs,
  desired_settings_revision::text AS desired_settings_revision,
  skills_revision,
  work_checkpoint,
  work_checkpoint_sequence::text AS work_checkpoint_sequence,
  turn_id,
  turn_status,
  attempt_status,
  dispatch_state,
  event_cursor::text AS event_cursor,
  unknown_event_count,
  malformed_event_count,
  oversized_event_count,
  cold_start_deadline_at,
  inactivity_deadline_at,
  absolute_deadline_at,
  operation_kind,
  operation_started_at,
  operation_attempt_count,
  provider_operation_id,
  target_settings_revision::text AS target_settings_revision,
  target_skills_revision,
  decision_status,
  decision_delivery_state,
  decision_request_key,
  decision_response_text`;

/** PostgreSQL implementation whose SQL surface consists only of Runtime v2 definer functions. */
export class PostgresRuntimeStore implements RuntimeStore {
  constructor(private readonly sql: RuntimeSqlClient) {}

  async ping(): Promise<void> {
    await this.gateStatus();
  }

  async gateStatus(): Promise<GateStatus> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT enabled, gate_epoch::text AS gate_epoch, updated_at
        FROM public.companion_runtime_gate_status()
      `);
      return decodeGateStatusRow(one(rows, "gate status"));
    });
  }

  async disable(expectedGateEpoch: bigint, actorId: string): Promise<GateStatus> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT enabled, gate_epoch::text AS gate_epoch, updated_at
        FROM public.companion_runtime_disable($1::bigint, $2::text)
      `, [expectedGateEpoch.toString(), actorId]);
      return decodeGateStatusRow(one(rows, "disable"));
    }, true);
  }

  async claimWork(input: {
    executorId: string;
    limit: number;
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS;
    gateEpoch: bigint;
  }): Promise<RuntimeClaim[]> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT ${CLAIM_COLUMNS}
        FROM public.companion_runtime_claim_work(
          $1::text, $2::integer, $3::integer, $4::bigint, 1::integer
        )
      `, [input.executorId, input.limit, input.leaseSeconds, input.gateEpoch.toString()]);
      return rows.map(decodeRuntimeClaimRow);
    }, true);
  }

  async renewAndAuthorize(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeAuthorization | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT ${AUTHORIZATION_COLUMNS}
        FROM public.companion_runtime_renew_and_authorize(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeRuntimeAuthorizationRow(one(rows, "renew authorization"), fence.workKind);
    }, true);
  }

  async checkpoint(fence: LeaseFence, input: RuntimeCheckpointInput): Promise<bigint | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_checkpoint(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::bigint, $10::text, $11::text, $12::uuid, $13::text,
          $14::bigint, $15::timestamptz, $16::integer, $17::integer, $18::integer
        )::text AS next_sequence
      `, [
        ...fenceParameters(fence),
        input.expectedSequence.toString(),
        input.nextCheckpoint,
        input.providerOperationId ?? null,
        input.commandId ?? null,
        input.piInvocationId ?? null,
        input.eventCursor?.toString() ?? null,
        input.activityAt ?? null,
        input.unknownEventCount ?? null,
        input.malformedEventCount ?? null,
        input.oversizedEventCount ?? null,
      ]);
      return nullableBigintResult(rows, "next_sequence");
    }, true);
  }

  async observeInstance(fence: LeaseFence, input: RuntimeObservationInput): Promise<bigint | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_observe_instance(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::bigint, $10::bigint, $11::text,
          $12::public.companion_box_observed_state,
          $13::public.companion_pi_observed_state,
          $14::text, $15::integer, $16::bigint, $17::integer, $18::timestamptz
        )::text AS next_sequence
      `, [
        ...fenceParameters(fence),
        input.runtimeGeneration.toString(),
        input.expectedSequence.toString(),
        input.boxId ?? null,
        input.boxState ?? null,
        input.piState ?? null,
        input.piInvocationId ?? null,
        input.diskLayoutVersion ?? null,
        input.appliedSettingsRevision?.toString() ?? null,
        input.appliedSkillsRevision ?? null,
        input.observedAt,
      ]);
      return nullableBigintResult(rows, "next_sequence");
    }, true);
  }

  async getMaterial(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeWorkMaterial | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT turn_id, attempt_id, message_event_id, prompt_text, decision_request_kind,
               decision_response_payload, provider_material, skill_material, mcp_material,
               model_input, has_visible_output, attachments, credential_snapshot_matches
        FROM public.companion_runtime_get_material(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeMaterial(one(rows, "work material"));
    }, true);
  }

  async getSkillUpdateMaterial(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeSkillUpdateMaterial | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT target_skills_revision, required_skills_revision,
               selected_skill_ids, skill_refs, skill_material
        FROM public.companion_runtime_get_skill_update_material(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeSkillUpdateMaterial(one(rows, "Skill update material"));
    }, true);
  }

  async commitSkillUpdate(
    fence: LeaseFence,
    input: RuntimeSkillUpdateMaterial & { skillsDigest: string },
  ): Promise<true | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_commit_skill_update(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          ${RUNTIME_LEASE_SECONDS}::integer,
          $9::integer, $10::jsonb, $11::jsonb, $12::text
        ) AS committed
      `, [
        ...fenceParameters(fence),
        input.targetSkillsRevision,
        JSON.stringify(input.selectedSkillIds),
        JSON.stringify(input.skillRefs),
        input.skillsDigest,
      ]);
      const value = one(rows, "commit Skill update").committed;
      if (value === null) return null;
      if (value !== true) throw new RuntimeStoreContractError();
      return true;
    }, true);
  }

  async recordSkillUpdateError(
    fence: LeaseFence,
    input: { code: string; message: string },
  ): Promise<true | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_record_skill_update_error(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          ${RUNTIME_LEASE_SECONDS}::integer,
          $9::text, $10::text
        ) AS recorded
      `, [...fenceParameters(fence), input.code, input.message]);
      const value = one(rows, "record Skill update error").recorded;
      if (value === null) return null;
      if (value !== true) throw new RuntimeStoreContractError();
      return true;
    }, true);
  }

  async getConfigCatalog(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<RuntimeConfigCatalog | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT catalog
        FROM public.companion_runtime_get_config_catalog(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeConfigCatalog(one(rows, "config catalog"));
    }, true);
  }

  async mintHubToken(
    fence: LeaseFence,
    leaseSeconds: typeof RUNTIME_LEASE_SECONDS,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT token, expires_at
        FROM public.companion_runtime_mint_hub_token(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeHubToken(one(rows, "hub token"));
    }, true);
  }

  async recordMaterialSnapshot(fence: LeaseFence, input: {
    clientSurface: ClientSurface;
    materialExpiresAt: Date | null;
  }): Promise<true | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_record_material_snapshot(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::public.companion_client_surface, $10::timestamptz
        ) AS recorded
      `, [...fenceParameters(fence), input.clientSurface, input.materialExpiresAt]);
      const recorded = one(rows, "record material snapshot").recorded;
      if (typeof recorded !== "boolean") throw new RuntimeStoreContractError();
      return recorded ? true : null;
    }, true);
  }

  async publishMaterialSnapshot(fence: LeaseFence, input: {
    piInvocationId: string;
  }): Promise<true | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_publish_material_snapshot(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::text
        ) AS published
      `, [...fenceParameters(fence), input.piInvocationId]);
      const published = one(rows, "publish material snapshot").published;
      if (typeof published !== "boolean") throw new RuntimeStoreContractError();
      return published ? true : null;
    }, true);
  }

  async getAttemptTerminalProjection(fence: LeaseFence): Promise<{
    checkpoint: "agent_settled" | "process_exited";
    eventCursor: bigint;
    hasVisibleOutput: boolean;
    outputsHarvested: boolean;
  } | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT checkpoint, event_cursor::text AS event_cursor, has_visible_output, outputs_harvested
        FROM public.companion_runtime_get_attempt_terminal_projection(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid
        )
      `, fenceParameters(fence));
      if (rows.length === 0) return null;
      return decodeAttemptTerminalProjection(one(rows, "attempt terminal projection"));
    });
  }

  async recordAttemptOutputs(fence: LeaseFence, input: {
    attachments: RuntimeOutputAttachment[];
    activityAt: Date;
  }): Promise<{ recorded: number; hasVisibleOutput: boolean } | null> {
    return await mapped(async () => {
      // The driver serializes an array parameter to JSON for a jsonb column, exactly as the event
      // projector's batch does. Pre-stringifying it here would arrive as a JSON *string* instead.
      const attachments = input.attachments.map((attachment, position) => ({
        storage_key: attachment.storageKey,
        content_type: attachment.contentType,
        byte_size: attachment.byteSize,
        sha256: attachment.sha256,
        filename: attachment.filename,
        position,
      }));
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT recorded, has_visible_output
        FROM public.companion_runtime_record_attempt_outputs(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::jsonb, $10::timestamptz
        )
      `, [...fenceParameters(fence), attachments, input.activityAt]);
      if (rows.length === 0) return null;
      const row = one(rows, "attempt outputs");
      if (
        !Number.isSafeInteger(row.recorded)
        || (row.recorded as number) < 0
        || typeof row.has_visible_output !== "boolean"
      ) throw new RuntimeStoreContractError();
      return { recorded: row.recorded as number, hasVisibleOutput: row.has_visible_output };
    }, true);
  }

  async projectEventBatch(fence: LeaseFence, input: {
    expectedSequence: bigint;
    piInvocationId: string;
    events: RuntimePiProjection[];
    throughCursor: bigint;
    activityAt?: Date;
    unknownEventCount: number;
    malformedEventCount: number;
    oversizedEventCount: number;
  }): Promise<{
    checkpointSequence: bigint;
    eventCursor: bigint;
    hasVisibleOutput: boolean;
  } | null> {
    return await mapped(async () => {
      const events = input.events.map((event) => ({
        ...event,
        sequence: event.sequence.toString(),
      }));
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT checkpoint_sequence::text AS checkpoint_sequence,
               event_cursor::text AS event_cursor,
               has_visible_output
        FROM public.companion_runtime_project_event_batch(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::bigint, $10::text, $11::jsonb, $12::bigint, $13::timestamptz,
          $14::integer, $15::integer, $16::integer
        )
      `, [
        ...fenceParameters(fence),
        input.expectedSequence.toString(),
        input.piInvocationId,
        events,
        input.throughCursor.toString(),
        input.activityAt ?? null,
        input.unknownEventCount,
        input.malformedEventCount,
        input.oversizedEventCount,
      ]);
      if (rows.length === 0) return null;
      const row = one(rows, "event projection");
      const checkpointSequence = row.checkpoint_sequence;
      const eventCursor = row.event_cursor;
      const hasVisibleOutput = row.has_visible_output;
      if (
        typeof checkpointSequence !== "string"
        || !/^[1-9][0-9]*$/.test(checkpointSequence)
        || typeof eventCursor !== "string"
        || !/^(0|[1-9][0-9]*)$/.test(eventCursor)
        || typeof hasVisibleOutput !== "boolean"
      ) throw new RuntimeStoreContractError();
      return {
        checkpointSequence: BigInt(checkpointSequence),
        eventCursor: BigInt(eventCursor),
        hasVisibleOutput,
      };
    }, true);
  }

  async registerDuplicateCleanups(
    fence: LeaseFence,
    boxIds: string[],
  ): Promise<DuplicateCleanup[]> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT box_id, status, provider_operation_id,
               checkpoint_sequence::text AS checkpoint_sequence
        FROM public.companion_runtime_register_duplicate_cleanups(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::text[]
        )
      `, [...fenceParameters(fence), boxIds]);
      return rows.map(duplicateCleanup);
    }, true);
  }

  async checkpointDuplicateCleanup(fence: LeaseFence, input: {
    boxId: string;
    expectedSequence: bigint;
    nextStatus: DuplicateCleanupStatus;
    providerOperationId?: string;
  }): Promise<DuplicateCleanup | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT box_id, status, provider_operation_id,
               checkpoint_sequence::text AS checkpoint_sequence
        FROM public.companion_runtime_checkpoint_duplicate_cleanup(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::text, $10::bigint, $11::public.companion_duplicate_cleanup_status, $12::text
        )
      `, [
        ...fenceParameters(fence),
        input.boxId,
        input.expectedSequence.toString(),
        input.nextStatus,
        input.providerOperationId ?? null,
      ]);
      if (rows.length === 0) return null;
      return duplicateCleanup(one(rows, "duplicate cleanup checkpoint"));
    }, true);
  }

  async casMcpOauth(fence: LeaseFence, input: {
    accountId: string;
    expectedGeneration: string;
    nextGeneration: string;
    envelope: McpOauthEnvelope;
  }): Promise<McpOauthCasResult | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT updated, credential_generation
        FROM public.companion_runtime_cas_mcp_oauth(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::uuid, $10::uuid, $11::uuid,
          $12::text, $13::text, $14::text, $15::text, $16::text, $17::text, $18::text
        )
      `, [
        ...fenceParameters(fence),
        input.accountId,
        input.expectedGeneration,
        input.nextGeneration,
        input.envelope.ciphertext,
        input.envelope.iv,
        input.envelope.authTag,
        input.envelope.wrappedDek,
        input.envelope.wrapIv,
        input.envelope.wrapAuthTag,
        input.envelope.keyId,
      ]);
      if (rows.length === 0) return null;
      const row = one(rows, "MCP OAuth CAS");
      if (
        typeof row.updated !== "boolean"
        || typeof row.credential_generation !== "string"
        || !UUID_PATTERN.test(row.credential_generation)
      ) throw new RuntimeStoreContractError();
      return {
        updated: row.updated,
        credentialGeneration: row.credential_generation,
      };
    }, true);
  }

  async settle(fence: LeaseFence, input: RuntimeSettlementInput): Promise<boolean> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_settle(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid,
          $9::text, $10::text, $11::text,
          $12::public.companion_runtime_error_action
        ) AS settled
      `, [
        ...fenceParameters(fence),
        input.terminalStatus,
        input.error?.code ?? null,
        input.error?.message ?? null,
        input.error?.action ?? null,
      ]);
      return booleanResult(rows, "settled");
    }, true);
  }

  async release(fence: LeaseFence): Promise<boolean> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT public.companion_runtime_release_lease(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid
        ) AS released
      `, fenceParameters(fence));
      return booleanResult(rows, "released");
    }, true);
  }
}
