import { describe, expect, it } from "vitest";
import {
  COMPANION_MANIFEST_SCHEMA_URL,
  companionDependencySlugs,
  companionEnvironmentToRequirements,
  companionManifestJson,
  companionManifestSchema,
  fallbackCompanionManifest,
} from "../src/companionManifest";

describe("companionManifestSchema", () => {
  it("parses manifest v2 fields", () => {
    const parsed = companionManifestSchema.parse({
      $schema: COMPANION_MANIFEST_SCHEMA_URL,
      name: "incident-summary",
      version: "1.2.0",
      title: "Incident summary",
      description: "Generate clean incident handoffs from raw notes.",
      notes: "## Notes\n\nMarkdown notes.",
      metadata: {
        companionSkillId: "84d8bee1-5ad3-4676-8c16-730e2a15ba70",
        changelog: [{ version: "1.2.0", date: "2026-06-24", changes: ["Ship manifest v2."] }],
      },
      environment: {
        env: { OPENAI_BASE_URL: { required: false, description: "Optional gateway." } },
        secrets: { OPENAI_API_KEY: { required: true, description: "Ask an admin." } },
      },
      dependencies: { "markdown-report": "84d8bee1-5ad3-4676-8c16-730e2a15ba70" },
      commands: [{ name: "Publish", desc: "Publish safely." }],
      checks: { updates: { runtime: "python", script: "scripts/check_updates.py", timeoutSeconds: 30 } },
    });

    expect(parsed.name).toBe("incident-summary");
    expect(parsed.version).toBe("1.2.0");
    expect(parsed.metadata.companionSkillId).toBe("84d8bee1-5ad3-4676-8c16-730e2a15ba70");
    expect(companionDependencySlugs(parsed)).toEqual(["markdown-report"]);
    expect(companionEnvironmentToRequirements(parsed.environment).map((r) => r.key)).toEqual([
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
    ]);
    expect(parsed.display.summary).toBe("Generate clean incident handoffs from raw notes.");
    expect(companionManifestJson(parsed)).toMatchObject({
      checks: { updates: { runtime: "python", script: "scripts/check_updates.py", timeoutSeconds: 30 } },
    });
  });

  it("accepts legacy display, requirements, and dependency arrays for migration", () => {
    const parsed = companionManifestSchema.parse({
      display: {
        name: "Incident summary",
        summary: "Generate clean incident handoffs from raw notes.",
        description: "Longer human-readable description shown in Companion.",
      },
      requirements: [{ key: "OPENAI_API_KEY", type: "secret", required: true, note: "Ask an admin." }],
      dependencies: ["markdown-report", { slug: "log-parser" }, "markdown-report"],
    });

    expect(parsed.title).toBe("Incident summary");
    expect(parsed.requirements).toEqual([{ key: "OPENAI_API_KEY", type: "secret", required: true, note: "Ask an admin." }]);
    expect(parsed.dependencies).toEqual({});
    expect(parsed.legacyDependencySlugs).toEqual(["log-parser", "markdown-report"]);
    expect(companionDependencySlugs(parsed)).toEqual(["log-parser", "markdown-report"]);
  });

  it("rejects duplicate legacy requirement keys and invalid dependency names", () => {
    expect(() =>
      companionManifestSchema.parse({
        requirements: [{ key: "DUP" }, { key: "DUP" }],
      }),
    ).toThrow(/duplicate requirement key/);

    expect(() => companionManifestSchema.parse({ dependencies: ["Not A Slug"] })).toThrow(/dependency slug/);
    expect(() => companionManifestSchema.parse({ dependencies: { "markdown-report": "" } })).toThrow(/UUID/);
    expect(() =>
      companionManifestSchema.parse({
        dependencies: Object.fromEntries(
          Array.from({ length: 65 }, (_, i) => [`dep-${i}`, "84d8bee1-5ad3-4676-8c16-730e2a15ba70"]),
        ),
      }),
    ).toThrow(/64 dependencies/);
  });

  it("rejects unsafe local update check declarations", () => {
    expect(() =>
      companionManifestSchema.parse({
        checks: { updates: { runtime: "node", script: "scripts/check_updates.py" } },
      }),
    ).toThrow();
    expect(() =>
      companionManifestSchema.parse({
        checks: { updates: { runtime: "python", script: "/tmp/check.py" } },
      }),
    ).toThrow(/relative/);
    expect(() =>
      companionManifestSchema.parse({
        checks: { updates: { runtime: "python", script: "../check.py" } },
      }),
    ).toThrow(/dot-dot/);
    expect(() =>
      companionManifestSchema.parse({
        checks: { updates: { runtime: "python", script: "scripts\\check.py" } },
      }),
    ).toThrow(/forward slashes/);
  });

  it("rejects secret values and missing changelog for v2 versions", () => {
    expect(() =>
      companionManifestSchema.parse({
        $schema: COMPANION_MANIFEST_SCHEMA_URL,
        name: "bad",
        version: "1.0.0",
        description: "Bad manifest.",
        metadata: { changelog: [] },
      }),
    ).toThrow(/changelog/);

    expect(() =>
      companionManifestSchema.parse({
        environment: {
          env: {},
          secrets: {
            API_KEY: { required: true, description: "Never store values.", value: "secret" },
          },
        },
      }),
    ).toThrow(/must not include values/);
  });

  it("builds a fallback manifest from SKILL.md data", () => {
    const manifest = fallbackCompanionManifest({
      summary: "Fallback summary.",
      requirements: [{ key: "SOME_TOKEN", type: "secret", required: true, note: "" }],
    });

    expect(manifest.description).toBe("Fallback summary.");
    expect(manifest.requirements.map((r) => r.key)).toEqual(["SOME_TOKEN"]);
    expect(manifest.dependencies).toEqual({});
  });
});
