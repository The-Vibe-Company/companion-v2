import { describe, expect, it } from "vitest";
import { RuntimeInvariantError } from "./errors";
import {
  createJsonRuntimeProcessLog,
  describeThrownError,
  workFailureLogRecord,
} from "./logging";
import { attemptClaim, attemptAuthorization } from "./test/fixtures";

describe("runtime process error logs", () => {
  it("keeps the thrown name and message after credential redaction", () => {
    const thrown = describeThrownError(new Error(
      "Pi is not installed; token=box_secret_value https://ascii.dev/api/box",
    ));
    expect(thrown.name).toBe("Error");
    expect(thrown.message).toContain("Pi is not installed");
    expect(thrown.message).toContain("[redacted]");
    expect(thrown.message).not.toContain("box_secret_value");
    expect(thrown.message).not.toContain("ascii.dev");
  });

  it("walks Error.cause so an indeterminate store wrap still names the decode failure", () => {
    const cause = new RuntimeInvariantError({
      code: "settings_snapshot_invalid",
      message: "settings claim has an impossible nullable shape",
    });
    const thrown = describeThrownError(new Error("Runtime database mutation outcome is indeterminate", {
      cause,
    }));
    const nested = Array.isArray(thrown.causes) ? thrown.causes[0] : undefined;
    expect(nested).toMatchObject({
      name: "RuntimeInvariantError",
      stableCode: "settings_snapshot_invalid",
      message: "settings claim has an impossible nullable shape",
    });
  });

  it("marks a generic persisted fallback so operators can tell a swallowed provider error", () => {
    const claim = attemptClaim();
    const record = workFailureLogRecord({
      ts: new Date("2026-08-16T12:00:00.000Z"),
      event: "runtime.work.failed",
      claim,
      authorization: attemptAuthorization(claim),
      outcome: "failed",
      thrown: new Error("Pi is not installed; configure COMPANION_PI_INSTALL_COMMAND"),
      persisted: {
        code: "runtime_execution_failed",
        message: "Runtime execution failed.",
        action: "retry",
      },
    });
    expect(record.genericFallback).toBe(true);
    expect(record.companionId).toBe(claim.companionId);
    expect(record.claimedCheckpoint).toBe(claim.checkpoint);
    expect(record.thrown).toMatchObject({
      message: "Pi is not installed; configure COMPANION_PI_INSTALL_COMMAND",
    });
  });

  it("emits one JSON stderr line and redacts secrets in nested fields", () => {
    const lines: string[] = [];
    const log = createJsonRuntimeProcessLog((line) => lines.push(line));
    log.error({
      ts: "2026-08-16T12:00:00.000Z",
      event: "runtime.work.failed",
      detail: "Authorization: Bearer super-secret-token",
    });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(parsed).toMatchObject({
      level: "error",
      event: "runtime.work.failed",
    });
    expect(String(parsed.detail)).toContain("[redacted]");
    expect(lines[0]).not.toContain("super-secret-token");
  });
});
