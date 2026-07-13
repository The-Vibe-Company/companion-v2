import { afterEach, describe, expect, it, vi } from "vitest";
import { RunRuntimeError, type RunSandboxRuntime, type SandboxRef } from "@companion/core";
import { RunBusyError, RunValidationError } from "@companion/core/services";
import {
  claimedRunLeaseDeadline,
  createSandboxTimeoutExtender,
  isTransientRunFailure,
  runFailureEvent,
  sandboxTimeoutExtensionSchedule,
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
});
