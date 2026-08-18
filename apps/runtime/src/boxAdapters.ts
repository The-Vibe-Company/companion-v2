import {
  observedBoxStateFromProvider,
  type BoxRuntimeLifecycleClient,
  type CompanionBoxRuntimeV2,
  type BoxState,
} from "@companion/box-runtime";
import type {
  BrokerWriteOutcome,
  RuntimeBoxControl,
  RuntimePiControl,
} from "@companion/companion-runtime";

export interface RuntimeBoxAdapterOptions {
  lifecycle: BoxRuntimeLifecycleClient;
  /** Fresh adapter per port call prevents one staging call's signal budget leaking into another. */
  runtime(): CompanionBoxRuntimeV2;
  /** Each provider operation gets a bound even when delete/health work has no turn deadline. */
  providerDeadlineMs?: number;
  now?: () => number;
}

export function createRuntimeBoxControl(options: RuntimeBoxAdapterOptions): RuntimeBoxControl {
  const deadline = providerDeadlineFactory(options);
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
      const result = await options.lifecycle.createOrRecoverGenerationBox({
        companionId: input.companionId,
        generation: generationNumber(input.generation),
        ttlSeconds: input.ttlSeconds,
        deadlineAt: deadline(input.deadlineAt),
        signal: input.signal,
      });
      return result.outcome === "created"
        ? result
        : { ...normalizeDiscovery(result), outcome: "recovered", boxId: result.boxId };
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
      const observed = await options.runtime().existingBoxStatus(input);
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
      return brokerState(await options.runtime().brokerState(input));
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
  result: Awaited<ReturnType<CompanionBoxRuntimeV2["dispatchPrompt"]>>,
): BrokerWriteOutcome {
  if (result.outcome === "refused") return { outcome: "rejected", code: result.code };
  if (result.outcome === "ambiguous") return { outcome: "ambiguous", code: result.code };
  return { outcome: "accepted", invocationId: result.invocationId };
}

function brokerState(
  state: Awaited<ReturnType<CompanionBoxRuntimeV2["brokerState"]>>,
): Awaited<ReturnType<RuntimePiControl["brokerState"]>> {
  return {
    ...state,
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

const DEFAULT_PROVIDER_DEADLINE_MS = 30_000;

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
