import type { ErrorAction, SafeRuntimeError } from "./types";

const STABLE_CODE = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_ERROR_MESSAGE_LENGTH = 500;

export class AmbiguousExternalEffectError extends Error {
  readonly stableCode: string;
  readonly action = "retry" as const;

  constructor(code: "box_create_ambiguous" | "prompt_dispatch_ambiguous" | "decision_delivery_ambiguous") {
    super(
      code === "box_create_ambiguous"
        ? "Box creation may have succeeded, so it will not be replayed automatically."
        : code === "prompt_dispatch_ambiguous"
          ? "The prompt may have reached Pi, so it will not be replayed automatically."
          : "The decision response may have reached Pi, so it will not be replayed automatically.",
    );
    this.name = "AmbiguousExternalEffectError";
    this.stableCode = code;
  }
}

export class RuntimeInvariantError extends Error {
  readonly stableCode: string;
  readonly action: ErrorAction;

  constructor(input: { code: string; message: string; action?: ErrorAction }) {
    super(input.message);
    this.name = "RuntimeInvariantError";
    this.stableCode = input.code;
    this.action = input.action ?? "retry";
  }
}

export class RuntimeShutdownError extends Error {
  readonly stableCode = "runtime_shutting_down";
  readonly action = "retry" as const;

  constructor() {
    super("Runtime execution was interrupted during shutdown.");
    this.name = "RuntimeShutdownError";
  }
}

/** Local process handoff signal. This error must never be persisted as a terminal outcome. */
export class RuntimeHandoffError extends Error {
  constructor() {
    super("Runtime execution is being handed off to another replica.");
    this.name = "RuntimeHandoffError";
  }
}

const DENIAL_ERRORS: Record<string, SafeRuntimeError> = {
  cold_start_deadline_exceeded: {
    code: "cold_start_deadline_exceeded",
    message: "The Companion did not start before its deadline.",
    action: "retry",
  },
  inactivity_deadline_exceeded: {
    code: "turn_stalled",
    message: "The Companion stopped making progress.",
    action: "retry",
  },
  absolute_deadline_exceeded: {
    code: "turn_deadline_exceeded",
    message: "The Companion reached its maximum execution time.",
    action: "retry",
  },
  actor_not_authorized: {
    code: "actor_not_authorized",
    message: "The initiating member is no longer authorized.",
    action: "none",
  },
  companion_access_revoked: {
    code: "companion_access_revoked",
    message: "Access to this Companion was revoked.",
    action: "none",
  },
  provider_unavailable: {
    code: "provider_unavailable",
    message: "The selected provider connection is unavailable.",
    action: "reconnect_provider",
  },
  provider_access_revoked: {
    code: "provider_access_revoked",
    message: "The selected provider connection is no longer authorized.",
    action: "reconnect_provider",
  },
  resource_access_revoked: {
    code: "resource_access_revoked",
    message: "A selected Skill or plugin is no longer authorized.",
    action: "none",
  },
  settings_changed: {
    code: "settings_changed",
    message: "Companion settings changed before execution began.",
    action: "retry",
  },
  settings_changed_since_claim: {
    code: "settings_changed_since_claim",
    message: "Companion settings changed before execution began.",
    action: "retry",
  },
  actor_access_revoked: {
    code: "actor_access_revoked",
    message: "The initiating member is no longer authorized.",
    action: "none",
  },
  decision_actor_access_revoked: {
    code: "decision_actor_access_revoked",
    message: "The responding member is no longer authorized.",
    action: "none",
  },
  decision_actor_missing: {
    code: "decision_actor_missing",
    message: "The decision response has no authorized actor.",
    action: "none",
  },
  skill_access_revoked: {
    code: "skill_access_revoked",
    message: "A selected Skill is no longer authorized.",
    action: "none",
  },
  mcp_access_revoked: {
    code: "mcp_access_revoked",
    message: "A selected MCP account is no longer authorized.",
    action: "none",
  },
  invalid_resource_selection: {
    code: "invalid_resource_selection",
    message: "The selected runtime resources are no longer valid.",
    action: "none",
  },
  invalid_model_selection: {
    code: "invalid_model_selection",
    message: "The selected model is no longer valid.",
    action: "switch_model",
  },
};

const SECRET_ASSIGNMENT = /\b(token|api[_-]?key|secret|password|authorization|cookie|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER = /\bbearer\s+[a-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;
const URL = /\b(?:https?|wss?):\/\/[^\s<>()]+/gi;
const CREDENTIAL_SHAPE = /\b(?:sk|box|ghp|github_pat|xox[baprs])-[_a-zA-Z0-9-]{8,}\b/g;

export function expurgateRuntimeMessage(value: unknown, fallback = "Runtime execution failed."): string {
  const source = typeof value === "string" ? value : fallback;
  const scrubbed = source
    .replace(URL, "[url removed]")
    .replace(BEARER, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[redacted]`)
    .replace(JWT, "[token removed]")
    .replace(CREDENTIAL_SHAPE, "[credential removed]")
    .replace(/[\r\n\u2028\u2029]+/g, " ")
    .replace(/[\t ]+/g, " ")
    .trim();
  const message = scrubbed || fallback;
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

export function safeRuntimeError(input: {
  code: string;
  message: unknown;
  action: ErrorAction;
}): SafeRuntimeError {
  return {
    code: STABLE_CODE.test(input.code) ? input.code : "runtime_failure",
    message: expurgateRuntimeMessage(input.message),
    action: input.action,
  };
}

export function denialRuntimeError(code: string): {
  terminalStatus: "failed" | "interrupted";
  error: SafeRuntimeError;
} {
  const known = DENIAL_ERRORS[code];
  if (known) {
    return {
      terminalStatus: code.endsWith("deadline_exceeded") ? "interrupted" : "failed",
      error: { ...known },
    };
  }
  return {
    terminalStatus: "failed",
    error: {
      code: "runtime_authorization_denied",
      message: "Runtime authorization was denied.",
      action: "none",
    },
  };
}

export function errorAction(value: unknown, fallback: ErrorAction = "retry"): ErrorAction {
  if (
    value === "retry"
    || value === "cancel"
    || value === "restart_pi"
    || value === "restart_box"
    || value === "switch_model"
    || value === "reconnect_provider"
    || value === "none"
  ) return value;
  return fallback;
}

export function safeErrorFromUnknown(
  error: unknown,
  fallback: { code: string; message: string; action: ErrorAction },
): SafeRuntimeError {
  if (error && typeof error === "object") {
    const candidate = error as { stableCode?: unknown; message?: unknown; action?: unknown };
    const hasExplicitStableCode = typeof candidate.stableCode === "string"
      && STABLE_CODE.test(candidate.stableCode);
    if (!hasExplicitStableCode) return safeRuntimeError(fallback);
    return safeRuntimeError({
      code: candidate.stableCode as string,
      message: typeof candidate.message === "string" ? candidate.message : fallback.message,
      action: errorAction(candidate.action, fallback.action),
    });
  }
  return safeRuntimeError(fallback);
}

export const RUNTIME_DEADLINE_DENIALS = new Set([
  "cold_start_deadline_exceeded",
  "inactivity_deadline_exceeded",
  "absolute_deadline_exceeded",
]);
