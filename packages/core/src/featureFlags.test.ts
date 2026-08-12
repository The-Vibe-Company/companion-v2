import { describe, expect, it } from "vitest";
import { COMPANIONS_FEATURE_FLAG, companionsEnabled } from "./featureFlags";

describe("companionsEnabled", () => {
  it("fails closed when the flag is absent or disabled", () => {
    expect(companionsEnabled({})).toBe(false);
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: "false" })).toBe(false);
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: "1" })).toBe(false);
  });

  it("accepts an explicit true value", () => {
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: "true" })).toBe(true);
    expect(companionsEnabled({ [COMPANIONS_FEATURE_FLAG]: " TRUE " })).toBe(true);
  });
});
