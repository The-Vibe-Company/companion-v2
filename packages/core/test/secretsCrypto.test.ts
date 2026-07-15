import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SecretConfigurationError,
  decryptOpaqueValue,
  decryptSecretValue,
  encryptOpaqueValue,
  encryptSecretValue,
  loadSecretsMasterKey,
} from "../src/secretsCrypto";

describe("secret envelope encryption", () => {
  const key = randomBytes(32);
  const context = {
    orgId: "9c3a3624-3579-4516-a853-ad6dba50c9cf",
    secretId: "d7db14b7-016d-4c35-9022-ceba6ec45754",
    version: 1,
  };

  it("round trips without persisting the plaintext", () => {
    const value = "SENTINEL-never-persist-this";
    const encrypted = encryptSecretValue({ ...context, value }, key);
    expect(JSON.stringify(encrypted)).not.toContain(value);
    expect(decryptSecretValue({ ...context, ...encrypted }, key)).toBe(value);
  });

  it("binds opaque credentials to purpose and subject", () => {
    const encrypted = encryptOpaqueValue(
      { orgId: context.orgId, purpose: "opencode-server-password", subjectId: "run-1", value: "sentinel" },
      key,
    );
    expect(JSON.stringify(encrypted)).not.toContain("sentinel");
    expect(
      decryptOpaqueValue(
        { orgId: context.orgId, purpose: "opencode-server-password", subjectId: "run-1", ...encrypted },
        key,
      ),
    ).toBe("sentinel");
    expect(() =>
      decryptOpaqueValue(
        { orgId: context.orgId, purpose: "opencode-server-password", subjectId: "run-2", ...encrypted },
        key,
      ),
    ).toThrow();
  });

  it("binds ciphertext and wrapped keys to tenant, secret, and version", () => {
    const encrypted = encryptSecretValue({ ...context, value: "secret" }, key);
    expect(() => decryptSecretValue({ ...context, orgId: "other-org", ...encrypted }, key)).toThrow();
    expect(() => decryptSecretValue({ ...context, version: 2, ...encrypted }, key)).toThrow();
  });

  it("rejects tampering and a different root key", () => {
    const encrypted = encryptSecretValue({ ...context, value: "secret" }, key);
    expect(() => decryptSecretValue({ ...context, ...encrypted, ciphertext: Buffer.from("tampered").toString("base64") }, key)).toThrow(
      "encrypted secret value could not be decrypted",
    );
    expect(() => decryptSecretValue({ ...context, ...encrypted, authTag: Buffer.from("tampered-auth-tag").toString("base64") }, key)).toThrow();
    expect(() => decryptSecretValue({ ...context, ...encrypted, wrappedDek: Buffer.from("tampered-dek").toString("base64") }, key)).toThrow();
    expect(() => decryptSecretValue({ ...context, ...encrypted, wrapAuthTag: Buffer.from("tampered-wrap-tag").toString("base64") }, key)).toThrow();
    expect(() => decryptSecretValue({ ...context, ...encrypted }, randomBytes(32))).toThrow(SecretConfigurationError);
  });

  it("requires a strict 32-byte base64 key", () => {
    expect(loadSecretsMasterKey(key.toString("base64"))).toEqual(key);
    expect(() => loadSecretsMasterKey("not-base64")).toThrow(SecretConfigurationError);
    expect(() => loadSecretsMasterKey(undefined)).toThrow(SecretConfigurationError);
  });
});
