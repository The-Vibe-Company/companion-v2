import { describe, expect, it } from "vitest";
import { companionManifestSchema, fallbackCompanionManifest } from "../src/companionManifest";

describe("companionManifestSchema", () => {
  it("parses display, requirements, and dependencies", () => {
    const parsed = companionManifestSchema.parse({
      display: {
        name: "Incident summary",
        summary: "Generate clean incident handoffs from raw notes.",
        description: "Longer human-readable description shown in Companion.",
      },
      requirements: [{ key: "OPENAI_API_KEY", type: "secret", required: true, note: "Ask an admin." }],
      dependencies: ["markdown-report", { slug: "log-parser" }, "markdown-report"],
    });

    expect(parsed.display.name).toBe("Incident summary");
    expect(parsed.requirements).toEqual([{ key: "OPENAI_API_KEY", type: "secret", required: true, note: "Ask an admin." }]);
    expect(parsed.dependencies).toEqual(["log-parser", "markdown-report"]);
  });

  it("rejects duplicate requirement keys and invalid dependency slugs", () => {
    expect(() =>
      companionManifestSchema.parse({
        requirements: [{ key: "DUP" }, { key: "DUP" }],
      }),
    ).toThrow(/duplicate requirement key/);

    expect(() => companionManifestSchema.parse({ dependencies: ["Not A Slug"] })).toThrow(/dependency slug/);
  });

  it("rejects empty display strings and manifest arrays over the cap", () => {
    expect(() => companionManifestSchema.parse({ display: { name: "" } })).toThrow(/display name/);
    expect(() => companionManifestSchema.parse({ display: { summary: "" } })).toThrow(/display summary/);
    expect(() => companionManifestSchema.parse({ display: { description: "" } })).toThrow(/display description/);

    expect(() =>
      companionManifestSchema.parse({
        dependencies: Array.from({ length: 65 }, (_, i) => `dep-${i}`),
      }),
    ).toThrow(/64 dependencies/);
    expect(() =>
      companionManifestSchema.parse({
        requirements: Array.from({ length: 65 }, (_, i) => ({ key: `TOKEN_${i}` })),
      }),
    ).toThrow(/64 requirements/);
  });

  it("strips unknown manifest and nested fields", () => {
    const parsed = companionManifestSchema.parse({
      display: { name: "Name", summary: "Summary.", badge: "ignored" },
      dependencies: [{ slug: "markdown-report", version: "1.0.0" }],
      extra: true,
    });

    expect(parsed).toEqual({
      display: { name: "Name", summary: "Summary." },
      requirements: [],
      dependencies: ["markdown-report"],
    });
  });

  it("builds a fallback manifest from SKILL.md data", () => {
    const manifest = fallbackCompanionManifest({
      summary: "Fallback summary.",
      requirements: [{ key: "SOME_TOKEN", type: "secret", required: true, note: "" }],
    });

    expect(manifest.display.summary).toBe("Fallback summary.");
    expect(manifest.requirements.map((r) => r.key)).toEqual(["SOME_TOKEN"]);
    expect(manifest.dependencies).toEqual([]);
  });
});
