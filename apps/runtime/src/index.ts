import { runRuntimeUntilSignal } from "./process";
import { buildProductionRuntimeService } from "./production";

void runRuntimeUntilSignal({ build: buildProductionRuntimeService }).catch(() => {
  // Startup/runtime failures may contain provider or connection detail. Keep process logs stable.
  console.error("runtime failed to start");
  process.exitCode = 1;
});
