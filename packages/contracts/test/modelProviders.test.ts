import { describe, expect, it } from "vitest";
import {
  modelProviderConnectionRowSchema,
  setModelProviderConnectionInputSchema,
} from "../src/modelProviders";

describe("dedicated model-provider credentials", () => {
  it("accepts a write-only key and rejects generic vault fields", () => {
    const input = setModelProviderConnectionInputSchema.parse({
      provider: "anthropic",
      key_name: "ANTHROPIC_API_KEY",
      api_key: "sk-write-only",
    });
    expect(input.api_key).toBe("sk-write-only");
    expect(() => setModelProviderConnectionInputSchema.parse({
      provider: "anthropic",
      key_name: "ANTHROPIC_API_KEY",
      secret_id: "a57b0803-6afb-47d0-a307-e8fb80c56511",
    })).toThrow();
    expect(() => setModelProviderConnectionInputSchema.parse({ ...input, api_key: "   " })).toThrow(/blank/);
    expect(() =>
      setModelProviderConnectionInputSchema.parse({ ...input, key_name: "OPENCODE_SERVER_FUTURE_CREDENTIAL" }),
    ).toThrow(/reserved/);
  });

  it("returns connection/version metadata without credential or vault metadata", () => {
    const row = modelProviderConnectionRowSchema.parse({
      id: "a57b0803-6afb-47d0-a307-e8fb80c56511",
      provider: "anthropic",
      key_name: "ANTHROPIC_API_KEY",
      scope: "personal",
      credential_version: 2,
      set: true,
      created_at: "2026-07-13T00:00:00.000Z",
      updated_at: "2026-07-13T01:00:00.000Z",
    });
    expect(row).not.toHaveProperty("api_key");
    expect(row).not.toHaveProperty("secret_id");
    expect(row).not.toHaveProperty("secret_name");
  });
});
