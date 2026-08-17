import { errorAction, expurgateRuntimeMessage } from "./errors";
import type { RuntimeAuthorization, RuntimeClaim, SafeRuntimeError } from "./types";

const STABLE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_CAUSE_DEPTH = 4;
const MAX_STACK_CHARS = 1_200;
const MAX_LOG_LINE_CHARS = 4_000;

export type JsonLogValue =
  | string
  | number
  | boolean
  | null
  | JsonLogValue[]
  | { [key: string]: JsonLogValue };

/** One JSON-serializable process log line. Strings are expurgated before emit. */
export interface RuntimeLogRecord {
  ts: string;
  event: string;
  [key: string]: JsonLogValue;
}

export interface RuntimeProcessLog {
  error(record: RuntimeLogRecord): void;
  warn(record: RuntimeLogRecord): void;
}

export const silentRuntimeProcessLog: RuntimeProcessLog = {
  error() {},
  warn() {},
};

export type ThrownErrorLog = {
  [key: string]: JsonLogValue;
  name: string;
  message: string;
};

/**
 * Operator-visible description of a thrown value. Persisted runtime errors stay on the 500-character
 * SafeRuntimeError path; this is the process log, so the original name and message survive after
 * generic credential redaction. That is the difference between "Runtime execution failed." and the
 * line that named a missing Pi install command.
 */
export function describeThrownError(error: unknown, depth = 0): ThrownErrorLog {
  if (error instanceof Error) {
    const candidate = error as Error & {
      stableCode?: unknown;
      action?: unknown;
      status?: unknown;
      field?: unknown;
      cause?: unknown;
    };
    const described: ThrownErrorLog = {
      name: error.name || "Error",
      message: expurgateRuntimeMessage(error.message, "Runtime execution failed."),
    };
    if (typeof candidate.stableCode === "string" && STABLE_CODE.test(candidate.stableCode)) {
      described.stableCode = candidate.stableCode;
    }
    const action = errorAction(candidate.action, "retry");
    if (candidate.action !== undefined) described.action = action;
    if (typeof candidate.status === "number" && Number.isFinite(candidate.status)) {
      described.status = candidate.status;
    }
    if (typeof candidate.field === "string" && candidate.field.length > 0) {
      described.field = expurgateRuntimeMessage(candidate.field, "field");
    }
    const stack = expurgateRuntimeMessage(error.stack ?? "", "");
    if (stack) described.stack = stack.slice(0, MAX_STACK_CHARS);
    if (depth < MAX_CAUSE_DEPTH && candidate.cause !== undefined) {
      described.causes = [describeThrownError(candidate.cause, depth + 1)];
    }
    return described;
  }
  if (error && typeof error === "object") {
    const candidate = error as { name?: unknown; message?: unknown; stableCode?: unknown };
    return {
      name: typeof candidate.name === "string" ? candidate.name : "Object",
      message: expurgateRuntimeMessage(
        typeof candidate.message === "string" ? candidate.message : "Runtime execution failed.",
      ),
      ...(typeof candidate.stableCode === "string" && STABLE_CODE.test(candidate.stableCode)
        ? { stableCode: candidate.stableCode }
        : {}),
    };
  }
  return {
    name: typeof error,
    message: expurgateRuntimeMessage(error, "Runtime execution failed."),
  };
}

export function createJsonRuntimeProcessLog(
  write: (line: string) => void = (line) => {
    console.error(line);
  },
): RuntimeProcessLog {
  const emit = (level: "error" | "warn", record: RuntimeLogRecord): void => {
    const payload: Record<string, JsonLogValue> = {
      level,
      ts: record.ts,
      event: record.event,
    };
    for (const [key, value] of Object.entries(record)) {
      if (key === "ts" || key === "event") continue;
      payload[key] = expurgateLogValue(value);
    }
    let line = JSON.stringify(payload);
    if (line.length > MAX_LOG_LINE_CHARS) {
      line = `${line.slice(0, MAX_LOG_LINE_CHARS - 1)}…`;
    }
    write(line);
  };
  return {
    error: (record) => emit("error", record),
    warn: (record) => emit("warn", record),
  };
}

export function workFailureLogRecord(input: {
  ts: Date;
  event: string;
  claim: RuntimeClaim;
  authorization: RuntimeAuthorization | null;
  outcome: string;
  reason?: string;
  thrown?: unknown;
  persisted?: SafeRuntimeError;
}): RuntimeLogRecord {
  const thrown = input.thrown === undefined ? undefined : describeThrownError(input.thrown);
  const genericFallback = Boolean(
    thrown
    && input.persisted?.code === "runtime_execution_failed"
    && thrown.stableCode === undefined,
  );
  const live = input.authorization;
  return compactRecord({
    ts: input.ts.toISOString(),
    event: input.event,
    companionId: input.claim.companionId,
    workKind: input.claim.workKind,
    workId: input.claim.workId,
    operationKind: input.claim.operationKind,
    claimedCheckpoint: input.claim.checkpoint,
    liveCheckpoint: live?.workCheckpoint ?? null,
    boxId: live?.boxId ?? null,
    boxState: live?.boxState ?? null,
    piState: live?.piState ?? null,
    turnId: input.claim.turnId ?? live?.turnId ?? null,
    outcome: input.outcome,
    reason: input.reason ?? null,
    genericFallback,
    thrown: thrown ?? null,
    persisted: input.persisted
      ? {
        code: input.persisted.code,
        message: input.persisted.message,
        action: input.persisted.action,
      }
      : null,
  });
}

function compactRecord(value: Record<string, JsonLogValue | undefined>): RuntimeLogRecord {
  const record: RuntimeLogRecord = {
    ts: String(value.ts),
    event: String(value.event),
  };
  for (const [key, entry] of Object.entries(value)) {
    if (key === "ts" || key === "event" || entry === undefined || entry === null) continue;
    if (entry === false && key === "genericFallback") continue;
    record[key] = entry as JsonLogValue;
  }
  return record;
}

function expurgateLogValue(value: JsonLogValue): JsonLogValue {
  if (typeof value === "string") return expurgateRuntimeMessage(value, value);
  if (Array.isArray(value)) return value.map((entry) => expurgateLogValue(entry));
  if (value && typeof value === "object") {
    const nested: { [key: string]: JsonLogValue } = {};
    for (const [key, entry] of Object.entries(value)) nested[key] = expurgateLogValue(entry);
    return nested;
  }
  return value;
}
