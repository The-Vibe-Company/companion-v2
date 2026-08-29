import { describe, expect, it, vi } from "vitest";

import {
  BoxLabProcessIdentityError,
  createBoxLabProcessIdentity,
  hostBoxLabProcessIdentity,
  type BoxLabProcessIdentityOptions,
} from "../src/processIdentity";
import type { ProcessResult, ProcessRunner } from "../src/process";

const PID = 42_424;
const NONCE = "a".repeat(32);
const TITLE = `@companion/box-lab:${NONCE}`;

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: `${TITLE}\n`,
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

function identityOptions(
  runner: ProcessRunner,
  overrides: Partial<BoxLabProcessIdentityOptions> = {},
): BoxLabProcessIdentityOptions {
  return {
    pid: PID,
    nonce: NONCE,
    runner,
    setProcessTitle: () => undefined,
    processExistence: () => "live",
    ...overrides,
  };
}

describe("Box Lab host process identity", () => {
  it("sets a short process title and self-checks it through a bounded direct ps invocation", async () => {
    const run = vi.fn(async () => processResult());
    const setProcessTitle = vi.fn();
    const identity = createBoxLabProcessIdentity(identityOptions(
      { run },
      { setProcessTitle },
    ));

    await identity.prepare();
    await identity.prepare();

    expect(setProcessTitle).toHaveBeenCalledTimes(1);
    expect(setProcessTitle).toHaveBeenCalledWith(TITLE);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: "/bin/ps",
      args: ["-ww", "-o", "command=", "-p", String(PID)],
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
    }));
  });

  it("fails the self-check when ps observes another process identity", async () => {
    const run = vi.fn(async () => processResult({ stdout: "node unrelated.js\n" }));
    const identity = createBoxLabProcessIdentity(identityOptions({ run }));

    await expect(identity.prepare()).rejects.toBeInstanceOf(BoxLabProcessIdentityError);
    await expect(identity.prepare()).rejects.toBeInstanceOf(BoxLabProcessIdentityError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("classifies timeout and malformed Box Lab titles as unknown", async () => {
    const timedOut = createBoxLabProcessIdentity(identityOptions({
      run: async () => processResult({ timedOut: true }),
    }));
    const malformed = createBoxLabProcessIdentity(identityOptions({
      run: async () => processResult({ stdout: "@companion/box-lab:not-a-nonce\n" }),
    }));

    await expect(timedOut.observe(PID)).resolves.toEqual({ state: "unknown" });
    await expect(malformed.observe(PID)).resolves.toEqual({ state: "unknown" });
  });

  it("observes its real title through /bin/ps on supported local hosts", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    await hostBoxLabProcessIdentity.prepare();
    await expect(hostBoxLabProcessIdentity.observe(process.pid)).resolves.toEqual({
      state: "live",
      nonce: hostBoxLabProcessIdentity.nonce,
    });
  });
});
