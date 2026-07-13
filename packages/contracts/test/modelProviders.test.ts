import { describe, expect, it } from "vitest";
import { providerConnectionRowSchema, setProviderConnectionInputSchema } from "../src/modelProviders";

describe("provider secret bindings", () => {
  it("accepts only vault references on writes", () => {
    const input = setProviderConnectionInputSchema.parse({
      provider: "anthropic",
      key_name: "ANTHROPIC_API_KEY",
      secret_id: "a57b0803-6afb-47d0-a307-e8fb80c56511",
    });
    expect(input.secret_id).toBeTruthy();
    expect(() => setProviderConnectionInputSchema.parse({ ...input, key: "plaintext" })).toThrow();
    expect(() =>
      setProviderConnectionInputSchema.parse({ ...input, key_name: "OPENCODE_SERVER_FUTURE_CREDENTIAL" }),
    ).toThrow(/reserved/);
  });

  it("returns metadata without secret values", () => {
    const row = providerConnectionRowSchema.parse({
      provider: "anthropic",
      key_name: "ANTHROPIC_API_KEY",
      secret_id: "a57b0803-6afb-47d0-a307-e8fb80c56511",
      secret_name: "Anthropic production",
      secret_audience: "personal",
      secret_owner_name: "Ada",
      set: true,
      created_at: "2026-07-13T00:00:00.000Z",
    });
    expect(row).not.toHaveProperty("value");
    expect(row).not.toHaveProperty("key");
  });
});
