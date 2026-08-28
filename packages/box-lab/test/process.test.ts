import { describe, expect, it } from "vitest";

import { safeProcessFailure, type ProcessResult } from "../src/process";

function failure(stderr: string, exitCode = 1): ProcessResult {
  return {
    exitCode,
    signal: null,
    stdout: "",
    stderr,
    timedOut: false,
  };
}

describe("Box Lab process diagnostics", () => {
  it("classifies a missing pinned image without retaining raw registry output", () => {
    const error = safeProcessFailure(
      "Box Lab OCI image build",
      failure("registry.example.test/image@sha256:secret: not found"),
    );

    expect(error).toMatchObject({
      code: "process_resource_not_found",
      message: "Box Lab OCI image build could not find a required resource (exit 1)",
    });
    expect(error.message).not.toContain("registry.example.test");
    expect(error.message).not.toContain("sha256:secret");
  });

  it("reports timeouts without including command output", () => {
    const error = safeProcessFailure("Box Lab Lima start", {
      ...failure("token=must-not-leak", 137),
      timedOut: true,
    });

    expect(error).toMatchObject({ code: "process_timeout", message: "Box Lab Lima start timed out" });
    expect(error.message).not.toContain("must-not-leak");
  });
});
