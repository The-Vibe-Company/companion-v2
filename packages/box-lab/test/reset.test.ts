import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveBoxLabConfig } from "../src/config";
import { resetBoxLab } from "../src/reset";

describe("Box Lab reset", () => {
  it("removes retained diagnostics when state and the selected driver are absent", async () => {
    const stateRoot = await mkdtemp(join(tmpdir(), "box-lab-reset-test-"));
    try {
      const config = resolveBoxLabConfig({
        BOX_LAB_DRIVER: "lima",
        BOX_LAB_STATE_DIR: stateRoot,
        BOX_LAB_WORKSPACE_ID: "reset-without-driver",
      });
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
});
