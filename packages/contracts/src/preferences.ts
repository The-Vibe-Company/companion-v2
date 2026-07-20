import { z } from "zod";
import { validationStateSchema } from "./scope";
import { labelPathSchema } from "./labels";

/**
 * The active skill filters a member has applied. Skills are flat and org-wide, so the only axes are
 * validation status, dependency relationships, and the library label folders (a specific
 * label path, or the "no label" pseudo-filter).
 */
export const skillFilterTypeSchema = z.enum(["status", "deps", "label", "nolabel"]);
export type SkillFilterType = z.infer<typeof skillFilterTypeSchema>;

export const depsFilterSchema = z.enum(["has", "used"]);
export type DepsFilter = z.infer<typeof depsFilterSchema>;

export const skillFilterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), value: validationStateSchema }),
  // "has" = declares dependencies; "used" = depended on by another skill.
  z.object({ type: z.literal("deps"), value: depsFilterSchema }),
  // Filed under a specific label path (or any descendant of it).
  z.object({ type: z.literal("label"), value: labelPathSchema }),
  // Filed under no label at all.
  z.object({ type: z.literal("nolabel"), value: z.literal("true") }),
]);
export type SkillFilter = z.infer<typeof skillFilterSchema>;

export const skillFilterPreferencesSchema = z.object({
  active_filters: z.array(skillFilterSchema).max(20).default([]),
});
export type SkillFilterPreferences = z.infer<typeof skillFilterPreferencesSchema>;
