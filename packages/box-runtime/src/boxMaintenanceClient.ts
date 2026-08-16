import { z } from "zod";
import {
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
} from "./boxCompanionRuntime";

const DEFAULT_BOX_API_BASE = "https://ascii.dev/api/box/v1";
const BOX_REQUEST_TIMEOUT_MS = 30_000;
const BOX_LIST_PAGE_LIMIT = 200;

const boxIdSchema = z.string().regex(
  /^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$/,
  "invalid Box id",
);
const deletionOperationIdSchema = z.string().regex(
  /^bdop_[a-f0-9]{32}$/,
  "invalid Box deletion operation id",
);
const deletionStatusSchema = z.enum(["pending", "processing", "blocked", "completed"]);

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
  type: z.literal("deletion.operation"),
  operation: deletionOperationSchema,
}).passthrough();

export type BoxDeletionStatus = z.infer<typeof deletionStatusSchema>;

/** The identity needed to inventory provider Boxes without retaining signed or machine URLs. */
export interface BoxMaintenanceBox {
  id: string;
  name?: string;
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

export interface BoxMaintenanceClient {
  /** Read every Box page. Ownership and name matching remain the purge command's responsibility. */
  listAllBoxes(input?: { signal?: AbortSignal }): Promise<BoxMaintenanceBox[]>;
  /** Request irreversible deletion. A provider 404 is surfaced explicitly for caller policy. */
  requestPermanentDeletion(input: {
    boxId: string;
    signal?: AbortSignal;
  }): Promise<BoxPermanentDeletionResult>;
  /** Read one retained operation and prove it still belongs to the expected Box. */
  getDeletionOperation(input: {
    operationId: string;
    boxId: string;
    signal?: AbortSignal;
  }): Promise<BoxDeletionOperation>;
}

interface BoxRequestResult {
  status: number;
  body: unknown;
}

function invalidProviderResponse(message: string): BoxRuntimeProviderError {
  return new BoxRuntimeProviderError(message, 502, "invalid_provider_response");
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

function checkedOperation(
  value: unknown,
  expected: { operationId?: string; boxId: string },
): BoxDeletionOperation {
  const parsed = deletionOperationSchema.safeParse(value);
  if (!parsed.success) {
    throw invalidProviderResponse("Box API returned an invalid deletion operation");
  }
  const operation = parsed.data;
  if (expected.operationId !== undefined && operation.id !== expected.operationId) {
    throw invalidProviderResponse("Box API returned a different deletion operation");
  }
  if (operation.targetId !== expected.boxId) {
    throw invalidProviderResponse("Box API returned a deletion operation for a different Box");
  }
  if (
    (operation.status === "completed" && operation.completedAt === null)
    || (operation.status !== "completed" && operation.completedAt !== null)
  ) {
    throw invalidProviderResponse("Box API returned an inconsistent deletion operation state");
  }
  return operation;
}

/**
 * Narrow administrative Box client used by durable purge/lifecycle code. It intentionally exposes
 * no create, command, file, desktop, archive, or Pi surface.
 */
export class AsciiBoxMaintenanceClient implements BoxMaintenanceClient {
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

  #requestSignal(callerSignal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(BOX_REQUEST_TIMEOUT_MS);
    return callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  }

  async #request(path: string, init?: RequestInit): Promise<BoxRequestResult> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        ...init?.headers,
      },
      signal: this.#requestSignal(init?.signal ?? undefined),
    });

    if (!response.ok) {
      const body = await response.json().catch(() => null) as
        | { code?: string; message?: string; error?: { message?: string } }
        | null;
      throw new BoxRuntimeProviderError(
        body?.message || body?.error?.message || `Box API request failed with ${response.status}`,
        response.status,
        body?.code,
      );
    }

    try {
      return { status: response.status, body: await response.json() as unknown };
    } catch {
      throw invalidProviderResponse("Box API returned invalid JSON");
    }
  }

  async listAllBoxes(input: { signal?: AbortSignal } = {}): Promise<BoxMaintenanceBox[]> {
    const boxes: BoxMaintenanceBox[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    do {
      const query = new URLSearchParams({ limit: String(BOX_LIST_PAGE_LIMIT), sort: "desc" });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await this.#request(`/boxes?${query}`, { signal: input.signal });
      if (response.status !== 200) {
        throw invalidProviderResponse("Box API returned an unexpected list status");
      }
      const parsed = boxListEnvelopeSchema.safeParse(response.body);
      if (!parsed.success) {
        throw invalidProviderResponse("Box API returned an invalid Box list");
      }

      boxes.push(...parsed.data.boxes.map((box) => ({
        id: box.id,
        ...(box.name === undefined ? {} : { name: box.name }),
      })));

      const pageInfo = parsed.data.pageInfo;
      if (!pageInfo) {
        if (parsed.data.boxes.length === BOX_LIST_PAGE_LIMIT) {
          throw invalidProviderResponse("Box API omitted pagination for a full Box list page");
        }
        cursor = null;
        continue;
      }
      if (!pageInfo.hasMore) {
        if (pageInfo.nextCursor !== null) {
          throw invalidProviderResponse("Box API returned inconsistent Box list pagination");
        }
        cursor = null;
        continue;
      }
      if (pageInfo.nextCursor === null || seenCursors.has(pageInfo.nextCursor)) {
        throw invalidProviderResponse("Box API returned invalid Box list pagination");
      }
      seenCursors.add(pageInfo.nextCursor);
      cursor = pageInfo.nextCursor;
    } while (cursor !== null);

    return boxes;
  }

  async requestPermanentDeletion(input: {
    boxId: string;
    signal?: AbortSignal;
  }): Promise<BoxPermanentDeletionResult> {
    const boxId = assertBoxId(input.boxId);
    let response: BoxRequestResult;
    try {
      response = await this.#request(`/boxes/${encodeURIComponent(boxId)}`, {
        method: "DELETE",
        headers: { "X-Ascii-Confirm-Delete": boxId },
        signal: input.signal,
      });
    } catch (error) {
      if (error instanceof BoxRuntimeProviderError && error.status === 404) {
        return { outcome: "absent", boxId };
      }
      throw error;
    }

    if (response.status !== 202) {
      throw invalidProviderResponse("Box API returned an unexpected permanent deletion status");
    }
    const parsed = deleteAcceptedEnvelopeSchema.safeParse(response.body);
    if (!parsed.success) {
      throw invalidProviderResponse("Box API returned an invalid permanent deletion response");
    }
    return {
      outcome: "accepted",
      operation: checkedOperation(parsed.data.operation, { boxId }),
    };
  }

  async getDeletionOperation(input: {
    operationId: string;
    boxId: string;
    signal?: AbortSignal;
  }): Promise<BoxDeletionOperation> {
    const operationId = assertOperationId(input.operationId);
    const boxId = assertBoxId(input.boxId);
    const response = await this.#request(
      `/deletion-operations/${encodeURIComponent(operationId)}`,
      { signal: input.signal },
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
}
