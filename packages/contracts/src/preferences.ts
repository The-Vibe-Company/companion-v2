import { z } from "zod";
import { validationStateSchema } from "./scope";
import { labelPathSchema } from "./labels";

/**
 * The active skill filters and list grouping a member has applied. Filter axes are validation
 * status, dependency relationships, and the library label folders (a specific label path, or the
 * "no label" pseudo-filter). Grouping is an independent presentation preference.
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

export const skillGroupBySchema = z.enum(["folder", "none"]);
export type SkillGroupBy = z.infer<typeof skillGroupBySchema>;

export const skillSidebarOrderSchema = z.object({
  mine: z.array(labelPathSchema).default([]),
  org: z.array(labelPathSchema).default([]),
});
export type SkillSidebarOrder = z.infer<typeof skillSidebarOrderSchema>;

export const skillFilterPreferencesSchema = z.object({
  active_filters: z.array(skillFilterSchema).max(20).default([]),
  group_by: skillGroupBySchema.default("folder"),
  sidebar_order: skillSidebarOrderSchema.default({ mine: [], org: [] }),
});
export type SkillFilterPreferences = z.infer<typeof skillFilterPreferencesSchema>;

/** PUT input keeps the new axis optional so a tab loaded before deployment cannot erase it. */
export const skillFilterPreferencesInputSchema = skillFilterPreferencesSchema.extend({
  sidebar_order: skillSidebarOrderSchema.optional(),
});
export type SkillFilterPreferencesInput = z.infer<typeof skillFilterPreferencesInputSchema>;
