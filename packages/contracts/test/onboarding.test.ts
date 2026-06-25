import { describe, expect, it } from "vitest";
import { completeOnboardingInputSchema, onboardingContextSchema, TEAM_BRAND_COLORS } from "@companion/contracts";

const baseInput = {
  org: {
    name: "Acme",
    domain: "acme.test",
    autoJoin: false,
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
  });

  it("accepts org palette colors without a team payload", () => {
    const color = TEAM_BRAND_COLORS[0]!;
    expect(
      completeOnboardingInputSchema.parse({
        ...baseInput,
        org: { ...baseInput.org, color },
      }),
    ).toMatchObject({
      org: { color },
      invites: [],
    });
  });
});

describe("onboardingContextSchema", () => {
  it("accepts multiple matched organizations", () => {
    expect(
      onboardingContextSchema.parse({
        email: "owner@acme.test",
        domain: "acme.test",
        is_personal: false,
        matched_orgs: [
          { id: "org_1", name: "Client A", domain: "acme.test", member_count: 2 },
          { id: "org_2", name: "Client B", domain: "acme.test", member_count: 4 },
        ],
      }),
    ).toMatchObject({ matched_orgs: [{ id: "org_1" }, { id: "org_2" }] });
  });
});
