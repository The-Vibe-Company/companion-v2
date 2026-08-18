import { redactGenericRuntimeCredentials } from "./credentialRedaction";

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
    const redacted = redactGenericRuntimeCredentials(removeExact(value), redactUrl);
    // Generic replacements are synthetic text too: a credential may equal "redacted",
    // "credential", or an entire marker. Prove the final result is exact-value-free.
    return removeExact(redacted);
  };
}

export const genericRuntimeVisibleTextRedactor = createRuntimeVisibleTextRedactor([]);
