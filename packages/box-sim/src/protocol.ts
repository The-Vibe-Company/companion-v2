/** Canonical prefix for the simulator-only control plane. */
export const BOX_SIM_CONTROL_PREFIX = "/_box-sim";

/** States currently observed by the production Box adapter. */
export type BoxSimBoxState =
  | "init"
  | "provisioning"
  | "provisioned"
  | "cloning"
  | "ready"
  | "idle"
  | "running"
  | "archiving"
  | "archived"
  | "error";

export type BoxSimSetupStatus = "pending" | "running" | "done" | "failed" | null;

/** Public Box representation. It deliberately contains no setup script or minted desktop URL. */
export interface BoxSimBox {
  id: string;
  name?: string;
  state: BoxSimBoxState;
  desktopAvailable: boolean;
  setupStatus?: BoxSimSetupStatus;
  setupError?: string | null;
  ttlSeconds: number;
  createdTick: number;
  updatedTick: number;
}

export type BoxSimNamedSnapshotStatus = "saving" | "ready" | "failed";

export interface BoxSimNamedSnapshot {
  name: string;
  status: BoxSimNamedSnapshotStatus;
  sourceBoxId: string;
  createdAt: string;
}

export type BoxSimDeletionStatus = "pending" | "processing" | "blocked" | "completed";

export interface BoxSimDeletionOperation {
  id: string;
  targetId: string;
  status: BoxSimDeletionStatus;
  attemptCount: number;
  requestedAt: string;
  completedAt: string | null;
}

export interface BoxSimCommandResult {
  success: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type BoxSimMaybePromise<T> = T | Promise<T>;

/**
 * One Pi controller belongs to one simulated Box. The core depends on this interface only; a real
 * JSONL child-process controller can be supplied by another module without coupling the HTTP
 * provider simulator to process management.
 */
export interface BoxSimPiController {
  /** Optional liveness signal used to project an independently exited Pi process as failed. */
  readonly running?: boolean;
  start(): BoxSimMaybePromise<void>;
  restart(): BoxSimMaybePromise<void>;
  stop(): BoxSimMaybePromise<void>;
  handleRpc(command: Record<string, unknown>): BoxSimMaybePromise<Record<string, unknown> | null>;
  respondExtensionUi(response: Record<string, unknown>): BoxSimMaybePromise<void>;
  crash(): BoxSimMaybePromise<void>;
  setScenario(name: string): BoxSimMaybePromise<void>;
  dispose(): BoxSimMaybePromise<void>;
}

export interface BoxSimPiControllerContext {
  readonly boxId: string;
  appendEvent(event: Record<string, unknown> | string): void;
  appendFault(fault: "malformed" | "oversized" | "unterminated"): void;
  currentInvocationId(): string | null;
}

export type BoxSimPiControllerFactory = (
  context: BoxSimPiControllerContext,
) => BoxSimPiController;

export interface BoxSimDefaults {
  /** Number of observations between create and ready, including the ready observation. */
  createPolls: number;
  /** Number of observations between resume and ready, including the ready observation. */
  resumePolls: number;
  /** Provider states exposed after stop; the first is returned by the stop request itself. */
  archiveStates: BoxSimBoxState[];
  /** Number of operation observations between delete acceptance and completion. */
  deletePolls: number;
  ttlSeconds: number;
  desktopAvailable: boolean;
  piScenario: string;
}

export const DEFAULT_BOX_SIM_DEFAULTS: Readonly<BoxSimDefaults> = Object.freeze({
  createPolls: 2,
  resumePolls: 1,
  archiveStates: ["archiving", "archived"] as BoxSimBoxState[],
  deletePolls: 2,
  ttlSeconds: 21_600,
  desktopAvailable: true,
  piScenario: "normal",
});

export type BoxSimFaultAction =
  | {
      kind: "http";
      status: number;
      code?: string;
      message?: string;
    }
  | { kind: "disconnect" }
  | { kind: "stall" }
  | {
      kind: "command";
      success?: boolean;
      exitCode?: number | null;
      stdout?: string;
      stderr?: string;
    };

/**
 * Points are strings on purpose: the built-in server names its points `box.<operation>.<phase>`,
 * while scenario modules may add precise points without changing the core protocol package.
 */
export type BoxSimFaultPoint = string;

export interface BoxSimFaultRuleInput {
  id?: string;
  point: BoxSimFaultPoint;
  /** Fire on the Nth matching visit. Defaults to the first. */
  occurrence?: number;
  /** Continue firing on every visit from occurrence onward. Defaults to one-shot. */
  repeat?: boolean;
  action: BoxSimFaultAction;
}

export interface BoxSimFaultRule extends BoxSimFaultRuleInput {
  id: string;
  occurrence: number;
  repeat: boolean;
  visits: number;
  fired: number;
}

export interface BoxSimRequestJournalEntry {
  sequence: number;
  tick: number;
  surface: "box" | "control";
  method: string;
  path: string;
  /** Only property names are retained, never request values. */
  bodyKeys: string[];
}

export interface BoxSimFileSnapshot {
  path: string;
  bytes: number;
  sha256: string;
  volatile: boolean;
}

export interface BoxSimStateSnapshot {
  tick: number;
  defaults: BoxSimDefaults;
  boxes: Array<BoxSimBox & {
    pendingStates: BoxSimBoxState[];
    setupScriptSha256: string | null;
    files: BoxSimFileSnapshot[];
    daemon: {
      status: "inactive" | "active" | "failed";
      invocationId: string | null;
      layoutMarker: string | null;
      rpcReady: boolean;
      activeAttemptId: string | null;
      tailCursor: number;
      acknowledgedCursor: number;
      counters: {
        malformedLines: number;
        oversizedLines: number;
        unterminatedLines: number;
        unknownEvents: number;
        unboundEvents: number;
        orphanResponses: number;
      };
      restartCount: number;
      scenario: string;
      stderrSha256: string;
      unknownCommandDigests: string[];
    };
  }>;
  deletions: BoxSimDeletionOperation[];
  namedSnapshots: BoxSimNamedSnapshot[];
  faults: BoxSimFaultRule[];
  requests: BoxSimRequestJournalEntry[];
}

export class BoxSimHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "BoxSimHttpError";
    this.status = status;
    this.code = code;
  }
}
