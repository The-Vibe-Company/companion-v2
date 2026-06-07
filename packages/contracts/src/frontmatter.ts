import { z } from "zod";
import { scopeSchema } from "./scope";

/** Skill id / name: kebab-case (lowercase, digits, single hyphens). */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Strict semantic version (semver.org). */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * The required + optional fields of a `SKILL.md` YAML frontmatter block.
 * Parsing is data-only — no archive scripts are ever executed.
 */
export const skillFrontmatterSchema = z.object({
  name: z
    .string()
    .regex(SKILL_NAME_RE, "name must be kebab-case (lowercase letters, digits, hyphens)"),
  version: z.string().regex(SEMVER_RE, "version must be a valid semantic version"),
  description: z.string().min(1, "description is required").max(1024),
  license: z.string().min(1).optional(),
  tools: z.array(z.string()).default([]),
  scope: scopeSchema.optional(),
});
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
