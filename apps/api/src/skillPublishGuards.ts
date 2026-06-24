import type { SkillFrontmatter } from "@companion/contracts";

export type SkillPublishAction = "publish" | "validate";

export interface ExpectedSkill {
  id: string;
  slug: string;
}

export function parseSkillPublishAction(value: string | undefined): SkillPublishAction {
  if (value == null || value === "" || value === "publish") return "publish";
  if (value === "validate") return "validate";
  throw new Error(`unsupported skill publish action: ${value}`);
}

export function assertTargetedSkillUpdate(input: {
  frontmatter: SkillFrontmatter;
  companionSkillId?: string;
  expectSlug?: string;
  expectSkillId?: string;
  expectedSkill?: ExpectedSkill | null;
}): void {
  const { frontmatter, companionSkillId, expectSlug, expectSkillId, expectedSkill } = input;

  if (expectSlug && frontmatter.name !== expectSlug) {
    throw new Error(`package name "${frontmatter.name}" does not match the skill you are updating ("${expectSlug}")`);
  }

  if (!expectSkillId) return;

  const targetSlug = expectSlug ?? frontmatter.name;
  if (!expectedSkill) {
    throw new Error(`skill "${targetSlug}" was not found for targeted update`);
  }
  if (expectedSkill.id !== expectSkillId) {
    throw new Error(`target skill id does not match the skill you are updating ("${expectSkillId}")`);
  }

  const metadataSkillId = companionSkillId ?? frontmatter.metadata.companion_skill_id;
  if (metadataSkillId && metadataSkillId !== expectSkillId) {
    throw new Error(
      `package Companion skill id "${metadataSkillId}" does not match the skill you are updating ("${expectSkillId}")`,
    );
  }
}
