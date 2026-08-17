import {
  decodeGateStatusRow,
  decodeRuntimeAuthorizationRow,
  decodeRuntimeClaimRow,
  type GateStatus,
  type DuplicateCleanup,
  type DuplicateCleanupStatus,
  type LeaseFence,
  type McpOauthCasResult,
  type McpOauthEnvelope,
  type RuntimeAuthorization,
  type RuntimeCheckpointInput,
  type RuntimeClaim,
  type RuntimeObservationInput,
  type RuntimeSettlementInput,
  type RuntimeWorkMaterial,
} from "./types";
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
  getAttemptTerminalProjection(fence: LeaseFence): Promise<{
    checkpoint: "agent_settled" | "process_exited";
    eventCursor: bigint;
    hasVisibleOutput: boolean;
  } | null>;
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
  constructor() {
    super("Runtime database serialization conflict");
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
  constructor() {
    super("Runtime database mutation outcome is indeterminate");
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
    ) throw error;
    if (sqlState(error) === "40001") throw new RuntimeStoreSerializationError();
    if (sqlState(error) === "22023") throw new RuntimeStoreContractError();
    if (mutating) throw new RuntimeStoreIndeterminateError();
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
  if (requestKind !== null && requestKind !== "question" && requestKind !== "confirmation") {
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
  };
}

function decodeAttemptTerminalProjection(row: Record<string, unknown>): {
  checkpoint: "agent_settled" | "process_exited";
  eventCursor: bigint;
  hasVisibleOutput: boolean;
} {
  const checkpoint = row.checkpoint;
  const eventCursor = row.event_cursor;
  const hasVisibleOutput = row.has_visible_output;
  if (
    (checkpoint !== "agent_settled" && checkpoint !== "process_exited")
    || typeof eventCursor !== "string"
    || !/^[1-9][0-9]*$/.test(eventCursor)
    || typeof hasVisibleOutput !== "boolean"
  ) throw new RuntimeStoreContractError();
  return { checkpoint, eventCursor: BigInt(eventCursor), hasVisibleOutput };
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
          $1::text, $2::integer, $3::integer, $4::bigint
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
               model_input, has_visible_output, credential_snapshot_matches
        FROM public.companion_runtime_get_material(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid, $9::integer
        )
      `, [...fenceParameters(fence), leaseSeconds]);
      if (rows.length === 0) return null;
      return decodeMaterial(one(rows, "work material"));
    }, true);
  }

  async getAttemptTerminalProjection(fence: LeaseFence): Promise<{
    checkpoint: "agent_settled" | "process_exited";
    eventCursor: bigint;
    hasVisibleOutput: boolean;
  } | null> {
    return await mapped(async () => {
      const rows = await this.sql.unsafe<Record<string, unknown>[]>(`
        SELECT checkpoint, event_cursor::text AS event_cursor, has_visible_output
        FROM public.companion_runtime_get_attempt_terminal_projection(
          $1::uuid, $2::uuid, $3::uuid, $4::bigint, $5::bigint,
          $6::text, $7::public.companion_runtime_work_kind, $8::uuid
        )
      `, fenceParameters(fence));
      if (rows.length === 0) return null;
      return decodeAttemptTerminalProjection(one(rows, "attempt terminal projection"));
    });
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
