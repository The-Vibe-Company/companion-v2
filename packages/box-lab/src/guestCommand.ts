import { randomBytes } from "node:crypto";

import type { DriverCommandResult } from "./driver";
import type { ProcessResult } from "./process";

const COMMAND_COMPLETION_SEPARATOR = "\u001e";

interface WrappedGuestCommand {
  completionMarker: string;
  command: string;
  wrapper: string;
}

/**
 * Run Box text in a child shell so the fixed wrapper can prove normal completion separately from
 * GNU timeout's ambiguous exit code 124. The random marker is passed as argv, never interpolated
 * into guest text or a host shell.
 */
export function wrapGuestCommand(command: string): WrappedGuestCommand {
  return {
    completionMarker: `box-lab-command-${randomBytes(16).toString("hex")}`,
    command: `umask 0022\n${command}`,
    wrapper: `bash --noprofile --norc -lc "$1"
status=$?
printf '\\036%s:%s\\036' "$2" "$status" >&2
exit "$status"`,
  };
}

/** Remove the private completion marker and classify exit 124 only when timeout killed the wrapper. */
export function guestCommandResult(
  result: ProcessResult,
  completionMarker: string,
): DriverCommandResult {
  const prefix = `${COMMAND_COMPLETION_SEPARATOR}${completionMarker}:`;
  const primaryMarkerIndex = result.stderr.lastIndexOf(prefix);
  const markerInPrimary = primaryMarkerIndex >= 0
    && result.stderr.endsWith(COMMAND_COMPLETION_SEPARATOR);
  const markerSource = markerInPrimary ? result.stderr : (result.stderrTail ?? "");
  const markerIndex = markerSource.lastIndexOf(prefix);
  let completed = false;
  let stderr = result.stderr;
  if (markerIndex >= 0 && markerSource.endsWith(COMMAND_COMPLETION_SEPARATOR)) {
    const statusText = markerSource.slice(
      markerIndex + prefix.length,
      -COMMAND_COMPLETION_SEPARATOR.length,
    );
    const status = /^\d{1,3}$/.test(statusText) ? Number(statusText) : -1;
    if (status >= 0 && status <= 255 && status === result.exitCode) {
      completed = true;
      if (markerInPrimary) stderr = result.stderr.slice(0, primaryMarkerIndex);
    }
  }
  const timedOut = result.timedOut || (!completed && result.exitCode === 124);
  return {
    success: !timedOut && result.exitCode === 0,
    exitCode: timedOut ? null : result.exitCode,
    stdout: result.stdout,
    stderr,
    timedOut,
  };
}
