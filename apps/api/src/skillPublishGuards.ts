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

/** The six org folder roots every new skill must live under. */
export const SKILL_FOLDER_ROOTS = ["dev", "marketing", "admin", "clients", "project", "tools"] as const;

const SLUG_KEBAB_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * House naming + filing convention, enforced only when a BRAND-NEW org skill is published. Existing
 * skills (updates) are grandfathered — the caller skips this guard when a skill already owns the slug,
 * so their non-conforming slugs keep working and their re-publishes are never blocked.
 *
 * Two invariants keep the org catalogue navigable as it grows:
 *  - the slug is kebab-case, 2 to 4 blocks, and its LAST block is one of the six folder roots, so you
 *    can read any slug and know where it lives (`generate-image-marketing`, `review-code-dev`);
 *  - the skill is filed under at least one org folder whose root equals that same root — the "no
 *    orphan" rule: a skill can never exist without a folder, and the slug can never disagree with it.
 *
 * We deliberately do NOT try to verify the first block is an English action verb here: a server-side
 * verb list would false-reject legitimate verbs. That semantic part of the convention lives in the
 * `triage-skill-tools` skill, which is also the actionable fix pointed at by every error below.
 */
export function assertSkillNamingConvention(input: { slug: string; labels: string[] }): void {
  const { slug, labels } = input;
  const fix = "run the triage-skill-tools skill to file and rename it before publishing";
  const fail = (why: string) => new Error(`${why} — ${fix}.`);

  if (!SLUG_KEBAB_RE.test(slug)) {
    throw fail(`skill slug "${slug}" must be kebab-case (lowercase letters, digits, single hyphens)`);
  }
  const blocks = slug.split("-");
  if (blocks.length < 2 || blocks.length > 4) {
    throw fail(`skill slug "${slug}" must be 2 to 4 blocks in the form [verb]-[object]-[root]`);
  }
  const roots = SKILL_FOLDER_ROOTS as readonly string[];
  const slugRoot = blocks[blocks.length - 1] ?? "";
  if (!roots.includes(slugRoot)) {
    throw fail(
      `skill slug "${slug}" must end with a folder root (${SKILL_FOLDER_ROOTS.join(", ")}); its last block is "${slugRoot}"`,
    );
  }
  const labelRoots = labels.map((label) => label.split("/")[0] ?? "").filter((root) => roots.includes(root));
  if (labelRoots.length === 0) {
    throw fail(
      `skill "${slug}" must be filed under a folder rooted at one of ${SKILL_FOLDER_ROOTS.join(", ")}; none was provided`,
    );
  }
  if (!labelRoots.includes(slugRoot)) {
    throw fail(
      `skill "${slug}" ends with root "${slugRoot}" but is filed under [${labelRoots.join(", ")}]; the slug's root must match its folder`,
    );
  }
}
