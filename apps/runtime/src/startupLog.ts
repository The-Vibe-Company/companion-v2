import { createJsonRuntimeProcessLog, describeThrownError } from "@companion/companion-runtime";

/** Startup failures used to print only "runtime failed to start" and drop the cause. */
export function logRuntimeStartupFailure(
  error: unknown,
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): void {
  createJsonRuntimeProcessLog(write).error({
    ts: new Date().toISOString(),
    event: "runtime.startup.failed",
    thrown: describeThrownError(error),
  });
}
