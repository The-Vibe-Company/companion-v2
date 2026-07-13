import { describe, expect, it } from "vitest";
import {
  createSecretInputSchema,
  redeemedSecretGrantSchema,
  secretRowSchema,
  secretRetrievalPreflightInputSchema,
} from "../src/secrets";
import { TOKEN_SCOPES, tokenScopeSchema } from "../src/token";

describe("secret contracts", () => {
  it("exposes separate read and write scopes for Companion automation", () => {
    expect(tokenScopeSchema.parse("secrets:write")).toBe("secrets:write");
    expect(TOKEN_SCOPES).toEqual(["skills:read", "skills:write", "secrets:read", "secrets:write"]);
  });

  it("validates audiences and recipient rules", () => {
    expect(
      createSecretInputSchema.parse({
        name: "Linear",
        key: "LINEAR_API_KEY",
        value: "secret",
        audience: "restricted",
        recipient_ids: ["u-2"],
      }).audience,
    ).toBe("restricted");
    expect(() =>
      createSecretInputSchema.parse({
        name: "Bad",
        key: "TOKEN",
        value: "secret",
        audience: "restricted",
      }),
    ).toThrow(/recipient/);
  });

  it("keeps plaintext out of ordinary metadata", () => {
    const shape = secretRowSchema.keyof().options;
    expect(shape).not.toContain("value");
    expect(JSON.stringify(secretRowSchema._def)).not.toContain("secret value");
  });

  it("accepts skill and direct preflights but rejects an empty operation", () => {
    const operation_id = "4c322a19-e5e1-4c30-8be1-83251eb43b1f";
    expect(secretRetrievalPreflightInputSchema.parse({ operation_id, skills: [{ slug: "linear" }] }).skills).toHaveLength(1);
    expect(() => secretRetrievalPreflightInputSchema.parse({ operation_id })).toThrow(/at least one/);
  });

  it("limits plaintext to the dedicated redemption contract", () => {
    const parsed = redeemedSecretGrantSchema.parse({
      operation_id: "4c322a19-e5e1-4c30-8be1-83251eb43b1f",
      items: [
        {
          projection_id: "9a624988-833f-481a-b6b5-4a2407ec8881",
          skill: "linear",
          skill_version: "1.0.0",
          slot_id: "df80d275-30c9-5f0d-9a46-d77e6fca8448",
          env_key: "LINEAR_API_KEY",
          secret_id: "a57b0803-6afb-47d0-a307-e8fb80c56511",
          secret_version: 1,
          value: "plaintext",
        },
      ],
      tombstones: [],
    });
    expect(parsed.items[0]?.value).toBe("plaintext");
  });
});
