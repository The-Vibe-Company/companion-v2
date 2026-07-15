import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunSandboxRuntime } from "@companion/core";
import type { RunControlContext } from "@companion/core/services";

const mocks = vi.hoisted(() => ({
  claimRunPrewarms: vi.fn(),
  claimRunPrewarmCleanups: vi.fn(async () => []),
  completeRunPrewarmCleanup: vi.fn(),
  heartbeatClaimedRunPrewarm: vi.fn(async () => true),
  loadRunPrewarmPlan: vi.fn(),
  materializeRunPrewarmSkills: vi.fn(async () => [{ slug: "demo", version: "1.0.0", files: [] }]),
  purgeRunPrewarms: vi.fn(async () => 0),
  releaseClaimedRunPrewarm: vi.fn(async () => true),
  teardownSandbox: vi.fn(async () => true),
  updateClaimedRunPrewarm: vi.fn(async () => true),
}));

vi.mock("@companion/core/services", () => mocks);
vi.mock("@companion/db", () => ({
  db: {},
  withTenantContext: vi.fn(async (_scope: unknown, fn: (database: unknown) => unknown) => fn({})),
}));

import { createRunPrewarmScheduler } from "./prewarmSupervisor";

const row = {
  id: "88888888-8888-4888-8888-888888888888",
  orgId: "77777777-7777-4777-8777-777777777777",
  creatorId: "user-1",
  sandboxName: "prewarm-88888888-8888-4888-8888-888888888888",
  sandboxId: null,
  goldenSnapshotId: "golden",
  timeoutMs: 300_000,
  status: "warming",
  clientLeaseExpiresAt: new Date(Date.now() + 30_000),
  absoluteExpiresAt: new Date(Date.now() + 300_000),
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.claimRunPrewarms.mockResolvedValue([row]);
  mocks.loadRunPrewarmPlan.mockResolvedValue({ row, skills: [] });
});

describe("secretless run prewarming", () => {
  it("forks and uploads only skill bundles without starting OpenCode", async () => {
    const runtime = {
      forkFromGolden: vi.fn(async () => ({ sandboxId: row.sandboxName, domain: "https://sandbox.invalid" })),
      pushSkillBundles: vi.fn(async () => undefined),
      startServer: vi.fn(async () => undefined),
    } as unknown as RunSandboxRuntime;
    const ctx = {
      runtime,
      fetchArchive: vi.fn(),
      region: "iad1",
    } as unknown as RunControlContext;
    const scheduler = createRunPrewarmScheduler({
      workerId: "worker-1",
      concurrency: 2,
      leaseSeconds: 30,
      ctx,
      shutdownSignal: new AbortController().signal,
    });

    await scheduler.run();
    await scheduler.stop();

    expect(runtime.forkFromGolden).toHaveBeenCalled();
    expect(runtime.pushSkillBundles).toHaveBeenCalledWith(expect.objectContaining({
      skills: [{ slug: "demo", version: "1.0.0", files: [] }],
    }));
    expect(runtime.startServer).not.toHaveBeenCalled();
    expect(mocks.updateClaimedRunPrewarm).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "ready",
      phase: "ready",
      complete: true,
    }));
    expect(mocks.releaseClaimedRunPrewarm).toHaveBeenCalledWith(expect.objectContaining({
      sandboxId: row.sandboxName,
      sandboxDomain: "https://sandbox.invalid",
    }));
  });

  it("does not fork after cancellation has already taken the worker lease", async () => {
    mocks.updateClaimedRunPrewarm.mockResolvedValueOnce(false);
    const runtime = {
      forkFromGolden: vi.fn(async () => ({ sandboxId: row.sandboxName, domain: "https://sandbox.invalid" })),
      pushSkillBundles: vi.fn(async () => undefined),
    } as unknown as RunSandboxRuntime;
    const scheduler = createRunPrewarmScheduler({
      workerId: "worker-1",
      concurrency: 1,
      leaseSeconds: 30,
      ctx: { runtime, fetchArchive: vi.fn(), region: "iad1" } as unknown as RunControlContext,
      shutdownSignal: new AbortController().signal,
    });

    await scheduler.run();
    await scheduler.stop();

    expect(runtime.forkFromGolden).not.toHaveBeenCalled();
    expect(mocks.releaseClaimedRunPrewarm).toHaveBeenCalled();
  });
});
