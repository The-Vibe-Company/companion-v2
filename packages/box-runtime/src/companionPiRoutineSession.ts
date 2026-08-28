/**
 * Material that belongs only to one scheduled Companion routine Pi session.
 *
 * The routine session is deliberately addressed by the durable run UUID rather than by a caller
 * supplied path.  Keeping the path derivation here gives every Box operation the same traversal
 * boundary and makes the run root deterministic across takeover.
 */

export const COMPANION_PI_ROUTINE_ROOT_PATH = ".companion/runtime/routines";
export const COMPANION_PI_ROUTINE_SURFACE_EXTENSION_FILE = "companion-routine-surface.ts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CompanionPiRoutineSessionPaths {
  runId: string;
  root: string;
  /** A sibling advisory-lock file shared by start, launch, and terminate commands. */
  lock: string;
  /** A sibling cancellation tombstone that survives removal of the run root. */
  cancelMarker: string;
  /** Reservation written during prepare and required verbatim by the later launch command. */
  reservation: string;
  socket: string;
  journal: string;
  dispatchLedger: string;
  invocation: string;
  pid: string;
  extension: string;
}

/** Validate the opaque UUID before it can become any part of a Box path. */
export function isCompanionPiRoutineRunId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Return the one deterministic relative layout used by every routine-session operation. */
export function companionPiRoutineSessionPaths(runId: string): CompanionPiRoutineSessionPaths {
  if (!isCompanionPiRoutineRunId(runId)) throw new Error("routine run id is invalid");
  const normalizedRunId = runId.toLowerCase();
  const root = `${COMPANION_PI_ROUTINE_ROOT_PATH}/${normalizedRunId}`;
  return {
    runId: normalizedRunId,
    root,
    lock: `${COMPANION_PI_ROUTINE_ROOT_PATH}/${normalizedRunId}.lock`,
    cancelMarker: `${COMPANION_PI_ROUTINE_ROOT_PATH}/${normalizedRunId}.cancelled`,
    reservation: `${root}/state/invocation-reservation`,
    socket: `${root}/state/pi-broker.sock`,
    journal: `${root}/events`,
    dispatchLedger: `${root}/state/dispatch-ledger.json`,
    invocation: `${root}/state/invocation-id`,
    pid: `${root}/state/broker.pid`,
    extension: `${root}/pi/extensions/${COMPANION_PI_ROUTINE_SURFACE_EXTENSION_FILE}`,
  };
}

/**
 * Source staged into a routine's private `PI_CODING_AGENT_DIR`.  The tool returns a bounded,
 * payload-free acknowledgement: the runtime reads the first tool_execution_start as the durable
 * return, then terminates this run.  Persistence and main-thread delivery stay outside the Box.
 */
export const COMPANION_PI_ROUTINE_SURFACE_EXTENSION_SOURCE = `/**
 * Routine-only terminal bridge. This file is staged under one run-scoped Pi directory and is never
 * installed in the main Companion Pi directory.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const MAX_MESSAGE = 16_384;

export default function companionRoutineSurface(pi: ExtensionAPI) {
  pi.registerTool({
    name: "surface_to_main",
    label: "Surface to main",
    description:
      "Return one terminal result from this routine to the main Companion. The first accepted call ends the routine; use relay when the main Companion should answer and notify when it should only receive the result.",
    parameters: Type.Object({
      mode: Type.Union([Type.Literal("relay"), Type.Literal("notify")]),
      message: Type.String({ maxLength: MAX_MESSAGE, description: "The result to surface, at most 16,384 characters" }),
    }),
    executionMode: "sequential",
    async execute(_toolCallId, params) {
      const mode = params.mode === "relay" || params.mode === "notify" ? params.mode : null;
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!mode || !message || message.length > MAX_MESSAGE) {
        return {
          content: [{ type: "text", text: "Error: surface_to_main requires a mode and a bounded message" }],
          details: { accepted: false },
        };
      }
      return {
        content: [{ type: "text", text: "Accepted. This routine is ending after its terminal result." }],
        details: { accepted: true, terminal: true, mode, messageLength: message.length },
      };
    },
  });
}
`;
