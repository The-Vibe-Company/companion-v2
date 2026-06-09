import { z } from "zod";

/** Skill id / name: kebab-case (lowercase, digits, single hyphens). */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Strict semantic version (semver.org). */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/**
 * The required + optional fields of a `SKILL.md` YAML frontmatter block.
 * Parsing is data-only — no archive scripts are ever executed.
 */
const skillFrontmatterFields = z.object({
  name: z
    .string()
    .regex(SKILL_NAME_RE, "name must be kebab-case (lowercase letters, digits, hyphens)"),
  version: z.string().regex(SEMVER_RE, "version must be a valid semantic version"),
  description: z.string().min(1, "description is required").max(1024),
  license: z.string().min(1).optional(),
  tools: z.array(z.string()).default([]),
}).passthrough().superRefine((obj, ctx) => {
  if ("scope" in obj || "visibility" in obj) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "skill frontmatter must not declare visibility; use upload visibility instead",
    });
  }
}).transform(({ name, version, description, license, tools }) => ({
  name,
  version,
  description,
  tools,
  ...(license ? { license } : {}),
}));

/**
 * Companion's native field is `tools` (a YAML list). The Claude skill format declares the same
 * thing under `allowed-tools` (a YAML list, or a comma-separated string), so accept it as an alias
 * when `tools` is absent — normalized to an array before validation. Unknown keys (`argument-hint`,
 * `user-invocable`, …) are dropped by the object schema.
 */
export const skillFrontmatterSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const obj = value as Record<string, unknown>;
  if (obj.tools === undefined && obj["allowed-tools"] !== undefined) {
    const aliased = obj["allowed-tools"];
    const tools =
      typeof aliased === "string"
        ? aliased.split(",").map((t) => t.trim()).filter(Boolean)
        : aliased;
    return { ...obj, tools };
  }
  return value;
}, skillFrontmatterFields);
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;
