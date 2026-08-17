import { RuntimeInvariantError } from "./errors";
import { runtimeSucceeded, type RuntimeWorkDisposition } from "./handler";
import type { LeaseSession } from "./leaseSession";
import type { RuntimeEngineDependencies } from "./ports";
import { retryIdempotentLifecycle } from "./retry";
import type { RuntimeScheduler, RuntimeSchedulerSnapshot } from "./scheduler";
import type { RuntimeStore } from "./store";
import type { RuntimeClock } from "./clock";
import type { HealthRuntimeClaim } from "./types";

interface HealthContext {
  claim: HealthRuntimeClaim;
  session: LeaseSession;
  deps: RuntimeEngineDependencies;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && (error as { status?: unknown }).status === 404);
}

export async function handleHealth(
  context: HealthContext,
): Promise<RuntimeWorkDisposition> {
  const authorization = await context.session.reauthorize();
  if (authorization.workCheckpoint === "observed") return runtimeSucceeded;
  if (authorization.workCheckpoint !== "observing") {
    throw new RuntimeInvariantError({
      code: "health_checkpoint_invalid",
      message: "Runtime health work reached an unsupported checkpoint.",
      action: "none",
    });
  }
  if (!authorization.boxId) {
    await context.session.observe({
      runtimeGeneration: context.claim.runtimeGeneration,
      boxState: "absent",
      observedAt: context.deps.clock.now(),
    });
    return runtimeSucceeded;
  }
  const boxId = authorization.boxId;
  let boxState;
  try {
    boxState = (await retryIdempotentLifecycle({
      call: "get_status",
      clock: context.deps.clock,
      jitter: context.deps.jitter,
      signal: context.session.signal,
      operation: async () => await context.session.external(async (signal) =>
        await context.deps.box.getStatus({ boxId, signal })),
    })).state;
  } catch (error) {
    if (!isNotFound(error)) throw error;
    boxState = "absent" as const;
  }

  let piObservation: {
    piState?: Awaited<ReturnType<RuntimeEngineDependencies["pi"]["piDaemonStatus"]>>["state"];
    piInvocationId?: string;
  } = {};
  if (boxState === "ready" || boxState === "idle" || boxState === "running") {
    try {
      const pi = await retryIdempotentLifecycle({
        call: "get_status",
        clock: context.deps.clock,
        jitter: context.deps.jitter,
        signal: context.session.signal,
        operation: async () => await context.session.external(async (signal) =>
          await context.deps.pi.piDaemonStatus({ boxId, signal })),
      });
      piObservation = {
        piState: pi.state,
        ...(pi.invocationId ? { piInvocationId: pi.invocationId } : {}),
      };
    } catch (error) {
      if (!isNotFound(error)) throw error;
      piObservation = { piState: "absent" };
    }
  }
  await context.session.observe({
    runtimeGeneration: context.claim.runtimeGeneration,
    boxState,
    ...piObservation,
    observedAt: context.deps.clock.now(),
  });
  return runtimeSucceeded;
}

export interface RuntimeHealthSnapshot {
  healthy: boolean;
  databaseHealthy: boolean;
  claimLoopAlive: boolean;
  sweepFresh: boolean;
  acceptingClaims: boolean;
  claimsEnabled: boolean;
  gateEnabled: boolean | null;
  lastSweepStartedAt: Date | null;
  lastSweepCompletedAt: Date | null;
  claimLoopErrorAt: Date | null;
  activeCount: number;
}

/** Read-only process health; never includes ids, provider details, URLs, or error payloads. */
export class RuntimeHealth {
  constructor(private readonly input: {
    store: RuntimeStore;
    scheduler: RuntimeScheduler;
    clock: RuntimeClock;
  }) {}

  async check(): Promise<RuntimeHealthSnapshot> {
    let databaseHealthy = true;
    try {
      await this.input.store.ping();
    } catch {
      databaseHealthy = false;
    }
    const scheduler = this.input.scheduler.snapshot();
    const sweepFresh = this.#sweepFresh(scheduler);
    const claimLoopAlive = scheduler.claimLoopAlive;
    const healthy = databaseHealthy
      && claimLoopAlive
      && scheduler.claimLoopErrorAt === null
      && sweepFresh;
    return {
      healthy,
      databaseHealthy,
      claimLoopAlive,
      sweepFresh,
      acceptingClaims: scheduler.acceptingClaims,
      claimsEnabled: scheduler.claimsEnabled,
      gateEnabled: scheduler.gateEnabled,
      lastSweepStartedAt: scheduler.lastSweepStartedAt,
      lastSweepCompletedAt: scheduler.lastSweepCompletedAt,
      claimLoopErrorAt: scheduler.claimLoopErrorAt,
      activeCount: scheduler.activeCount,
    };
  }

  #sweepFresh(snapshot: RuntimeSchedulerSnapshot): boolean {
    if (!snapshot.lastSweepCompletedAt) return false;
    const maximumAge = (2 * snapshot.sweepIntervalMs) + 1_000;
    const age = this.input.clock.now().getTime() - snapshot.lastSweepCompletedAt.getTime();
    return age >= 0 && age <= maximumAge;
  }
}
