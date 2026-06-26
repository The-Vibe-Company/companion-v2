/**
 * User-avatar helpers shared by the API, core, web, and CLI.
 *
 * Crypto-free on purpose: the Gravatar hash (which needs `node:crypto`) lives in `packages/core`
 * (`resolveUserAvatarUrl`) so it never reaches the browser bundle. This module holds only the
 * serve-path shape, the "is this a hosted upload" probe, and the upload MIME allow-list — all of
 * which the web client imports for the Settings → Profile picker.
 */

/** Allowed profile avatar uploads (PNG, JPEG, WebP, GIF) — same set as workspace logos. */
export const USER_AVATAR_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type UserAvatarMimeType = (typeof USER_AVATAR_MIME_TYPES)[number];

const USER_AVATAR_EXTENSION_TO_MIME: Record<string, UserAvatarMimeType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export const USER_AVATAR_FILE_EXTENSIONS = Object.keys(USER_AVATAR_EXTENSION_TO_MIME) as Array<
  keyof typeof USER_AVATAR_EXTENSION_TO_MIME
>;

/** `accept` value for `<input type="file">` — extensions only (Finder ignores mixed MIME filters). */
export const USER_AVATAR_FILE_ACCEPT = USER_AVATAR_FILE_EXTENSIONS.join(",");

/** Upload cap, enforced on both the client and the API (matches the `POST` route `bodyLimit`). */
export const MAX_USER_AVATAR_BYTES = 2 * 1024 * 1024;

export function resolveUserAvatarContentType(file: { type: string; name: string }): UserAvatarMimeType | null {
  if ((USER_AVATAR_MIME_TYPES as readonly string[]).includes(file.type)) {
    return file.type as UserAvatarMimeType;
  }
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (ext && ext in USER_AVATAR_EXTENSION_TO_MIME) return USER_AVATAR_EXTENSION_TO_MIME[ext]!;
  return null;
}

export function isAllowedUserAvatarFile(file: { type: string; name: string }): boolean {
  return resolveUserAvatarContentType(file) !== null;
}

/**
 * Same-origin serve path for a user's custom avatar binary. `version` (the profile's `updatedAt`
 * epoch) busts caches on re-upload. The Next rewrite proxies `/v1/*` to the API, so the session
 * cookie rides along automatically — no email ever leaves the server.
 */
export function userAvatarPublicPath(userId: string, version: string | number): string {
  return `/v1/users/${userId}/avatar?v=${version}`;
}

/** True when an avatar URL points at our hosted upload endpoint (vs. a Gravatar URL). */
export function isHostedAvatarUrl(url: string): boolean {
  return /\/v1\/users\/[^/]+\/avatar(?:\?|$)/.test(url);
}
