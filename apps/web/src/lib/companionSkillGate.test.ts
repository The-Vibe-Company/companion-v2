import { describe, expect, it } from "vitest";
import type { LocalSkillRow } from "@companion/contracts";
import { requiresCompanionSkillInstall } from "./companionSkillGate";

function localSkill(status: LocalSkillRow["status"]): LocalSkillRow {
  return {
    workspaceId: "org_1",
    key: "companion",
    name: "Companion",
    description: "Manage skills locally.",
    status,
    installedVersion: status === "none" ? null : "1.0.0",
    availableVersion: "1.0.0",
    lastReportedAt: status === "none" ? null : "2026-06-25T00:00:00.000Z",
    agentLabel: null,
    notes: "",
    commands: [],
    changes: [],
    integrity: { packageChecksum: `sha256:${"a".repeat(64)}`, files: { "SKILL.md": `sha256:${"b".repeat(64)}` } },
    prompts: { install: "", update: "", use: "" },
  };
}

describe("requiresCompanionSkillInstall", () => {
  it("blocks when the required Companion local skill is absent or not installed", () => {
    expect(requiresCompanionSkillInstall(null)).toBe(true);
    expect(requiresCompanionSkillInstall([])).toBe(true);
    expect(requiresCompanionSkillInstall([localSkill("none")])).toBe(true);
  });

  it("allows the app when the skill is installed or only needs an update", () => {
    expect(requiresCompanionSkillInstall([localSkill("installed")])).toBe(false);
    expect(requiresCompanionSkillInstall([localSkill("update")])).toBe(false);
  });
});
