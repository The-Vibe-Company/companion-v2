import { createHash } from "node:crypto";

/**
 * Namespace for deterministic routine-fire `client_message_id`s. At-least-once worker ticks
 * collapse to exactly one turn via `(companion_id, client_message_id)`.
 *
 * Kept out of `companionRoutines.ts` so the web preview can validate cron without bundling Node.
 */
export const ROUTINE_FIRE_NAMESPACE = "a6e0c4d2-8b91-5333-9c47-1d2e3f4a5b6c";

const UUID_HEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * RFC 4122 name-based (v5) UUID. Shared with the trigger fire-id module so both deterministic
 * `client_message_id` families hash the same way; each keeps its own fixed namespace.
 */
export function uuidv5(name: string, namespace: string): string {
  if (!UUID_HEX.test(namespace)) {
    throw new Error("fire-id namespace is not a UUID");
  }
  const ns = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(ns).update(name).digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export function routineFireMessageId(input: {
  routineId: string;
  scheduledFor: Date;
}): string {
  return uuidv5(`${input.routineId}|${input.scheduledFor.toISOString()}`, ROUTINE_FIRE_NAMESPACE);
}
