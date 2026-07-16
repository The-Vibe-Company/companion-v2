import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunRedactor, RunRuntimeError, type RunSandboxRuntime, type SandboxRef } from "@companion/core";
import { putRunArtifactMetadata, RunBusyError, RunValidationError } from "@companion/core/services";
import {
  abortConversationForRetention,
  cancellationStateAfterStop,
  claimedRunLeaseDeadline,
  assertRetainedConversationAvailable,
  createSandboxTimeoutExtender,
  collectAndCacheRunArtifacts,
  dispatchPromptAfterAttachmentMount,
  isTransientRunFailure,
  runFailureEvent,
  sandboxTimeoutExtensionSchedule,
  shouldHeartbeatRunLease,
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
      sendPrompt: async () => { calls.push("send"); },
    });
    expect(calls).toEqual(["mount", "inspect", "send"]);
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
      sendPrompt: async () => { calls.push("send"); },
    });
    expect(calls).toEqual(["mount", "inspect"]);
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

  it("uses one deterministic object key and renews the same path through reservation and ready", async () => {
    const putMetadata = vi.fn(async (_input: Parameters<typeof putRunArtifactMetadata>[0]) => true);
    const putObject = vi.fn(async (_input: { body: Uint8Array }) => undefined);
    const headObject = vi.fn(async () => null);
    const append = vi.fn(async () => undefined);
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
      dependencies: { putMetadata, headObject, putObject, append, now: () => Date.parse("2026-07-16T12:00:00Z") },
    });
    expect(ready).toBe(1);
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
      expect.objectContaining({ type: "run.warning", code: "artifact_collection_failed" }),
    ]);
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
});
