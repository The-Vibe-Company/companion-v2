import type {
  RuntimeSchedulerSnapshot,
} from "@companion/companion-runtime";

import type { RuntimeApplicationScheduler } from "./application";

export interface RuntimeKernelScheduler {
  start(): void;
  stopClaims(): void;
  shutdown(input?: { drainTimeoutMs?: number }): Promise<void>;
  snapshot(): RuntimeSchedulerSnapshot;
}

/** Adapt the reusable kernel without inventing a second drain timer or health state. */
export function createRuntimeSchedulerAdapter(
  scheduler: RuntimeKernelScheduler,
): RuntimeApplicationScheduler {
  return {
    start: () => scheduler.start(),
    stopClaims: () => scheduler.stopClaims(),
    shutdown: async ({ drainTimeoutMs }) => {
      await scheduler.shutdown({ drainTimeoutMs });
    },
    snapshot: () => {
      const snapshot = scheduler.snapshot();
      return {
        claimLoopAlive: snapshot.claimLoopAlive,
        // RuntimeScheduler contains no terminal loop state: sweep errors are recoverable and carry
        // their timestamp. A process-level fatal error rejects startup instead of reaching here.
        fatal: false,
        lastSweepStartedAt: snapshot.lastSweepStartedAt,
        lastSweepCompletedAt: snapshot.lastSweepCompletedAt,
        claimLoopErrorAt: snapshot.claimLoopErrorAt,
        activeCount: snapshot.activeCount,
      };
    },
  };
}
