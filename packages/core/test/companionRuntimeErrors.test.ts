import { describe, expect, it } from "vitest";
import {
  COMPANION_RUNTIME_ERROR_FALLBACK,
  COMPANION_RUNTIME_ERROR_VIEWER_MESSAGE,
  companionRuntimeErrorForAccess,
  sanitizeCompanionRuntimeError,
} from "../src/companionRuntimeErrors";

describe("sanitizeCompanionRuntimeError", () => {
  it("keeps a configuration failure readable, including the environment variable to set", () => {
    expect(sanitizeCompanionRuntimeError("Box runtime is not configured; set COMPANION_BOX_API_KEY"))
      .toBe("Box runtime is not configured; set COMPANION_BOX_API_KEY");
  });

  it("reduces a multi-line failure to its first line", () => {
    expect(sanitizeCompanionRuntimeError(
      "Box Pi setup failed: exit 1\n    at start (/app/apps/api/src/boxCompanionRuntime.ts:220:11)",
    )).toBe("Box Pi setup failed: exit 1");
  });

  it("redacts credential-shaped text a Box or provider message echoed back", () => {
    const sanitized = sanitizeCompanionRuntimeError(
      'Box rejected the request: authorization: Bearer abcdef0123456789abcdef, key sk-live-abcdef012345',
    );

    expect(sanitized).not.toContain("abcdef0123456789abcdef");
    expect(sanitized).not.toContain("sk-live-abcdef012345");
    expect(sanitized).toContain("[redacted]");
  });

  it("drops the query string of a signed URL", () => {
    expect(sanitizeCompanionRuntimeError(
      "Box file upload failed for https://box.ascii.dev/v1/files?signature=abc123&expires=1",
    )).toBe("Box file upload failed for https://box.ascii.dev/v1/files[redacted]");
  });

  it("truncates a message that is longer than one line of status", () => {
    const sanitized = sanitizeCompanionRuntimeError("Box says ".repeat(200));

    expect(sanitized.length).toBeLessThanOrEqual(240);
    expect(sanitized.endsWith("…")).toBe(true);
  });
});

describe("companionRuntimeErrorForAccess", () => {
  it("gives an Owner and an Editor the recorded reason", () => {
    const lastError = "Box runtime is not configured; set COMPANION_BOX_API_KEY";

    for (const access of ["owner", "editor"] as const) {
      expect(companionRuntimeErrorForAccess({ state: "error", lastError, access })).toBe(lastError);
    }
  });

  it("gives a Viewer a generic line instead of an operator configuration hint", () => {
    const result = companionRuntimeErrorForAccess({
      state: "error",
      lastError: "Box runtime is not configured; set COMPANION_BOX_API_KEY",
      access: "viewer",
    });

    expect(result).toBe(COMPANION_RUNTIME_ERROR_VIEWER_MESSAGE);
    expect(result).not.toContain("COMPANION_BOX_API_KEY");
  });

  it("explains an error state recorded without a reason", () => {
    expect(companionRuntimeErrorForAccess({ state: "error", lastError: null, access: "owner" }))
      .toBe(COMPANION_RUNTIME_ERROR_FALLBACK);
  });

  it("returns nothing outside an error state, even when a stale reason survived", () => {
    for (const state of ["not_created", "provisioning", "running", "stopping", "stopped"] as const) {
      expect(companionRuntimeErrorForAccess({
        state,
        lastError: "Box entered error state",
        access: "owner",
      })).toBeNull();
    }
  });

  it("sanitizes a reason stored before this rule existed", () => {
    expect(companionRuntimeErrorForAccess({
      state: "error",
      lastError: "Box rejected the request: authorization: Bearer abcdef0123456789abcdef",
      access: "owner",
    })).toBe("Box rejected the request: authorization: [redacted]");
  });
});
