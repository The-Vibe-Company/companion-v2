import { createHash } from "node:crypto";

/**
 * OpenCode-compatible, time-ordered id allocated with a durable command.
 *
 * OpenCode compares message ids while constructing the assistant reply, so the timestamp-shaped
 * prefix must preserve prompt order. Only the suffix is hashed to make crash retries idempotent.
 */
export function deterministicAgentMessageId(
  commandKind: "run" | "project",
  subjectId: string,
  ordinal: number,
  createdAtMs: number,
): string {
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    !Number.isSafeInteger(createdAtMs) ||
    createdAtMs < 0
  ) {
    throw new Error("invalid durable prompt identity");
  }
  const encodedTime =
    (BigInt(createdAtMs) * 0x1000n + BigInt(ordinal + 1)) &
    ((1n << 48n) - 1n);
  const timeHex = encodedTime.toString(16).padStart(12, "0");
  const stableSuffix = createHash("sha256")
    .update(`companion-${commandKind}-prompt:v2:${subjectId}:${ordinal}:${createdAtMs}`)
    .digest("hex")
    .slice(0, 14);
  return `msg_${timeHex}${stableSuffix}`;
}
