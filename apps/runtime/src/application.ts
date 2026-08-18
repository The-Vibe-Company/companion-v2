import type { RuntimeServiceConfig } from "./config";
import type {
  RuntimeHttpServer,
  RuntimeSchedulerHealthSnapshot,
} from "./server";

export interface RuntimeGateStatus {
  enabled: boolean;
  gateEpoch: bigint;
  updatedAt: Date;
}

export interface RuntimeApplicationStore {
  ping(): Promise<void>;
  gateStatus(): Promise<RuntimeGateStatus>;
  disable(expectedGateEpoch: bigint, actorId: string): Promise<RuntimeGateStatus>;
}

export interface RuntimeApplicationScheduler {
  start(): void | Promise<void>;
  stopClaims(): void | Promise<void>;
  /** Stops local I/O and abandons active leases for expiry-based replica takeover. */
  shutdown(input: { drainTimeoutMs: number }): Promise<void>;
  snapshot(): RuntimeSchedulerHealthSnapshot;
}

export interface RuntimeApplication {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface RuntimeApplicationOptions {
  config: RuntimeServiceConfig;
  store: RuntimeApplicationStore;
  scheduler: RuntimeApplicationScheduler;
  server: RuntimeHttpServer;
  closeResources(): Promise<void>;
}

const MAX_DISABLE_SERIALIZATION_ATTEMPTS = 5;

/**
 * Owns process ordering, but none of the turn state machine. In particular the scheduler is the
 * component that distinguishes process handoff from a feature-gate interruption.
 */
export function createRuntimeApplication(options: RuntimeApplicationOptions): RuntimeApplication {
  let started = false;
  let startPromise: Promise<void> | null = null;
  let stopPromise: Promise<void> | null = null;

  async function startOnce(): Promise<void> {
    try {
      await options.store.ping();
      if (!options.config.companionsEnabled) {
        await durablyDisableRuntime(options.store, options.config.executorId);
      }
      await options.scheduler.start();
      await options.server.listen();
      started = true;
    } catch (error) {
      await stopAfterPartialStart();
      throw error;
    }
  }

  async function stopAfterPartialStart(): Promise<void> {
    await Promise.resolve().then(() => options.scheduler.stopClaims()).catch(() => undefined);
    await Promise.allSettled([
      options.server.close(),
      options.scheduler.shutdown({ drainTimeoutMs: options.config.shutdownDrainMs }),
    ]);
    await options.closeResources().catch(() => undefined);
  }

  async function stopOnce(): Promise<void> {
    // Stop claims before closing either ingress or dependencies. This is the signal-safe boundary:
    // after this call no new Companion can enter this process.
    let failure: unknown;
    try {
      await options.scheduler.stopClaims();
    } catch (error) {
      failure = error;
    }
    try {
      await options.server.close();
    } catch (error) {
      failure ??= error;
    }
    try {
      await options.scheduler.shutdown({ drainTimeoutMs: options.config.shutdownDrainMs });
    } catch (error) {
      failure ??= error;
    } finally {
      await options.closeResources().catch((error: unknown) => {
        failure ??= error;
      });
      started = false;
    }
    if (failure) throw failure;
  }

  return {
    async start(): Promise<void> {
      if (started) return;
      if (stopPromise) throw new Error("runtime application is stopping");
      startPromise ??= startOnce();
      try {
        await startPromise;
      } finally {
        startPromise = null;
      }
    },
    async stop(): Promise<void> {
      if (stopPromise) return await stopPromise;
      if (startPromise) {
        await startPromise.catch(() => undefined);
      }
      stopPromise = stopOnce();
      return await stopPromise;
    },
  };
}

/**
 * A local false flag is a one-way kill switch invocation, not just a skipped poll. A true local
 * flag deliberately has no symmetric enable path; re-enabling remains an operator/control-plane
 * action. A concurrent replica can move the epoch between the read and disable, so only the
 * store's explicit serialization signal is retried.
 */
export async function durablyDisableRuntime(
  store: RuntimeApplicationStore,
  actorId: string,
): Promise<RuntimeGateStatus> {
  for (let attempt = 1; attempt <= MAX_DISABLE_SERIALIZATION_ATTEMPTS; attempt += 1) {
    const current = await store.gateStatus();
    try {
      const disabled = await store.disable(current.gateEpoch, actorId);
      if (disabled.enabled) throw new Error("runtime gate remained enabled after disable");
      return disabled;
    } catch (error) {
      if (!isSerializationConflict(error) || attempt === MAX_DISABLE_SERIALIZATION_ATTEMPTS) {
        throw error;
      }
    }
  }
  throw new Error("runtime gate disable attempts exhausted");
}

function isSerializationConflict(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; code?: unknown };
  return value.name === "RuntimeStoreSerializationError" || value.code === "40001";
}
