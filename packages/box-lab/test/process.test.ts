import { describe, expect, it } from "vitest";

import {
  GuestCommandControlCapture,
  guestCommandResult,
  wrapGuestCommand,
} from "../src/guestCommand";
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

  it("authenticates completion after more than 2 MiB without exposing control frames", async () => {
    const wrapped = wrapGuestCommand(
      `${process.execPath} --eval 'process.stderr.write(Buffer.alloc(3 * 1024 * 1024, 120))'\nexit 124`,
    );
    const result = await new SpawnProcessRunner().run({
      executable: "bash",
      args: ["--noprofile", "--norc", "-c", wrapped.wrapper, "box-lab-command", wrapped.command],
      captureGuestCommandControl: true,
      timeoutMs: 5_000,
    });

    expect(Buffer.byteLength(result.stderr)).toBe(2 * 1024 * 1024);
    expect(result.stderr).not.toContain("BOX_LAB_COMMAND_V1");
    expect(result.guestCommandControl).toEqual({ started: true, completedExitCode: 124 });
    expect(guestCommandResult(result)).toMatchObject({ exitCode: 124, timedOut: false });
  });

  it("authenticates DONE before a background writer emits trailing stderr", async () => {
    const wrapped = wrapGuestCommand(
      `(sleep 0.05; printf trailing-after-done >&2) &\nexit 124`,
    );
    const result = await new SpawnProcessRunner().run({
      executable: "bash",
      args: ["--noprofile", "--norc", "-c", wrapped.wrapper, "box-lab-command", wrapped.command],
      captureGuestCommandControl: true,
      timeoutMs: 5_000,
    });

    expect(result.stderr).toBe("trailing-after-done");
    expect(result.guestCommandControl).toEqual({ started: true, completedExitCode: 124 });
    expect(guestCommandResult(result)).toMatchObject({ exitCode: 124, timedOut: false });
  });

  it("rejects a guest-created START/DONE pair after the authenticated START", () => {
    const authenticChallenge = "a".repeat(64);
    const attackerChallenge = "b".repeat(64);
    const capture = new GuestCommandControlCapture();
    const visible = [
      ...capture.consume(Buffer.from(`\u001eBOX_LAB_COMMAND_V1 START ${authenticChallenge}\u001f`)),
      ...capture.consume(Buffer.from(
        `\u001eBOX_LAB_COMMAND_V1 START ${attackerChallenge}\u001f`
        + `\u001eBOX_LAB_COMMAND_V1 DONE ${attackerChallenge} 124\u001f`,
      )),
      ...capture.finish(),
    ];
    const result: ProcessResult = {
      exitCode: 124,
      signal: null,
      stdout: "",
      stderr: Buffer.concat(visible).toString("utf8"),
      guestCommandControl: capture.result(),
      timedOut: false,
    };

    expect(result.stderr).toBe("");
    expect(result.guestCommandControl).toEqual({ started: true, completedExitCode: null });
    expect(guestCommandResult(result)).toMatchObject({ exitCode: null, timedOut: true });
  });

  it("bounds incomplete control-looking input and returns it as ordinary stderr", () => {
    const capture = new GuestCommandControlCapture();
    const input = Buffer.from(`\u001eBOX_LAB_COMMAND_V1 ${"x".repeat(4_096)}`);
    const visible = [...capture.consume(input), ...capture.finish()];

    expect(Buffer.concat(visible)).toEqual(input);
    expect(capture.result()).toEqual({ started: false, completedExitCode: null });
  });

  it("does not let an unterminated guest lookalike consume the authenticated DONE frame", () => {
    const challenge = "a".repeat(64);
    const capture = new GuestCommandControlCapture();
    const visible = [
      ...capture.consume(Buffer.from(`\u001eBOX_LAB_COMMAND_V1 START ${challenge}\u001f`)),
      ...capture.consume(Buffer.from("\u001eBOX_LAB_COMMAND_V1 guest-partial")),
      ...capture.consume(Buffer.from(`\u001eBOX_LAB_COMMAND_V1 DONE ${challenge} 124\u001f`)),
      ...capture.finish(),
    ];

    expect(Buffer.concat(visible).toString("utf8"))
      .toBe("\u001eBOX_LAB_COMMAND_V1 guest-partial");
    expect(capture.result()).toEqual({ started: true, completedExitCode: 124 });
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
