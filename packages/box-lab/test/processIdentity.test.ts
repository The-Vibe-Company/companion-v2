import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  BoxLabProcessIdentityError,
  createBoxLabProcessIdentity,
  hostBoxLabProcessIdentity,
  type BoxLabProcessBeacon,
  type BoxLabProcessIdentityOptions,
} from "../src/processIdentity";
import { SpawnProcessRunner, type ProcessResult, type ProcessRunner } from "../src/process";

const OWNER_PID = 41_414;
const BEACON_PID = 42_424;
const NONCE = "a".repeat(32);
const TITLE = `@companion/box-lab:${NONCE}`;
const COMMAND = `${TITLE} -e process.stdin.resume()`;
const preparedIdentitySchema = z.object({
  beaconPid: z.number().int().positive(),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  ownerPid: z.number().int().positive(),
});

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: `${COMMAND}\n`,
    stderr: "",
    timedOut: false,
    ...overrides,
  };
}

function fakeBeacon(): BoxLabProcessBeacon & { close: ReturnType<typeof vi.fn> } {
  let live = true;
  return {
    pid: BEACON_PID,
    close: vi.fn(() => { live = false; }),
    healthy: () => live,
  };
}

function identityOptions(
  runner: ProcessRunner,
  overrides: Partial<BoxLabProcessIdentityOptions> = {},
): BoxLabProcessIdentityOptions {
  return {
    ownerPid: OWNER_PID,
    nonce: NONCE,
    runner,
    startBeacon: async () => fakeBeacon(),
    processExistence: () => "live",
    ...overrides,
  };
}

async function commandForPid(pid: number): Promise<string | undefined> {
  const result = await new SpawnProcessRunner().run({
    executable: "/bin/ps",
    args: ["-ww", "-o", "command=", "-p", String(pid)],
    timeoutMs: 1_000,
    outputLimitBytes: 1_024,
  });
  return result.exitCode === 0 && !result.timedOut ? result.stdout.trimEnd() : undefined;
}

describe("Box Lab host process identity", () => {
  it("starts one beacon and self-checks its exact command through a bounded direct ps invocation", async () => {
    const run = vi.fn(async () => processResult());
    const beacon = fakeBeacon();
    const startBeacon = vi.fn(async () => beacon);
    const identity = createBoxLabProcessIdentity(identityOptions(
      { run },
      { startBeacon },
    ));

    await expect(identity.prepare()).resolves.toEqual({
      ownerPid: OWNER_PID,
      beaconPid: BEACON_PID,
      nonce: NONCE,
    });
    await identity.prepare();

    expect(startBeacon).toHaveBeenCalledTimes(1);
    expect(startBeacon).toHaveBeenCalledWith(TITLE);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      executable: "/bin/ps",
      args: ["-ww", "-o", "command=", "-p", String(BEACON_PID)],
      timeoutMs: 2_000,
      outputLimitBytes: 1_024,
    }));
  });

  it("closes the beacon when its exact self-check fails", async () => {
    const run = vi.fn(async () => processResult({ stdout: "node unrelated.js\n" }));
    const beacon = fakeBeacon();
    const identity = createBoxLabProcessIdentity(identityOptions(
      { run },
      { startBeacon: async () => beacon },
    ));

    await expect(identity.prepare()).rejects.toBeInstanceOf(BoxLabProcessIdentityError);
    await expect(identity.prepare()).rejects.toBeInstanceOf(BoxLabProcessIdentityError);
    expect(run).toHaveBeenCalledTimes(1);
    expect(beacon.close).toHaveBeenCalledTimes(1);
  });

  it("classifies timeout and malformed beacon commands as unknown", async () => {
    const timedOut = createBoxLabProcessIdentity(identityOptions({
      run: async () => processResult({ timedOut: true }),
    }));
    const malformed = createBoxLabProcessIdentity(identityOptions({
      run: async () => processResult({ stdout: `${TITLE} -e other-code\n` }),
    }));

    await expect(timedOut.observe(BEACON_PID)).resolves.toEqual({ state: "unknown" });
    await expect(malformed.observe(BEACON_PID)).resolves.toEqual({ state: "unknown" });
  });

  it("observes its real detached beacon through /bin/ps on supported local hosts", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    const prepared = await hostBoxLabProcessIdentity.prepare();
    await expect(hostBoxLabProcessIdentity.observe(prepared.beaconPid)).resolves.toEqual({
      state: "live",
      nonce: hostBoxLabProcessIdentity.nonce,
    });
  });

  it("lets a subprocess exit normally and leaves no beacon behind", async () => {
    if (process.platform !== "darwin" && process.platform !== "linux") return;

    const moduleUrl = new URL("../src/processIdentity.ts", import.meta.url).href;
    const source = [
      `import { hostBoxLabProcessIdentity } from ${JSON.stringify(moduleUrl)};`,
      "const prepared = await hostBoxLabProcessIdentity.prepare();",
      "process.stdout.write(`${JSON.stringify(prepared)}\\n`);",
    ].join("\n");
    const result = await new SpawnProcessRunner().run({
      executable: process.execPath,
      args: ["--import", "tsx", "--input-type=module", "--eval", source],
      timeoutMs: 5_000,
      outputLimitBytes: 4_096,
    });

    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    const prepared = preparedIdentitySchema.parse(JSON.parse(result.stdout.trim()));
    const expectedCommand =
      `@companion/box-lab:${prepared.nonce} -e process.stdin.resume()`;
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && await commandForPid(prepared.beaconPid) === expectedCommand) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
    }
    await expect(commandForPid(prepared.beaconPid)).resolves.not.toBe(expectedCommand);
  });
});
