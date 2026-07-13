import { describe, expect, it } from "vitest";
import { schema, type Db } from "@companion/db";
import { createRunRedactor } from "../src/runRedaction";
import {
  appendRunEvents,
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
      values: (values: Array<Record<string, unknown>>) => ({
        returning: async () => {
          if (table !== schema.skillRunEvents) throw new Error("unexpected insert");
          const rows = values.map((value) => ({ createdAt: new Date(), ...value })) as typeof events;
          events.push(...rows);
          return rows;
        },
      }),
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

  it("snapshots the transcript and its highest folded event sequence atomically", async () => {
    const { database, run } = eventDb();
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
        database,
      }),
    ).resolves.toBe(true);
    expect(run.transcriptEventSequence).toBe(2);
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
        where: async () => {
          if (table === schema.skillRuns) Object.assign(run, patch);
          else if (table === schema.skillRunJobs) Object.assign(job, patch);
          else throw new Error("unexpected update");
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
    expect(state.run).toMatchObject({ status: "error", phase: "cleanup" });
    expect(state.job).toMatchObject({ status: "failed", phase: "cleanup", leaseOwner: null });
    expect(state.events).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "run.error",
        payload: { code: "runtime_failed", message: "[REDACTED] failed", phase: "cleanup" },
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
