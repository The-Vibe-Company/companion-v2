const SECRET_ASSIGNMENT = /\b(token|api[_-]?key|secret|password|authorization|cookie|credential)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER = /\bbearer\s+[a-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s<>()]+/gi;
const CREDENTIAL_SHAPE = /\b(?:sk|box|ghp|github_pat|xox[baprs])-[_a-zA-Z0-9-]{8,}\b/g;

export type RuntimeVisibleTextRedactor = (value: string) => string;

function redactUrl(value: string): string {
  try {
    const parsed = new URL(value);
    return parsed.username || parsed.password || parsed.search || parsed.hash
      ? "[signed URL removed]"
      : value;
  } catch {
    return "[url removed]";
  }
}

/**
 * Build a turn-local redactor. Exact plaintext values are kept only inside this closure, are never
 * serialized or logged, and are discarded with the execution context after settlement/release.
 */
export function createRuntimeVisibleTextRedactor(
  sensitiveValues: readonly string[],
): RuntimeVisibleTextRedactor {
  const exact = [...new Set(sensitiveValues.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  const removeExact = (value: string): string => {
    let scrubbed = value;
    // Removing one secret can concatenate its neighbours into another secret. Iterate to a fixed
    // point, but keep adversarial one-character dictionaries bounded and fail closed if needed.
    for (let pass = 0; pass < 8; pass += 1) {
      const before = scrubbed;
      for (const sensitive of exact) scrubbed = scrubbed.split(sensitive).join("");
      if (scrubbed === before) return scrubbed;
    }
    return exact.some((sensitive) => scrubbed.includes(sensitive)) ? "" : scrubbed;
  };
  return (value) => {
    const redacted = removeExact(value)
      .replace(URL_PATTERN, redactUrl)
      .replace(BEARER, "Bearer [redacted]")
      .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[redacted]`)
      .replace(JWT, "[token removed]")
      .replace(CREDENTIAL_SHAPE, "[credential removed]");
    // Generic replacements are synthetic text too: a credential may equal "redacted",
    // "credential", or an entire marker. Prove the final result is exact-value-free.
    return removeExact(redacted);
  };
}

export const genericRuntimeVisibleTextRedactor = createRuntimeVisibleTextRedactor([]);
