import { describe, expect, it } from "vitest";
import { completeOnboardingInputSchema, TEAM_BRAND_COLORS } from "@companion/contracts";

const baseInput = {
  org: {
    name: "Acme",
    domain: "acme.test",
    autoJoin: false,
  },
  team: {
    name: "Engineering",
  },
  invites: [],
};

describe("completeOnboardingInputSchema", () => {
  it("rejects arbitrary CSS colors", () => {
    expect(() =>
      completeOnboardingInputSchema.parse({
        ...baseInput,
        org: { ...baseInput.org, color: "url(https://evil.test/x.png)" },
      }),
    ).toThrow();
    expect(() =>
      completeOnboardingInputSchema.parse({
        ...baseInput,
        team: { ...baseInput.team, color: "url(https://evil.test/x.png)" },
      }),
    ).toThrow();
  });

  it("accepts team palette colors", () => {
    const color = TEAM_BRAND_COLORS[0]!;
    expect(
      completeOnboardingInputSchema.parse({
        ...baseInput,
        org: { ...baseInput.org, color },
        team: { ...baseInput.team, color },
      }),
    ).toMatchObject({
      org: { color },
      team: { color },
    });
  });
});
