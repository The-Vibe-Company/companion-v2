import { describe, expect, it } from "vitest";

import { COMPANION_PLUGIN_SKILLS } from "./companionPluginSkills";

describe("COMPANION_PLUGIN_SKILLS", () => {
  it("ships exactly the github and linear plugin skills with valid frontmatter", () => {
    expect(COMPANION_PLUGIN_SKILLS.map((skill) => skill.slug)).toEqual([
      "plugin-github",
      "plugin-linear",
    ]);
    for (const skill of COMPANION_PLUGIN_SKILLS) {
      expect(skill.content.startsWith("---\n")).toBe(true);
      expect(skill.content).toContain(`name: ${skill.slug.replace(/^plugin-/, "")}-plugin`);
      expect(skill.content).toContain(`description: "`);
      // A capability must never be described before this runtime stages it: every plugin skill
      // documents triggers through the shared on-demand registration rules.
      expect(skill.content).toContain("propose_trigger");
      expect(skill.content).toContain("registration");
      expect(skill.content).not.toContain("TODO");
    }
  });

  it("keeps github-specific guidance out of linear and vice versa", () => {
    const github = COMPANION_PLUGIN_SKILLS.find((skill) => skill.provider === "github")!;
    const linear = COMPANION_PLUGIN_SKILLS.find((skill) => skill.provider === "linear")!;
    expect(github.content).toContain("owner/repo");
    expect(github.content).toContain("git push");
    expect(linear.content).not.toContain("git push");
    expect(linear.content).toContain("Linear API key");
  });
});
