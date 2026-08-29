import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveBoxLabConfig } from "../src/config";
import { resetBoxLab } from "../src/reset";
import {
  acquireBoxLabActivityLease,
  acquireBoxLabResetLease,
  boxLabWorkspaceLockDirectory,
} from "../src/workspaceLock";

async function temporaryConfig(workspaceId: string) {
  const stateRoot = await mkdtemp(join(tmpdir(), "box-lab-reset-test-"));
  return {
    config: resolveBoxLabConfig({
      BOX_LAB_DRIVER: "lima",
      BOX_LAB_STATE_DIR: stateRoot,
      BOX_LAB_WORKSPACE_ID: workspaceId,
    }),
    stateRoot,
  };
}

describe("Box Lab reset", () => {
  it("removes retained diagnostics when state and the selected driver are absent", async () => {
    const { config, stateRoot } = await temporaryConfig("reset-without-driver");
    try {
      await mkdir(config.diagnosticsDirectory, { recursive: true });
      await writeFile(`${config.diagnosticsDirectory}/retained.log`, "diagnostic\n");

      const missingDriver = Object.assign(new Error("spawn limactl ENOENT"), { code: "ENOENT" });
      await expect(resetBoxLab(config, { reset: async () => { throw missingDriver; } }))
        .resolves.toBe("already_clean");
      await expect(stat(config.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  });

  it("surfaces state access errors before provider or filesystem cleanup and releases its lease", async () => {
    const { config, stateRoot } = await temporaryConfig("state-access-error");
    const lockDirectory = boxLabWorkspaceLockDirectory(config.stateDirectory);
    let activity: Awaited<ReturnType<typeof acquireBoxLabActivityLease>> | undefined;
    let resetCalls = 0;
    try {
      await mkdir(config.diagnosticsDirectory, { recursive: true });
      const sentinel = `${config.diagnosticsDirectory}/must-survive.log`;
      await writeFile(sentinel, "must-survive\n");
      const accessDenied = Object.assign(new Error("state access denied"), { code: "EACCES" });

      await expect(resetBoxLab(
        config,
        { reset: async () => { resetCalls += 1; } },
        { accessState: async () => { throw accessDenied; } },
      )).rejects.toBe(accessDenied);
      expect(resetCalls).toBe(0);
      await expect(readFile(sentinel, "utf8")).resolves.toBe("must-survive\n");

      activity = await acquireBoxLabActivityLease(config.stateDirectory);
    } finally {
      await activity?.release();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(lockDirectory, { recursive: true, force: true });
    }
  });

  it("refuses reset without touching active workspace state or provider resources", async () => {
    const { config, stateRoot } = await temporaryConfig("active-reset");
    const activity = await acquireBoxLabActivityLease(config.stateDirectory);
    let resetCalls = 0;
    try {
      await mkdir(config.diagnosticsDirectory, { recursive: true });
      const sentinel = `${config.diagnosticsDirectory}/active.log`;
      await writeFile(sentinel, "must-survive\n");

      await expect(resetBoxLab(config, { reset: async () => { resetCalls += 1; } }))
        .rejects.toMatchObject({ code: "box_lab_workspace_active" });
      expect(resetCalls).toBe(0);
      await expect(readFile(sentinel, "utf8")).resolves.toBe("must-survive\n");
    } finally {
      await activity.release();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(boxLabWorkspaceLockDirectory(config.stateDirectory), { recursive: true, force: true });
    }
  });

  it("blocks new activity while reset owns the workspace", async () => {
    const { config, stateRoot } = await temporaryConfig("reset-blocks-activity");
    const resetLease = await acquireBoxLabResetLease(config.stateDirectory);
    try {
      await expect(acquireBoxLabActivityLease(config.stateDirectory))
        .rejects.toMatchObject({ code: "box_lab_workspace_resetting" });
    } finally {
      await resetLease.release();
      await rm(stateRoot, { recursive: true, force: true });
      await rm(boxLabWorkspaceLockDirectory(config.stateDirectory), { recursive: true, force: true });
    }
  });

  it("reclaims dead-owner leases before resetting", async () => {
    const { config, stateRoot } = await temporaryConfig("stale-reset");
    const lockDirectory = boxLabWorkspaceLockDirectory(config.stateDirectory);
    try {
      await mkdir(config.diagnosticsDirectory, { recursive: true });
      await writeFile(`${config.diagnosticsDirectory}/stale.log`, "stale\n");
      await mkdir(lockDirectory, { recursive: true });
      await writeFile(
        `${lockDirectory}/activity-99999999-deadbeefdeadbeefdeadbeefdeadbeef.lease`,
        "99999999\n",
      );
      await writeFile(
        `${lockDirectory}/reset-99999999-feedfacefeedfacefeedfacefeedface.lease`,
        "99999999\n",
      );
      let resetCalls = 0;

      await expect(resetBoxLab(config, { reset: async () => { resetCalls += 1; } }))
        .resolves.toBe("already_clean");
      expect(resetCalls).toBe(1);
      await expect(stat(config.stateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readdir(lockDirectory)).resolves.toEqual([]);
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
      await rm(lockDirectory, { recursive: true, force: true });
    }
  });
});
