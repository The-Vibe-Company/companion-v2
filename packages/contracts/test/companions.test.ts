import { describe, expect, it } from "vitest";
import {
  createCompanionInputSchema,
  saveCompanionProviderInputSchema,
  startCompanionRuntimeInputSchema,
} from "../src/companions";

describe("Companion provider contracts", () => {
  it("requires a single-line API key and accepts Pi OAuth subscription entries", () => {
    expect(saveCompanionProviderInputSchema.parse({
      auth_method: "api_key",
      credential: "sk-test",
    })).toEqual({ auth_method: "api_key", credential: "sk-test" });
    expect(saveCompanionProviderInputSchema.parse({
      auth_method: "subscription",
      credential: { type: "oauth", access: "token", refresh: "refresh", expires: 123 },
    })).toMatchObject({ auth_method: "subscription" });
    expect(() => saveCompanionProviderInputSchema.parse({
      auth_method: "api_key",
      credential: "line-one\nline-two",
    })).toThrow();
    expect(() => saveCompanionProviderInputSchema.parse({
      auth_method: "subscription",
      credential: { type: "api_key", key: "wrong shape" },
    })).toThrow();
  });

  it("selects a provider at creation and rejects direct start credentials", () => {
    expect(createCompanionInputSchema.parse({
      name: "Research",
      provider_id: "anthropic",
    })).toMatchObject({ provider_id: "anthropic" });
    expect(() => startCompanionRuntimeInputSchema.parse({
      credentials: [{ value: "must-not-enter-start" }],
    })).toThrow();
  });
});
