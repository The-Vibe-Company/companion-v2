import type { RuntimeClock } from "./clock";
import type { RuntimeExecutionResult } from "./engine";
import { describeThrownError, type RuntimeProcessLog } from "./logging";
import type { RuntimeClaim } from "./types";
import { claimFence } from "./leaseSession";
import { RUNTIME_LEASE_SECONDS, type RuntimeStore } from "./store";

export const DEFAULT_RUNTIME_SWEEP_INTERVAL_MS = 2_000;
export const DEFAULT_RUNTIME_CONCURRENCY = 8;
export const DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS = 25_000;

export interface RuntimeSchedulerSnapshot {
  claimLoopAlive: boolean;
  acceptingClaims: boolean;
  claimsEnabled: boolean;
  gateEnabled: boolean | null;
  lastSweepStartedAt: Date | null;
  lastSweepCompletedAt: Date | null;
  claimLoopErrorAt: Date | null;
  activeCount: number;
  concurrency: number;
  sweepIntervalMs: number;
}

export interface RuntimeEngineControl {
  execute(claim: RuntimeClaim): Promise<RuntimeExecutionResult>;
  handoffActive(): void;
  interruptActive(): void;
  requestShutdown(): void;
  drain(): Promise<void>;
}

export class RuntimeScheduler {
  readonly #store: RuntimeStore;
  readonly #engine: RuntimeEngineControl;
  readonly #clock: RuntimeClock;
  readonly #executorId: string;
  readonly #concurrency: number;
  readonly #sweepIntervalMs: number;
  readonly #claimsEnabled: boolean;
  readonly #log: RuntimeProcessLog | undefined;
  readonly #active = new Map<string, Promise<RuntimeExecutionResult>>();
  #loopAbort = new AbortController();
  #sleepAbort: AbortController | null = null;
  #loopTask: Promise<void> | null = null;
  #loopAlive = false;
  #acceptingClaims = true;
  #gateEnabled: boolean | null = null;
  #lastSweepStartedAt: Date | null = null;
  #lastSweepCompletedAt: Date | null = null;
  #claimLoopErrorAt: Date | null = null;
  #disableApplied = false;
  #gateInterruptionApplied = false;

  constructor(input: {
    store: RuntimeStore;
    engine: RuntimeEngineControl;
    clock: RuntimeClock;
    executorId: string;
    concurrency?: number;
    sweepIntervalMs?: number;
    claimsEnabled: boolean;
    log?: RuntimeProcessLog;
  }) {
    this.#store = input.store;
    this.#engine = input.engine;
    this.#clock = input.clock;
    this.#executorId = input.executorId;
    this.#concurrency = input.concurrency ?? DEFAULT_RUNTIME_CONCURRENCY;
    this.#sweepIntervalMs = input.sweepIntervalMs ?? DEFAULT_RUNTIME_SWEEP_INTERVAL_MS;
    this.#claimsEnabled = input.claimsEnabled;
    this.#log = input.log;
    if (!Number.isInteger(this.#concurrency) || this.#concurrency < 1 || this.#concurrency > 100) {
      throw new TypeError("Runtime concurrency must be between 1 and 100");
    }
    if (!Number.isInteger(this.#sweepIntervalMs) || this.#sweepIntervalMs < 100) {
      throw new TypeError("Runtime sweep interval must be at least 100ms");
    }
  }

  start(): void {
    if (this.#loopTask) return;
    this.#acceptingClaims = true;
    this.#loopTask = this.#runLoop();
  }

  stopClaims(): void {
    this.#acceptingClaims = false;
    if (!this.#loopAbort.signal.aborted) this.#loopAbort.abort();
    if (this.#sleepAbort && !this.#sleepAbort.signal.aborted) this.#sleepAbort.abort();
  }

  async shutdown(input: { drainTimeoutMs?: number } = {}): Promise<void> {
    const timeout = input.drainTimeoutMs ?? DEFAULT_RUNTIME_DRAIN_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout < 0) {
      throw new TypeError("Runtime drain timeout must be a non-negative finite number");
    }
    this.stopClaims();
    this.#engine.handoffActive();
    const drain = (async () => {
      await this.#loopTask?.catch(() => undefined);
      await Promise.allSettled([...this.#active.values()]);
      await this.#engine.drain();
    })();
    let timeoutHandle: unknown;
    const deadline = new Promise<void>((resolve) => {
      timeoutHandle = this.#clock.setTimeout(resolve, timeout);
    });
    await Promise.race([drain, deadline]);
    if (timeoutHandle !== undefined) this.#clock.clearTimeout(timeoutHandle);
  }

  snapshot(): RuntimeSchedulerSnapshot {
    return {
      claimLoopAlive: this.#loopAlive,
      acceptingClaims: this.#acceptingClaims,
      claimsEnabled: this.#claimsEnabled,
      gateEnabled: this.#gateEnabled,
      lastSweepStartedAt: this.#lastSweepStartedAt,
      lastSweepCompletedAt: this.#lastSweepCompletedAt,
      claimLoopErrorAt: this.#claimLoopErrorAt,
      activeCount: this.#active.size,
      concurrency: this.#concurrency,
      sweepIntervalMs: this.#sweepIntervalMs,
    };
  }

  async sweepOnce(): Promise<void> {
    this.#lastSweepStartedAt = this.#clock.now();
    try {
      let gate = await this.#store.gateStatus();
      this.#gateEnabled = gate.enabled;
      if (!this.#claimsEnabled) {
        if (gate.enabled) {
          gate = await this.#store.disable(gate.gateEpoch, `runtime:${this.#executorId}`);
          this.#gateEnabled = gate.enabled;
        }
        if (!this.#disableApplied) {
          this.#disableApplied = true;
          this.#engine.requestShutdown();
        }
        this.#claimLoopErrorAt = null;
        this.#lastSweepCompletedAt = this.#clock.now();
        return;
      }
      if (!this.#acceptingClaims || !gate.enabled) {
        if (!gate.enabled && !this.#gateInterruptionApplied) {
          this.#gateInterruptionApplied = true;
          this.#engine.interruptActive();
        }
        this.#claimLoopErrorAt = null;
        this.#lastSweepCompletedAt = this.#clock.now();
        return;
      }
      this.#gateInterruptionApplied = false;
      const freeSlots = this.#concurrency - this.#active.size;
      if (freeSlots > 0) {
        const claims = await this.#store.claimWork({
          executorId: this.#executorId,
          limit: freeSlots,
          leaseSeconds: RUNTIME_LEASE_SECONDS,
          gateEpoch: gate.gateEpoch,
        });
        for (const claim of claims) {
          if (!this.#acceptingClaims) {
            await this.#store.release(claimFence(claim, this.#executorId));
            continue;
          }
          if (this.#active.has(claim.companionId)) {
            await this.#store.release(claimFence(claim, this.#executorId));
            continue;
          }
          const execution = this.#engine.execute(claim);
          this.#active.set(claim.companionId, execution);
          void execution.then(
            () => this.#removeActive(claim.companionId, execution),
            () => this.#removeActive(claim.companionId, execution),
          );
        }
      }
      this.#claimLoopErrorAt = null;
      this.#lastSweepCompletedAt = this.#clock.now();
    } catch (error) {
      this.#claimLoopErrorAt = this.#clock.now();
      this.#log?.error({
        ts: this.#clock.now().toISOString(),
        event: "runtime.claim_loop.error",
        thrown: describeThrownError(error),
      });
      throw error;
    }
  }

  async #runLoop(): Promise<void> {
    this.#loopAlive = true;
    try {
      while (this.#acceptingClaims) {
        try {
          await this.sweepOnce();
        } catch {
          // Health exposes the stable error timestamp. The loop remains alive for DB recovery.
        }
        if (!this.#acceptingClaims) break;
        const sleepAbort = new AbortController();
        this.#sleepAbort = sleepAbort;
        try {
          await this.#clock.sleep(
            this.#sweepIntervalMs,
            AbortSignal.any([this.#loopAbort.signal, sleepAbort.signal]),
          );
        } catch {
          if (!this.#acceptingClaims || this.#loopAbort.signal.aborted) break;
        } finally {
          if (this.#sleepAbort === sleepAbort) this.#sleepAbort = null;
        }
      }
    } finally {
      this.#loopAlive = false;
    }
  }

  #removeActive(companionId: string, execution: Promise<RuntimeExecutionResult>): void {
    if (this.#active.get(companionId) !== execution) return;
    this.#active.delete(companionId);
    // A completed start operation can have made the queued turn claimable. Interrupt only the
    // scheduler's recovery sleep; the main shutdown signal and periodic sweep remain unchanged.
    if (this.#sleepAbort && !this.#sleepAbort.signal.aborted) this.#sleepAbort.abort();
  }
}
