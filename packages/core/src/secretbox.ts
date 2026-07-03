import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Envelope encryption for agent secrets (write-only values, e.g. skill env vars and the per-agent
 * OpenCode server password). AES-256-GCM at both layers:
 *
 *   value  --AES-256-GCM(DEK, iv)-->  ciphertext          (random 32-byte DEK per secret)
 *   DEK    --AES-256-GCM(KEK, iv)-->  wrappedDek          (KEK = COMPANION_SECRETS_KEY, base64 32B)
 *
 * Both blobs serialize as `v1:<b64 iv>:<b64 tag>:<b64 data>`. The AAD (`orgId:agentId:key`) binds a
 * ciphertext to its exact row, so a blob copied onto another row fails to open. Plaintext exists
 * only in memory at injection time — never logged, never returned by the API, never written to a
 * sandbox filesystem.
 */

const VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class SecretBoxError extends Error {}

function encodeBlob(iv: Buffer, tag: Buffer, data: Buffer): string {
  return [VERSION, iv.toString("base64"), tag.toString("base64"), data.toString("base64")].join(":");
}

function decodeBlob(blob: string): { iv: Buffer; tag: Buffer; data: Buffer } {
  const [version, iv, tag, data, ...rest] = blob.split(":");
  if (version !== VERSION || !iv || !tag || !data || rest.length > 0) {
    throw new SecretBoxError("unsupported secret blob format");
  }
  return {
    iv: Buffer.from(iv, "base64"),
    tag: Buffer.from(tag, "base64"),
    data: Buffer.from(data, "base64"),
  };
}

function gcmSeal(key: Buffer, plaintext: Buffer, aad: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return encodeBlob(iv, cipher.getAuthTag(), data);
}

function gcmOpen(key: Buffer, blob: string, aad: string): Buffer {
  const { iv, tag, data } = decodeBlob(blob);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(data), decipher.final()]);
  } catch {
    // Deliberately drop the underlying error: it can echo buffer contents in some Node builds.
    throw new SecretBoxError("secret failed to decrypt (wrong key, tampered blob, or mismatched context)");
  }
}

/** Parse COMPANION_SECRETS_KEY (base64, exactly 32 bytes). */
export function parseSecretsKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim() === "") {
    throw new SecretBoxError("COMPANION_SECRETS_KEY is not set (base64 32-byte key required for agent secrets)");
  }
  const key = Buffer.from(raw.trim(), "base64");
  if (key.length !== KEY_BYTES) {
    throw new SecretBoxError("COMPANION_SECRETS_KEY must decode to exactly 32 bytes");
  }
  return key;
}

/** Generate a fresh KEK (or any 32-byte key) as base64 — used by dev bootstrap and key rotation. */
export function generateSecretsKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export interface SealedSecret {
  wrappedDek: string;
  ciphertext: string;
}

/** Encrypt one secret value under a fresh DEK; the DEK is wrapped by the KEK. */
export function sealSecret(input: { kek: Buffer; plaintext: string; aad: string }): SealedSecret {
  const dek = randomBytes(KEY_BYTES);
  const ciphertext = gcmSeal(dek, Buffer.from(input.plaintext, "utf8"), input.aad);
  const wrappedDek = gcmSeal(input.kek, dek, input.aad);
  dek.fill(0);
  return { wrappedDek, ciphertext };
}

/** Decrypt a sealed secret. Throws {@link SecretBoxError} on any mismatch — callers must not log it. */
export function openSecret(input: { kek: Buffer; sealed: SealedSecret; aad: string }): string {
  const dek = gcmOpen(input.kek, input.sealed.wrappedDek, input.aad);
  if (dek.length !== KEY_BYTES) {
    throw new SecretBoxError("secret failed to decrypt (wrong key, tampered blob, or mismatched context)");
  }
  const plaintext = gcmOpen(dek, input.sealed.ciphertext, input.aad);
  dek.fill(0);
  return plaintext.toString("utf8");
}

/** AAD binding a secret to its row: `${orgId}:${agentId}:${key}`. */
export function agentSecretAad(orgId: string, agentId: string, key: string): string {
  return `${orgId}:${agentId}:${key}`;
}
