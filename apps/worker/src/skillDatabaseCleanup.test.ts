import { describe, expect, it, vi } from "vitest";
import { startSkillDatabaseCleanupSupervisor, sweepSkillDatabaseObjects } from "./skillDatabaseCleanup";

vi.mock("@companion/core", async (importOriginal) => ({
  ...await importOriginal<typeof import("@companion/core")>(),
  claimSkillDatabaseObjectDeletions: vi.fn(async () => []),
}));

describe("Skill Database object cleanup", () => {
  it("keeps draining lifecycle deletions while the request capability is disabled", async () => {
    const prior = process.env.COMPANION_SKILL_DATABASES_ENABLED;
    delete process.env.COMPANION_SKILL_DATABASES_ENABLED;
    try {
      const supervisor = await startSkillDatabaseCleanupSupervisor();
      expect(supervisor).not.toBeNull();
      await supervisor!.stop();
    } finally {
      if (prior === undefined) delete process.env.COMPANION_SKILL_DATABASES_ENABLED;
      else process.env.COMPANION_SKILL_DATABASES_ENABLED = prior;
    }
  });

  it("acknowledges deleted objects and defers failed deletes", async () => {
    const complete = vi.fn(async () => true);
    const defer = vi.fn(async () => true);
    const result = await sweepSkillDatabaseObjects({
      claim: async () => [
        { storageKey: "deleted.db", claimToken: "00000000-0000-0000-0000-000000000001" },
        { storageKey: "retry.db", claimToken: "00000000-0000-0000-0000-000000000002" },
      ],
      complete,
      defer,
      deleteObject: async (key) => {
        if (key === "retry.db") throw new Error("storage unavailable");
      },
    });
    expect(result).toEqual({ deleted: 1, failed: 1 });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(defer).toHaveBeenCalledWith({
      deletion: expect.objectContaining({ storageKey: "retry.db" }),
    });
  });

  it("leases a claimed batch for its worst-case sequential delete deadlines", async () => {
    const claim = vi.fn(async () => []);
    await sweepSkillDatabaseObjects({ limit: 100, claim });
    expect(claim).toHaveBeenCalledWith({ limit: 100, leaseSeconds: 530 });
  });

  it("times out a stalled delete and continues draining later objects", async () => {
    const prior = process.env.COMPANION_SKILL_DB_DELETE_TIMEOUT_MS;
    process.env.COMPANION_SKILL_DB_DELETE_TIMEOUT_MS = "20";
    const complete = vi.fn(async () => true);
    const defer = vi.fn(async () => true);
    try {
      const result = await sweepSkillDatabaseObjects({
        claim: async () => [
          { storageKey: "stalled.db", claimToken: "00000000-0000-0000-0000-000000000003" },
          { storageKey: "next.db", claimToken: "00000000-0000-0000-0000-000000000004" },
        ],
        complete,
        defer,
        deleteObject: async (key, signal) => {
          if (key !== "stalled.db") return;
          await new Promise<void>((_resolve, reject) => {
            const abort = () => reject(signal.reason);
            if (signal.aborted) abort();
            else signal.addEventListener("abort", abort, { once: true });
          });
        },
      });
      expect(result).toEqual({ deleted: 1, failed: 1 });
      expect(complete).toHaveBeenCalledWith({
        deletion: expect.objectContaining({ storageKey: "next.db" }),
      });
      expect(defer).toHaveBeenCalledWith({
        deletion: expect.objectContaining({ storageKey: "stalled.db" }),
      });
    } finally {
      if (prior === undefined) delete process.env.COMPANION_SKILL_DB_DELETE_TIMEOUT_MS;
      else process.env.COMPANION_SKILL_DB_DELETE_TIMEOUT_MS = prior;
    }
  });

  it("waits for an active sweep during shutdown", async () => {
    vi.useFakeTimers();
    let finish!: () => void;
    const sweep = vi.fn(() => new Promise<{ deleted: number; failed: number }>((resolve) => {
      finish = () => resolve({ deleted: 0, failed: 0 });
    }));
    const supervisor = await startSkillDatabaseCleanupSupervisor({ sweep, intervalMs: 1_000 });
    expect(supervisor).not.toBeNull();
    const stopped = supervisor!.stop();
    finish();
    await stopped;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sweep).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
