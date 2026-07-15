import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const SECRETS_MASTER_KEY_ENV = "COMPANION_SECRETS_MASTER_KEY";

export class SecretConfigurationError extends Error {
  constructor(message = `${SECRETS_MASTER_KEY_ENV} must be a base64-encoded 32-byte key`) {
    super(message);
    this.name = "SecretConfigurationError";
  }
}

export interface SecretCiphertext {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  wrapIv: string;
  wrapAuthTag: string;
  keyId: string;
}

/** Envelope used for control-plane credentials that are not user-managed vault rows. */
export type OpaqueCiphertext = SecretCiphertext;

function decodeMasterKey(raw: string | undefined): Buffer {
  if (!raw) throw new SecretConfigurationError();
  const normalized = raw.trim();
  const key = Buffer.from(normalized, "base64");
  const canonical = key.toString("base64").replace(/=+$/, "");
  if (key.byteLength !== 32 || canonical !== normalized.replace(/=+$/, "")) throw new SecretConfigurationError();
  return key;
}

export function loadSecretsMasterKey(raw = process.env[SECRETS_MASTER_KEY_ENV]): Buffer {
  return decodeMasterKey(raw);
}

export function secretsKeyId(key: Buffer): string {
  return `sha256:${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

function aad(kind: "value" | "dek", input: { orgId: string; secretId: string; version: number }): Buffer {
  return Buffer.from(`companion-secret:${kind}:v1:${input.orgId}:${input.secretId}:${input.version}`, "utf8");
}

function opaqueAad(
  kind: "value" | "dek",
  input: { orgId: string; purpose: string; subjectId: string },
): Buffer {
  return Buffer.from(`companion-opaque:${kind}:v1:${input.orgId}:${input.purpose}:${input.subjectId}`, "utf8");
}

function encryptAead(plaintext: Buffer, key: Buffer, additionalData: Buffer): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext, iv, tag: cipher.getAuthTag() };
}

function decryptAead(ciphertext: Buffer, key: Buffer, iv: Buffer, tag: Buffer, additionalData: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(additionalData);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encryptSecretValue(
  input: { orgId: string; secretId: string; version: number; value: string },
  masterKey = loadSecretsMasterKey(),
): SecretCiphertext {
  const dek = randomBytes(32);
  try {
    const encrypted = encryptAead(Buffer.from(input.value, "utf8"), dek, aad("value", input));
    const wrapped = encryptAead(dek, masterKey, aad("dek", input));
    return {
      ciphertext: encrypted.ciphertext.toString("base64"),
      iv: encrypted.iv.toString("base64"),
      authTag: encrypted.tag.toString("base64"),
      wrappedDek: wrapped.ciphertext.toString("base64"),
      wrapIv: wrapped.iv.toString("base64"),
      wrapAuthTag: wrapped.tag.toString("base64"),
      keyId: secretsKeyId(masterKey),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptSecretValue(
  input: { orgId: string; secretId: string; version: number } & SecretCiphertext,
  masterKey = loadSecretsMasterKey(),
): string {
  const expectedKeyId = Buffer.from(secretsKeyId(masterKey), "utf8");
  const actualKeyId = Buffer.from(input.keyId, "utf8");
  if (expectedKeyId.byteLength !== actualKeyId.byteLength || !timingSafeEqual(expectedKeyId, actualKeyId)) {
    throw new SecretConfigurationError("configured secrets master key does not match the encrypted value key id");
  }
  try {
    const dek = decryptAead(
      Buffer.from(input.wrappedDek, "base64"),
      masterKey,
      Buffer.from(input.wrapIv, "base64"),
      Buffer.from(input.wrapAuthTag, "base64"),
      aad("dek", input),
    );
    try {
      return decryptAead(
        Buffer.from(input.ciphertext, "base64"),
        dek,
        Buffer.from(input.iv, "base64"),
        Buffer.from(input.authTag, "base64"),
        aad("value", input),
      ).toString("utf8");
    } finally {
      dek.fill(0);
    }
  } catch (error) {
    if (error instanceof SecretConfigurationError) throw error;
    throw new SecretConfigurationError("encrypted secret value could not be decrypted");
  }
}

/**
 * Encrypt a short-lived internal credential with the vault master key while keeping its AAD domain
 * separate from vault secret versions. The returned object is safe to JSON-serialize; plaintext is
 * not.
 */
export function encryptOpaqueValue(
  input: { orgId: string; purpose: string; subjectId: string; value: string },
  masterKey = loadSecretsMasterKey(),
): OpaqueCiphertext {
  const dek = randomBytes(32);
  try {
    const encrypted = encryptAead(Buffer.from(input.value, "utf8"), dek, opaqueAad("value", input));
    const wrapped = encryptAead(dek, masterKey, opaqueAad("dek", input));
    return {
      ciphertext: encrypted.ciphertext.toString("base64"),
      iv: encrypted.iv.toString("base64"),
      authTag: encrypted.tag.toString("base64"),
      wrappedDek: wrapped.ciphertext.toString("base64"),
      wrapIv: wrapped.iv.toString("base64"),
      wrapAuthTag: wrapped.tag.toString("base64"),
      keyId: secretsKeyId(masterKey),
    };
  } finally {
    dek.fill(0);
  }
}

export function decryptOpaqueValue(
  input: { orgId: string; purpose: string; subjectId: string } & OpaqueCiphertext,
  masterKey = loadSecretsMasterKey(),
): string {
  const expectedKeyId = Buffer.from(secretsKeyId(masterKey), "utf8");
  const actualKeyId = Buffer.from(input.keyId, "utf8");
  if (expectedKeyId.byteLength !== actualKeyId.byteLength || !timingSafeEqual(expectedKeyId, actualKeyId)) {
    throw new SecretConfigurationError("configured secrets master key does not match the encrypted value key id");
  }
  try {
    const dek = decryptAead(
      Buffer.from(input.wrappedDek, "base64"),
      masterKey,
      Buffer.from(input.wrapIv, "base64"),
      Buffer.from(input.wrapAuthTag, "base64"),
      opaqueAad("dek", input),
    );
    try {
      return decryptAead(
        Buffer.from(input.ciphertext, "base64"),
        dek,
        Buffer.from(input.iv, "base64"),
        Buffer.from(input.authTag, "base64"),
        opaqueAad("value", input),
      ).toString("utf8");
    } finally {
      dek.fill(0);
    }
  } catch (error) {
    if (error instanceof SecretConfigurationError) throw error;
    throw new SecretConfigurationError("opaque credential could not be decrypted");
  }
}
