/* oxlint-disable anti-slop/no-conditional-empty-object-spread, anti-slop/no-known-value-widening, anti-slop/no-unknown-parameters -- Optional lifecycle inputs are conditionally spread; cleanup callbacks receive unknown thrown values by design. */
import {
  observedBoxStateFromProvider,
  BoxRuntimeAdapterError,
  type BoxRuntimeLifecycleClient,
  type CompanionBoxRuntimeV2,
  type BoxState,
} from "@companion/box-runtime";
import { COMPANION_BUDGETS_BASE } from "@companion/contracts";
import type {
  BrokerWriteOutcome,
  BrokerPromptWriteOutcome,
  RuntimeBoxControl,
  RuntimePiControl,
  RuntimeProcessLog,
} from "@companion/companion-runtime";

/** How long a Box create waits on the registry's published build before a cold install. */
export const RUNTIME_IMAGE_WAIT_MS = 60_000;

/** The durable image registry as seen by Box creation. Status is published in PostgreSQL. */
export interface RuntimeImageSource {
  expectedName(): string;
  cloneName(): string | null;
  /**
   * Resolves with the registry's published outcome for this digest: `ready` (clone
   * expectedName), `failed`, or `pending` past the bound (cold install remains possible).
   */
  waitForResolution(
    boundMs: number,
    signal: AbortSignal,
  ): Promise<"ready" | "failed" | "pending">;
}

export interface RuntimeBoxAdapterOptions {
  lifecycle: BoxRuntimeLifecycleClient;
  /** Fresh adapter per port call prevents one staging call's signal budget leaking into another. */
  runtime(): CompanionBoxRuntimeV2;
  /** Named snapshot source to clone when the baker has a ready layout image. */
  runtimeImage?: RuntimeImageSource;
  /** Structured create evidence: fromImage, fallback reason, and timings. Never secrets. */
  log?: RuntimeProcessLog;
  /** Each provider operation gets a bound even when delete/health work has no turn deadline. */
  providerDeadlineMs?: number;
  now?: () => number;
}

export function createRuntimeBoxControl(options: RuntimeBoxAdapterOptions): RuntimeBoxControl {
  const deadline = providerDeadlineFactory(options);
  const now = options.now ?? Date.now;
  return {
    async findGenerationBoxes(input) {
      const result = await options.lifecycle.findGenerationBoxes({
        companionId: input.companionId,
        generation: generationNumber(input.generation),
        deadlineAt: deadline(input.deadlineAt),
        signal: input.signal,
      });
      return normalizeDiscovery(result);
    },
    async createGenerationBox(input) {
      const startedAt = now();
      const image = options.runtimeImage;
      let from = image?.cloneName() ?? undefined;
      let imageWaitMs = 0;
      let fallbackReason:
        | "image_build_pending" | "image_build_failed" | "no_snapshot"
        | "unknown_snapshot_fallback" | undefined;
      if (image && from === undefined) {
        // Wait on the registry's published build state instead of racing in-process baker
        // memory; the bound keeps a broken build from consuming the operation deadline.
        const waitStartedAt = now();
        const resolution = await image.waitForResolution(RUNTIME_IMAGE_WAIT_MS, input.signal);
        imageWaitMs = now() - waitStartedAt;
        if (resolution === "ready") {
          from = image.expectedName();
        } else {
          fallbackReason = resolution === "failed" ? "image_build_failed" : "image_build_pending";
        }
      }
      const create = (fromImage?: string) =>
        options.lifecycle.createGenerationBoxAfterObservedAbsence({
        companionId: input.companionId,
        generation: generationNumber(input.generation),
        ttlSeconds: input.ttlSeconds,
        deadlineAt: deadline(input.deadlineAt),
        signal: input.signal,
        ...(fromImage ? { from: fromImage } : {}),
        });
      let created: Awaited<ReturnType<typeof create>>;
      try {
        created = await create(from);
      } catch (error) {
        if (!from || !isUnknownSnapshot(error)) throw error;
        fallbackReason = "unknown_snapshot_fallback";
        from = undefined;
        created = await create();
      }
      const result = created;
      options.log?.info({
        ts: new Date(now()).toISOString(),
        event: "runtime.box.create",
        companionId: input.companionId,
        generation: generationNumber(input.generation),
        expectedImage: image?.expectedName() ?? null,
        fromImage: from ?? null,
        ...(fallbackReason ? { fallbackReason } : {}),
        imageWaitMs,
        durationMs: now() - startedAt,
        outcome: result.outcome,
      });
      return result;
    },
    async applyGenerationBoxSettings(input) {
      await options.lifecycle.applyGenerationBoxSettings({
        boxId: input.boxId,
        companionId: input.companionId,
        generation: generationNumber(input.generation),
        ttlSeconds: input.ttlSeconds,
        deadlineAt: deadline(input.deadlineAt),
        signal: input.signal,
      });
    },
    async getStatus(input) {
      const observed = await options.runtime().existingBoxStatus({
        boxId: input.boxId,
        ...(input.companionId !== undefined ? { companionId: input.companionId } : {}),
        ...(input.generation !== undefined
          ? { runtimeGeneration: generationNumber(input.generation) }
          : {}),
        signal: input.signal,
      });
      return { state: observedBoxStateFromProvider(observed.state) };
    },
    async setTtl(input) {
      await options.runtime().refreshTtl(input);
    },
    async stopExistingBox(input) {
      await options.runtime().archiveExistingBox(input);
    },
    async resumeExistingBox(input) {
      await options.runtime().resumeExistingBox(input);
    },
    async requestPermanentDeletion(input) {
      const result = await options.lifecycle.requestPermanentDeletion({
        ...input,
        deadlineAt: deadline(),
      });
      return result.outcome === "absent"
        ? { outcome: "absent" }
        : { outcome: "accepted", operationId: result.operation.id };
    },
    async pollPermanentDeletion(input) {
      const operation = await options.lifecycle.getDeletionOperation({
        ...input,
        deadlineAt: deadline(),
      });
      if (operation.status === "completed") return { status: "completed" };
      if (operation.status === "blocked") return { status: "blocked" };
      return { status: operation.status };
    },
  };
}

export function createRuntimePiControl(options: RuntimeBoxAdapterOptions): RuntimePiControl {
  return {
    async stopPiDaemon(input) {
      await options.runtime().stopPiDaemon(input);
    },
    async startPiDaemon(input) {
      return await options.runtime().startPiDaemon(input);
    },
    async restartPiDaemon(input) {
      return await options.runtime().restartPiDaemon(input);
    },
    async piDaemonStatus(input) {
      return await options.runtime().piDaemonStatus(input);
    },
    async brokerState(input) {
      const runtime = options.runtime();
      return brokerState(
        await runtime.brokerState(input),
        runtime.layoutIdentity().fullMarker,
      );
    },
    async prompt(input) {
      input.signal.throwIfAborted();
      const runtime = options.runtime();
      const result = await runtime.dispatchPrompt({
        boxId: input.boxId,
        attemptId: input.attemptId,
        message: input.message,
        requestId: input.commandId,
        signal: input.signal,
      });
      return promptWriteOutcome(result);
    },
    async abort(input) {
      input.signal.throwIfAborted();
      const runtime = options.runtime();
      const result = await runtime.dispatchAbort({
        boxId: input.boxId,
        attemptId: input.attemptId,
        requestId: input.commandId,
        signal: input.signal,
      });
      return writeOutcome(result);
    },
    async readBrokerEvents(input) {
      return await options.runtime().readEvents({
        boxId: input.boxId,
        after: cursorNumber(input.after),
        signal: input.signal,
      });
    },
    async ackBrokerEvents(input) {
      const acknowledged = await options.runtime().ackEvents({
        boxId: input.boxId,
        through: cursorNumber(input.through),
        signal: input.signal,
      });
      return BigInt(acknowledged.acknowledgedCursor);
    },
    async respondExtensionUi(input) {
      input.signal.throwIfAborted();
      const runtime = options.runtime();
      const result = await runtime.dispatchExtensionUi({
        boxId: input.boxId,
        attemptId: input.attemptId,
        requestId: input.commandId,
        response: input.response,
        signal: input.signal,
      });
      return writeOutcome(result);
    },
  };
}

function writeOutcome(
  result: Awaited<ReturnType<CompanionBoxRuntimeV2["dispatchAbort"]>>,
): BrokerWriteOutcome {
  if (result.outcome === "refused") return { outcome: "rejected", code: result.code };
  if (result.outcome === "ambiguous") return { outcome: "ambiguous", code: result.code };
  return {
    outcome: "accepted",
    invocationId: result.invocationId,
  };
}

function promptWriteOutcome(
  result: Awaited<ReturnType<CompanionBoxRuntimeV2["dispatchPrompt"]>>,
): BrokerPromptWriteOutcome {
  if (result.outcome === "refused") return { outcome: "rejected", code: result.code };
  if (result.outcome === "ambiguous") return { outcome: "ambiguous", code: result.code };
  return {
    outcome: "accepted",
    invocationId: result.invocationId,
    initialCursor: BigInt(result.initialCursor),
  };
}

function brokerState(
  state: Awaited<ReturnType<CompanionBoxRuntimeV2["brokerState"]>>,
  expectedLayoutMarker: string,
): Awaited<ReturnType<RuntimePiControl["brokerState"]>> {
  return {
    ...state,
    layoutCurrent: state.layoutMarker === expectedLayoutMarker,
    tailCursor: BigInt(state.tailCursor),
    acknowledgedCursor: BigInt(state.acknowledgedCursor),
  };
}

function normalizeDiscovery(input: {
  name: string;
  canonical: { id: string; name?: string; state?: BoxState } | null;
  duplicates: Array<{ id: string; name?: string; state?: BoxState }>;
}): {
  name: string;
  canonical: { id: string; name: string; state?: ReturnType<typeof observedBoxStateFromProvider> } | null;
  duplicates: Array<{ id: string; name: string; state?: ReturnType<typeof observedBoxStateFromProvider> }>;
} {
  const named = (box: { id: string; name?: string; state?: BoxState }) => ({
    id: box.id,
    name: box.name ?? input.name,
    ...(box.state ? { state: observedBoxStateFromProvider(box.state) } : {}),
  });
  return {
    name: input.name,
    canonical: input.canonical ? named(input.canonical) : null,
    duplicates: input.duplicates.map(named),
  };
}

function generationNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 2_147_483_647) {
    throw new TypeError("Runtime generation is outside the Box identity range");
  }
  return number;
}

function cursorNumber(value: bigint): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("Pi broker cursor is outside the safe integer range");
  }
  return number;
}

function isUnknownSnapshot(error: unknown): boolean {
  if (!(error instanceof BoxRuntimeAdapterError)) return false;
  return error.providerCode === "unknown_snapshot" || error.stableCode === "box_not_found";
}

const DEFAULT_PROVIDER_DEADLINE_MS = COMPANION_BUDGETS_BASE.boxRequestTimeoutMs;

function providerDeadlineFactory(options: RuntimeBoxAdapterOptions): (value?: Date) => Date {
  const now = options.now ?? Date.now;
  const timeout = options.providerDeadlineMs ?? DEFAULT_PROVIDER_DEADLINE_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000) {
    throw new TypeError("Box provider deadline must be between 1 and 120000 milliseconds");
  }
  return (value?: Date): Date => {
    const boundedAt = now() + timeout;
    if (value === undefined) return new Date(boundedAt);
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
      throw new TypeError("Box lifecycle work requires a valid absolute deadline");
    }
    return new Date(Math.min(value.getTime(), boundedAt));
  };
}
