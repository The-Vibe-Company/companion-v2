import { access, rm } from "node:fs/promises";

import type { BoxLabConfig } from "./config";
import type { BoxLabDriver } from "./driver";
import { createBoxLabDriver } from "./factory";
import { BoxLabStateStore } from "./state";

export type BoxLabResetResult = "removed" | "already_clean";

export async function resetBoxLab(
  config: BoxLabConfig,
  driver: Pick<BoxLabDriver, "reset"> = createBoxLabDriver(config),
): Promise<BoxLabResetResult> {
  const statePath = new BoxLabStateStore(config.stateDirectory, config.workspaceScope).path;
  let knownState = true;
  try { await access(statePath); } catch { knownState = false; }

  try {
    await driver.reset();
  } catch (error) {
    const missingExecutable = error instanceof Error && "code" in error && error.code === "ENOENT";
    if (!missingExecutable || knownState) throw error;
  }

  await rm(config.stateDirectory, { recursive: true, force: true });
  return knownState ? "removed" : "already_clean";
}
