import type { CompanionAccess, CompanionRuntimeState } from "@companion/contracts";

/** An error line is one short sentence, never a transcript. */
const MAX_LENGTH = 240;
/**
 * The same bound, for callers that compose a line out of several pieces. A caller that budgets
 * against its own copy of this number would silently start losing its last piece the day this one
 * changed.
 */
export const COMPANION_RUNTIME_ERROR_MAX_LENGTH = MAX_LENGTH;
const REDACTED = "[redacted]";

/**
 * Credential-shaped text a runtime or Box message could carry. Redaction runs on every stored and
 * returned line, so a provider that echoes a header, key, or signed URL back at us cannot turn a
 * diagnostic into a leak.
 */
const SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|secret|password|passwd|authorization|bearer|cookie)\b\s*[:=]?\s*["']?[A-Za-z0-9._~+/=-]{8,}["']?/gi,
  /\b(?:sk|pk|rk|xoxb|xoxp|ghp|gho|ghs)[-_][A-Za-z0-9_-]{8,}\b/g,
  /\b[A-Za-z0-9_-]{40,}\b/g,
];

/** Query strings and fragments carry signed upload and desktop URLs, so only the path survives. */
const URL_TAIL = /(https?:\/\/[^\s?#]*)[?#]\S*/gi;

/**
 * One operator-safe line from a runtime failure. Only the first line survives, credential-shaped
 * text is redacted, and the result is truncated, so neither a stack trace nor a provider payload
 * can reach a stored row, an API response, or the thread UI.
 */
export function sanitizeCompanionRuntimeError(message: string): string {
  const firstLine = message.split(/[\r\n]/, 1)[0] ?? "";
  const printable = firstLine.replace(/\p{C}/gu, " ");
  const redacted = SECRET_PATTERNS.reduce(
    (text, pattern) => text.replace(pattern, REDACTED),
    printable.replace(URL_TAIL, `$1${REDACTED}`),
  );
  const collapsed = redacted.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_LENGTH - 1).trimEnd()}…`;
}

/**
 * What a Viewer reads when a Companion they can only watch is in `error`. A Viewer never runs Box,
 * so an operator hint — a missing key, a Box status, a Pi failure — would only invite them to try.
 */
export const COMPANION_RUNTIME_ERROR_VIEWER_MESSAGE = "This Companion is unavailable right now.";

/** Owner/Editor line for an `error` state recorded without a message, such as a live Box poll. */
export const COMPANION_RUNTIME_ERROR_FALLBACK = "This Companion's Box reported an error.";

/**
 * The error line a reader is allowed to see. Nothing is returned outside `error`, so a recovered
 * Companion never keeps explaining a failure it already retried past.
 */
export function companionRuntimeErrorForAccess(input: {
  state: CompanionRuntimeState;
  lastError: string | null;
  access: CompanionAccess;
}): string | null {
  if (input.state !== "error") return null;
  if (input.access === "viewer") return COMPANION_RUNTIME_ERROR_VIEWER_MESSAGE;
  if (!input.lastError) return COMPANION_RUNTIME_ERROR_FALLBACK;
  return sanitizeCompanionRuntimeError(input.lastError) || COMPANION_RUNTIME_ERROR_FALLBACK;
}
