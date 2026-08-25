import { RuntimeInvariantError } from "./errors";
import { mustAbandonRuntimeExecution } from "./executionControl";
import { runtimeSucceeded, type RuntimeWorkDisposition } from "./handler";
import type { LeaseSession } from "./leaseSession";
import type { RuntimeEngineDependencies } from "./ports";
import { retryIdempotentLifecycle } from "./retry";
import { refreshWarmCompanionLayout } from "./layoutRefresh";
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
      piState: "absent",
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
  if (boxState === "absent") piObservation = { piState: "absent" };
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
  if (
    (boxState === "ready" || boxState === "idle" || boxState === "running")
    && piObservation.piState === "idle"
  ) {
    try {
      // Only recycle Pi when the running broker actually reports a stale layout. Restarting a warm
      // Pi that already runs the current layout would interrupt a Companion that was recently active,
      // so healing must never do it — full Box restart stays an explicit user action. When the broker
      // cannot be read we assume the layout is current and do not force a restart on an unknown state.
      let layoutCurrent = true;
      try {
        const broker = await context.session.external(async (signal) =>
          await context.deps.pi.brokerState({ boxId, signal }));
        layoutCurrent = broker.layoutCurrent;
      } catch (error) {
        if (mustAbandonRuntimeExecution(error)) throw error;
      }
      const refreshed = await refreshWarmCompanionLayout({
        session: context.session,
        deps: context.deps,
        authorization: requiredAuthorization(context),
        restartPi: !layoutCurrent,
      });
      if (refreshed.restartedPi && refreshed.piInvocationId) {
        piObservation = { piState: "idle", piInvocationId: refreshed.piInvocationId };
      }
    } catch (error) {
      if (mustAbandonRuntimeExecution(error)) throw error;
      // Layout refresh is opportunistic on health. The next send retries it on the warm path.
    }
  }
  // Health may persist a recycled or orphaned Pi identity only with idle proof (migration 0109
  // mirrors the operation rule). A busy Pi whose live id differs from the durable projection keeps
  // its observed states but omits the id, so the SQL guard remains a true bug detector.
  const observedInvocationId = piObservation.piInvocationId;
  const mayRecordIdentity = observedInvocationId === undefined
    || observedInvocationId === authorization.piInvocationId
    || piObservation.piState === "idle";
  await observeHealth(context, {
    boxState,
    ...(piObservation.piState ? { piState: piObservation.piState } : {}),
    ...(observedInvocationId !== undefined && mayRecordIdentity
      ? { piInvocationId: observedInvocationId }
      : {}),
  });
  return runtimeSucceeded;
}

function requiredAuthorization(context: HealthContext) {
  const authorization = context.session.authorization;
  if (!authorization?.authorized) {
    throw new RuntimeInvariantError({
      code: "runtime_authorization_missing",
      message: "Runtime authorization was unavailable at an execution checkpoint.",
      action: "none",
    });
  }
  return authorization;
}

async function observeHealth(
  context: HealthContext,
  observation: Omit<Parameters<LeaseSession["observe"]>[0], "runtimeGeneration" | "observedAt">,
): Promise<void> {
  await context.session.observe({
    runtimeGeneration: context.claim.runtimeGeneration,
    observedAt: context.deps.clock.now(),
    ...observation,
  });
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
    // Kept consistent with the /healthz window in apps/runtime/src/server.ts: tolerate a few missed
    // sweeps (max(5 * interval, 15s)) so a GC pause or recovery backoff does not flap the endpoint.
    const maximumAge = Math.max(5 * snapshot.sweepIntervalMs, 15_000);
    const age = this.input.clock.now().getTime() - snapshot.lastSweepCompletedAt.getTime();
    return age >= 0 && age <= maximumAge;
  }
}
