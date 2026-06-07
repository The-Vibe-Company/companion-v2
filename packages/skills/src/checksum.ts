import { createHash } from "node:crypto";

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * The canonical skill identity: sha256 over the deterministic (uncompressed) tar
 * bytes, prefixed `sha256:`. Decoupled from gzip so the checksum is stable across
 * zlib versions. This is what `skill_versions.checksum` and the lockfile store.
 */
export function skillChecksum(canonicalTar: Buffer | Uint8Array): string {
  return `sha256:${sha256Hex(canonicalTar)}`;
}
