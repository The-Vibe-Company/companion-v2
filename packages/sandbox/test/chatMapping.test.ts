import { describe, expect, it } from "vitest";
import { skillFromToolInput, toolTitleAndSkill } from "../src/chatMapping";

describe("skillFromToolInput", () => {
  it("extracts the skill slug from a bash command that runs a skill script", () => {
    expect(skillFromToolInput('{"command":"python3 .claude/skills/email-digest/scripts/run.py"}')).toBe("email-digest");
  });

  it("extracts from a read/file path referencing a skill dir", () => {
    expect(skillFromToolInput('{"filePath":"/vercel/sandbox/.claude/skills/meeting-digest/SKILL.md"}')).toBe("meeting-digest");
  });

  it("returns null when no skill path is present", () => {
    expect(skillFromToolInput('{"command":"ls -la"}')).toBeNull();
    expect(skillFromToolInput("")).toBeNull();
    expect(skillFromToolInput(null)).toBeNull();
    expect(skillFromToolInput(undefined)).toBeNull();
  });

  it("ignores non-slug-shaped paths", () => {
    expect(skillFromToolInput('{"command":".claude/skills//run"}')).toBeNull();
  });
});

describe("toolTitleAndSkill", () => {
  it("returns the trimmed human title and resolved skill", () => {
    expect(
      toolTitleAndSkill({
        tool: "bash",
        title: "  Run digest  ",
        inputJson: '{"command":"python3 .claude/skills/email-digest/run.py"}',
      }),
    ).toEqual({ title: "Run digest", skill: "email-digest" });
  });

  it("nulls an empty/whitespace title and a skill-less input", () => {
    expect(toolTitleAndSkill({ tool: "read", title: "  ", inputJson: '{"filePath":"README.md"}' })).toEqual({
      title: null,
      skill: null,
    });
    expect(toolTitleAndSkill({ tool: "bash", title: null, inputJson: null })).toEqual({ title: null, skill: null });
  });
});
