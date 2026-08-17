import { runRuntimeUntilSignal } from "./process";
import { buildProductionRuntimeService } from "./production";
import { logRuntimeStartupFailure } from "./startupLog";

void runRuntimeUntilSignal({ build: buildProductionRuntimeService }).catch((error: unknown) => {
  logRuntimeStartupFailure(error);
  process.exitCode = 1;
});
