import { describe, expect, it } from "vitest";
import { sweepRunSandboxes, sandboxNameForRun, type RunControlContext } from "../src/services";
import type { RunSandboxRuntime } from "../src/runRuntime";
import { emptyStore, fakeRunsDb, type FakeRunRow, type FakeStore } from "./runsFakeDb";

const ORG = "00000000-0000-0000-0000-0000000000dd";
const NOW = new Date("2026-07-08T12:00:00Z");
const OLD = new Date("2026-07-08T11:00:00Z"); // 1h stale — past every cutoff
const FRESH = new Date("2026-07-08T11:59:30Z"); // 30s — inside the 2-min grace

let runSeq = 0;
function seedRun(store: FakeStore, values: Partial<FakeRunRow>): FakeRunRow {
  runSeq += 1;
  const id = `00000000-0000-0000-0000-0000000010${String(runSeq).padStart(2, "0")}`;
  const row = {
    id,
    orgId: ORG,
    skillId: "skill-1",
    creatorId: "user-me",
    skillVersion: "1.0.0",
    model: "anthropic/claude-sonnet-4-5",
    prompt: "go",
    status: "frozen",
    statusDetail: null,
    sandboxName: sandboxNameForRun(ORG, id),
    sandboxId: null,
    sandboxDomain: null,
    goldenSnapshotId: null,
    opencodeVersion: null,
    opencodeSessionId: null,
    serverPasswordEnc: null,
    timeoutMs: 300_000,
    transcript: [],
    transcriptUpdatedAt: null,
    lastActiveAt: null,
    frozenAt: null,
    sandboxCleanedAt: null,
    createdAt: OLD,
    updatedAt: OLD,
    ...values,
  } as unknown as FakeRunRow;
  store.runs.push(row);
  return row;
}

function makeSweepHarness(script: { failDestroyFor?: string[] } = {}) {
  const store = emptyStore();
  const database = fakeRunsDb(store);
  const calls: Array<{ op: "stop" | "destroy"; sandboxName: string }> = [];
  const runtime = {
    provider: "vercel",
    stop: async (ref) => {
      calls.push({ op: "stop", sandboxName: ref.sandboxName });
    },
    destroy: async (ref) => {
      calls.push({ op: "destroy", sandboxName: ref.sandboxName });
      if (script.failDestroyFor?.includes(ref.sandboxName)) throw new Error("vercel API down");
    },
  } as Partial<RunSandboxRuntime> as RunSandboxRuntime;
  // The sweep touches only `runtime` and `region` — the rest of the context is never reached.
  const ctx = { runtime, region: "iad1" } as RunControlContext;
  const sweep = (input: { jobAlive?: (runId: string) => boolean; batchSize?: number } = {}) =>
    sweepRunSandboxes({ ctx, database, jobAlive: input.jobAlive ?? (() => false), batchSize: input.batchSize, now: () => NOW });
  return { store, database, calls, ctx, sweep };
}

describe("sweepRunSandboxes", () => {
  it("destroys the sandbox of a stale terminal run and marks it cleaned", async () => {
    const { store, calls, sweep } = makeSweepHarness();
    const frozen = seedRun(store, { status: "frozen" });
    const errored = seedRun(store, { status: "error" });

    const result = await sweep();

    expect(result).toEqual({ destroyed: 2, orphansKilled: 0, failed: 0 });
    expect(calls.filter((c) => c.op === "destroy").map((c) => c.sandboxName)).toEqual([
      frozen.sandboxName,
      errored.sandboxName,
    ]);
    expect(store.runs.every((r) => r.sandboxCleanedAt !== null)).toBe(true);
  });

  it("leaves already-cleaned rows and rows inside the grace window untouched", async () => {
    const { store, calls, sweep } = makeSweepHarness();
    seedRun(store, { status: "frozen", sandboxCleanedAt: OLD });
    const fresh = seedRun(store, { status: "frozen", updatedAt: FRESH });

    const result = await sweep();

    expect(result).toEqual({ destroyed: 0, orphansKilled: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect(fresh.sandboxCleanedAt).toBeNull();
  });

  it("rewrites a dead starting/running orphan like the read-time recovery, then destroys it", async () => {
    const { store, calls, sweep } = makeSweepHarness();
    const starting = seedRun(store, { status: "starting" });
    const running = seedRun(store, { status: "running" });

    const result = await sweep();

    expect(result).toEqual({ destroyed: 0, orphansKilled: 2, failed: 0 });
    expect(starting.status).toBe("error");
    expect(running.status).toBe("frozen");
    expect(running.statusDetail).toMatch(/Interrupted/);
    expect(calls.some((c) => c.op === "destroy" && c.sandboxName === running.sandboxName)).toBe(true);
    expect(store.runs.every((r) => r.sandboxCleanedAt !== null)).toBe(true);
  });

  it("never kills a run whose job is alive in this process, nor one inside the timeout window", async () => {
    const { store, calls, sweep } = makeSweepHarness();
    const alive = seedRun(store, { status: "running" });
    // Stale past the grace but NOT past timeoutMs + grace: could be legitimately alive elsewhere.
    const recent = seedRun(store, { status: "running", updatedAt: new Date(NOW.getTime() - 200_000) });

    const result = await sweep({ jobAlive: (runId) => runId === alive.id });

    expect(result).toEqual({ destroyed: 0, orphansKilled: 0, failed: 0 });
    expect(calls).toEqual([]);
    expect(alive.status).toBe("running");
    expect(recent.status).toBe("running");
  });

  it("keeps a failed destroy owed (NULL) and succeeds on the next tick", async () => {
    const { store, calls, sweep } = makeSweepHarness();
    const row = seedRun(store, { status: "frozen" });
    const harness2 = makeSweepHarness({ failDestroyFor: [row.sandboxName!] });
    harness2.store.runs.push(row);

    const failing = await harness2.sweep();
    expect(failing).toEqual({ destroyed: 0, orphansKilled: 0, failed: 1 });
    expect(row.sandboxCleanedAt).toBeNull();

    const retry = await sweep();
    expect(retry).toEqual({ destroyed: 1, orphansKilled: 0, failed: 0 });
    expect(row.sandboxCleanedAt).not.toBeNull();
    expect(calls.some((c) => c.op === "destroy" && c.sandboxName === row.sandboxName)).toBe(true);
  });

  it("caps each tick at batchSize, oldest first", async () => {
    const { store, sweep } = makeSweepHarness();
    seedRun(store, { status: "frozen", updatedAt: new Date("2026-07-08T09:00:00Z") });
    seedRun(store, { status: "frozen", updatedAt: new Date("2026-07-08T10:00:00Z") });
    seedRun(store, { status: "frozen", updatedAt: OLD });

    const result = await sweep({ batchSize: 2 });

    expect(result).toEqual({ destroyed: 2, orphansKilled: 0, failed: 0 });
    expect(store.runs.filter((r) => r.sandboxCleanedAt === null)).toHaveLength(1);
  });
});
