import { describe, expect, it } from "vitest";
import {
  RUN_ATTACHMENT_MAX_BYTES,
  RUN_ATTACHMENT_MAX_TOTAL_BYTES,
  RUN_CHAT_DELTA_MAX,
  RUN_CHAT_TOOL_INPUT_MAX,
  RUN_CHAT_TOOL_OUTPUT_MAX,
} from "@companion/contracts";
import { schema, type Db } from "@companion/db";
import { createRunRedactor } from "../src/runRedaction";
import {
  appendRunEvents,
  cancelOutstandingRunPromptsByWorker,
  claimNextRunPrompt,
  claimRunPromptStopRecovery,
  claimRunJobs,
  completeRunPrompt,
  failRunPrompt,
  failOrRetryRunJob,
  persistRunTranscript,
  requestRunCancellation,
  requestRunPromptCancellation,
} from "../src/runJobs";
import { validateRunMessageAttachments } from "../src/skillRuns";
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
  const prompts: Array<{ messageId: string; userText: string }> = [];
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
          if (table === schema.skillRunPrompts) {
            return { orderBy: async () => prompts };
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
  return { database: handle as unknown as Db, events, run, prompts };
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
        { type: "run.warning", code: "recorder_reconnected", message: "super-secret-value recovered", phase: "record" },
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

  it("continues after the folded transcript cursor when retained live events were purged", async () => {
    const { database, events, run } = eventDb();
    run.transcriptEventSequence = 42;
    const rows = await appendRunEvents({
      actor,
      orgId: ORG,
      runId: RUN,
      events: [{ type: "status", state: "busy", attempt: null, message: null }],
      database,
    });
    expect(rows.map((row) => row.sequence)).toEqual([43]);
    expect(events[0]?.sequence).toBe(43);
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

  it("persists user-authored text instead of private runtime attachment instructions", async () => {
    const { database, run, prompts } = eventDb();
    prompts.push({ messageId: "msg-user-attachment", userText: "" });
    await expect(
      persistRunTranscript({
        actor,
        orgId: ORG,
        runId: RUN,
        items: [{
          kind: "user",
          message_id: "msg-user-attachment",
          text: "Inspect files\n\n---\nprivate mounted path: ./attachments/secret.pdf",
        }],
        redactor: createRunRedactor([]),
        database,
      }),
    ).resolves.toBe(true);
    expect(run.transcript).toEqual([{ kind: "user", message_id: "msg-user-attachment", text: "" }]);
  });

  it("keeps a deduplicated redacted warning snapshot after live events expire", async () => {
    const { database, run } = eventDb();
    const redactor = createRunRedactor(["warning-secret"]);
    const warning = {
      type: "run.warning" as const,
      code: "recorder_reconnected",
      message: "warning-secret connection recovered",
      phase: "record" as const,
    };
    await appendRunEvents({ actor, orgId: ORG, runId: RUN, events: [warning, warning], redactor, database });
    await appendRunEvents({ actor, orgId: ORG, runId: RUN, events: [warning], redactor, database });

    expect(run.warnings).toEqual([
      {
        code: "recorder_reconnected",
        message: "[REDACTED] connection recovered",
        phase: "record",
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
    reactivatableUntil: status === "canceled" ? new Date(Date.now() + 60_000) : null,
    activationRevision: 0,
    transcriptEventSequence: 0,
  } as Record<string, unknown>;
  const job = { orgId: ORG, runId: RUN, creatorId: actor.id, status: "queued", phase: "queued" } as Record<string, unknown>;
  const prompt = {
    id: "60000000-0000-4000-8000-000000000010",
    orgId: ORG,
    runId: RUN,
    messageId: "msg_cancel_initial",
    ordinal: 0,
    kind: "initial",
    status: "queued",
    attempt: 0,
    dispatchProtocol: 0,
    sendAttemptedAt: null,
    attachmentsRetained: true,
    cancelRequestedAt: null,
  } as Record<string, unknown>;
  const audit: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const handle = {
    query: { memberships: { findFirst: async () => ({ orgRole: "developer" }) } },
    transaction: async (fn: (transaction: Db) => Promise<unknown>) => fn(handle as unknown as Db),
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.skillRuns) {
            return Object.assign(Promise.resolve([run]), { for: async () => [run] });
          }
          if (table === schema.skillRunPrompts) return { for: async () => [prompt] };
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
            else if (table === schema.skillRunPrompts) Object.assign(prompt, patch);
            else throw new Error("unexpected update");
          };
          return {
            returning: async () => {
              apply();
              return table === schema.skillRunPrompts ? [prompt] : [{ id: String(run.id) }];
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
        if (table === schema.auditLog) audit.push(value);
        else if (table === schema.skillRunEvents) events.push(value);
        else throw new Error("unexpected insert");
      },
    }),
  };
  return { database: handle as unknown as Db, run, job, prompt, audit, events };
}

describe("run cancellation", () => {
  it("cancels queued work atomically without ever creating a sandbox", async () => {
    const state = cancellationDb("queued");
    await expect(
      requestRunCancellation({ actor, orgId: ORG, runId: RUN, database: state.database }),
    ).resolves.toEqual({ status: "canceled", requested: true });
    expect(state.run).toMatchObject({ status: "canceled", phase: "complete" });
    expect(state.run.reactivatableUntil).toBeInstanceOf(Date);
    expect(state.run.sandboxCleanedAt).toBeNull();
    expect(state.job).toMatchObject({ status: "canceled", phase: "complete", leaseOwner: null });
    expect(state.prompt).toMatchObject({ status: "canceled", leaseOwner: null });
    expect(state.events).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "prompt.status",
        payload: expect.objectContaining({ status: "canceled" }),
      }),
    ]);
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

function promptCancellationDb(input: {
  status: "queued" | "processing";
  kind?: "initial" | "follow_up";
  stopReady?: boolean;
  withAttachment?: boolean;
  attachmentCount?: number;
  attempt?: number;
  dispatchProtocol?: number;
  sendAttemptedAt?: Date | null;
}) {
  const run = {
    id: RUN,
    orgId: ORG,
    creatorId: actor.id,
    status: "running",
    phase: "record",
    cancelRequestedAt: null,
    transcriptEventSequence: 0,
  } as Record<string, unknown>;
  const prompt = {
    id: "60000000-0000-4000-8000-000000000099",
    orgId: ORG,
    runId: RUN,
    ordinal: 2,
    messageId: "msg_01J00000000000000000000099",
    kind: input.kind ?? "follow_up",
    status: input.status,
    attempt: input.attempt ?? (input.status === "processing" ? 1 : 0),
    dispatchProtocol: input.dispatchProtocol ?? (input.status === "processing" ? 2 : 0),
    sendAttemptedAt: input.sendAttemptedAt ?? null,
    attachmentsRetained: true,
    cancelRequestedAt: null,
    leaseOwner: input.status === "processing" ? "worker-a" : null,
    leaseExpiresAt: input.status === "processing" ? new Date(Date.now() + 60_000) : null,
  } as Record<string, unknown>;
  const job = {
    id: "50000000-0000-4000-8000-000000000099",
    orgId: ORG,
    runId: RUN,
    creatorId: actor.id,
    status: "leased",
    leaseOwner: "worker-a",
  } as Record<string, unknown>;
  const attachments = input.withAttachment
    ? Array.from({ length: input.attachmentCount ?? 1 }, (_, index) => ({
        storageKey: `run-attachments/file-${index + 1}`,
        promptId: prompt.id,
        byteSize: RUN_ATTACHMENT_MAX_BYTES,
      }))
    : [];
  const reservations: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const audit: Record<string, unknown>[] = [];
  const handle = {
    query: { memberships: { findFirst: async () => ({ orgRole: "developer" }) } },
    transaction: async (fn: (transaction: Db) => Promise<unknown>) => fn(handle as unknown as Db),
    execute: async () => [{ ready: input.stopReady ?? true }],
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.skillRuns) {
            return Object.assign(Promise.resolve([run]), { for: async () => [run] });
          }
          if (table === schema.skillRunPrompts) {
            if (projection && "id" in projection) {
              const active = prompt.status === "queued" || prompt.status === "processing";
              return { for: async () => active ? [prompt] : [] };
            }
            return Object.assign(Promise.resolve([prompt]), { for: async () => [prompt] });
          }
          if (table === schema.skillRunJobs) {
            return Object.assign(Promise.resolve([job]), { for: async () => [job] });
          }
          if (table === schema.skillRunAttachments) return Promise.resolve(attachments);
          if (table === schema.skillRunEvents && projection && "value" in projection) {
            return Promise.resolve([{ value: events.length }]);
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
    insert: (table: unknown) => ({
      values: (value: Record<string, unknown>) => {
        if (table === schema.skillRunAttachmentUploads) {
          reservations.push(value);
          return { onConflictDoUpdate: async () => undefined };
        }
        if (table === schema.skillRunEvents) {
          events.push(value);
          return Promise.resolve();
        }
        if (table === schema.auditLog) {
          audit.push(value);
          return Promise.resolve();
        }
        throw new Error("unexpected insert");
      },
    }),
  };
  return {
    database: handle as unknown as Db,
    run,
    job,
    prompt,
    attachments,
    reservations,
    events,
    audit,
  };
}

describe("prompt-scoped cancellation", () => {
  it("publishes canceled exactly once when the destructive worker owns finalization", async () => {
    const state = promptCancellationDb({ status: "processing" });
    state.run.cancelRequestedAt = new Date();
    await expect(cancelOutstandingRunPromptsByWorker({
      actor,
      orgId: ORG,
      runId: RUN,
      workerId: "worker-a",
      database: state.database,
    })).resolves.toBe(true);
    await expect(cancelOutstandingRunPromptsByWorker({
      actor,
      orgId: ORG,
      runId: RUN,
      workerId: "worker-a",
      database: state.database,
    })).resolves.toBe(true);
    expect(state.prompt.status).toBe("canceled");
    expect(state.events).toEqual([
      expect.objectContaining({
        type: "prompt.status",
        payload: expect.objectContaining({ status: "canceled" }),
      }),
    ]);
  });

  it("removes queued work and hands attachment objects to the age-gated orphan sweeper", async () => {
    const state = promptCancellationDb({ status: "queued", withAttachment: true });
    await expect(requestRunPromptCancellation({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(state.prompt.id),
      database: state.database,
    })).resolves.toEqual({ prompt_id: state.prompt.id, status: "canceled", requested: true });
    expect(state.prompt).toMatchObject({ status: "canceled", leaseOwner: null });
    expect(state.prompt.attachmentsRetained).toBe(false);
    expect(state.attachments).toEqual([
      expect.objectContaining({ storageKey: "run-attachments/file-1", byteSize: RUN_ATTACHMENT_MAX_BYTES }),
    ]);
    expect(state.reservations).toEqual([
      expect.objectContaining({ storageKey: "run-attachments/file-1", creatorId: actor.id }),
    ]);
    expect(state.events.at(-1)).toMatchObject({ type: "prompt.status", payload: expect.objectContaining({ status: "canceled" }) });
  });

  it("direct-cancels a protocol-2 retry that failed before its send barrier", async () => {
    const state = promptCancellationDb({
      status: "queued",
      withAttachment: true,
      attempt: 2,
      dispatchProtocol: 2,
      sendAttemptedAt: null,
    });
    await expect(requestRunPromptCancellation({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(state.prompt.id),
      database: state.database,
    })).resolves.toMatchObject({ status: "canceled", requested: true });
    expect(state.prompt).toMatchObject({
      status: "canceled",
      attempt: 2,
      attachmentsRetained: false,
    });
    expect(state.reservations).toHaveLength(1);
  });

  it("routes an ambiguous queued retry through stop recovery without reserving its files", async () => {
    const state = promptCancellationDb({
      status: "queued",
      withAttachment: true,
      attempt: 2,
      dispatchProtocol: 2,
      sendAttemptedAt: new Date(),
      stopReady: true,
    });
    await expect(requestRunPromptCancellation({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(state.prompt.id),
      database: state.database,
    })).resolves.toMatchObject({ status: "cancel_requested", requested: true });
    expect(state.prompt).toMatchObject({
      status: "processing",
      attachmentsRetained: true,
      cancelRequestedAt: expect.any(Date),
    });
    expect(state.reservations).toEqual([]);
  });

  it("treats a rolling protocol-1 retry without a marker as ambiguous", async () => {
    const state = promptCancellationDb({
      status: "queued",
      withAttachment: true,
      attempt: 1,
      dispatchProtocol: 0,
      sendAttemptedAt: null,
      stopReady: true,
    });
    await expect(requestRunPromptCancellation({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(state.prompt.id),
      database: state.database,
    })).resolves.toMatchObject({ status: "cancel_requested" });
    expect(state.prompt.status).toBe("processing");
    expect(state.reservations).toEqual([]);
  });

  it("reserves only never-dispatched queued follow-ups during whole-run cancellation", async () => {
    const queued = promptCancellationDb({
      status: "queued",
      withAttachment: true,
      attempt: 2,
      dispatchProtocol: 2,
      sendAttemptedAt: null,
    });
    queued.run.cancelRequestedAt = new Date();
    await expect(cancelOutstandingRunPromptsByWorker({
      actor,
      orgId: ORG,
      runId: RUN,
      workerId: "worker-a",
      database: queued.database,
    })).resolves.toBe(true);
    expect(queued.reservations).toHaveLength(1);

    const ambiguous = promptCancellationDb({
      status: "queued",
      withAttachment: true,
      attempt: 2,
      dispatchProtocol: 2,
      sendAttemptedAt: new Date(),
    });
    ambiguous.run.cancelRequestedAt = new Date();
    await cancelOutstandingRunPromptsByWorker({
      actor,
      orgId: ORG,
      runId: RUN,
      workerId: "worker-a",
      database: ambiguous.database,
    });
    expect(ambiguous.reservations).toEqual([]);

    const reactivatableInitial = promptCancellationDb({
      status: "queued",
      kind: "initial",
      withAttachment: true,
    });
    reactivatableInitial.run.cancelRequestedAt = new Date();
    await cancelOutstandingRunPromptsByWorker({
      actor,
      orgId: ORG,
      runId: RUN,
      workerId: "worker-a",
      database: reactivatableInitial.database,
    });
    expect(reactivatableInitial.reservations).toEqual([]);
  });

  it("keeps canceled queued bytes charged until the deferred object sweep succeeds", async () => {
    const state = promptCancellationDb({ status: "queued", withAttachment: true, attachmentCount: 5 });
    await requestRunPromptCancellation({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(state.prompt.id),
      database: state.database,
    });
    const canceledBytes = state.attachments.reduce((total, attachment) => total + attachment.byteSize, 0);
    expect(canceledBytes).toBe(5 * RUN_ATTACHMENT_MAX_BYTES);
    const otherPromptBytes = RUN_ATTACHMENT_MAX_TOTAL_BYTES - canceledBytes;
    expect(() => validateRunMessageAttachments({
      text: "try to reuse the canceled upload budget",
      existingBytes: canceledBytes + otherPromptBytes,
      attachments: [{
        id: "70000000-0000-4000-8000-000000000001",
        fileName: "extra.txt",
        contentType: "text/plain",
        byteSize: 1,
        storageKey: "run-attachments/extra",
      }],
    })).toThrow(expect.objectContaining({ code: "attachment_total_too_large" }));
  });

  it("records one idempotent stop request for a processing prompt", async () => {
    const state = promptCancellationDb({ status: "processing", stopReady: true });
    const request = {
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(state.prompt.id),
      database: state.database,
    };
    await expect(requestRunPromptCancellation(request)).resolves.toEqual({
      prompt_id: state.prompt.id,
      status: "cancel_requested",
      requested: true,
    });
    await expect(requestRunPromptCancellation(request)).resolves.toEqual({
      prompt_id: state.prompt.id,
      status: "cancel_requested",
      requested: false,
    });
    expect(state.events).toHaveLength(1);
    expect(state.audit).toHaveLength(1);
  });

  it("refuses to stop an active turn owned by a rolling protocol-0 worker", async () => {
    const state = promptCancellationDb({ status: "processing", stopReady: false });
    await expect(requestRunPromptCancellation({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(state.prompt.id),
      database: state.database,
    })).rejects.toMatchObject({ code: "prompt_stop_worker_unavailable" });
    expect(state.prompt.cancelRequestedAt).toBeNull();
    expect(state.events).toEqual([]);
  });

  it("requires full End session cancellation for an initial prompt that has not dispatched", async () => {
    const state = promptCancellationDb({ status: "queued", kind: "initial" });
    await expect(requestRunPromptCancellation({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(state.prompt.id),
      database: state.database,
    })).rejects.toMatchObject({ code: "initial_prompt_requires_run_cancel" });
    expect(state.prompt.status).toBe("queued");
  });

  it("lets a committed stop request win atomically over a retryable prompt failure", async () => {
    const state = promptCancellationDb({ status: "processing", stopReady: true });
    const request = {
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(state.prompt.id),
      workerId: "worker-a",
      database: state.database,
    };
    await requestRunPromptCancellation(request);
    await expect(failRunPrompt({
      ...request,
      errorCode: "runtime_error",
      userMessage: "temporary failure",
      retry: true,
    })).resolves.toBe("cancel_requested");
    expect(state.prompt).toMatchObject({ status: "processing" });
    expect(state.prompt.cancelRequestedAt).toBeInstanceOf(Date);

    await expect(failRunPrompt({
      ...request,
      errorCode: "prompt_stop_failed",
      userMessage: "unsafe context",
      retry: false,
      overrideCancellation: true,
    })).resolves.toBe("updated");
    expect(state.prompt).toMatchObject({ status: "error", errorCode: "prompt_stop_failed" });
  });

  it("arbitrates natural completion and stop under the same prompt row lock", async () => {
    const naturallyCompleted = promptCancellationDb({ status: "processing" });
    await expect(completeRunPrompt({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(naturallyCompleted.prompt.id),
      workerId: "worker-a",
      database: naturallyCompleted.database,
    })).resolves.toBe("completed");
    expect(naturallyCompleted.events).toEqual([
      expect.objectContaining({
        type: "prompt.status",
        payload: expect.objectContaining({ status: "completed" }),
      }),
    ]);

    const stopped = promptCancellationDb({ status: "processing" });
    await requestRunPromptCancellation({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(stopped.prompt.id),
      database: stopped.database,
    });
    await expect(completeRunPrompt({
      actor,
      orgId: ORG,
      runId: RUN,
      promptId: String(stopped.prompt.id),
      workerId: "worker-a",
      database: stopped.database,
    })).resolves.toBe("cancel_requested");
    expect(stopped.events).toHaveLength(1);
    expect(stopped.events[0]).toMatchObject({
      type: "prompt.status",
      payload: expect.objectContaining({ status: "cancel_requested" }),
    });
  });
});

function failureDb(cancelRequestedAt: Date | null = null, withPrompt = false) {
  const run = {
    id: RUN,
    orgId: ORG,
    creatorId: actor.id,
    status: "running",
    phase: "record",
    cancelRequestedAt,
    transcriptEventSequence: 0,
  } as Record<string, unknown>;
  const prompt = withPrompt
    ? {
        id: "60000000-0000-4000-8000-000000000011",
        orgId: ORG,
        runId: RUN,
        messageId: "msg_failure_initial",
        ordinal: 0,
        status: "queued",
        cancelRequestedAt: null,
      } as Record<string, unknown>
    : null;
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
          if (table === schema.skillRunPrompts) return { for: async () => prompt ? [prompt] : [] };
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
            else if (table === schema.skillRunPrompts && prompt) Object.assign(prompt, patch);
            else throw new Error("unexpected update");
          };
          return {
            returning: async () => {
              apply();
              if (table === schema.skillRunPrompts) return prompt ? [prompt] : [];
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
  return { database: handle as unknown as Db, run, job, prompt, events };
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

  it("allocates a terminal error above the folded transcript cursor after event purge", async () => {
    const state = failureDb();
    state.run.transcriptEventSequence = 42;
    await expect(
      failOrRetryRunJob({
        actor,
        orgId: ORG,
        runId: RUN,
        workerId: "worker-a",
        errorCode: "run_context_unavailable",
        userMessage: "Retained context unavailable",
        transient: false,
        database: state.database,
      }),
    ).resolves.toBe("failed");
    expect(state.events).toEqual([
      expect.objectContaining({ sequence: 43, type: "run.error" }),
    ]);
  });

  it("terminalizes queued prompts with replayable error status when setup exhausts retries", async () => {
    const state = failureDb(null, true);
    await expect(
      failOrRetryRunJob({
        actor,
        orgId: ORG,
        runId: RUN,
        workerId: "worker-a",
        errorCode: "sandbox_setup_failed",
        userMessage: "Sandbox setup failed",
        transient: false,
        database: state.database,
      }),
    ).resolves.toBe("failed");
    expect(state.prompt).toMatchObject({
      status: "error",
      errorCode: "sandbox_setup_failed",
      userMessage: "Sandbox setup failed",
      leaseOwner: null,
    });
    expect(state.events).toEqual([
      expect.objectContaining({
        sequence: 1,
        type: "prompt.status",
        payload: expect.objectContaining({ status: "error" }),
      }),
      expect.objectContaining({ sequence: 2, type: "run.error" }),
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
  it("delegates only bounded claims and decodes raw PostgreSQL timestamps", async () => {
    const claimed = [{
      id: "job-1",
      orgId: ORG,
      runId: RUN,
      creatorId: actor.id,
      status: "leased",
      phase: "queued",
      attempt: 1,
      maxAttempts: 3,
      leaseReclaimCount: 0,
      availableAt: "2026-07-13T20:00:00.000Z",
      leaseOwner: "worker-a",
      leaseExpiresAt: "2026-07-13T20:00:30.000Z",
      heartbeatAt: null,
      lastErrorCode: null,
      createdAt: "2026-07-13T19:59:00.000Z",
      updatedAt: "2026-07-13T20:00:00.000Z",
    }];
    const database = { execute: async () => claimed } as unknown as Db;
    const rows = await claimRunJobs({ workerId: "worker-a", limit: 2, leaseSeconds: 30, database });
    expect(rows).toEqual([
      expect.objectContaining({
        id: "job-1",
        availableAt: new Date("2026-07-13T20:00:00.000Z"),
        leaseExpiresAt: new Date("2026-07-13T20:00:30.000Z"),
        heartbeatAt: null,
        createdAt: new Date("2026-07-13T19:59:00.000Z"),
        updatedAt: new Date("2026-07-13T20:00:00.000Z"),
      }),
    ]);
    expect(rows[0]?.leaseExpiresAt).toBeInstanceOf(Date);
    expect(rows[0]?.leaseExpiresAt?.getTime()).toBe(Date.parse("2026-07-13T20:00:30.000Z"));
    await expect(claimRunJobs({ workerId: "", database })).rejects.toThrow("worker id");
    await expect(claimRunJobs({ workerId: "worker-a", limit: 33, database })).rejects.toThrow("claim limits");
  });
});

function promptClaimDb(prompt: Record<string, unknown>) {
  const events: Record<string, unknown>[] = [];
  const run = {
    id: RUN,
    orgId: ORG,
    creatorId: actor.id,
    status: "running",
    phase: "record",
    cancelRequestedAt: null,
    transcriptEventSequence: 0,
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
    select: (projection?: Record<string, unknown>) => ({
      from: (table: unknown) => ({
        where: () => {
          if (table === schema.skillRuns) {
            return Object.assign(Promise.resolve([run]), { for: async () => [run] });
          }
          if (table === schema.skillRunPrompts) {
            const lockOne = { for: async () => [prompt] };
            return {
              orderBy: () => ({
                limit: () => lockOne,
              }),
              limit: () => lockOne,
            };
          }
          if (table === schema.skillRunJobs) {
            return { for: async () => [job] };
          }
          if (table === schema.skillRunEvents && projection && "value" in projection) {
            return Promise.resolve([{ value: events.length }]);
          }
          throw new Error("unexpected select");
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        if (table !== schema.skillRunEvents) throw new Error("unexpected insert");
        events.push(value);
      },
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
      messageId: "msg_01J00000000000000000000000",
      cancelRequestedAt: null,
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

  it("reclaims a committed stop without clearing its cancellation intent", async () => {
    const prompt = {
      id: "60000000-0000-4000-8000-000000000002",
      orgId: ORG,
      runId: RUN,
      status: "processing",
      attempt: 1,
      leaseReclaimCount: 2,
      ordinal: 2,
      messageId: "msg_01J00000000000000000000002",
      cancelRequestedAt: new Date(),
      leaseOwner: "crashed-worker",
    } as Record<string, unknown>;
    const database = promptClaimDb(prompt);
    await expect(claimRunPromptStopRecovery({
      actor,
      orgId: ORG,
      runId: RUN,
      workerId: "replacement-worker",
      database,
    })).resolves.toMatchObject({
      status: "processing",
      leaseOwner: "replacement-worker",
      leaseReclaimCount: 3,
      cancelRequestedAt: expect.any(Date),
    });
  });
});
