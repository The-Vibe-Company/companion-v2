import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunRedactor, RunRuntimeError, type RunSandboxRuntime, type SandboxRef } from "@companion/core";
import { putRunArtifactMetadata, RunBusyError, RunValidationError } from "@companion/core/services";
import {
  abortConversationForRetention,
  abortPromptForContinuation,
  armRecorderForPromptDispatch,
  cancellationStateAfterStop,
  claimedRunLeaseDeadline,
  assertRetainedConversationAvailable,
  createSandboxTimeoutExtender,
  collectAndCacheRunArtifacts,
  createSingleFlightArtifactCollector,
  createRecorderIdleBarrierTracker,
  dispatchPromptAfterAttachmentMount,
  isTransientRunFailure,
  promptStopBarrierPlan,
  proveSessionIdleAfterMissingAttempt,
  releaseSyntheticRecorderBusy,
  recorderRetryWindowExpired,
  runFailureEvent,
  sandboxTimeoutExtensionSchedule,
  shouldHeartbeatRunLease,
  toolMayWriteArtifacts,
} from "./runSupervisor";

afterEach(() => {
  vi.useRealTimers();
});

describe("run worker retry classification", () => {
  it("retries provider/runtime outages", () => {
    expect(isTransientRunFailure(new RunRuntimeError("provider unavailable"))).toBe(true);
    const aborted = new Error("request aborted");
    aborted.name = "AbortError";
    expect(isTransientRunFailure(aborted)).toBe(true);
  });

  it("fails validation and conflict errors immediately", () => {
    expect(isTransientRunFailure(new RunValidationError("secret unavailable", "secret_unavailable"))).toBe(false);
    expect(isTransientRunFailure(new RunBusyError("run is terminal", "run_terminal"))).toBe(false);
    expect(isTransientRunFailure(new Error("database connection reset"))).toBe(true);
  });
});

describe("recorder retry deadline", () => {
  it("stops at the absolute runtime deadline before the five-minute retry window", () => {
    expect(recorderRetryWindowExpired({
      degradedAtMs: 1_000,
      nowMs: 20_000,
      maxUnavailableMs: 300_000,
      runtimeDeadlineAt: new Date(20_000),
    })).toBe(true);
  });

  it("stops at the retry window when the runtime deadline is later", () => {
    expect(recorderRetryWindowExpired({
      degradedAtMs: 1_000,
      nowMs: 301_000,
      maxUnavailableMs: 300_000,
      runtimeDeadlineAt: new Date(600_000),
    })).toBe(true);
    expect(recorderRetryWindowExpired({
      degradedAtMs: 1_000,
      nowMs: 300_999,
      maxUnavailableMs: 300_000,
      runtimeDeadlineAt: null,
    })).toBe(false);
  });
});

describe("reactivated OpenCode context", () => {
  it("fails closed when a reactivated run lost its retained session", () => {
    expect(() => assertRetainedConversationAvailable({
      activationRevision: 1,
      opencodeSessionId: "session-1",
      sessionState: "missing",
    })).toThrow(expect.objectContaining({ code: "run_context_unavailable" }));
    expect(() => assertRetainedConversationAvailable({
      activationRevision: 1,
      opencodeSessionId: "session-1",
      sessionState: "idle",
    })).not.toThrow();
    expect(() => assertRetainedConversationAvailable({
      activationRevision: 1,
      opencodeSessionId: null,
      sessionState: "missing",
    })).not.toThrow();
  });

  it("retains only after OpenCode confirms that the canceled turn was aborted", async () => {
    const target = { domain: "sandbox.example", password: "secret" };
    const signal = new AbortController().signal;
    const abortSession = vi.fn(async () => undefined);

    await expect(abortConversationForRetention({
      chat: { abortSession },
      target,
      sessionId: "session-1",
      signal,
    })).resolves.toBe(true);
    expect(abortSession).toHaveBeenCalledWith(target, "session-1", signal);

    abortSession.mockRejectedValueOnce(new Error("OpenCode unavailable"));
    await expect(abortConversationForRetention({
      chat: { abortSession },
      target,
      sessionId: "session-1",
      signal,
    })).resolves.toBe(false);
  });

  it("allows pre-session cancellations to retain their sandbox", async () => {
    const abortSession = vi.fn(async () => undefined);
    await expect(abortConversationForRetention({
      chat: { abortSession },
      target: null,
      sessionId: null,
      signal: new AbortController().signal,
    })).resolves.toBe(true);
    expect(abortSession).not.toHaveBeenCalled();
  });
});

describe("claimed run lease decoding boundary", () => {
  it("accepts decoded dates and routes malformed claims through durable runtime failure handling", () => {
    expect(claimedRunLeaseDeadline({ leaseExpiresAt: new Date("2026-07-13T20:00:30.000Z") }))
      .toBe(Date.parse("2026-07-13T20:00:30.000Z"));
    expect(() => claimedRunLeaseDeadline({ leaseExpiresAt: new Date(Number.NaN) }))
      .toThrow("invalid lease metadata");
    expect(() => claimedRunLeaseDeadline({ leaseExpiresAt: null }))
      .toThrow("invalid lease metadata");
  });
});

describe("cancellation lease finalization", () => {
  it("keeps heartbeating after user work is aborted while the retained sandbox is finalized", () => {
    expect(shouldHeartbeatRunLease({ signalAborted: false, finalizingCancellation: false })).toBe(true);
    expect(shouldHeartbeatRunLease({ signalAborted: true, finalizingCancellation: false })).toBe(false);
    expect(shouldHeartbeatRunLease({ signalAborted: true, finalizingCancellation: true })).toBe(true);
  });
});

describe("cancellation sandbox settlement", () => {
  it("retains an existing stop but leaves cleanup owed when the sandbox name is still missing", () => {
    expect(cancellationStateAfterStop(true)).toEqual({ retained: true, cleaned: false });
    expect(cancellationStateAfterStop(false)).toEqual({ retained: false, cleaned: true });
  });
});

describe("run worker failure events", () => {
  it("keeps retries non-terminal and emits run.error only after exhaustion", () => {
    expect(runFailureEvent("queued", { attempt: 1, code: "runtime_error", message: "Unavailable" }))
      .toEqual({ type: "status", state: "retry", attempt: 2, message: "Retrying the run" });
    expect(runFailureEvent("failed", { attempt: 3, code: "runtime_error", message: "Unavailable" }))
      .toBeNull();
    expect(runFailureEvent("cancel_requested", { attempt: 1, code: "runtime_error", message: "Unavailable" }))
      .toBeNull();
    expect(runFailureEvent("lost_lease", { attempt: 1, code: "runtime_error", message: "Unavailable" }))
      .toBeNull();
  });
});

describe("follow-up attachment dispatch ordering", () => {
  it("mounts files before inspecting and sending the deterministic message", async () => {
    const calls: string[] = [];
    await dispatchPromptAfterAttachmentMount({
      mountAttachments: async () => { calls.push("mount"); },
      getMessageState: async () => { calls.push("inspect"); return "missing"; },
      beforeSend: async () => { calls.push("mark"); },
      sendPrompt: async () => { calls.push("send"); },
    });
    expect(calls).toEqual(["mount", "inspect", "mark", "send"]);
  });

  it("never inspects or sends a prompt when attachment mounting fails", async () => {
    const getMessageState = vi.fn(async () => "missing" as const);
    const sendPrompt = vi.fn(async () => undefined);
    await expect(dispatchPromptAfterAttachmentMount({
      mountAttachments: async () => { throw new Error("storage unavailable"); },
      getMessageState,
      sendPrompt,
    })).rejects.toThrow("storage unavailable");
    expect(getMessageState).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it("rewrites safely after a retry without resending an existing message", async () => {
    const calls: string[] = [];
    await dispatchPromptAfterAttachmentMount({
      mountAttachments: async () => { calls.push("mount"); },
      getMessageState: async () => { calls.push("inspect"); return "completed"; },
      onMessageObserved: async () => { calls.push("observe"); },
      sendPrompt: async () => { calls.push("send"); },
    });
    expect(calls).toEqual(["mount", "inspect", "observe"]);
  });

  it("clears a completed retry revision before a racing cancellation can interrupt marking", async () => {
    let turnBarrierRevision: number | null = 7;
    await expect(dispatchPromptAfterAttachmentMount({
      mountAttachments: async () => undefined,
      getMessageState: async () => "completed",
      onMessageObserved: async (state) => {
        if (state === "completed") turnBarrierRevision = null;
        throw new Error("cancel_requested");
      },
      sendPrompt: async () => undefined,
    })).rejects.toThrow("cancel_requested");
    expect(turnBarrierRevision).toBeNull();
  });
});

describe("prompt FIFO dispatch gate", () => {
  it("starts the next prompt when cancellation wins after claim but before dispatch", () => {
    const recorder = { busy: false };
    const prompts = [
      { id: "prompt-canceled", control: "cancel_requested" as const },
      { id: "prompt-next", control: "continue" as const },
    ];
    const dispatched: string[] = [];

    for (const prompt of prompts) {
      if (recorder.busy) break;
      const control = armRecorderForPromptDispatch(recorder, prompt.control);
      if (control === "cancel_requested") continue;
      dispatched.push(prompt.id);
    }

    expect(dispatched).toEqual(["prompt-next"]);
    expect(recorder.busy).toBe(true);
  });

  it("releases only a synthetic pre-send busy gate", () => {
    const unsent = { busy: true };
    expect(releaseSyntheticRecorderBusy(unsent, false)).toBe(true);
    expect(unsent.busy).toBe(false);

    const ambiguous = { busy: true };
    expect(releaseSyntheticRecorderBusy(ambiguous, true)).toBe(false);
    expect(ambiguous.busy).toBe(true);
  });
});

describe("prompt-scoped stop barrier", () => {
  it("proves an attempted-but-missing message session idle before continuation", async () => {
    const target = { domain: "sandbox.example", password: "secret" };
    const abortSession = vi.fn(async () => undefined);
    const getSessionState = vi.fn()
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("idle");

    await expect(proveSessionIdleAfterMissingAttempt({
      chat: { abortSession, getSessionState },
      target,
      sessionId: "session-1",
      signal: new AbortController().signal,
      timeoutMs: 1_000,
    })).resolves.toBe("aborted");
    expect(abortSession).toHaveBeenCalledOnce();
    expect(getSessionState).toHaveBeenCalledTimes(3);
  });

  it("keeps continuation closed when an ambiguous prompt lost its session", async () => {
    const abortSession = vi.fn(async () => undefined);
    await expect(proveSessionIdleAfterMissingAttempt({
      chat: { abortSession, getSessionState: vi.fn(async () => "missing" as const) },
      target: { domain: "sandbox.example", password: "secret" },
      sessionId: "session-1",
      signal: new AbortController().signal,
    })).rejects.toThrow("conversation context disappeared");
    expect(abortSession).not.toHaveBeenCalled();
  });

  it("publishes a new continuation revision only after snapshot and fresh idle reconnect", async () => {
    const barriers = createRecorderIdleBarrierTracker();
    const signal = new AbortController().signal;
    const before = barriers.revision();
    let resolved = false;
    const waiting = barriers.waitForAfter(before, 1_000, signal).then(() => { resolved = true; });

    barriers.markFreshIdleConnection();
    barriers.markSnapshotPersisted();
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(barriers.revision()).toBe(before);

    barriers.markFreshIdleConnection();
    await waiting;
    expect(resolved).toBe(true);
    expect(barriers.revision()).toBe(before + 1);
  });

  it("fails closed when the recorder never reconnects after its durable snapshot", async () => {
    const barriers = createRecorderIdleBarrierTracker();
    const before = barriers.revision();
    barriers.markSnapshotPersisted();
    await expect(barriers.waitForAfter(before, 5, new AbortController().signal))
      .rejects.toThrow("durable idle barrier");
    expect(barriers.revision()).toBe(before);

    const closed = createRecorderIdleBarrierTracker();
    const waiting = closed.waitForAfter(0, 1_000, new AbortController().signal);
    closed.close(new Error("recorder closed"));
    await expect(waiting).rejects.toThrow("recorder closed");
  });

  it("accepts a natural-completion barrier already acquired during the stop race", async () => {
    const barriers = createRecorderIdleBarrierTracker();
    const turnRevision = barriers.revision();
    barriers.markSnapshotPersisted();
    barriers.markFreshIdleConnection();

    expect(promptStopBarrierPlan({
      messageState: "completed",
      turnBarrierRevision: turnRevision,
      currentBarrierRevision: barriers.revision(),
    })).toEqual({ abort: false, waitAfterRevision: turnRevision });

    await expect(barriers.waitForAfter(turnRevision, 1_000, new AbortController().signal))
      .resolves.toBeUndefined();
    expect(barriers.revision()).toBe(turnRevision + 1);
  });

  it("does not abort an idle shared session when cancellation won before dispatch", async () => {
    const abortSession = vi.fn(async () => undefined);
    const getSessionState = vi.fn(async () => "idle" as const);
    await expect(abortPromptForContinuation({
      chat: { abortSession, getSessionState },
      target: { domain: "sandbox.example", password: "secret" },
      sessionId: "session-1",
      messageExists: false,
      signal: new AbortController().signal,
    })).resolves.toBeUndefined();
    expect(abortSession).not.toHaveBeenCalled();
    expect(getSessionState).not.toHaveBeenCalled();
  });

  it("does not abort when the attempted-but-missing message session is already idle", async () => {
    const abortSession = vi.fn(async () => undefined);
    await expect(proveSessionIdleAfterMissingAttempt({
      chat: { abortSession, getSessionState: vi.fn(async () => "idle" as const) },
      target: { domain: "sandbox.example", password: "secret" },
      sessionId: "session-1",
      signal: new AbortController().signal,
    })).resolves.toBe("already_idle");
    expect(abortSession).not.toHaveBeenCalled();
  });

  it("aborts a dispatched turn and waits until OpenCode confirms idle", async () => {
    const abortSession = vi.fn(async () => undefined);
    const getSessionState = vi.fn()
      .mockResolvedValueOnce("busy")
      .mockResolvedValueOnce("idle");
    await expect(abortPromptForContinuation({
      chat: { abortSession, getSessionState },
      target: { domain: "sandbox.example", password: "secret" },
      sessionId: "session-1",
      messageExists: true,
      signal: new AbortController().signal,
      timeoutMs: 2_000,
    })).resolves.toBeUndefined();
    expect(abortSession).toHaveBeenCalledTimes(1);
    expect(getSessionState).toHaveBeenCalledTimes(2);
  });
});

describe("run artifact publication", () => {
  const job = {
    orgId: "11111111-1111-4111-8111-111111111111",
    runId: "22222222-2222-4222-8222-222222222222",
    creatorId: "user-1",
    leaseOwner: "worker-1",
  };
  const actor = { id: "user-1", email: "user@example.test", name: "User" };
  const ref: SandboxRef = { sandboxName: "run-test", sandboxId: "run-test", region: "iad1", timeoutMs: 60_000 };

  it("publishes an empty successful scan so collecting state always settles", async () => {
    const append = vi.fn(async () => undefined);
    const reconcileMetadata = vi.fn(async () => true);
    const ready = await collectAndCacheRunArtifacts({
      job: job as never,
      actor,
      workerId: "worker-1",
      ctx: { runtime: { collectOutputFiles: async () => [] } as unknown as RunSandboxRuntime } as never,
      ref,
      imagePaths: [],
      redactor: createRunRedactor([]),
      signal: new AbortController().signal,
      dependencies: { append, reconcileMetadata },
    });
    expect(ready).toBe(0);
    expect(reconcileMetadata).toHaveBeenCalledWith(expect.objectContaining({ paths: [] }));
    expect(append).toHaveBeenCalledWith([{ type: "artifacts.updated", count: 0 }]);
  });

  it("uses one deterministic object key and renews the same path through reservation and ready", async () => {
    const putMetadata = vi.fn(async (_input: Parameters<typeof putRunArtifactMetadata>[0]) => true);
    const putObject = vi.fn(async (_input: { body: Uint8Array }) => undefined);
    const headObject = vi.fn(async () => null);
    const append = vi.fn(async () => undefined);
    const reconcileMetadata = vi.fn(async () => true);
    const collectOutputFiles = vi.fn(async () => [{ path: "artifacts/cat.png", data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), byteSize: 8 }]);
    const ready = await collectAndCacheRunArtifacts({
      job: job as never,
      actor,
      workerId: "worker-1",
      ctx: { runtime: { collectOutputFiles } as unknown as RunSandboxRuntime } as never,
      ref,
      imagePaths: [],
      redactor: createRunRedactor([]),
      signal: new AbortController().signal,
      dependencies: { putMetadata, reconcileMetadata, headObject, putObject, append, now: () => Date.parse("2026-07-16T12:00:00Z") },
    });
    expect(ready).toBe(1);
    expect(reconcileMetadata).toHaveBeenCalledWith(expect.objectContaining({ paths: ["artifacts/cat.png"] }));
    expect(putMetadata).toHaveBeenCalledTimes(3);
    expect(putMetadata.mock.calls[0]![0]).toMatchObject({ ready: false, path: "artifacts/cat.png" });
    expect(putMetadata.mock.calls[1]![0]).toMatchObject({ ready: false, path: "artifacts/cat.png" });
    expect(putMetadata.mock.calls[2]![0]).toMatchObject({
      ready: true,
      storageKey: putMetadata.mock.calls[0]![0].storageKey,
      expiresAt: new Date("2026-07-17T12:00:00Z"),
    });
    expect(append).toHaveBeenCalledWith([{ type: "artifacts.updated", count: 1 }]);
    expect(putObject).toHaveBeenCalledWith(expect.objectContaining({
      preventOverwrite: true,
      ifMatch: undefined,
      signal: expect.any(AbortSignal),
    }));
  });

  it("leaves a non-ready reservation and emits a non-terminal warning after an upload crash", async () => {
    const putMetadata = vi.fn(async (_input: Parameters<typeof putRunArtifactMetadata>[0]) => true);
    const append = vi.fn(async () => undefined);
    const ready = await collectAndCacheRunArtifacts({
      job: job as never,
      actor,
      workerId: "worker-1",
      ctx: {
        runtime: {
          collectOutputFiles: async () => [{ path: "artifacts/report.txt", data: Buffer.from("report"), byteSize: 6 }],
        } as unknown as RunSandboxRuntime,
      } as never,
      ref,
      imagePaths: [],
      redactor: createRunRedactor([]),
      signal: new AbortController().signal,
      dependencies: {
        putMetadata,
        headObject: async () => null,
        putObject: async () => { throw new Error("crash after reservation"); },
        append,
      },
    });
    expect(ready).toBe(0);
    expect(putMetadata).toHaveBeenCalledTimes(2);
    expect(putMetadata.mock.calls[0]![0]).toMatchObject({ ready: false });
    expect(append).toHaveBeenCalledWith([
      { type: "artifacts.updated", count: 0 },
      expect.objectContaining({ type: "run.warning", code: "artifact_collection_failed" }),
    ]);
  });

  it("redacts exact injected secret bytes before an artifact reaches object storage", async () => {
    const secret = "provider-secret-value";
    const putMetadata = vi.fn(async (_input: Parameters<typeof putRunArtifactMetadata>[0]) => true);
    const putObject = vi.fn(async (_input: { body: Uint8Array }) => undefined);
    const append = vi.fn(async () => undefined);
    const ready = await collectAndCacheRunArtifacts({
      job: job as never,
      actor,
      workerId: "worker-1",
      ctx: {
        runtime: {
          collectOutputFiles: async () => [{
            path: "artifacts/report.txt",
            data: Buffer.from(`before ${secret} after`),
            byteSize: 35,
          }],
        } as unknown as RunSandboxRuntime,
      } as never,
      ref,
      imagePaths: [],
      redactor: createRunRedactor([secret]),
      signal: new AbortController().signal,
      dependencies: {
        putMetadata,
        headObject: async () => null,
        putObject,
        append,
      },
    });

    expect(ready).toBe(1);
    const uploaded = Buffer.from(putObject.mock.calls[0]![0].body);
    expect(uploaded.toString("utf8")).toBe("before [REDACTED] after");
    expect(uploaded.includes(Buffer.from(secret))).toBe(false);
    expect(putMetadata.mock.calls.at(-1)?.[0]).toMatchObject({ ready: true, byteSize: uploaded.length });
  });

  it("retires a prior path when redaction leaves no publishable bytes", async () => {
    const secret = "provider-secret-value";
    const reconcileMetadata = vi.fn(async () => true);
    const append = vi.fn(async () => undefined);
    const ready = await collectAndCacheRunArtifacts({
      job: job as never,
      actor,
      workerId: "worker-1",
      ctx: {
        runtime: {
          collectOutputFiles: async () => [{
            path: "artifacts/secret.txt",
            data: Buffer.from(secret),
            byteSize: secret.length,
          }],
        } as unknown as RunSandboxRuntime,
      } as never,
      ref,
      imagePaths: [],
      redactor: { redactBytes: () => Buffer.alloc(0) } as never,
      signal: new AbortController().signal,
      dependencies: { reconcileMetadata, append },
    });

    expect(ready).toBe(0);
    expect(reconcileMetadata).toHaveBeenCalledWith(expect.objectContaining({ paths: [] }));
    expect(append).toHaveBeenCalledWith([
      { type: "artifacts.updated", count: 0 },
      expect.objectContaining({ type: "run.warning", code: "artifact_collection_failed" }),
    ]);
  });

  it("revalidates the exact lease and retries with the latest ETag after a CAS collision", async () => {
    const putMetadata = vi.fn(async (_input: Parameters<typeof putRunArtifactMetadata>[0]) => true);
    const append = vi.fn(async () => undefined);
    const headObject = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ etag: '"winner"' });
    const collision = Object.assign(new Error("precondition failed"), { name: "PreconditionFailed" });
    const putObject = vi.fn()
      .mockRejectedValueOnce(collision)
      .mockResolvedValueOnce(undefined);

    const ready = await collectAndCacheRunArtifacts({
      job: job as never,
      actor,
      workerId: "worker-1",
      ctx: {
        runtime: {
          collectOutputFiles: async () => [{ path: "artifacts/report.txt", data: Buffer.from("report"), byteSize: 6 }],
        } as unknown as RunSandboxRuntime,
      } as never,
      ref,
      imagePaths: [],
      redactor: createRunRedactor([]),
      signal: new AbortController().signal,
      dependencies: {
        putMetadata,
        headObject,
        putObject,
        isPreconditionFailure: (error) => error === collision,
        append,
      },
    });

    expect(ready).toBe(1);
    expect(putMetadata).toHaveBeenCalledTimes(4);
    expect(putObject).toHaveBeenNthCalledWith(1, expect.objectContaining({ preventOverwrite: true }));
    expect(putObject).toHaveBeenNthCalledWith(2, expect.objectContaining({ ifMatch: '"winner"' }));
  });

  it("does not upload after the worker loses its lease between reservation and PUT", async () => {
    const putMetadata = vi.fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const append = vi.fn(async () => undefined);
    const putObject = vi.fn(async () => undefined);

    const ready = await collectAndCacheRunArtifacts({
      job: job as never,
      actor,
      workerId: "stale-worker",
      ctx: {
        runtime: {
          collectOutputFiles: async () => [{ path: "artifacts/report.txt", data: Buffer.from("report"), byteSize: 6 }],
        } as unknown as RunSandboxRuntime,
      } as never,
      ref,
      imagePaths: [],
      redactor: createRunRedactor([]),
      signal: new AbortController().signal,
      dependencies: {
        putMetadata,
        headObject: async () => null,
        putObject,
        append,
      },
    });

    expect(ready).toBe(0);
    expect(putObject).not.toHaveBeenCalled();
    expect(append).toHaveBeenCalledWith([
      { type: "artifacts.updated", count: 0 },
      expect.objectContaining({ type: "run.warning", code: "artifact_collection_failed" }),
    ]);
  });

  it("aborts a stalled object upload at the storage deadline", async () => {
    vi.useFakeTimers();
    const putMetadata = vi.fn(async (_input: Parameters<typeof putRunArtifactMetadata>[0]) => true);
    const append = vi.fn(async () => undefined);
    let uploadSignal: AbortSignal | undefined;
    const result = collectAndCacheRunArtifacts({
      job: job as never,
      actor,
      workerId: "worker-1",
      ctx: {
        runtime: {
          collectOutputFiles: async () => [{ path: "artifacts/report.txt", data: Buffer.from("report"), byteSize: 6 }],
        } as unknown as RunSandboxRuntime,
      } as never,
      ref,
      imagePaths: [],
      redactor: createRunRedactor([]),
      signal: new AbortController().signal,
      dependencies: {
        putMetadata,
        headObject: async () => null,
        putObject: ({ signal }) => new Promise((_resolve, reject) => {
          uploadSignal = signal;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
        append,
      },
    });

    await vi.advanceTimersByTimeAsync(30_001);
    await expect(result).resolves.toBe(0);
    expect(uploadSignal?.aborted).toBe(true);
    expect(append).toHaveBeenCalledWith([
      { type: "artifacts.updated", count: 0 },
      expect.objectContaining({ type: "run.warning", code: "artifact_collection_failed" }),
    ]);
  });
});

describe("live artifact collection triggers", () => {
  it("recognizes artifact writes and targeted shell commands without scanning unrelated tools", () => {
    expect(toolMayWriteArtifacts("write", '{"filePath":"/vercel/sandbox/artifacts/todo.txt"}')).toBe(true);
    expect(toolMayWriteArtifacts("edit", '{"path":"artifacts/report.md"}')).toBe(true);
    expect(toolMayWriteArtifacts("apply_patch", "*** Update File: ./artifacts/report.md")).toBe(true);
    expect(toolMayWriteArtifacts("bash", '{"command":"python build.py > artifacts/report.csv"}')).toBe(true);
    expect(toolMayWriteArtifacts("write", '{"filePath":"src/index.ts"}')).toBe(false);
    expect(toolMayWriteArtifacts("read", '{"filePath":"artifacts/report.md"}')).toBe(false);
  });

  it("coalesces concurrent requests into one in-flight scan and one trailing scan", async () => {
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => { release = resolve; });
    const collect = vi.fn()
      .mockImplementationOnce(() => firstGate)
      .mockResolvedValue(undefined);
    const collector = createSingleFlightArtifactCollector(collect);

    collector.request();
    collector.request();
    collector.request();
    expect(collect).toHaveBeenCalledTimes(1);
    release();
    await collector.waitForIdle();
    expect(collect).toHaveBeenCalledTimes(2);
  });
});

describe("active sandbox hard-timeout extension", () => {
  it("bounds both the provider extension and refresh cadence", () => {
    expect(sandboxTimeoutExtensionSchedule(1)).toEqual({ extensionMs: 10_000, intervalMs: 5_000 });
    expect(sandboxTimeoutExtensionSchedule(300_000)).toEqual({ extensionMs: 300_000, intervalMs: 60_000 });
    expect(sandboxTimeoutExtensionSchedule(Number.MAX_SAFE_INTEGER)).toEqual({
      extensionMs: 3_600_000,
      intervalMs: 60_000,
    });
  });

  it("extends immediately and periodically, then stops before teardown", async () => {
    vi.useFakeTimers();
    const extendTimeout = vi.fn(async () => undefined);
    const runtime = { extendTimeout } as unknown as RunSandboxRuntime;
    const ref: SandboxRef = {
      sandboxName: "run-test",
      sandboxId: "sandbox-test",
      region: "iad1",
      timeoutMs: 20_000,
    };
    const extender = createSandboxTimeoutExtender(runtime);
    extender.activate(ref);
    await vi.advanceTimersByTimeAsync(0);
    expect(extendTimeout).toHaveBeenCalledWith(ref, 20_000, expect.any(AbortSignal));

    await vi.advanceTimersByTimeAsync(20_000);
    expect(extendTimeout).toHaveBeenCalledTimes(3);
    await extender.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(extendTimeout).toHaveBeenCalledTimes(3);
  });

  it("extends a managed sandbox only by newly reserved runtime", async () => {
    vi.useFakeTimers();
    const extendTimeout = vi.fn(async () => undefined);
    const runtime = { extendTimeout } as unknown as RunSandboxRuntime;
    const ref: SandboxRef = {
      sandboxName: "run-managed",
      sandboxId: "sandbox-managed",
      region: "iad1",
      timeoutMs: 20_000,
    };
    const readBudgetMs = vi.fn(async () => 20_000);
    const extender = createSandboxTimeoutExtender(runtime, readBudgetMs);
    extender.activate(ref);
    await vi.advanceTimersByTimeAsync(0);
    expect(extendTimeout).not.toHaveBeenCalled();

    readBudgetMs.mockResolvedValue(27_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(extendTimeout).toHaveBeenCalledWith(ref, 7_000, expect.any(AbortSignal));

    await vi.advanceTimersByTimeAsync(5_000);
    expect(extendTimeout).toHaveBeenCalledTimes(1);
    await extender.stop();
  });

  it("uses the safety cap when a managed observe-mode budget is null", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    const ref: SandboxRef = {
      sandboxName: "run-observe",
      sandboxId: "sandbox-observe",
      region: "iad1",
      timeoutMs: 300_000,
    };
    const observe = vi.fn(async () => ({
      state: "running" as const,
      expiresAt: new Date("2026-07-23T12:05:00.000Z"),
    }));
    const extendTimeout = vi.fn(async (_ref: SandboxRef, ms: number) => ({
      state: "running" as const,
      expiresAt: new Date(Date.now() + 300_000 + ms),
    }));
    const runtime = { observe, extendTimeout } as unknown as RunSandboxRuntime;
    const onObservation = vi.fn(async () => undefined);
    const extender = createSandboxTimeoutExtender(runtime, async () => null, {
      maxSessionMs: 3_600_000,
      onObservation,
    });
    extender.activate(ref);
    await vi.advanceTimersByTimeAsync(0);

    expect(observe).toHaveBeenCalledOnce();
    expect(extendTimeout).toHaveBeenCalledWith(ref, 3_300_000, expect.any(AbortSignal));
    expect(onObservation).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAt: new Date("2026-07-23T13:00:00.000Z"),
    }));
    await extender.stop();
  });
});
