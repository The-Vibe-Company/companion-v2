import { createHash } from "node:crypto";
import { userAvatarPublicPath } from "@companion/contracts";

/**
 * Avatar URL resolution — server-only (uses `node:crypto`), so it lives here in `core` rather than
 * in `contracts`. Every user-bearing row the API returns carries one resolved `avatarUrl`; the
 * browser only ever sees the resolved string, never the email behind a Gravatar hash.
 */

/** Gravatar identity hash: SHA-256 of the trimmed, lowercased email (Gravatar accepts SHA-256). */
export function gravatarHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

/**
 * Gravatar image URL for an email. `d=404` makes Gravatar 404 when no avatar exists for the address,
 * so the client `<img onError>` falls through to the colored initials instead of a generic default.
 */
export function gravatarUrl(email: string, size = 160): string {
  return `https://www.gravatar.com/avatar/${gravatarHash(email)}?d=404&s=${size}`;
}

/**
 * Resolve the avatar a user should show: their custom upload if present (cache-busted by the
 * profile's `updatedAt`), otherwise their Gravatar. Never null — the client falls back to initials
 * only when the chosen URL fails to load.
 */
export function resolveUserAvatarUrl(input: {
  userId: string;
  email: string;
  avatarUrl: string | null;
  updatedAtEpoch: number;
}): string {
  if (input.avatarUrl) return userAvatarPublicPath(input.userId, input.updatedAtEpoch);
  return gravatarUrl(input.email);
}
