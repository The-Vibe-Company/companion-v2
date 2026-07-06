import { mkdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentCredentialsPath, loadAgentCredentials, saveAgentCredentials } from "./credentials";

let home: string;

beforeEach(async () => {
  home = join(tmpdir(), `companion-agent-credentials-${process.pid}-${Date.now()}`);
  await mkdir(home, { recursive: true });
  process.env.COMPANION_HOME = home;
});

afterEach(async () => {
  delete process.env.COMPANION_HOME;
  await rm(home, { recursive: true, force: true });
});

describe("agent credentials", () => {
  it("writes the device token file with private permissions", async () => {
    await saveAgentCredentials({
      schemaVersion: 1,
      deviceId: "device-1",
      orgId: "org-1",
      apiUrl: "http://127.0.0.1:3001",
      token: "cmp_dev_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      installChannel: "notify",
      nodePath: process.execPath,
      entryPath: "/tmp/companion",
      installedAt: "2026-07-06T10:00:00.000Z",
    });

    await expect(loadAgentCredentials()).resolves.toMatchObject({ deviceId: "device-1", token: expect.stringMatching(/^cmp_dev_/) });
    if (process.platform !== "win32") {
      const mode = (await stat(agentCredentialsPath())).mode & 0o777;
      expect(mode).toBe(0o600);
    }
  });
});
