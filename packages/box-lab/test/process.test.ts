import { describe, expect, it } from "vitest";

import { safeProcessFailure, SpawnProcessRunner, type ProcessResult } from "../src/process";

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

  it("returns the child result when it closes stdin before a buffered payload is written", async () => {
    const result = await new SpawnProcessRunner().run({
      executable: process.execPath,
      args: ["--eval", "process.stdin.destroy(); setTimeout(() => process.exit(0), 25)"],
      input: Buffer.alloc(8 * 1024 * 1024, 0x61),
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
  });

  it("retains a bounded stderr tail without expanding exposed command output", async () => {
    const limit = 1_024;
    const result = await new SpawnProcessRunner().run({
      executable: process.execPath,
      args: [
        "--eval",
        "require('node:fs').writeFileSync(2, Buffer.alloc(4096, 120)); process.stderr.write('tail-marker')",
      ],
      outputLimitBytes: limit,
      timeoutMs: 5_000,
    });

    expect(Buffer.byteLength(result.stderr)).toBe(limit);
    expect(result.stderr).not.toContain("tail-marker");
    expect(result.stderrTail).toMatch(/tail-marker$/);
    expect(Buffer.byteLength(result.stderrTail ?? "")).toBeLessThanOrEqual(1_024);
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
