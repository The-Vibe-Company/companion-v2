import type { BoxLabConfig } from "./config";
import type { BoxLabDriver } from "./driver";
import { LimaDriver } from "./limaDriver";
import { OciSystemdDriver } from "./ociSystemdDriver";
import { SpawnProcessRunner, type ProcessRunner } from "./process";

export function createBoxLabDriver(
  config: BoxLabConfig,
  runner: ProcessRunner = new SpawnProcessRunner(),
): BoxLabDriver {
  if (config.driver === "lima") {
    return new LimaDriver({
      runner,
      resourcePrefix: config.resourcePrefix,
      stateDirectory: config.stateDirectory,
    });
  }
  return new OciSystemdDriver({
    runner,
    engine: config.ociEngine,
    image: config.ociImage,
    resourcePrefix: config.resourcePrefix,
    workspaceScope: config.workspaceScope,
  });
}
