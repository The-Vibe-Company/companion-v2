import { describe, expect, it } from "vitest";

import { deploymentReleaseId } from "../src/deploymentRelease";

describe("deployment release identity", () => {
  it("prefers Railway's injected commit SHA over other platform aliases", () => {
    expect(deploymentReleaseId({
      RAILWAY_GIT_COMMIT_SHA: " fc2cca3d7b4d23fbd49c9a8c736676f33ce1f5c9 ",
      SOURCE_COMMIT: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      GITHUB_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })).toBe("fc2cca3d7b4d23fbd49c9a8c736676f33ce1f5c9");
  });

  it("falls back from SOURCE_COMMIT to GITHUB_SHA when Railway is absent", () => {
    expect(deploymentReleaseId({
      SOURCE_COMMIT: "ccccccccccccddddddddeeeeeeeeffffffffff00",
      GITHUB_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })).toBe("ccccccccccccddddddddeeeeeeeeffffffffff00");
    expect(deploymentReleaseId({
      GITHUB_SHA: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    })).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("ignores leftover COMPANION_RELEASE_ID even when it matches the old pin format", () => {
    expect(deploymentReleaseId({
      COMPANION_RELEASE_ID: "production-2026-08-17.3",
      RAILWAY_GIT_COMMIT_SHA: "fc2cca3d7b4d23fbd49c9a8c736676f33ce1f5c9",
    })).toBe("fc2cca3d7b4d23fbd49c9a8c736676f33ce1f5c9");
    expect(deploymentReleaseId({
      COMPANION_RELEASE_ID: "production-2026-08-17.3",
    })).toBe("local");
  });

  it("returns a clearly-local default when no platform commit identity is present", () => {
    expect(deploymentReleaseId({})).toBe("local");
    expect(deploymentReleaseId({
      RAILWAY_GIT_COMMIT_SHA: "https://release.example/secret?q=1",
      COMPANION_RELEASE_ID: "stale-pin",
    })).toBe("local");
  });
});
