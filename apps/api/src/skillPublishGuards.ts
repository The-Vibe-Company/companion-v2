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

/**
 * Authoritative anti-retarget guard, run on EVERY publish/validate (it does not depend on the caller
 * sending `expect_*`). The package's declared Companion skill id (`companion.json metadata.companionSkillId`,
 * which is the `skills.id`) is the stable identity. A buggy or malicious agent must not be able to
 * re-point an existing skill by publishing under a different slug.
 *
 * - `slugSkill` is the skill currently owning `frontmatter.name` (null on a fresh create).
 * - `companionIdSkill` is the skill the declared id resolves to, org-scoped (null when none).
 */
export function assertNoCompanionRetarget(input: {
  frontmatter: SkillFrontmatter;
  companionSkillId?: string;
  lookup: { slugSkill?: ExpectedSkill | null; companionIdSkill?: ExpectedSkill | null };
}): void {
  const { frontmatter, companionSkillId, lookup } = input;
  const declaredId = companionSkillId ?? frontmatter.metadata.companion_skill_id;
  if (!declaredId) return; // identity-less old packages: nothing to retarget.

  // (i) the declared id belongs to an existing skill whose slug is not this package's name.
  if (lookup.companionIdSkill && lookup.companionIdSkill.slug !== frontmatter.name) {
    throw new Error(
      `package Companion skill id "${declaredId}" belongs to skill "${lookup.companionIdSkill.slug}", not "${frontmatter.name}"; refusing to retarget`,
    );
  }

  // (ii) a skill already exists for this slug (an update) but the package declares a different id.
  if (lookup.slugSkill && lookup.slugSkill.id !== declaredId) {
    throw new Error(
      `skill "${frontmatter.name}" has id "${lookup.slugSkill.id}", but the package declares Companion skill id "${declaredId}"; refusing to retarget`,
    );
  }
}

/**
 * Strict update gate: when a publish targets an existing slug (i.e. it is an update, not a create), the
 * caller must declare its intent with both `expect_slug` and `expect_skill_id`. Fresh creates
 * (`slugSkill` null) are exempt.
 */
export function assertUpdateIsTargeted(input: {
  frontmatter: SkillFrontmatter;
  slugSkill?: ExpectedSkill | null;
  expectSlug?: string;
  expectSkillId?: string;
}): void {
  const { frontmatter, slugSkill, expectSlug, expectSkillId } = input;
  if (!slugSkill) return; // fresh create — nothing to target.
  if (!expectSlug || !expectSkillId) {
    throw new Error(
      `updating skill "${frontmatter.name}" requires expect_slug and expect_skill_id`,
    );
  }
}
