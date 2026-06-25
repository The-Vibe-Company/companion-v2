import { describe, expect, it } from "vitest";
import { localSkillRowSchema } from "../src/localSkills";

describe("localSkillRowSchema", () => {
  it("requires official integrity metadata for bootstrap checks", () => {
    const parsed = localSkillRowSchema.parse({
      workspaceId: "org-1",
      key: "companion",
      name: "Companion",
      description: "Manage skills locally.",
      status: "installed",
      installedVersion: "1.13.0",
      availableVersion: "1.13.0",
      lastReportedAt: "2026-06-25T00:00:00.000Z",
      agentLabel: "Codex",
      notes: "Local helper.",
      commands: [{ name: "Bootstrap health check", desc: "Gather context." }],
      changes: [],
      integrity: {
        packageChecksum: `sha256:${"a".repeat(64)}`,
        files: {
          "SKILL.md": `sha256:${"b".repeat(64)}`,
          "scripts/bootstrap.py": `sha256:${"c".repeat(64)}`,
        },
      },
      prompts: { install: "install", update: "update", use: "use" },
    });

    expect(parsed.integrity.packageChecksum).toMatch(/^sha256:/);
    expect(parsed.integrity.files["scripts/bootstrap.py"]).toMatch(/^sha256:/);
  });

  it("rejects unsafe integrity file paths", () => {
    expect(() =>
      localSkillRowSchema.parse({
        workspaceId: "org-1",
        key: "companion",
        name: "Companion",
        description: "Manage skills locally.",
        status: "installed",
        installedVersion: "1.13.0",
        availableVersion: "1.13.0",
        lastReportedAt: "2026-06-25T00:00:00.000Z",
        agentLabel: null,
        notes: "Local helper.",
        commands: [],
        changes: [],
        integrity: {
          packageChecksum: `sha256:${"a".repeat(64)}`,
          files: {
            "../SKILL.md": `sha256:${"b".repeat(64)}`,
          },
        },
        prompts: { install: "install", update: "update", use: "use" },
      }),
    ).toThrow();
  });
});
