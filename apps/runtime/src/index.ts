import "./sentry";
import { captureRuntimeException, Sentry } from "./sentry";
import { runRuntimeUntilSignal } from "./process";
import { buildProductionRuntimeService } from "./production";
import { logRuntimeStartupFailure } from "./startupLog";

void runRuntimeUntilSignal({ build: buildProductionRuntimeService }).catch(async (error: unknown) => {
  captureRuntimeException(error);
  logRuntimeStartupFailure(error);
  await Sentry.flush(2000);
  process.exitCode = 1;
});
