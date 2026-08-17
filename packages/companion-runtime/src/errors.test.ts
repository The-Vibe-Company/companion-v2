import { describe, expect, it } from "vitest";
import { expurgateRuntimeMessage, safeErrorFromUnknown, safeRuntimeError } from "./errors";

describe("runtime error safety", () => {
  it("removes URLs, credentials, bearer values, and newlines and caps at 500 characters", () => {
    const message = expurgateRuntimeMessage(
      `failed at https://example.test/signed?token=secret\nAuthorization: Bearer abc.def.ghi ${"x".repeat(700)}`,
    );
    expect(message).not.toContain("example.test");
    expect(message).not.toContain("abc.def.ghi");
    expect(message).not.toContain("\n");
    expect(message.length).toBeLessThanOrEqual(500);
  });

  it("replaces unstable error codes", () => {
    expect(safeRuntimeError({ code: "BAD CODE", message: "failed", action: "retry" }).code)
      .toBe("runtime_failure");
  });

  it("never persists an arbitrary provider message without an explicit stable code", () => {
    const opaqueProviderValue = "opaque-material-Qm9VZ2h0VG9rZW5UaGF0UmVkYWN0aW9uV291bGRNaXNz";
    const result = safeErrorFromUnknown({
      code: "provider_command_failed",
      message: `provider said ${opaqueProviderValue}`,
    }, {
      code: "runtime_execution_failed",
      message: "Runtime execution failed.",
      action: "retry",
    });

    expect(result).toEqual({
      code: "runtime_execution_failed",
      message: "Runtime execution failed.",
      action: "retry",
    });
    expect(result.message).not.toContain(opaqueProviderValue);
  });
});
