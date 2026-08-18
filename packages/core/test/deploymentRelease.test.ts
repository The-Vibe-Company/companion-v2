import { describe, expect, it } from "vitest";

import { deploymentReleaseId } from "../src/deploymentRelease";

describe("deployment release identity", () => {
  it("returns a stable public identifier only for the bounded deployment format", () => {
    expect(deploymentReleaseId({ COMPANION_RELEASE_ID: " production-2026-08-17.3 " }))
      .toBe("production-2026-08-17.3");
    expect(deploymentReleaseId({})).toBe("unknown");
    expect(deploymentReleaseId({ COMPANION_RELEASE_ID: "https://release.example/secret?q=1" }))
      .toBe("unknown");
  });
});
