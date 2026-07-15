import { afterEach, describe, expect, it, vi } from "vitest";
import { RunRuntimeError, type RunSandboxRuntime, type SandboxRef } from "@companion/core";
import { RunBusyError, RunValidationError } from "@companion/core/services";
import {
  abortConversationForRetention,
  cancellationStateAfterStop,
  claimedRunLeaseDeadline,
  assertRetainedConversationAvailable,
  createSandboxTimeoutExtender,
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
