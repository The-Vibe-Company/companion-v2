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

  it.each([
    '{"access_token":"plain-opaque-access-value"}',
    "refreshToken='plain-opaque-refresh-value'",
    '"client_secret": "plain-opaque-client-value"',
    "api-key=plain-opaque-api-value",
  ])("redacts credential assignments independent of token shape: %s", (source) => {
    const message = expurgateRuntimeMessage(source);
    expect(message).not.toContain("plain-opaque");
    expect(message).toContain("[redacted]");
  });

  it.each([
    "Authorization: Basic dXNlcjpwYXNzL3dpdGg9cHVuY3Q=",
    "Authorization: Digest username=member,response=opaque-secret,nonce=second-secret",
    "Cookie: session=opaque-session; refresh=opaque-refresh, preference=private",
  ])("redacts the complete sensitive header value before generic matching: %s", (source) => {
    const message = expurgateRuntimeMessage(`provider rejected ${source}`);
    expect(message).toMatch(/(?:Authorization|Cookie) \[redacted\]$/);
    expect(message).not.toContain("opaque");
    expect(message).not.toContain("dXNlcj");
    expect(message).not.toContain("private");
  });

  it("redacts Companion's own delegated token, which every Box is staged with", () => {
    // COMPANION_DELEGATION_TOKEN is the credential most likely to be echoed back by something
    // running inside the Box, and its prefix matches none of the vendor shapes.
    const message = expurgateRuntimeMessage(
      `hub call failed for cmp_pat_${"a1b2c3d4".repeat(6)} while listing skills`,
    );
    expect(message).not.toContain("a1b2c3d4");
    expect(message).toContain("[credential removed]");
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
