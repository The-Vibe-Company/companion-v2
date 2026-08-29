import type {
  GuestCommandControlResult,
  ProcessResult,
} from "./process";
import type { DriverCommandResult } from "./driver";

const CONTROL_PREFIX = Buffer.from("\u001eBOX_LAB_COMMAND_V1 ", "ascii");
const CONTROL_SUFFIX = 0x1f;
const MAX_CONTROL_FRAME_BYTES = 128;
const CHALLENGE_PATTERN = "[a-f0-9]{64}";
const START_PATTERN = new RegExp(`^START (${CHALLENGE_PATTERN})$`);
const DONE_PATTERN = new RegExp(`^DONE (${CHALLENGE_PATTERN}) ([0-9]{1,3})$`);

interface WrappedGuestCommand {
  command: string;
  wrapper: string;
}

/**
 * Create a wrapper that authenticates normal completion without putting its challenge in argv or
 * the environment. START is written before the child exists; fd 3 is then closed in the child.
 */
export function wrapGuestCommand(command: string): WrappedGuestCommand {
  return {
    command: `umask 0022\n${command}`,
    wrapper: `exec 3>&2
challenge="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \\n')"
if [[ ! "$challenge" =~ ^[a-f0-9]{64}$ ]]; then exit 125; fi
printf '\\036BOX_LAB_COMMAND_V1 START %s\\037' "$challenge" >&3 || exit 125
bash --noprofile --norc -lc "$1" 3>&-
status=$?
printf '\\036BOX_LAB_COMMAND_V1 DONE %s %s\\037' "$challenge" "$status" >&3 || exit 125
exit "$status"`,
  };
}

/**
 * Incrementally separates bounded control frames from ordinary stderr. It retains at most one
 * incomplete frame and never returns the authenticated challenge in its public result.
 */
export class GuestCommandControlCapture {
  #challenge: string | undefined;
  #completedExitCode: number | null = null;
  #pending = Buffer.alloc(0);

  consume(chunk: Buffer): Buffer[] {
    let input = this.#pending.byteLength === 0
      ? chunk
      : Buffer.concat([this.#pending, chunk]);
    this.#pending = Buffer.alloc(0);
    const visible: Buffer[] = [];

    while (input.byteLength > 0) {
      const frameStart = input.indexOf(CONTROL_PREFIX);
      if (frameStart < 0) {
        const retainedBytes = Math.min(input.byteLength, CONTROL_PREFIX.byteLength - 1);
        const visibleBytes = input.byteLength - retainedBytes;
        if (visibleBytes > 0) visible.push(input.subarray(0, visibleBytes));
        this.#pending = Buffer.from(input.subarray(visibleBytes));
        break;
      }
      if (frameStart > 0) visible.push(input.subarray(0, frameStart));
      input = input.subarray(frameStart);

      const frameEnd = input.indexOf(CONTROL_SUFFIX, CONTROL_PREFIX.byteLength);
      const nestedFrameStart = input.indexOf(CONTROL_PREFIX, CONTROL_PREFIX.byteLength);
      if (nestedFrameStart >= 0 && (frameEnd < 0 || nestedFrameStart < frameEnd)) {
        visible.push(input.subarray(0, nestedFrameStart));
        input = input.subarray(nestedFrameStart);
        continue;
      }
      if (frameEnd < 0) {
        if (input.byteLength <= MAX_CONTROL_FRAME_BYTES) {
          this.#pending = Buffer.from(input);
          break;
        }
        visible.push(input.subarray(0, CONTROL_PREFIX.byteLength));
        input = input.subarray(CONTROL_PREFIX.byteLength);
        continue;
      }

      const frameBytes = frameEnd + 1;
      const frame = input.subarray(0, frameBytes);
      if (frameBytes > MAX_CONTROL_FRAME_BYTES || !this.#consumeFrame(frame)) {
        visible.push(frame);
      }
      input = input.subarray(frameBytes);
    }

    return visible;
  }

  finish(): Buffer[] {
    if (this.#pending.byteLength === 0) return [];
    const pending = this.#pending;
    this.#pending = Buffer.alloc(0);
    return [pending];
  }

  result(): GuestCommandControlResult {
    return {
      started: this.#challenge !== undefined,
      completedExitCode: this.#completedExitCode,
    };
  }

  #consumeFrame(frame: Buffer): boolean {
    const payload = frame.subarray(CONTROL_PREFIX.byteLength, -1).toString("ascii");
    const start = START_PATTERN.exec(payload);
    if (start) {
      if (this.#challenge === undefined) this.#challenge = start[1]!;
      return true;
    }
    const done = DONE_PATTERN.exec(payload);
    if (!done) return false;
    const status = Number(done[2]);
    if (status < 0 || status > 255) return false;
    if (done[1] === this.#challenge && this.#completedExitCode === null) {
      this.#completedExitCode = status;
    }
    return true;
  }
}

/** Classify completion from authenticated START/DONE state, never from guest-controlled output. */
export function guestCommandResult(result: ProcessResult): DriverCommandResult {
  const completed = result.guestCommandControl?.started === true
    && result.guestCommandControl.completedExitCode === result.exitCode;
  const timedOut = result.timedOut || (!completed && result.exitCode === 124);
  return {
    success: completed && !timedOut && result.exitCode === 0,
    exitCode: timedOut ? null : result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut,
  };
}
