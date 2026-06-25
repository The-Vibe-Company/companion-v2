import { describe, expect, it } from "vitest";
import { COMPANION_MANIFEST_SCHEMA_URL } from "@companion/contracts";
import { skillVersionRowFromRecord } from "../src/services";

const createdAt = new Date("2026-06-25T10:00:00.000Z");

function versionRecord(version: string, frontmatter: string) {
  return {
    id: `version-${version}`,
    orgId: "00000000-0000-0000-0000-0000000000aa",
    skillId: "00000000-0000-0000-0000-0000000000bb",
    version,
    note: "Manual release note",
    frontmatter,
    body: "Use this skill for demos.",
    tools: [],
    license: "MIT",
    sizeBytes: 1234,
    checksum: "sha256:" + "a".repeat(64),
    storagePath: `archives/demo-skill/${version}.tar.gz`,
    validation: "valid" as const,
    validationError: null,
    createdBy: "user-1",
    createdAt,
  };
}

function storedFrontmatter() {
  return JSON.stringify({
    name: "demo-skill",
    description: "Demo skill.",
    metadata: {},
    companion: {
      $schema: COMPANION_MANIFEST_SCHEMA_URL,
      name: "demo-skill",
      version: "1.2.0",
      description: "Demo skill.",
      metadata: {
        changelog: [
          { version: "1.2.0", date: "2026-06-25", changes: ["Add Activity changelog.", "Keep notes as fallback."] },
          { version: "1.1.0", date: "2026-06-24", changes: ["Initial publish."] },
        ],
      },
      environment: { env: {}, secrets: {} },
      dependencies: {},
      commands: [],
    },
  });
}

describe("skillVersionRowFromRecord", () => {
  it("returns the Companion changelog entry matching the published version", () => {
    const row = skillVersionRowFromRecord(versionRecord("1.2.0", storedFrontmatter()), {
      description: "Demo skill.",
    });

    expect(row.changelog).toEqual({
      version: "1.2.0",
      date: "2026-06-25",
      changes: ["Add Activity changelog.", "Keep notes as fallback."],
    });
    expect(row.created_at).toBe("2026-06-25T10:00:00.000Z");
  });

  it("uses null when the stored manifest has no changelog entry for the version", () => {
    const row = skillVersionRowFromRecord(versionRecord("1.0.0", storedFrontmatter()), {
      description: "Demo skill.",
    });

    expect(row.changelog).toBeNull();
    expect(row.note).toBe("Manual release note");
  });
});
