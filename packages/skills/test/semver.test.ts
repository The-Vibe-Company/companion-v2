import { describe, expect, it } from "vitest";
import { bumpSemver, compareSemver, gtSemver, isValidSemver, resolvePin } from "../src/semver";

describe("semver", () => {
  it("validates", () => {
    expect(isValidSemver("1.0.0")).toBe(true);
    expect(isValidSemver("2.3.1-rc.1")).toBe(true);
    expect(isValidSemver("1.2")).toBe(false);
    expect(isValidSemver("v1.0.0")).toBe(false);
  });

  it("compares", () => {
    expect(compareSemver("1.0.0", "1.0.1")).toBe(-1);
    expect(compareSemver("2.0.0", "1.9.9")).toBe(1);
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(gtSemver("1.4.0", "1.3.9")).toBe(true);
  });

  it("bumps", () => {
    expect(bumpSemver("1.2.3", "patch")).toBe("1.2.4");
    expect(bumpSemver("1.2.3", "minor")).toBe("1.3.0");
    expect(bumpSemver("1.2.3", "major")).toBe("2.0.0");
  });

  it("resolves pins", () => {
    const versions = ["1.0.0", "1.4.0", "1.5.0", "2.0.0"];
    expect(resolvePin(null, versions)).toBe("2.0.0");
    expect(resolvePin("1.4.0", versions)).toBe("1.4.0");
    expect(resolvePin("^1.4.0", versions)).toBe("1.5.0");
    expect(resolvePin("~1.4.0", versions)).toBe("1.4.0");
    expect(resolvePin("^9.0.0", versions)).toBe(null);
  });
});
