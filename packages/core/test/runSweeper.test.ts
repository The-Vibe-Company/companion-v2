import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import { sweepRunSandboxes } from "../src/runSweeper";
import { sandboxNameForRun, type RunControlContext, type RunRow } from "../src/skillRuns";
import type { RunSandboxRuntime } from "../src/runRuntime";

const ORG = "00000000-0000-0000-0000-000000000001";
const NOW = new Date("2026-07-13T12:00:00Z");
const OLD = new Date("2026-07-13T10:00:00Z");

function run(id: string, status: RunRow["status"], updatedAt = OLD): RunRow {
  return {
    id,
    orgId: ORG,
    skillId: "10000000-0000-0000-0000-000000000001",
    creatorId: "user-me",
    skillVersionId: "20000000-0000-0000-0000-000000000001",
    skillVersion: "1.0.0",
    runConfigId: null,
    runConfigNameSnapshot: null,
    idempotencyKey: `idempotency-${id}`,
    payloadHash: "a".repeat(64),
    model: "anthropic/claude",
    prompt: "go",
    status,
    phase: status === "frozen" || status === "canceled" ? "complete" : "cleanup",
    errorCode: null,
    userMessage: null,
    cancelRequestedAt: null,
    sandboxName: sandboxNameForRun(ORG, id),
    sandboxId: null,
    sandboxDomain: null,
    goldenSnapshotId: "golden",
    opencodeVersion: "1.0.0",
    opencodeSessionId: null,
    serverPasswordEnc: null,
    timeoutMs: 300_000,
    transcript: [],
    warnings: [],
    transcriptEventSequence: 0,
    transcriptUpdatedAt: null,
    lastActiveAt: null,
    frozenAt: status === "frozen" || status === "canceled" ? updatedAt : null,
    sandboxCleanedAt: null,
    cleanupLeaseOwner: null,
    cleanupLeaseExpiresAt: null,
    cleanupAttempt: 0,
    createdAt: OLD,
    updatedAt,
  };
}

function fakeDb(rows: RunRow[]): Db {
  return {
    select: () => ({
      from: (table: unknown) => {
        if (table !== schema.skillRuns) throw new Error("unexpected table");
        return {
          where: () => ({ orderBy: async () => rows }),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Partial<RunRow>) => ({
        where: async () => {
          if (table !== schema.skillRuns) throw new Error("unexpected table");
          const pending = rows.find((row) => row.sandboxCleanedAt === null && ["frozen", "error", "canceled"].includes(row.status));
          if (pending) Object.assign(pending, patch);
        },
      }),
    }),
  } as unknown as Db;
}

function harness(rows: RunRow[], failed = new Set<string>()) {
  const destroyed: string[] = [];
  const runtime = {
    provider: "vercel",
    stop: async () => undefined,
    destroy: async (ref) => {
      destroyed.push(ref.sandboxName);
      if (failed.has(ref.sandboxName)) throw new Error("provider unavailable");
    },
  } as Partial<RunSandboxRuntime> as RunSandboxRuntime;
  const ctx = { runtime, region: "iad1" } as RunControlContext;
  return {
    destroyed,
    sweep: () => sweepRunSandboxes({ ctx, database: fakeDb(rows), now: () => NOW, graceMs: 60_000 }),
  };
}

describe("terminal run sandbox sweeper", () => {
  it("destroys frozen, error and canceled sandboxes and marks them clean", async () => {
    const rows = [run("run-frozen", "frozen"), run("run-error", "error"), run("run-canceled", "canceled")];
    const { sweep, destroyed } = harness(rows);
    await expect(sweep()).resolves.toEqual({ destroyed: 3, failed: 0 });
    expect(destroyed).toHaveLength(3);
    expect(rows.every((row) => row.sandboxCleanedAt !== null)).toBe(true);
  });

  it("never infers liveness or kills queued/starting/running work", async () => {
    const rows = [run("run-queued", "queued"), run("run-starting", "starting"), run("run-running", "running")];
    const { sweep, destroyed } = harness(rows);
    await expect(sweep()).resolves.toEqual({ destroyed: 0, failed: 0 });
    expect(destroyed).toEqual([]);
    expect(rows.every((row) => row.sandboxCleanedAt === null)).toBe(true);
  });

  it("retains cleanup debt when destroy fails", async () => {
    const row = run("run-failed", "error");
    const { sweep } = harness([row], new Set([row.sandboxName!]));
    await expect(sweep()).resolves.toEqual({ destroyed: 0, failed: 1 });
    expect(row.sandboxCleanedAt).toBeNull();
  });

  it("respects the grace window", async () => {
    const fresh = run("run-fresh", "frozen", new Date(NOW.getTime() - 30_000));
    const { sweep, destroyed } = harness([fresh]);
    await expect(sweep()).resolves.toEqual({ destroyed: 0, failed: 0 });
    expect(destroyed).toEqual([]);
  });
});
