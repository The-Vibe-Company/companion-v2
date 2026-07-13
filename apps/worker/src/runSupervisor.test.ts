import { describe, expect, it } from "vitest";
import { RunRuntimeError } from "@companion/core";
import { RunBusyError, RunValidationError } from "@companion/core/services";
import { isTransientRunFailure, runFailureEvent } from "./runSupervisor";

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
