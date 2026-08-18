const SECRET_ASSIGNMENT = new RegExp(
  String.raw`(^|[^a-z0-9])(["']?)(access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|api[_-]?key|client[_-]?secret|private[_-]?key|token|secret|password|authorization|cookie|credential)\2\s*[:=]\s*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}\]]+)`,
  "gi",
);
const BEARER = /\bbearer\s+[a-z0-9._~+/=-]+/gi;
const JWT = /\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\b/g;
const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s<>()]+/gi;
const CREDENTIAL_SHAPE = /\b(?:sk|box|ghp|github_pat|xox[baprs])-[_a-zA-Z0-9-]{8,}\b/g;
const SENSITIVE_HEADER = /\b(authorization|cookie)\s*:\s*[^\r\n]*/gi;

/** Shared generic credential scrubber for persisted errors and user-visible Pi projections. */
export function redactGenericRuntimeCredentials(
  value: string,
  redactUrl: (url: string) => string,
): string {
  return value
    // Header values are free-form and may contain schemes (Basic, Digest), comma/semicolon
    // separated cookies, quotes, or punctuation that the generic assignment matcher treats as a
    // boundary. Remove the complete value first so a partial match cannot leave credential tails.
    .replace(SENSITIVE_HEADER, (_match, name: string) => `${name} [redacted]`)
    .replace(URL_PATTERN, redactUrl)
    .replace(BEARER, "Bearer [redacted]")
    .replace(SECRET_ASSIGNMENT, (
      _match,
      prefix: string,
      _quote: string,
      key: string,
    ) => `${prefix}${key}=[redacted]`)
    .replace(JWT, "[token removed]")
    .replace(CREDENTIAL_SHAPE, "[credential removed]");
}
