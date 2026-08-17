import { z } from "zod";
import {
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
} from "./boxCompanionRuntime";

const DEFAULT_BOX_API_BASE = "https://ascii.dev/api/box/v1";
const BOX_REQUEST_TIMEOUT_MS = 30_000;
const BOX_LIST_PAGE_LIMIT = 200;
const BOX_TTL_MAX_SECONDS = 2_592_000;
const DEFAULT_DELETION_POLL_INTERVAL_MS = 1_000;
const MAX_GENERATION = 2_147_483_647;
const SAFE_PROVIDER_CODES = new Set([
  "unauthorized",
  "invalid_request",
  "request_too_large",
  "box_not_found",
  "box_name_conflict",
  "box_already_stopping",
  "box_not_resumable",
  "box_not_running",
  "delete_confirmation_required",
  "delete_blocked",
  "deletion_operation_not_found",
  "rate_limited",
  "internal_error",
]);

export type BoxAbsoluteDeadline = number | Date;

export interface BoxCallControl {
  /** Abort this caller without weakening the adapter's own per-request timeout. */
  signal?: AbortSignal;
  /** Absolute wall-clock deadline shared by every request in the operation. */
  deadlineAt?: BoxAbsoluteDeadline;
}

export interface BoxDeadlineControl extends BoxCallControl {
  deadlineAt: BoxAbsoluteDeadline;
}

const boxIdSchema = z.string().regex(
  /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/,
  "invalid Box id",
);
const deletionOperationIdSchema = z.string().regex(
  /^bdop_[a-f0-9]{32}$/,
  "invalid Box deletion operation id",
);
const deletionStatusSchema = z.enum(["pending", "processing", "blocked", "completed"]);
const companionIdSchema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  "invalid Companion id",
);
const generationSchema = z.number().int().positive().max(MAX_GENERATION);

const boxListItemSchema = z.object({
  id: boxIdSchema,
  name: z.string().optional(),
}).passthrough();

const boxListEnvelopeSchema = z.object({
  ok: z.literal(true),
  type: z.literal("box.list"),
  boxes: z.array(boxListItemSchema),
  pageInfo: z.object({
    nextCursor: z.string().min(1).nullable(),
    hasMore: z.boolean(),
  }).optional(),
}).passthrough();

const boxCreateEnvelopeSchema = z.object({
  ok: z.literal(true),
  type: z.literal("box.created"),
  status: z.literal("provisioning"),
  ttlSeconds: z.number().int().positive().max(BOX_TTL_MAX_SECONDS),
  box: boxListItemSchema,
}).passthrough();

const boxUpdateEnvelopeSchema = z.object({
  ok: z.literal(true),
  type: z.literal("box.info"),
  box: boxListItemSchema,
}).passthrough();

const deletionOperationSchema = z.object({
  id: deletionOperationIdSchema,
  targetId: boxIdSchema,
  status: deletionStatusSchema,
  attemptCount: z.number().int().nonnegative(),
  requestedAt: z.string().min(1),
  completedAt: z.string().min(1).nullable(),
}).passthrough();

const deleteAcceptedEnvelopeSchema = z.object({
  ok: z.literal(true),
  type: z.union([z.literal("box.deleting"), z.literal("deletion.operation")]),
  operation: deletionOperationSchema,
}).passthrough();

const deletionOperationEnvelopeSchema = z.object({
  ok: z.literal(true),
  type: z.union([z.literal("deletion.operation"), z.literal("box.deleting")]),
  operation: deletionOperationSchema,
}).passthrough();

export type BoxDeletionStatus = z.infer<typeof deletionStatusSchema>;

/** The identity needed to inventory provider Boxes without retaining signed or machine URLs. */
export interface BoxMaintenanceBox {
  id: string;
  name?: string;
}

/** Exact generation-qualified Box identity. Prefix and whitespace matches are deliberately absent. */
export interface BoxGenerationDiscovery {
  name: string;
  canonical: BoxMaintenanceBox | null;
  duplicates: BoxMaintenanceBox[];
}

export interface BoxGenerationCreateInput extends BoxDeadlineControl {
  companionId: string;
  generation: number;
  ttlSeconds: number;
  setupScript?: string;
  environment?: string;
  env?: Record<string, string>;
}

/**
 * Resolution result before any rename. The created arm makes no post-create canonical/duplicate
 * claim: the caller must durably checkpoint `boxId` before applying settings and rediscovery.
 */
export type BoxGenerationCreateResult =
  | (BoxGenerationDiscovery & {
    outcome: "recovered";
    boxId: string;
  })
  | {
    outcome: "created";
    boxId: string;
    name: string;
  };

export interface BoxGenerationSettingsInput extends BoxDeadlineControl {
  boxId: string;
  companionId: string;
  generation: number;
  ttlSeconds: number;
}

export interface BoxGenerationSettingsResult {
  boxId: string;
  name: string;
  ttlSeconds: number;
}

/** Durable provider identity and state for one permanent Box deletion. */
export interface BoxDeletionOperation {
  id: string;
  targetId: string;
  status: BoxDeletionStatus;
  attemptCount: number;
  requestedAt: string;
  completedAt: string | null;
}

export type BoxPermanentDeletionResult =
  | { outcome: "accepted"; operation: BoxDeletionOperation }
  | { outcome: "absent"; boxId: string };

export type BoxPermanentDeletionTerminalResult =
  | { outcome: "deleted"; operation: BoxDeletionOperation }
  | { outcome: "blocked"; operation: BoxDeletionOperation }
  | { outcome: "already_deleted"; boxId: string };

export type BoxRuntimeAdapterStableCode =
  | "box_request_cancelled"
  | "box_request_deadline_exceeded"
  | "box_network_error"
  | "box_authentication_failed"
  | "box_not_found"
  | "box_conflict"
  | "box_rate_limited"
  | "box_provider_unavailable"
  | "box_request_rejected"
  | "invalid_provider_response"
  | "box_deletion_deadline_exceeded";

/**
 * Provider failure safe to persist as runtime metadata. `message` is fixed adapter copy: response
 * bodies, signed URLs, request URLs, tokens, and arbitrary provider diagnostics never cross it.
 */
export class BoxRuntimeAdapterError extends BoxRuntimeProviderError {
  readonly stableCode: BoxRuntimeAdapterStableCode;
  readonly providerCode?: string;
  readonly retryable: boolean;
  readonly outcomeUnknown: boolean;

  constructor(input: {
    stableCode: BoxRuntimeAdapterStableCode;
    message: string;
    status: number;
    providerCode?: string;
    retryable: boolean;
    outcomeUnknown: boolean;
  }) {
    // Keep the inherited provider code for backwards-compatible operational branching. Runtime v2
    // persists stableCode instead; providerCode is allowlisted to a bounded identifier below.
    super(input.message, input.status, input.providerCode ?? input.stableCode);
    this.stableCode = input.stableCode;
    this.providerCode = input.providerCode;
    this.retryable = input.retryable;
    this.outcomeUnknown = input.outcomeUnknown;
  }
}

export interface BoxMaintenanceClient {
  /** Read every Box page. Ownership and name matching remain the purge command's responsibility. */
  listAllBoxes(input?: BoxCallControl): Promise<BoxMaintenanceBox[]>;
  /** Request irreversible deletion. A provider 404 is surfaced explicitly for caller policy. */
  requestPermanentDeletion(input: {
    boxId: string;
  } & BoxCallControl): Promise<BoxPermanentDeletionResult>;
  /** Read one retained operation and prove it still belongs to the expected Box. */
  getDeletionOperation(input: {
    operationId: string;
    boxId: string;
  } & BoxCallControl): Promise<BoxDeletionOperation>;
}

/** Additive Runtime v2 lifecycle surface; purge-only fakes may keep implementing the narrow base. */
export interface BoxRuntimeLifecycleClient extends BoxMaintenanceClient {
  findGenerationBoxes(input: {
    companionId: string;
    generation: number;
  } & BoxDeadlineControl): Promise<BoxGenerationDiscovery>;
  createOrRecoverGenerationBox(input: BoxGenerationCreateInput): Promise<BoxGenerationCreateResult>;
  applyGenerationBoxSettings(
    input: BoxGenerationSettingsInput,
  ): Promise<BoxGenerationSettingsResult>;
  deletePermanentlyAndWait(input: {
    boxId: string;
    operationId?: string;
    pollIntervalMs?: number;
  } & BoxDeadlineControl): Promise<BoxPermanentDeletionTerminalResult>;
}

interface BoxRequestResult {
  status: number;
  body: unknown;
}

function adapterError(input: ConstructorParameters<typeof BoxRuntimeAdapterError>[0]): BoxRuntimeAdapterError {
  return new BoxRuntimeAdapterError(input);
}

function invalidProviderResponse(
  message: string,
  outcomeUnknown = false,
): BoxRuntimeAdapterError {
  return adapterError({
    stableCode: "invalid_provider_response",
    message,
    status: 502,
    retryable: false,
    outcomeUnknown,
  });
}

function assertBoxId(value: string): string {
  const parsed = boxIdSchema.safeParse(value);
  if (!parsed.success) throw new BoxRuntimeConfigurationError("Invalid Box id");
  return parsed.data;
}

function assertOperationId(value: string): string {
  const parsed = deletionOperationIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new BoxRuntimeConfigurationError("Invalid Box deletion operation id");
  }
  return parsed.data;
}

function assertGenerationIdentity(input: { companionId: string; generation: number }): {
  companionId: string;
  generation: number;
} {
  const companionId = companionIdSchema.safeParse(input.companionId);
  const generation = generationSchema.safeParse(input.generation);
  if (!companionId.success) {
    throw new BoxRuntimeConfigurationError("Invalid Companion id");
  }
  if (!generation.success) {
    throw new BoxRuntimeConfigurationError("Invalid runtime generation");
  }
  return { companionId: companionId.data, generation: generation.data };
}

function assertPositiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new BoxRuntimeConfigurationError(`${label} must be a positive integer`);
  }
  return value;
}

function assertBoxTtlSeconds(value: number): number {
  const ttlSeconds = assertPositiveInteger(value, "Box TTL seconds");
  if (ttlSeconds > BOX_TTL_MAX_SECONDS) {
    throw new BoxRuntimeConfigurationError(
      `Box TTL seconds must not exceed ${BOX_TTL_MAX_SECONDS}`,
    );
  }
  return ttlSeconds;
}

function deadlineMilliseconds(deadlineAt: BoxAbsoluteDeadline | undefined): number | undefined {
  if (deadlineAt === undefined) return undefined;
  const milliseconds = deadlineAt instanceof Date ? deadlineAt.getTime() : deadlineAt;
  if (!Number.isFinite(milliseconds)) {
    throw new BoxRuntimeConfigurationError("Box deadline must be a finite timestamp");
  }
  return milliseconds;
}

function safeProviderCode(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_PROVIDER_CODES.has(value)
    ? value
    : undefined;
}

function classifiedHttpError(input: {
  status: number;
  providerCode?: string;
  outcomeUnknown: boolean;
}): BoxRuntimeAdapterError {
  const common = {
    status: input.status,
    providerCode: input.providerCode,
    outcomeUnknown: input.outcomeUnknown,
  };
  if (input.status === 401 || input.status === 403) {
    return adapterError({
      ...common,
      stableCode: "box_authentication_failed",
      message: "Box provider authentication failed",
      retryable: false,
    });
  }
  if (input.status === 404) {
    return adapterError({
      ...common,
      stableCode: "box_not_found",
      message: "The Box provider resource was not found",
      retryable: false,
    });
  }
  if (input.status === 409) {
    return adapterError({
      ...common,
      stableCode: "box_conflict",
      message: "The Box request conflicted with current provider state",
      retryable: false,
    });
  }
  if (input.status === 429) {
    return adapterError({
      ...common,
      stableCode: "box_rate_limited",
      message: "The Box provider rate limited the request",
      retryable: true,
    });
  }
  if (input.status === 408 || input.status === 425 || input.status >= 500) {
    return adapterError({
      ...common,
      stableCode: "box_provider_unavailable",
      message: "The Box provider is temporarily unavailable",
      retryable: true,
    });
  }
  return adapterError({
    ...common,
    stableCode: "box_request_rejected",
    message: "The Box provider rejected the request",
    retryable: false,
  });
}

export function companionGenerationBoxName(input: {
  companionId: string;
  generation: number;
}): string {
  const identity = assertGenerationIdentity(input);
  return `Companion ${identity.companionId} g${identity.generation}`;
}

function selectGenerationBoxes(
  boxes: readonly BoxMaintenanceBox[],
  name: string,
): BoxGenerationDiscovery {
  const matches = boxes
    .filter((box) => box.name === name)
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  return {
    name,
    canonical: matches[0] ?? null,
    duplicates: matches.slice(1),
  };
}

function checkedOperation(
  value: unknown,
  expected: { operationId?: string; boxId: string },
  outcomeUnknown = false,
): BoxDeletionOperation {
  const parsed = deletionOperationSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidProviderResponse("Box API returned an invalid deletion operation", outcomeUnknown);
  }
  const operation = parsed.data;
  if (expected.operationId !== undefined && operation.id !== expected.operationId) {
    throw invalidProviderResponse("Box API returned a different deletion operation", outcomeUnknown);
  }
  if (operation.targetId !== expected.boxId) {
    throw invalidProviderResponse(
      "Box API returned a deletion operation for a different Box",
      outcomeUnknown,
    );
  }
  if (
    (operation.status === "completed" && operation.completedAt === null)
    || (operation.status !== "completed" && operation.completedAt !== null)
  ) {
    throw invalidProviderResponse(
      "Box API returned an inconsistent deletion operation state",
      outcomeUnknown,
    );
  }
  return operation;
}

/**
 * Narrow Box lifecycle client used by durable purge/runtime code. It exposes generation-qualified
 * create/recovery and permanent deletion, but no command, file, desktop, archive, or Pi surface.
 */
export class AsciiBoxMaintenanceClient implements BoxRuntimeLifecycleClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    const apiKey = env.COMPANION_BOX_API_KEY?.trim();
    if (!apiKey) {
      throw new BoxRuntimeConfigurationError(
        "Box runtime is not configured; set COMPANION_BOX_API_KEY",
      );
    }
    this.#apiKey = apiKey;
    this.#baseUrl = (env.COMPANION_BOX_API_BASE?.trim() || DEFAULT_BOX_API_BASE).replace(/\/+$/, "");
  }

  #requestSignal(control: BoxCallControl): {
    signal: AbortSignal;
    deadlineAt: number;
    callerSignal?: AbortSignal;
  } {
    const callerDeadline = deadlineMilliseconds(control.deadlineAt);
    const deadlineAt = Math.min(
      Date.now() + BOX_REQUEST_TIMEOUT_MS,
      callerDeadline ?? Number.POSITIVE_INFINITY,
    );
    const remaining = deadlineAt - Date.now();
    if (remaining <= 0) {
      throw adapterError({
        stableCode: "box_request_deadline_exceeded",
        message: "The Box request deadline elapsed",
        status: 504,
        retryable: true,
        outcomeUnknown: false,
      });
    }
    const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    return {
      signal: control.signal ? AbortSignal.any([timeout, control.signal]) : timeout,
      deadlineAt,
      ...(control.signal ? { callerSignal: control.signal } : {}),
    };
  }

  async #request(
    path: string,
    init: RequestInit | undefined,
    control: BoxCallControl,
    outcomeUnknownOnTransportFailure = false,
  ): Promise<BoxRequestResult> {
    const requestControl = this.#requestSignal(control);
    let response: Response;
    try {
      response = await fetch(`${this.#baseUrl}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          ...(init?.body ? { "Content-Type": "application/json" } : {}),
          ...init?.headers,
        },
        signal: requestControl.signal,
      });
    } catch {
      if (requestControl.callerSignal?.aborted) {
        throw adapterError({
          stableCode: "box_request_cancelled",
          message: "The Box request was cancelled",
          status: 499,
          retryable: false,
          outcomeUnknown: outcomeUnknownOnTransportFailure,
        });
      }
      if (Date.now() >= requestControl.deadlineAt || requestControl.signal.aborted) {
        throw adapterError({
          stableCode: "box_request_deadline_exceeded",
          message: "The Box request deadline elapsed",
          status: 504,
          retryable: true,
          outcomeUnknown: outcomeUnknownOnTransportFailure,
        });
      }
      throw adapterError({
        stableCode: "box_network_error",
        message: "The Box provider could not be reached",
        status: 503,
        retryable: true,
        outcomeUnknown: outcomeUnknownOnTransportFailure,
      });
    }

    if (!response.ok) {
      const body = await response.json().catch(() => null) as
        | { code?: string; message?: string; error?: { message?: string } }
        | null;
      const mutationCouldHaveCommitted = outcomeUnknownOnTransportFailure
        && (response.status === 408
          || response.status === 425
          || response.status === 429
          || response.status >= 500);
      throw classifiedHttpError({
        status: response.status,
        providerCode: safeProviderCode(body?.code),
        outcomeUnknown: mutationCouldHaveCommitted,
      });
    }

    try {
      return { status: response.status, body: await response.json() as unknown };
    } catch {
      throw invalidProviderResponse("Box API returned invalid JSON", outcomeUnknownOnTransportFailure);
    }
  }

  async listAllBoxes(input: BoxCallControl = {}): Promise<BoxMaintenanceBox[]> {
    const boxes: BoxMaintenanceBox[] = [];
    const seenBoxIds = new Set<string>();
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    do {
      const query = new URLSearchParams({ limit: String(BOX_LIST_PAGE_LIMIT), sort: "desc" });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await this.#request(`/boxes?${query}`, undefined, input);
      if (response.status !== 200) {
        throw invalidProviderResponse("Box API returned an unexpected list status");
      }
      const parsed = boxListEnvelopeSchema.safeParse(response.body);
      if (!parsed.success) {
        throw invalidProviderResponse("Box API returned an invalid Box list");
      }

      const pageInfo = parsed.data.pageInfo;
      if (!pageInfo) {
        if (parsed.data.boxes.length === BOX_LIST_PAGE_LIMIT) {
          throw invalidProviderResponse("Box API omitted pagination for a full Box list page");
        }
        cursor = null;
      } else if (!pageInfo.hasMore) {
        if (pageInfo.nextCursor !== null) {
          throw invalidProviderResponse("Box API returned inconsistent Box list pagination");
        }
        cursor = null;
      } else {
        if (pageInfo.nextCursor === null || seenCursors.has(pageInfo.nextCursor)) {
          throw invalidProviderResponse("Box API returned invalid Box list pagination");
        }
        seenCursors.add(pageInfo.nextCursor);
        cursor = pageInfo.nextCursor;
      }

      for (const box of parsed.data.boxes) {
        if (seenBoxIds.has(box.id)) {
          throw invalidProviderResponse("Box API repeated a Box across list pages");
        }
        seenBoxIds.add(box.id);
        boxes.push({
          id: box.id,
          ...(box.name === undefined ? {} : { name: box.name }),
        });
      }
    } while (cursor !== null);

    return boxes;
  }

  async requestPermanentDeletion(input: {
    boxId: string;
  } & BoxCallControl): Promise<BoxPermanentDeletionResult> {
    const boxId = assertBoxId(input.boxId);
    let response: BoxRequestResult;
    try {
      response = await this.#request(
        `/boxes/${encodeURIComponent(boxId)}`,
        {
          method: "DELETE",
          headers: { "X-Ascii-Confirm-Delete": boxId },
        },
        input,
        true,
      );
    } catch (error) {
      if (
        error instanceof BoxRuntimeProviderError
        && error.status === 404
        && error.code === "box_not_found"
      ) {
        return { outcome: "absent", boxId };
      }
      throw error;
    }

    if (response.status !== 202) {
      throw invalidProviderResponse(
        "Box API returned an unexpected permanent deletion status",
        true,
      );
    }
    const parsed = deleteAcceptedEnvelopeSchema.safeParse(response.body);
    if (!parsed.success) {
      throw invalidProviderResponse(
        "Box API returned an invalid permanent deletion response",
        true,
      );
    }
    return {
      outcome: "accepted",
      operation: checkedOperation(parsed.data.operation, { boxId }, true),
    };
  }

  async getDeletionOperation(input: {
    operationId: string;
    boxId: string;
  } & BoxCallControl): Promise<BoxDeletionOperation> {
    const operationId = assertOperationId(input.operationId);
    const boxId = assertBoxId(input.boxId);
    const response = await this.#request(
      `/deletion-operations/${encodeURIComponent(operationId)}`,
      undefined,
      input,
    );
    if (response.status !== 200) {
      throw invalidProviderResponse("Box API returned an unexpected deletion operation status");
    }
    const parsed = deletionOperationEnvelopeSchema.safeParse(response.body);
    if (!parsed.success) {
      throw invalidProviderResponse("Box API returned an invalid deletion operation response");
    }
    return checkedOperation(parsed.data.operation, { operationId, boxId });
  }

  /**
   * Discover only the exact generation-qualified name across every provider page. Canonical choice
   * is deterministic by Box id; the caller gets every other id explicitly for permanent deletion.
   */
  async findGenerationBoxes(input: {
    companionId: string;
    generation: number;
  } & BoxDeadlineControl): Promise<BoxGenerationDiscovery> {
    const name = companionGenerationBoxName(input);
    return selectGenerationBoxes(await this.listAllBoxes(input), name);
  }

  /**
   * Resolve an exact generation name or issue one create POST. Create cannot assign a name, so an
   * ambiguous POST is never "reconciled" through name lookup and is never replayed here. A valid
   * 202 exposes the provider id immediately so runtime can checkpoint it before any PATCH.
   */
  async createOrRecoverGenerationBox(
    input: BoxGenerationCreateInput,
  ): Promise<BoxGenerationCreateResult> {
    const name = companionGenerationBoxName(input);
    const ttlSeconds = assertBoxTtlSeconds(input.ttlSeconds);
    const initial = selectGenerationBoxes(await this.listAllBoxes(input), name);
    if (initial.canonical) {
      return {
        ...initial,
        outcome: "recovered",
        boxId: initial.canonical.id,
      };
    }

    const response = await this.#request(
      "/boxes",
      {
        method: "POST",
        body: JSON.stringify({
          ttlSeconds,
          noEnv: true,
          ...(input.setupScript === undefined ? {} : { setupScript: input.setupScript }),
          ...(input.environment === undefined ? {} : { environment: input.environment }),
          ...(input.env === undefined ? {} : { env: input.env }),
        }),
      },
      input,
      true,
    );
    if (response.status !== 202) {
      throw invalidProviderResponse("Box API returned an unexpected create status", true);
    }
    const parsed = boxCreateEnvelopeSchema.safeParse(response.body);
    if (!parsed.success || parsed.data.ttlSeconds !== ttlSeconds) {
      throw invalidProviderResponse("Box API returned an invalid Box create response", true);
    }
    return {
      outcome: "created",
      boxId: parsed.data.box.id,
      name,
    };
  }

  /**
   * Apply the deterministic name and warm TTL with one idempotent PATCH. This method does not retry
   * internally. Any loss after write remains outcome-unknown even though a later checkpoint may
   * safely invoke the same PATCH again using the already-persisted Box id.
   */
  async applyGenerationBoxSettings(
    input: BoxGenerationSettingsInput,
  ): Promise<BoxGenerationSettingsResult> {
    const boxId = assertBoxId(input.boxId);
    const name = companionGenerationBoxName(input);
    const ttlSeconds = assertBoxTtlSeconds(input.ttlSeconds);
    const response = await this.#request(
      `/boxes/${encodeURIComponent(boxId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name, ttlSeconds }),
      },
      input,
      true,
    );
    if (response.status !== 200) {
      throw invalidProviderResponse("Box API returned an unexpected update status", true);
    }
    const parsed = boxUpdateEnvelopeSchema.safeParse(response.body);
    if (
      !parsed.success
      || parsed.data.box.id !== boxId
      || parsed.data.box.name !== name
    ) {
      throw invalidProviderResponse("Box API returned an invalid Box update response", true);
    }
    return { boxId, name, ttlSeconds };
  }

  /** Request permanent deletion and follow its retained provider operation to a terminal result. */
  async deletePermanentlyAndWait(input: {
    boxId: string;
    /** Resume polling a durable operation without issuing DELETE again. */
    operationId?: string;
    pollIntervalMs?: number;
  } & BoxDeadlineControl): Promise<BoxPermanentDeletionTerminalResult> {
    const boxId = assertBoxId(input.boxId);
    const deadlineAt = deadlineMilliseconds(input.deadlineAt);
    if (deadlineAt === undefined) {
      throw new BoxRuntimeConfigurationError("Permanent deletion polling requires an absolute deadline");
    }
    const pollIntervalMs = assertPositiveInteger(
      input.pollIntervalMs ?? DEFAULT_DELETION_POLL_INTERVAL_MS,
      "Deletion poll interval",
    );

    let operation: BoxDeletionOperation;
    if (input.operationId !== undefined) {
      operation = await this.getDeletionOperation({
        operationId: input.operationId,
        boxId,
        deadlineAt,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } else {
      const requested = await this.requestPermanentDeletion({
        boxId,
        deadlineAt,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (requested.outcome === "absent") {
        return { outcome: "already_deleted", boxId };
      }
      operation = requested.operation;
    }

    while (true) {
      if (operation.status === "completed") return { outcome: "deleted", operation };
      if (operation.status === "blocked") return { outcome: "blocked", operation };

      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        throw adapterError({
          stableCode: "box_deletion_deadline_exceeded",
          message: "The Box deletion deadline elapsed",
          status: 504,
          retryable: true,
          outcomeUnknown: false,
        });
      }
      await new Promise<void>((resolve, reject) => {
        const finish = () => {
          input.signal?.removeEventListener("abort", abort);
          resolve();
        };
        const timer = setTimeout(finish, Math.min(pollIntervalMs, remaining));
        const abort = () => {
          clearTimeout(timer);
          input.signal?.removeEventListener("abort", abort);
          reject(adapterError({
            stableCode: "box_request_cancelled",
            message: "The Box request was cancelled",
            status: 499,
            retryable: false,
            outcomeUnknown: false,
          }));
        };
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) abort();
      });
      if (Date.now() >= deadlineAt) {
        throw adapterError({
          stableCode: "box_deletion_deadline_exceeded",
          message: "The Box deletion deadline elapsed",
          status: 504,
          retryable: true,
          outcomeUnknown: false,
        });
      }
      operation = await this.getDeletionOperation({
        operationId: operation.id,
        boxId,
        deadlineAt,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    }
  }
}
