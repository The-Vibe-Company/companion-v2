import { describe, expect, it } from "vitest";
import { companionManifestJson, fallbackCompanionManifest } from "@companion/contracts";
import { buildInlineCompanionManifest, uploadDependencyValues, withResolvedManifestDependencies } from "./skillCompanionManifest";

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

describe("withResolvedManifestDependencies", () => {
  it("replaces only dependencies and preserves complete manifest v2 fields", () => {
    const manifest = fallbackCompanionManifest({
      summary: "Uploaded manifest description.",
      display: {
        name: "Manifest v2",
        summary: "Uploaded manifest description.",
        description: "## Notes\n\nKeep this package complete.",
      },
      name: "manifest-v2",
      version: "1.2.0",
      companionSkillId: "84d8bee1-5ad3-4676-8c16-730e2a15ba70",
      changelog: [
        { version: "1.2.0", date: "2026-06-24", changes: ["Publish version 1.2.0."] },
        { version: "1.1.0", date: "2026-06-20", changes: ["Add manifest v2 metadata."] },
      ],
      environment: {
        env: { OPENAI_BASE_URL: { required: false, description: "Optional gateway." } },
        secrets: { OPENAI_API_KEY: { required: true, description: "Ask an admin." } },
      },
      dependencies: { "old-dep": "3e16ce8a-0d5f-4b2e-9db3-ae30d05e4bf8" },
      commands: [{ name: "Review package", desc: "Inspect and publish the package safely." }],
      checks: { updates: { runtime: "python", script: "scripts/check_updates.py", timeoutSeconds: 30 } },
      notes: "## Notes\n\nKeep this package complete.",
    });

    const updated = withResolvedManifestDependencies(manifest, {
      "markdown-report": "c0e39fb6-fb84-4610-92e7-fcfc1dc09dde",
    });
    const json = companionManifestJson(updated);

    expect(json).toMatchObject({
      name: "manifest-v2",
      version: "1.2.0",
      title: "Manifest v2",
      description: "Uploaded manifest description.",
      notes: "## Notes\n\nKeep this package complete.",
      metadata: {
        companionSkillId: "84d8bee1-5ad3-4676-8c16-730e2a15ba70",
        changelog: [
          { version: "1.2.0", date: "2026-06-24", changes: ["Publish version 1.2.0."] },
          { version: "1.1.0", date: "2026-06-20", changes: ["Add manifest v2 metadata."] },
        ],
      },
      environment: {
        env: { OPENAI_BASE_URL: { required: false, description: "Optional gateway." } },
        secrets: { OPENAI_API_KEY: { required: true, description: "Ask an admin." } },
      },
      dependencies: { "markdown-report": "c0e39fb6-fb84-4610-92e7-fcfc1dc09dde" },
      commands: [{ name: "Review package", desc: "Inspect and publish the package safely." }],
      checks: { updates: { runtime: "python", script: "scripts/check_updates.py", timeoutSeconds: 30 } },
    });
    expect(json).not.toHaveProperty("display");
    expect(json).not.toHaveProperty("requirements");
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
      carriedRequirements: [{ key: "OPENAI_API_KEY", type: "secret", slot_id: "c8868fb3-c654-5615-b477-ce8d807ab722", required: true, note: "Ask an admin." }],
      carriedDependencies: ["markdown-report"],
    });

    expect(manifest.display).toEqual({
      name: "Human name",
      summary: "Updated short summary.",
      description: undefined,
    });
    expect(manifest.notes).toBe("Long detail copy.");
    expect(manifest.requirements.map((req) => req.key)).toEqual(["OPENAI_API_KEY"]);
    expect(manifest.environment.secrets.OPENAI_API_KEY?.slotId).toBe("c8868fb3-c654-5615-b477-ce8d807ab722");
    expect(manifest.dependencies).toEqual({});
    expect(manifest.legacyDependencySlugs).toEqual(["markdown-report"]);
  });

  it("does not synthesize notes when the carried description was only the old summary", () => {
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
      description: undefined,
    });
    expect(manifest.notes).toBeUndefined();
  });

  it("preserves carried Manifest V2 notes for inline edits", () => {
    const manifest = buildInlineCompanionManifest({
      description: "Updated short summary.",
      carriedDisplay: {
        name: "Human name",
        summary: "Old summary.",
      },
      carriedNotes: "## Notes\n\nKeep the setup detail.",
      carriedRequirements: [],
      carriedDependencies: [],
    });

    expect(manifest.display).toEqual({
      name: "Human name",
      summary: "Updated short summary.",
      description: undefined,
    });
    expect(manifest.notes).toBe("## Notes\n\nKeep the setup detail.");
  });
});
