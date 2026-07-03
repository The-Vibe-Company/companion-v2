import { describe, expect, it } from "vitest";
import {
  SecretBoxError,
  agentSecretAad,
  generateSecretsKey,
  openSecret,
  parseSecretsKey,
  sealSecret,
} from "../src/secretbox";

const kek = parseSecretsKey(generateSecretsKey());
const aad = agentSecretAad("org-1", "agent-1", "SLACK_BOT_TOKEN");

describe("secretbox", () => {
  it("round-trips a secret under the same AAD", () => {
    const sealed = sealSecret({ kek, plaintext: "xoxb-secret-value", aad });
    expect(openSecret({ kek, sealed, aad })).toBe("xoxb-secret-value");
  });

  it("produces distinct blobs for the same plaintext (fresh DEK + IVs)", () => {
    const a = sealSecret({ kek, plaintext: "same", aad });
    const b = sealSecret({ kek, plaintext: "same", aad });
    expect(a.ciphertext).not.toBe(b.ciphertext);
    expect(a.wrappedDek).not.toBe(b.wrappedDek);
  });

  it("refuses to open under a different AAD (row-swap protection)", () => {
    const sealed = sealSecret({ kek, plaintext: "value", aad });
    const otherRow = agentSecretAad("org-1", "agent-2", "SLACK_BOT_TOKEN");
    expect(() => openSecret({ kek, sealed, aad: otherRow })).toThrow(SecretBoxError);
  });

  it("refuses to open with a different KEK", () => {
    const sealed = sealSecret({ kek, plaintext: "value", aad });
    const otherKek = parseSecretsKey(generateSecretsKey());
    expect(() => openSecret({ kek: otherKek, sealed, aad })).toThrow(SecretBoxError);
  });

  it("detects ciphertext tampering", () => {
    const sealed = sealSecret({ kek, plaintext: "value", aad });
    const [version = "", iv = "", tag = "", encoded = ""] = sealed.ciphertext.split(":");
    const data = Buffer.from(encoded, "base64");
    data[0] = (data[0] ?? 0) ^ 0xff;
    const tampered = { ...sealed, ciphertext: [version, iv, tag, data.toString("base64")].join(":") };
    expect(() => openSecret({ kek, sealed: tampered, aad })).toThrow(SecretBoxError);
  });

  it("rejects unknown blob formats", () => {
    const sealed = sealSecret({ kek, plaintext: "value", aad });
    expect(() => openSecret({ kek, sealed: { ...sealed, wrappedDek: "v2:a:b:c" }, aad })).toThrow(
      "unsupported secret blob format",
    );
  });

  it("validates the KEK env format", () => {
    expect(() => parseSecretsKey(undefined)).toThrow(SecretBoxError);
    expect(() => parseSecretsKey("")).toThrow(SecretBoxError);
    expect(() => parseSecretsKey(Buffer.alloc(16).toString("base64"))).toThrow("exactly 32 bytes");
    expect(parseSecretsKey(generateSecretsKey()).length).toBe(32);
  });

  it("handles multi-byte plaintext", () => {
    const value = "clé-secrète-🗝️-" + "x".repeat(4096);
    const sealed = sealSecret({ kek, plaintext: value, aad });
    expect(openSecret({ kek, sealed, aad })).toBe(value);
  });
});
