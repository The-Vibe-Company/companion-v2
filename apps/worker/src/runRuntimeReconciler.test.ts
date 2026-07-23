import { describe, expect, it, vi } from "vitest";
import type { RunSandboxRuntime } from "@companion/core";
import {
  createRunRuntimeReconciler,
  processRunRuntimeReconciliation,
  runtimeReconciliationLeaseSeconds,
  type ClaimedRunRuntimeReconciliation,
} from "./runRuntimeReconciler";

const claim: ClaimedRunRuntimeReconciliation = {
  orgId: "00000000-0000-0000-0000-000000000001",
  runId: "10000000-0000-0000-0000-000000000001",
  creatorId: "user-1",
  sandboxId: "sandbox-1",
  sandboxName: "run-1",
  timeoutMs: 300_000,
  activationRevision: 2,
  reconcileGeneration: 4,
  runtimeDeadlineAt: new Date("2026-07-23T13:00:00.000Z"),
};

describe("run runtime reconciler", () => {
  it("settles terminal usage independently of provider cleanup claims", async () => {
    const settleTerminal = vi.fn(async () => 2);
    const reconciler = createRunRuntimeReconciler({
      workerId: "worker-1",
      concurrency: 1,
      leaseSeconds: 30,
      runtime: {} as RunSandboxRuntime,
      region: "iad1",
      settleTerminal,
      claim: vi.fn(async () => []),
    });

    await reconciler.run();
    expect(settleTerminal).toHaveBeenCalledWith({ limit: 32 });
    await reconciler.stop();
  });

  it("keeps the provider mutation fence alive for the full bounded sequence", () => {
    expect(runtimeReconciliationLeaseSeconds(10)).toBe(105);
    expect(runtimeReconciliationLeaseSeconds(120)).toBe(120);
  });

  it("does not complete while the provider still reports an extension shortfall", async () => {
    const observedExpiry = new Date("2026-07-23T12:10:00.000Z");
    const runtime = {
      observe: vi.fn(async () => ({ state: "running" as const, expiresAt: observedExpiry })),
      extendTimeout: vi.fn(async () => ({ state: "running" as const, expiresAt: observedExpiry })),
    } as unknown as RunSandboxRuntime;
    const complete = vi.fn(async () => true);

    await expect(processRunRuntimeReconciliation({
      claim,
      workerId: "worker-1",
      runtime,
      region: "iad1",
      complete,
      now: () => Date.parse("2026-07-23T12:00:00.000Z"),
    })).resolves.toBe("retry");
    expect(runtime.extendTimeout).toHaveBeenCalledTimes(3);
    expect(complete).not.toHaveBeenCalled();
  });

  it("stops instead of extending again when the deadline passes during reconciliation", async () => {
    let nowMs = Date.parse("2026-07-23T12:59:50.000Z");
    const observe = vi
      .fn()
      .mockResolvedValueOnce({
        state: "running" as const,
        expiresAt: new Date("2026-07-23T12:59:55.000Z"),
      })
      .mockResolvedValueOnce({ state: "stopped" as const, expiresAt: null });
    const extendTimeout = vi.fn(async () => {
      nowMs = Date.parse("2026-07-23T13:00:01.000Z");
      return { state: "running" as const, expiresAt: claim.runtimeDeadlineAt };
    });
    const stop = vi.fn(async () => true);
    const complete = vi.fn(async () => true);
    const runtime = { observe, extendTimeout, stop } as unknown as RunSandboxRuntime;

    await expect(processRunRuntimeReconciliation({
      claim,
      workerId: "worker-1",
      runtime,
      region: "iad1",
      complete,
      now: () => nowMs,
    })).resolves.toBe("completed");
    expect(extendTimeout).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      observation: { state: "stopped", expiresAt: null },
    }));
  });

  it("extends only the shortfall to the absolute deadline", async () => {
    const observe = vi.fn(async () => ({
      state: "running" as const,
      expiresAt: new Date("2026-07-23T12:10:00.000Z"),
    }));
    const extendTimeout = vi.fn(async () => ({
      state: "running" as const,
      expiresAt: claim.runtimeDeadlineAt,
    }));
    const complete = vi.fn(async () => true);
    const runtime = { observe, extendTimeout } as unknown as RunSandboxRuntime;

    await expect(processRunRuntimeReconciliation({
      claim,
      workerId: "worker-1",
      runtime,
      region: "iad1",
      complete,
      now: () => Date.parse("2026-07-23T12:00:00.000Z"),
    })).resolves.toBe("completed");

    expect(extendTimeout).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "run-1" }),
      3_000_000,
      expect.any(AbortSignal),
    );
  });

  it("re-observes after an ambiguous extension failure", async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce({
        state: "running" as const,
        expiresAt: new Date("2026-07-23T12:10:00.000Z"),
      })
      .mockResolvedValueOnce({
        state: "running" as const,
        expiresAt: claim.runtimeDeadlineAt,
      });
    const runtime = {
      observe,
      extendTimeout: vi.fn(async () => {
        throw new Error("response timeout");
      }),
    } as unknown as RunSandboxRuntime;
    const complete = vi.fn(async () => true);

    await expect(processRunRuntimeReconciliation({
      claim,
      workerId: "worker-1",
      runtime,
      region: "iad1",
      complete,
      now: () => Date.parse("2026-07-23T12:00:00.000Z"),
    })).resolves.toBe("completed");
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it("passes a missing provider state to the fenced completion", async () => {
    const complete = vi.fn(async () => true);
    const runtime = {
      observe: vi.fn(async () => ({ state: "missing" as const, expiresAt: null })),
    } as unknown as RunSandboxRuntime;

    await processRunRuntimeReconciliation({
      claim,
      workerId: "worker-1",
      runtime,
      region: "iad1",
      complete,
    });
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      observation: { state: "missing", expiresAt: null },
    }));
  });

  it("stops a still-running provider once the absolute deadline is reached", async () => {
    const observe = vi
      .fn()
      .mockResolvedValueOnce({
        state: "running" as const,
        expiresAt: new Date("2026-07-23T14:00:00.000Z"),
      })
      .mockResolvedValueOnce({ state: "stopped" as const, expiresAt: null });
    const stop = vi.fn(async () => true);
    const complete = vi.fn(async () => true);
    const runtime = { observe, stop } as unknown as RunSandboxRuntime;

    await expect(processRunRuntimeReconciliation({
      claim,
      workerId: "worker-1",
      runtime,
      region: "iad1",
      complete,
      now: () => claim.runtimeDeadlineAt!.getTime(),
    })).resolves.toBe("completed");

    expect(stop).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: "run-1" }),
      expect.any(AbortSignal),
    );
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      observation: { state: "stopped", expiresAt: null },
    }));
  });
});
