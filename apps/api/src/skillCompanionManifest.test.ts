import { describe, expect, it } from "vitest";
import { fallbackCompanionManifest } from "@companion/contracts";
import { buildInlineCompanionManifest, uploadDependencyValues } from "./skillCompanionManifest";

describe("uploadDependencyValues", () => {
  it("uses companion.json dependencies when a package manifest is present", () => {
    const manifest = fallbackCompanionManifest({
      summary: "Manifest summary.",
      dependencies: ["manifest-dep"],
    });

    expect(
      uploadDependencyValues({
        queryDependencies: ["query-dep"],
        companionManifestPath: "companion.json",
        companionManifest: manifest,
      }),
    ).toEqual(["manifest-dep"]);
  });

  it("keeps dependency query params as a legacy fallback when no manifest exists", () => {
    expect(
      uploadDependencyValues({
        queryDependencies: ["query-dep"],
        companionManifestPath: null,
      }),
    ).toEqual(["query-dep"]);
  });
});

describe("buildInlineCompanionManifest", () => {
  it("preserves rich display description, requirements, and dependencies for inline edits", () => {
    const manifest = buildInlineCompanionManifest({
      description: "Updated short summary.",
      carriedDisplay: {
        name: "Human name",
        summary: "Old summary.",
        description: "Long detail copy.",
      },
      carriedRequirements: [{ key: "OPENAI_API_KEY", type: "secret", required: true, note: "Ask an admin." }],
      carriedDependencies: ["markdown-report"],
    });

    expect(manifest.display).toEqual({
      name: "Human name",
      summary: "Updated short summary.",
      description: "Long detail copy.",
    });
    expect(manifest.requirements.map((req) => req.key)).toEqual(["OPENAI_API_KEY"]);
    expect(manifest.dependencies).toEqual({});
    expect(manifest.legacyDependencySlugs).toEqual(["markdown-report"]);
  });

  it("updates display description when the carried description was only the old summary", () => {
    const manifest = buildInlineCompanionManifest({
      description: "Updated short summary.",
      carriedDisplay: {
        name: "Human name",
        summary: "Old summary.",
        description: "Old summary.",
      },
      carriedRequirements: [],
      carriedDependencies: [],
    });

    expect(manifest.display).toEqual({
      name: "Human name",
      summary: "Updated short summary.",
      description: "Updated short summary.",
    });
  });
});
