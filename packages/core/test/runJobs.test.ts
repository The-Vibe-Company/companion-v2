import { describe, expect, it } from "vitest";
import {
  RUN_CHAT_DELTA_MAX,
  RUN_CHAT_TOOL_INPUT_MAX,
  RUN_CHAT_TOOL_OUTPUT_MAX,
} from "@companion/contracts";
import { schema, type Db } from "@companion/db";
import { createRunRedactor } from "../src/runRedaction";
import {
  appendRunEvents,
  claimNextRunPrompt,
  claimRunJobs,
  failOrRetryRunJob,
  persistRunTranscript,
  requestRunCancellation,
} from "../src/runJobs";
import type { ActorContext } from "../src/services";

const ORG = "00000000-0000-0000-0000-000000000001";
const RUN = "10000000-0000-0000-0000-000000000001";
const actor: ActorContext = { id: "user-me", email: "me@example.com", name: "Me" };

function eventDb() {
  const events: Array<{
    orgId: string;
    runId: string;
    sequence: number;
    type: string;
    payload: Record<string, unknown>;
    createdAt: Date;
  }> = [];
  const run = { id: RUN, transcript: [] as unknown[], warnings: [] as unknown[], transcriptEventSequence: 0 };
  const handle = {
    transaction: async (fn: (transaction: Db) => Promise<unknown>) => fn(handle as unknown as Db),
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.skillRuns) {
            return { for: async () => [run] };
          }
          if (table === schema.skillRunEvents && projection && "value" in projection) {
            return Promise.resolve([
              { value: events.length ? Math.max(...events.map((event) => event.sequence)) : null },
            ]);
          }
          throw new Error("unexpected select");
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown> | Array<Record<string, unknown>>) => {
        if (table !== schema.skillRunEvents) throw new Error("unexpected insert");
        if (!Array.isArray(values)) {
          events.push({ createdAt: new Date(), ...values } as typeof events[number]);
          return Promise.resolve();
        }
        return {
          returning: async () => {
            const rows = values.map((value) => ({ createdAt: new Date(), ...value })) as typeof events;
            events.push(...rows);
            return rows;
          },
        };
      },
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          if (table !== schema.skillRuns) throw new Error("unexpected update");
          Object.assign(run, patch);
          return { returning: async () => [{ id: RUN }] };
        },
      }),
    }),
  };
  return { database: handle as unknown as Db, events, run };
}

describe("durable run events", () => {
  it("allocates monotonic sequences under a run lock and redacts before persistence", async () => {
    const { database, events } = eventDb();
    const redactor = createRunRedactor(["super-secret-value"]);
    const first = await appendRunEvents({
      actor,
      orgId: ORG,
      runId: RUN,
      events: [
        { type: "status", state: "busy", attempt: 1, message: null },
        { type: "run.warning", code: "artifact_publish_failed", message: "super-secret-value failed", phase: "collect_artifacts" },
      ],
      redactor,
      database,
    });
    const second = await appendRunEvents({
      actor,
      orgId: ORG,
      runId: RUN,
      events: [{ type: "session.idle", session_id: "session-1" }],
      database,
    });
    expect([...first, ...second].map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(JSON.stringify(events)).not.toContain("super-secret-value");
    expect(JSON.stringify(events)).toContain("[REDACTED]");
  });

  it("redacts before bounding tool payloads and splits oversized deltas losslessly", async () => {
    const { database, events } = eventDb();
    const secret = "SENTINEL-SECRET-123456789";
    const input = `${"i".repeat(RUN_CHAT_TOOL_INPUT_MAX - 5)}${secret} tail`;
    const output = `${"o".repeat(RUN_CHAT_TOOL_OUTPUT_MAX - 5)}${secret} tail`;
    const delta = "🤖".repeat(RUN_CHAT_DELTA_MAX);

    const rows = await appendRunEvents({
      actor,
      orgId: ORG,
      runId: RUN,
      events: [
        { type: "tool.start", call_id: "call-1", skill: null, tool: "bash", title: null, input },
        { type: "tool.done", call_id: "call-1", title: null, output, duration_ms: 1 },
        { type: "text.delta", message_id: "message-1", delta },
      ],
      redactor: createRunRedactor([secret]),
      database,
    });

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("SENTI");
    expect(rows[0]?.event).toMatchObject({ type: "tool.start" });
    if (rows[0]?.event.type === "tool.start") {
      expect(Buffer.byteLength(rows[0].event.input, "utf8")).toBeLessThanOrEqual(RUN_CHAT_TOOL_INPUT_MAX);
    }
    if (rows[1]?.event.type === "tool.done") {
      expect(Buffer.byteLength(rows[1].event.output, "utf8")).toBeLessThanOrEqual(RUN_CHAT_TOOL_OUTPUT_MAX);
    }
    expect(
      rows
        .filter((row) => row.event.type === "text.delta")
        .map((row) => row.event.type === "text.delta" ? row.event.delta : "")
        .join(""),
    ).toBe(delta);
  });

  it("snapshots the transcript and its highest folded event sequence atomically", async () => {
    const { database, events, run } = eventDb();
    const redactor = createRunRedactor(["snapshot-secret"]);
    await appendRunEvents({
      actor,
      orgId: ORG,
      runId: RUN,
      events: [
        { type: "status", state: "busy", attempt: null, message: null },
        { type: "session.idle", session_id: "session-1" },
      ],
      database,
    });

    await expect(
      persistRunTranscript({
        actor,
        orgId: ORG,
        runId: RUN,
        items: [{ kind: "assistant", text: "snapshot-secret answer" }],
        redactor,
        barrierEvent: { type: "session.idle", session_id: "session-1" },
        database,
      }),
    ).resolves.toBe(true);
    expect(run.transcriptEventSequence).toBe(3);
    expect(events.at(-1)).toMatchObject({ sequence: 3, type: "session.idle" });
    expect(JSON.stringify(run.transcript)).toContain("[REDACTED]");
    expect(JSON.stringify(run.transcript)).not.toContain("snapshot-secret");
  });

  it("keeps a deduplicated redacted warning snapshot after live events expire", async () => {
    const { database, run } = eventDb();
    const redactor = createRunRedactor(["warning-secret"]);
    const warning = {
      type: "run.warning" as const,
      code: "vanish_publish_failed",
      message: "warning-secret could not be published",
      phase: "collect_artifacts" as const,
    };
    await appendRunEvents({ actor, orgId: ORG, runId: RUN, events: [warning, warning], redactor, database });
    await appendRunEvents({ actor, orgId: ORG, runId: RUN, events: [warning], redactor, database });

    expect(run.warnings).toEqual([
      {
        code: "vanish_publish_failed",
        message: "[REDACTED] could not be published",
        phase: "collect_artifacts",
      },
    ]);
    expect(JSON.stringify(run.warnings)).not.toContain("warning-secret");
  });
});

function cancellationDb(status: "queued" | "running" | "canceled") {
  const run = {
    id: RUN,
    orgId: ORG,
    creatorId: actor.id,
    status,
    phase: status === "queued" ? "queued" : status === "running" ? "record" : "complete",
    cancelRequestedAt: status === "canceled" ? new Date() : null,
  } as Record<string, unknown>;
  const job = { orgId: ORG, runId: RUN, creatorId: actor.id, status: "queued", phase: "queued" } as Record<string, unknown>;
  const prompt = { orgId: ORG, runId: RUN, status: "queued" } as Record<string, unknown>;
  const audit: Record<string, unknown>[] = [];
  const handle = {
    query: { memberships: { findFirst: async () => ({ orgRole: "developer" }) } },
    transaction: async (fn: (transaction: Db) => Promise<unknown>) => fn(handle as unknown as Db),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.skillRuns) {
            return Object.assign(Promise.resolve([run]), { for: async () => [run] });
          }
          throw new Error("unexpected select");
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: async () => {
          if (table === schema.skillRuns) Object.assign(run, patch);
          else if (table === schema.skillRunJobs) Object.assign(job, patch);
          else if (table === schema.skillRunPrompts) Object.assign(prompt, patch);
          else throw new Error("unexpected update");
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        if (table !== schema.auditLog) throw new Error("unexpected insert");
        audit.push(value);
      },
    }),
  };
  return { database: handle as unknown as Db, run, job, prompt, audit };
}

describe("run cancellation", () => {
  it("cancels queued work atomically without ever creating a sandbox", async () => {
    const state = cancellationDb("queued");
    await expect(
      requestRunCancellation({ actor, orgId: ORG, runId: RUN, database: state.database }),
    ).resolves.toEqual({ status: "canceled", requested: true });
    expect(state.run).toMatchObject({ status: "canceled", phase: "complete" });
    expect(state.job).toMatchObject({ status: "canceled", phase: "complete", leaseOwner: null });
    expect(state.prompt).toMatchObject({ status: "canceled", leaseOwner: null });
    expect(state.audit).toHaveLength(1);
  });

  it("marks an active run for worker-owned snapshot and teardown", async () => {
    const state = cancellationDb("running");
    await expect(
      requestRunCancellation({ actor, orgId: ORG, runId: RUN, database: state.database }),
    ).resolves.toEqual({ status: "running", requested: true });
    expect(state.run).toMatchObject({ status: "running", phase: "cancel" });
    expect(state.run.cancelRequestedAt).toBeInstanceOf(Date);
  });

  it("does not enqueue duplicate cancellation work for an active run", async () => {
    const state = cancellationDb("running");
    await requestRunCancellation({ actor, orgId: ORG, runId: RUN, database: state.database });
    await expect(
      requestRunCancellation({ actor, orgId: ORG, runId: RUN, database: state.database }),
    ).resolves.toEqual({ status: "running", requested: false });
    expect(state.audit).toHaveLength(1);
  });

  it("is idempotent after a terminal cancellation", async () => {
    const state = cancellationDb("canceled");
    await expect(
      requestRunCancellation({ actor, orgId: ORG, runId: RUN, database: state.database }),
    ).resolves.toEqual({ status: "canceled", requested: false });
    expect(state.audit).toEqual([]);
  });
});

function failureDb(cancelRequestedAt: Date | null = null) {
  const run = {
    id: RUN,
    orgId: ORG,
    creatorId: actor.id,
    status: "running",
    phase: "record",
    cancelRequestedAt,
  } as Record<string, unknown>;
  const job = {
    id: "50000000-0000-4000-8000-000000000001",
    orgId: ORG,
    runId: RUN,
    creatorId: actor.id,
    status: "leased",
    phase: "record",
    attempt: 3,
    maxAttempts: 3,
    leaseOwner: "worker-a",
  } as Record<string, unknown>;
  const events: Record<string, unknown>[] = [];
  const handle = {
    transaction: async (fn: (transaction: Db) => Promise<unknown>) => fn(handle as unknown as Db),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.skillRuns) return { for: async () => [run] };
          if (table === schema.skillRunJobs) return { for: async () => [job] };
          if (table === schema.skillRunEvents) {
            return Promise.resolve([{ value: events.length ? events.length : null }]);
          }
          throw new Error("unexpected select");
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => {
          const apply = () => {
            if (table === schema.skillRuns) Object.assign(run, patch);
            else if (table === schema.skillRunJobs) Object.assign(job, patch);
            else throw new Error("unexpected update");
          };
          return {
            returning: async () => {
              apply();
              return [{ id: String(table === schema.skillRuns ? run.id : job.id) }];
            },
            then: (resolve: (value: undefined) => unknown) => {
              apply();
              return Promise.resolve(undefined).then(resolve);
            },
          };
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        if (table !== schema.skillRunEvents) throw new Error("unexpected insert");
        events.push(value);
      },
    }),
  };
  return { database: handle as unknown as Db, run, job, events };
}

describe("atomic run failure transition", () => {
  it("persists one redacted terminal event with the terminal state", async () => {
    const state = failureDb();
    const redactor = createRunRedactor(["failure-secret"]);
    await expect(
      failOrRetryRunJob({
        actor,
        orgId: ORG,
        runId: RUN,
        workerId: "worker-a",
        errorCode: "runtime_failed",
        userMessage: "failure-secret failed",
        transient: false,
        redactor,
        database: state.database,
      }),
    ).resolves.toBe("failed");
    expect(state.run).toMatchObject({ status: "error", phase: "record" });
    expect(state.job).toMatchObject({ status: "failed", phase: "record", leaseOwner: null });
    expect(state.events).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "run.error",
        payload: { code: "runtime_failed", message: "[REDACTED] failed", phase: "record" },
      }),
    ]);
  });

  it("hands a racing cancellation back to the same lease owner", async () => {
    const state = failureDb(new Date());
    await expect(
      failOrRetryRunJob({
        actor,
        orgId: ORG,
        runId: RUN,
        workerId: "worker-a",
        errorCode: "runtime_failed",
        userMessage: "failed",
        transient: false,
        database: state.database,
      }),
    ).resolves.toBe("cancel_requested");
    expect(state.job).toMatchObject({ status: "leased", leaseOwner: "worker-a" });
    expect(state.events).toEqual([]);
  });
});

describe("cross-tenant job claim seam", () => {
  it("delegates only bounded claims to the SECURITY DEFINER function", async () => {
    const claimed = [{ id: "job-1", orgId: ORG, runId: RUN }];
    const database = { execute: async () => claimed } as unknown as Db;
    await expect(claimRunJobs({ workerId: "worker-a", limit: 2, leaseSeconds: 30, database })).resolves.toEqual(claimed);
    await expect(claimRunJobs({ workerId: "", database })).rejects.toThrow("worker id");
    await expect(claimRunJobs({ workerId: "worker-a", limit: 33, database })).rejects.toThrow("claim limits");
  });
});

function promptClaimDb(prompt: Record<string, unknown>) {
  const run = {
    id: RUN,
    orgId: ORG,
    creatorId: actor.id,
    status: "running",
    phase: "record",
    cancelRequestedAt: null,
  };
  const job = {
    id: "50000000-0000-4000-8000-000000000002",
    orgId: ORG,
    runId: RUN,
    creatorId: actor.id,
    status: "leased",
    leaseOwner: "worker-a",
  };
  const handle = {
    transaction: async (fn: (transaction: Db) => Promise<unknown>) => fn(handle as unknown as Db),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.skillRuns) {
            return Object.assign(Promise.resolve([run]), { for: async () => [run] });
          }
          if (table === schema.skillRunPrompts) {
            return {
              orderBy: () => ({
                limit: () => ({ for: async () => [prompt] }),
              }),
            };
          }
          if (table === schema.skillRunJobs) {
            return { for: async () => [job] };
          }
          throw new Error("unexpected select");
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (patch: Record<string, unknown>) => ({
        where: () => ({
          returning: async () => {
            if (table !== schema.skillRunPrompts) throw new Error("unexpected update");
            Object.assign(prompt, patch);
            return [prompt];
          },
        }),
      }),
    }),
  };
  return handle as unknown as Db;
}

describe("prompt lease recovery budget", () => {
  it("increments execution attempts for queued dispatch but not an expired processing lease", async () => {
    const prompt = {
      id: "60000000-0000-4000-8000-000000000001",
      orgId: ORG,
      runId: RUN,
      status: "queued",
      attempt: 0,
      leaseReclaimCount: 0,
      ordinal: 1,
    } as Record<string, unknown>;
    const database = promptClaimDb(prompt);
    await claimNextRunPrompt({ actor, orgId: ORG, runId: RUN, workerId: "worker-a", database });
    expect(prompt).toMatchObject({ status: "processing", attempt: 1, leaseReclaimCount: 0 });

    // A deployment/crash resumes the same deterministic message id even at the old safety ceiling.
    Object.assign(prompt, { status: "processing", attempt: 10, leaseReclaimCount: 4, leaseOwner: "worker-a" });
    // Simulate the expired prompt lease being resumed by the still-current job owner.
    await claimNextRunPrompt({ actor, orgId: ORG, runId: RUN, workerId: "worker-b", database });
    expect(prompt).toMatchObject({ status: "processing", attempt: 10, leaseReclaimCount: 5, leaseOwner: "worker-b" });
  });
});
