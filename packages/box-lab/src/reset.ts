import { access, rm } from "node:fs/promises";

import type { BoxLabConfig } from "./config";
import type { BoxLabDriver } from "./driver";
import { createBoxLabDriver } from "./factory";
import { BoxLabStateStore } from "./state";
import { acquireBoxLabResetLease } from "./workspaceLock";

export type BoxLabResetResult = "removed" | "already_clean";

interface BoxLabResetOptions {
  accessState?: (path: string) => Promise<void>;
}

export async function resetBoxLab(
  config: BoxLabConfig,
  driver: Pick<BoxLabDriver, "reset"> = createBoxLabDriver(config),
  options: BoxLabResetOptions = {},
): Promise<BoxLabResetResult> {
  const lease = await acquireBoxLabResetLease(config.stateDirectory);
  try {
    const statePath = new BoxLabStateStore(config.stateDirectory, config.workspaceScope).path;
    let knownState = true;
    try {
      await (options.accessState ?? access)(statePath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      knownState = false;
    }

    try {
      await driver.reset();
    } catch (error) {
      const missingExecutable = error instanceof Error && "code" in error && error.code === "ENOENT";
      if (!missingExecutable || knownState) throw error;
    }

    await rm(config.stateDirectory, { recursive: true, force: true });
    return knownState ? "removed" : "already_clean";
  } finally {
    await lease.release();
  }
}
