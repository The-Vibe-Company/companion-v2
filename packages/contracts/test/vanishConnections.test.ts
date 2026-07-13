import { describe, expect, it } from "vitest";
import { setVanishConnectionInputSchema, vanishConnectionResponseSchema } from "../src/vanishConnections";

describe("Vanish vault bindings", () => {
  it("accepts only a generic secret reference", () => {
    const secretId = "a57b0803-6afb-47d0-a307-e8fb80c56511";
    expect(setVanishConnectionInputSchema.parse({ secret_id: secretId })).toEqual({ secret_id: secretId });
    expect(() => setVanishConnectionInputSchema.parse({ secret_id: secretId, api_key: "plaintext" })).toThrow();
  });

  it("returns redacted vault metadata or null", () => {
    expect(vanishConnectionResponseSchema.parse({ connection: null })).toEqual({ connection: null });
    const parsed = vanishConnectionResponseSchema.parse({
      connection: {
        key_name: "VANISH_API_KEY",
        secret_id: "a57b0803-6afb-47d0-a307-e8fb80c56511",
        secret_name: "Vanish",
        secret_audience: "organization",
        secret_owner_name: "Ada",
        scope: "organization",
        set: true,
        created_at: "2026-07-13T00:00:00.000Z",
        updated_at: "2026-07-13T00:00:00.000Z",
      },
    });
    expect(parsed.connection).not.toHaveProperty("value");
  });
});
