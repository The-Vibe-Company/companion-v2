import { describe, expect, it, vi } from "vitest";
import type { RunSandboxRuntime } from "@companion/core";
import {
  processRunRuntimeReconciliation,
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
});
