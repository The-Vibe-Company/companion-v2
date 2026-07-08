import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireAgentLock, agentPidPath, currentAgentPid } from "./lock";

let home: string;

beforeEach(async () => {
  home = join(tmpdir(), `companion-agent-lock-${process.pid}-${Date.now()}`);
  await mkdir(home, { recursive: true });
  process.env.COMPANION_HOME = home;
});

afterEach(async () => {
  delete process.env.COMPANION_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("agent pid lock", () => {
  it("rejects a second live daemon and releases its own pid", async () => {
    const release = await acquireAgentLock();
    await expect(currentAgentPid()).resolves.toBe(process.pid);
    await expect(acquireAgentLock()).rejects.toThrow("already running");
    await release();
    await expect(currentAgentPid()).resolves.toBeNull();
  });

  it("recovers a stale pidfile", async () => {
    await writeFile(agentPidPath(), "99999999\n");
    const release = await acquireAgentLock();
    await expect(currentAgentPid()).resolves.toBe(process.pid);
    await release();
  });

  it("allows only one concurrent acquisition", async () => {
    const results = await Promise.allSettled([acquireAgentLock(), acquireAgentLock()]);
    const fulfilled = results.filter((result): result is PromiseFulfilledResult<() => Promise<void>> => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    await fulfilled[0]!.value();
  });
});
