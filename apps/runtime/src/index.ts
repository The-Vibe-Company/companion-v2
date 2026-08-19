import { initSentry, Sentry } from "./sentry";

initSentry();

import { runRuntimeUntilSignal } from "./process";
import { buildProductionRuntimeService } from "./production";
import { logRuntimeStartupFailure } from "./startupLog";

void runRuntimeUntilSignal({ build: buildProductionRuntimeService }).catch((error: unknown) => {
  Sentry.captureException(error);
  logRuntimeStartupFailure(error);
  process.exitCode = 1;
});
