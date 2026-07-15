import { describe, expect, it, vi } from "vitest";
import type { RunSandboxRuntime } from "@companion/core";
import {
  createRunCleanupScheduler,
  processClaimedRunCleanup,
  type ClaimedRunCleanup,
} from "./runCleanup";

const claim: ClaimedRunCleanup = {
  orgId: "00000000-0000-4000-8000-000000000001",
  runId: "00000000-0000-4000-8000-000000000002",
  creatorId: "run-owner",
  sandboxId: "sandbox-1",
  sandboxName: "run-00000000-00000000",
  cleanupAttempt: 1,
};

function runtime(destroy: () => Promise<void>): RunSandboxRuntime {
  return {
    provider: "vercel",
    stop: vi.fn(async () => true),
    destroy: vi.fn(destroy),
  } as unknown as RunSandboxRuntime;
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("terminal run cleanup", () => {
  it("tears down the claimed sandbox and completes only its worker lease", async () => {
    const sandbox = runtime(async () => undefined);
    const complete = vi.fn(async () => true);
    const settle = vi.fn(async () => undefined);

    const result = await processClaimedRunCleanup({
      claim,
      workerId: "worker-a",
      runtime: sandbox,
      region: "iad1",
      timeoutMs: 30_000,
      complete,
      settle,
    });

    expect(result).toBe("completed");
    expect(sandbox.stop).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxName: claim.sandboxName }),
      expect.any(AbortSignal),
    );
    expect(sandbox.destroy).toHaveBeenCalledTimes(1);
    expect(complete).toHaveBeenCalledWith(expect.objectContaining({
      orgId: claim.orgId,
      runId: claim.runId,
      workerId: "worker-a",
    }));
    expect(settle).toHaveBeenCalledWith(claim);
  });

  it("leaves the lease to expire after provider failure so another worker can retry", async () => {
    const sandbox = runtime(async () => { throw new Error("provider unavailable"); });
    const complete = vi.fn(async () => true);

    const result = await processClaimedRunCleanup({
      claim: { ...claim, cleanupAttempt: 2 },
      workerId: "worker-b",
      runtime: sandbox,
      region: "iad1",
      timeoutMs: 30_000,
      complete,
    });

    expect(result).toBe("retry");
    expect(complete).not.toHaveBeenCalled();
  });

  it("retries cleanup when provider teardown succeeds but usage settlement fails", async () => {
    const sandbox = runtime(async () => undefined);
    const complete = vi.fn(async () => true);

    const result = await processClaimedRunCleanup({
      claim,
      workerId: "worker-b",
      runtime: sandbox,
      region: "iad1",
      timeoutMs: 30_000,
      complete,
      settle: vi.fn(async () => { throw new Error("database unavailable"); }),
    });

    expect(result).toBe("retry");
    expect(complete).not.toHaveBeenCalled();
  });

  it("completes a terminal run that never created a sandbox", async () => {
    const sandbox = runtime(async () => undefined);
    const complete = vi.fn(async () => true);

    const result = await processClaimedRunCleanup({
      claim: { ...claim, sandboxId: null, sandboxName: null },
      workerId: "worker-c",
      runtime: sandbox,
      region: "iad1",
      timeoutMs: 30_000,
      complete,
      settle: vi.fn(async () => undefined),
    });

    expect(result).toBe("completed");
    expect(sandbox.stop).not.toHaveBeenCalled();
    expect(sandbox.destroy).not.toHaveBeenCalled();
  });
});

describe("terminal cleanup shutdown", () => {
  it("does not start teardown for a DB claim that resolves after stop", async () => {
    const pendingClaim = deferred<ClaimedRunCleanup[]>();
    const process = vi.fn(async () => "completed" as const);
    const claimRuns = vi.fn(() => pendingClaim.promise);
    const scheduler = createRunCleanupScheduler({
      workerId: "worker-a",
      concurrency: 2,
      leaseSeconds: 30,
      runtime: runtime(async () => undefined),
      region: "iad1",
      timeoutMs: 30_000,
      claim: claimRuns,
      process,
    });

    const claimPromise = scheduler.run();
    const stopPromise = scheduler.stop();
    pendingClaim.resolve([claim]);
    await Promise.all([claimPromise, stopPromise]);

    expect(process).not.toHaveBeenCalled();
    await scheduler.run();
    expect(claimRuns).toHaveBeenCalledTimes(1);
  });

  it("waits for an already-started terminal teardown before stop resolves", async () => {
    const teardown = deferred<"completed">();
    const process = vi.fn(() => teardown.promise);
    const scheduler = createRunCleanupScheduler({
      workerId: "worker-a",
      concurrency: 1,
      leaseSeconds: 30,
      runtime: runtime(async () => undefined),
      region: "iad1",
      timeoutMs: 30_000,
      claim: vi.fn(async () => [claim]),
      process,
    });

    await scheduler.run();
    expect(process).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopPromise = scheduler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    teardown.resolve("completed");
    await stopPromise;
    expect(stopped).toBe(true);
  });
});
