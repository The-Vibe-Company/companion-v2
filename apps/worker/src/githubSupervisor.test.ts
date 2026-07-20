import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAppClient } from "@companion/github";

/**
 * Product promise:
 * A stale worker can prepare Git objects, but only a live generation/revision fence can publish the
 * non-force branch update and durably complete it in the same transaction.
 *
 * Regression caught:
 * Holding a transaction through preparation, publishing after a lost/ABA lease, or completing in a
 * second transaction could expose a commit that the durable destination state does not own.
 *
 * Why this test is worker-level:
 * The guarantee depends on orchestration order between S3, the renderer, GitHub, and revision fencing.
 *
 * Failure proof:
 * Removing generation propagation, periodic fence aborts, the publish lock, or in-finalize completion
 * makes these scenarios fail.
 */

const coreMocks = vi.hoisted(() => ({
  claim: vi.fn(),
  plan: vi.fn(),
  isLive: vi.fn(),
  lockPublish: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
}));
const storageMocks = vi.hoisted(() => ({ get: vi.fn() }));
const githubMocks = vi.hoisted(() => ({ render: vi.fn() }));
const dbMocks = vi.hoisted(() => ({ withTenant: vi.fn(), execute: vi.fn() }));

vi.mock("@companion/core/services", () => ({
  claimGitHubSyncDestinations: coreMocks.claim,
  getGitHubSyncPlan: coreMocks.plan,
  isGitHubSyncFenceLive: coreMocks.isLive,
  lockGitHubSyncPublishFence: coreMocks.lockPublish,
  completeGitHubSync: coreMocks.complete,
  failGitHubSync: coreMocks.fail,
}));
vi.mock("@companion/db", () => ({ withTenantContext: dbMocks.withTenant }));
vi.mock("@companion/storage", () => ({ getSkillArchive: storageMocks.get }));
vi.mock("@companion/github", () => ({
  githubAppConfig: vi.fn(() => null),
  renderSkillRepository: githubMocks.render,
  GitHubAppClient: class {},
}));

import { loadGitHubSkillArchives, startGitHubSupervisor } from "./githubSupervisor";

const claim = {
  orgId: "org-1",
  destinationId: "destination-1",
  claimedRevision: 7,
  leaseGeneration: 41,
};
const skill = {
  id: "skill-1",
  slug: "incident",
  version: "1.0.0",
  checksum: "sha256:x",
  storagePath: "skills/incident.tgz",
};
const plan = {
  destination: {
    installationId: "91",
    repositoryId: "501",
    owner: "acme",
    name: "skills",
    defaultBranch: "main",
  },
  skills: [skill],
};

beforeEach(() => {
  let transactionId = 0;
  dbMocks.execute.mockResolvedValue([]);
  dbMocks.withTenant.mockImplementation(async (_context, callback) => callback({
    id: ++transactionId,
    execute: dbMocks.execute,
  }));
  coreMocks.isLive.mockResolvedValue(true);
  coreMocks.lockPublish.mockResolvedValue(undefined);
  coreMocks.complete.mockResolvedValue(true);
  coreMocks.fail.mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("GitHub sync supervisor failure fencing", () => {
  it("does not write or complete when an archive fetch fails, and persists a retry error", async () => {
    coreMocks.claim.mockResolvedValueOnce([claim]).mockResolvedValue([]);
    coreMocks.plan.mockResolvedValue(plan);
    storageMocks.get.mockRejectedValue(new Error("S3 unavailable"));
    const writeRepository = vi.fn();
    const client = {
      config: { appId: "1", privateKey: "key" },
      writeRepository,
    } as unknown as GitHubAppClient;
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const supervisor = await startGitHubSupervisor({ client, intervalMs: 60_000 });
    await vi.waitFor(() => expect(coreMocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      orgId: "org-1", destinationId: "destination-1", workerId: expect.any(String),
      claimedRevision: 7, leaseGeneration: 41, error: "S3 unavailable",
    })));
    expect(coreMocks.plan).toHaveBeenCalledWith(expect.objectContaining({
      claimedRevision: 7,
      leaseGeneration: 41,
    }));
    expect(githubMocks.render).not.toHaveBeenCalled();
    expect(writeRepository).not.toHaveBeenCalled();
    expect(coreMocks.complete).not.toHaveBeenCalled();
    await supervisor?.stop();
  });

  it("fails the claim when database completion fencing is lost after a GitHub write", async () => {
    coreMocks.claim.mockResolvedValueOnce([{ ...claim, claimedRevision: 8 }]).mockResolvedValue([]);
    coreMocks.plan.mockResolvedValue(plan);
    storageMocks.get.mockResolvedValue(Buffer.from("archive"));
    githubMocks.render.mockResolvedValue([]);
    coreMocks.complete.mockResolvedValue(false);
    const client = {
      config: { appId: "1", privateKey: "key" },
      writeRepository: vi.fn(async (input: Parameters<GitHubAppClient["writeRepository"]>[0]) => {
        await input.assertFence?.();
        await input.finalize?.({ commitSha: "commit-1", branch: "main", publish: async () => undefined });
        return { commitSha: "commit-1", branch: "main" };
      }),
    } as unknown as GitHubAppClient;
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const supervisor = await startGitHubSupervisor({ client, intervalMs: 60_000 });
    await vi.waitFor(() => expect(coreMocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      error: "GitHub synchronization completion fence was lost",
    })));
    await supervisor?.stop();
  });

  it("aborts in-flight preparation when the periodic durable fence becomes invalid", async () => {
    coreMocks.claim.mockResolvedValueOnce([claim]).mockResolvedValue([]);
    coreMocks.plan.mockResolvedValue(plan);
    coreMocks.isLive.mockResolvedValue(false);
    let archiveSignal: AbortSignal | undefined;
    storageMocks.get.mockImplementation(({ signal }: { signal?: AbortSignal }) => new Promise<Buffer>((_resolve, reject) => {
      archiveSignal = signal;
      const aborted = () => reject(signal?.reason ?? new Error("aborted"));
      if (signal?.aborted) aborted();
      else signal?.addEventListener("abort", aborted, { once: true });
    }));
    const writeRepository = vi.fn();
    const client = {
      config: { appId: "1", privateKey: "key" },
      writeRepository,
    } as unknown as GitHubAppClient;
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const supervisor = await startGitHubSupervisor({ client, intervalMs: 60_000, fenceCheckIntervalMs: 5 });
    await vi.waitFor(() => expect(coreMocks.fail).toHaveBeenCalledWith(expect.objectContaining({
      claimedRevision: 7,
      leaseGeneration: 41,
      error: "GitHub synchronization fence was lost",
    })));
    expect(archiveSignal?.aborted).toBe(true);
    expect(writeRepository).not.toHaveBeenCalled();
    expect(coreMocks.lockPublish).not.toHaveBeenCalled();
    expect(coreMocks.complete).not.toHaveBeenCalled();
    await supervisor?.stop();
  });
});

describe("GitHub sync durable publication", () => {
  it("prepares outside a transaction, then locks, publishes, and completes in one ABA-fenced transaction", async () => {
    let activeTenantTransactions = 0;
    let transactionId = 0;
    dbMocks.withTenant.mockImplementation(async (_context, callback) => {
      activeTenantTransactions += 1;
      try {
        return await callback({ id: ++transactionId, execute: dbMocks.execute });
      } finally {
        activeTenantTransactions -= 1;
      }
    });
    coreMocks.claim.mockResolvedValueOnce([claim]).mockResolvedValue([]);
    coreMocks.plan.mockResolvedValue(plan);
    storageMocks.get.mockImplementation(async () => {
      expect(activeTenantTransactions).toBe(0);
      return Buffer.from("archive");
    });
    githubMocks.render.mockImplementation(async () => {
      expect(activeTenantTransactions).toBe(0);
      return [];
    });
    const events: string[] = [];
    let publishDatabase: unknown;
    coreMocks.lockPublish.mockImplementation(async (input) => {
      publishDatabase = input.database;
      events.push("lock");
    });
    coreMocks.complete.mockImplementation(async (input) => {
      expect(input.database).toBe(publishDatabase);
      expect(activeTenantTransactions).toBe(1);
      events.push("complete");
      return true;
    });
    const client = {
      config: { appId: "1", privateKey: "key" },
      writeRepository: vi.fn(async (input: Parameters<GitHubAppClient["writeRepository"]>[0]) => {
        expect(activeTenantTransactions).toBe(0);
        expect(input.signal).toBeInstanceOf(AbortSignal);
        await input.assertFence?.();
        expect(activeTenantTransactions).toBe(0);
        await input.finalize?.({
          commitSha: "commit-1",
          branch: "main",
          publish: async (signal) => {
            expect(activeTenantTransactions).toBe(1);
            expect(signal).toBeInstanceOf(AbortSignal);
            expect(signal?.aborted).toBe(false);
            events.push("publish");
            await new Promise((resolve) => setTimeout(resolve, 12));
          },
        });
        return { commitSha: "commit-1", branch: "main" };
      }),
    } as unknown as GitHubAppClient;
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const supervisor = await startGitHubSupervisor({
      client,
      intervalMs: 60_000,
      transactionHeartbeatIntervalMs: 2,
    });
    await vi.waitFor(() => expect(coreMocks.complete).toHaveBeenCalledTimes(1));
    expect(events).toEqual(["lock", "publish", "complete"]);
    expect(dbMocks.execute.mock.calls.length).toBeGreaterThan(1);
    for (const operation of [coreMocks.plan, coreMocks.isLive, coreMocks.lockPublish, coreMocks.complete]) {
      expect(operation).toHaveBeenCalledWith(expect.objectContaining({
        orgId: "org-1",
        destinationId: "destination-1",
        claimedRevision: 7,
        leaseGeneration: 41,
      }));
    }
    expect(coreMocks.complete).toHaveBeenCalledWith(expect.objectContaining({
      commitSha: "commit-1",
      branch: "main",
      skillCount: 1,
    }));
    expect(coreMocks.fail).not.toHaveBeenCalled();
    await supervisor?.stop();
  });
});

describe("GitHub archive loading limits", () => {
  const skills = Array.from({ length: 10 }, (_, index) => ({
    id: `skill-${index}`,
    slug: `skill-${index}`,
    version: "1.0.0",
    checksum: `sha256:${index}`,
    storagePath: `skills/${index}.tgz`,
  }));

  it("bounds concurrent S3 archive reads", async () => {
    let active = 0;
    let maximum = 0;
    await loadGitHubSkillArchives(skills, async () => {
      active += 1;
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      return Buffer.from("archive");
    });
    expect(maximum).toBeGreaterThan(1);
    expect(maximum).toBeLessThanOrEqual(4);
  });

  it("rejects a catalog whose aggregate archives exceed the worker memory budget", async () => {
    const largeArchive = Buffer.alloc(22 * 1024 * 1024);
    await expect(loadGitHubSkillArchives(skills.slice(0, 3), async () => largeArchive)).rejects.toThrow(
      "64 MB archive safety limit",
    );
  });

  it("settles active reads and stops dequeuing before a failed load returns", async () => {
    let starts = 0;
    await expect(loadGitHubSkillArchives(skills, async (storagePath) => {
      starts += 1;
      if (storagePath === "skills/0.tgz") throw new Error("archive failed");
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Buffer.from("archive");
    })).rejects.toThrow("archive failed");
    const startsWhenRejected = starts;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(starts).toBe(startsWhenRejected);
    expect(starts).toBeLessThanOrEqual(4);
  });
});
