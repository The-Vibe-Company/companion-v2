import { describe, expect, it } from "vitest";
import type { RuntimeExecutionResult } from "./engine";
import {
  DEFAULT_RUNTIME_CONCURRENCY,
  DEFAULT_RUNTIME_SWEEP_INTERVAL_MS,
  RuntimeScheduler,
  type RuntimeEngineControl,
} from "./scheduler";
import { RuntimeRowDecodeError, type RuntimeClaim } from "./types";
import {
  MemoryRuntimeStore,
  TestClock,
  attemptAuthorization,
  attemptClaim,
} from "./test/fixtures";

class HoldingEngine implements RuntimeEngineControl {
  readonly claims: RuntimeClaim[] = [];
  handoffs = 0;
  shutdowns = 0;
  interruptions = 0;

  execute(claim: RuntimeClaim): Promise<RuntimeExecutionResult> {
    this.claims.push(claim);
    return new Promise(() => undefined);
  }

  requestShutdown(): void {
    this.shutdowns += 1;
  }

  handoffActive(): void {
    this.handoffs += 1;
  }

  interruptActive(): void {
    this.interruptions += 1;
  }

  async drain(): Promise<void> {}
}

class HangingDrainEngine extends HoldingEngine {
  override async drain(): Promise<void> {
    await new Promise<void>(() => undefined);
  }
}

function numberedClaim(index: number, companionIndex = index): RuntimeClaim {
  const companionHex = (companionIndex + 16).toString(16).padStart(12, "0");
  const workHex = (index + 32).toString(16).padStart(12, "0");
  return attemptClaim({
    companionId: `22222222-2222-4222-8222-${companionHex}`,
    workId: `33333333-3333-4333-8333-${workHex}`,
  });
}

describe("RuntimeScheduler", () => {
  it("disables the database gate when the local feature flag is off and never claims", async () => {
    const base = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(base) });
    store.claims.push(numberedClaim(0));
    const engine = new HoldingEngine();
    const scheduler = new RuntimeScheduler({
      store,
      engine,
      clock: new TestClock(),
      executorId: "scheduler-test",
      claimsEnabled: false,
    });

    await scheduler.sweepOnce();

    expect(store.disables).toBe(1);
    expect(store.gate.enabled).toBe(false);
    expect(engine.shutdowns).toBe(1);
    expect(engine.claims).toHaveLength(0);
    expect(scheduler.snapshot().lastSweepCompletedAt).not.toBeNull();
  });

  it("claims at most eight Companions and leaves no local duplicate active", async () => {
    const base = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(base) });
    store.claims.push(...Array.from({ length: 10 }, (_, index) => numberedClaim(index)));
    const engine = new HoldingEngine();
    const scheduler = new RuntimeScheduler({
      store,
      engine,
      clock: new TestClock(),
      executorId: "scheduler-test",
      claimsEnabled: true,
    });

    await scheduler.sweepOnce();

    expect(engine.claims).toHaveLength(DEFAULT_RUNTIME_CONCURRENCY);
    expect(scheduler.snapshot().activeCount).toBe(DEFAULT_RUNTIME_CONCURRENCY);
    expect(store.claims).toHaveLength(2);

    await scheduler.sweepOnce();
    expect(engine.claims).toHaveLength(DEFAULT_RUNTIME_CONCURRENCY);
  });

  it("interrupts active sessions when another replica has disabled the shared gate", async () => {
    const base = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(base) });
    store.gate = { ...store.gate, enabled: false, gateEpoch: 2n };
    const engine = new HoldingEngine();
    const scheduler = new RuntimeScheduler({
      store,
      engine,
      clock: new TestClock(),
      executorId: "scheduler-test",
      claimsEnabled: true,
    });

    await scheduler.sweepOnce();
    await scheduler.sweepOnce();

    expect(engine.interruptions).toBe(1);
    expect(engine.shutdowns).toBe(0);
    expect(engine.claims).toHaveLength(0);
    expect(scheduler.snapshot().gateEnabled).toBe(false);
  });

  it("releases a defensive duplicate claim for the same Companion", async () => {
    const base = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(base) });
    store.claims.push(numberedClaim(0, 7), numberedClaim(1, 7));
    const engine = new HoldingEngine();
    const scheduler = new RuntimeScheduler({
      store,
      engine,
      clock: new TestClock(),
      executorId: "scheduler-test",
      claimsEnabled: true,
    });

    await scheduler.sweepOnce();

    expect(engine.claims).toHaveLength(1);
    expect(store.releases).toBe(1);
    expect(scheduler.snapshot().activeCount).toBe(1);
  });

  it("releases a claim captured while process handoff stops the claim loop", async () => {
    const base = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(base) });
    const captured = numberedClaim(0);
    let resolveClaimWork!: (claims: RuntimeClaim[]) => void;
    let markClaimWorkStarted!: () => void;
    const claimWorkStarted = new Promise<void>((resolve) => {
      markClaimWorkStarted = resolve;
    });
    store.claimWork = async () => {
      markClaimWorkStarted();
      return await new Promise<RuntimeClaim[]>((resolve) => {
        resolveClaimWork = resolve;
      });
    };
    const engine = new HoldingEngine();
    const scheduler = new RuntimeScheduler({
      store,
      engine,
      clock: new TestClock(),
      executorId: "scheduler-test",
      claimsEnabled: true,
    });

    scheduler.start();
    await claimWorkStarted;
    const shutdown = scheduler.shutdown({ drainTimeoutMs: 250 });
    resolveClaimWork([captured]);
    await shutdown;

    expect(engine.claims).toHaveLength(0);
    expect(engine.handoffs).toBe(1);
    expect(engine.shutdowns).toBe(0);
    expect(store.releases).toBe(1);
  });

  it("publishes the two-second sweep contract", () => {
    expect(DEFAULT_RUNTIME_SWEEP_INTERVAL_MS).toBe(2_000);
    expect(DEFAULT_RUNTIME_CONCURRENCY).toBe(8);
  });

  it("bounds shutdown drain instead of waiting forever", async () => {
    const base = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(base) });
    const engine = new HangingDrainEngine();
    const clock = new TestClock();
    const scheduler = new RuntimeScheduler({
      store,
      engine,
      clock,
      executorId: "scheduler-test",
      claimsEnabled: true,
    });

    const shutdown = scheduler.shutdown({ drainTimeoutMs: 250 });
    await Promise.resolve();
    expect([...clock.timers.values()][0]?.milliseconds).toBe(250);
    clock.runNextTimer();
    await shutdown;

    expect(engine.handoffs).toBe(1);
    expect(engine.shutdowns).toBe(0);
    expect(scheduler.snapshot().acceptingClaims).toBe(false);
  });

  it("bounds shutdown while the claim loop is stuck reading the gate", async () => {
    const base = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(base) });
    let gateStarted!: () => void;
    const started = new Promise<void>((resolve) => { gateStarted = resolve; });
    store.gateStatus = async () => {
      gateStarted();
      return await new Promise<never>(() => undefined);
    };
    const engine = new HoldingEngine();
    const clock = new TestClock();
    const scheduler = new RuntimeScheduler({
      store,
      engine,
      clock,
      executorId: "scheduler-test",
      claimsEnabled: true,
    });
    scheduler.start();
    await started;

    const shutdown = scheduler.shutdown({ drainTimeoutMs: 250 });
    await Promise.resolve();
    expect([...clock.timers.values()][0]?.milliseconds).toBe(250);
    clock.runNextTimer();
    await shutdown;

    expect(engine.handoffs).toBe(1);
    expect(scheduler.snapshot().acceptingClaims).toBe(false);
  });

  it("logs a claim-loop decode failure instead of only flipping healthz", async () => {
    const base = attemptClaim();
    const store = new MemoryRuntimeStore({ authorization: attemptAuthorization(base) });
    store.claimWork = async () => {
      throw new RuntimeRowDecodeError("settings", "settings claim has an impossible nullable shape");
    };
    const records: Record<string, unknown>[] = [];
    const scheduler = new RuntimeScheduler({
      store,
      engine: new HoldingEngine(),
      clock: new TestClock(),
      executorId: "scheduler-test",
      claimsEnabled: true,
      log: {
        error(record) { records.push(record); },
        warn() {},
        info() {},
      },
    });

    await expect(scheduler.sweepOnce()).rejects.toBeInstanceOf(RuntimeRowDecodeError);
    expect(scheduler.snapshot().claimLoopErrorAt).not.toBeNull();
    expect(records).toEqual([expect.objectContaining({
      event: "runtime.claim_loop.error",
      thrown: expect.objectContaining({
        name: "RuntimeRowDecodeError",
        stableCode: "runtime_row_decode_failed",
        field: "settings",
        message: "settings claim has an impossible nullable shape",
      }),
    })]);
  });
});
