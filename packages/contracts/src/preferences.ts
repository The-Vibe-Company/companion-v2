import { z } from "zod";
import { validationStateSchema, visibilityFilterSchema } from "./scope";

export const skillFilterTypeSchema = z.enum(["visibility", "status", "starred", "owner", "team"]);
export type SkillFilterType = z.infer<typeof skillFilterTypeSchema>;

export const skillFilterSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("visibility"), value: visibilityFilterSchema }),
  z.object({ type: z.literal("status"), value: validationStateSchema }),
  z.object({ type: z.literal("starred"), value: z.literal("true") }),
  z.object({ type: z.literal("owner"), value: z.string().min(1).max(256) }),
  z.object({ type: z.literal("team"), value: z.string().min(1).max(128) }),
]);
export type SkillFilter = z.infer<typeof skillFilterSchema>;

export const skillSavedViewSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.string().min(1).max(128),
  icon: z.string().min(1).max(64),
  filters: z.array(skillFilterSchema).max(20),
  custom: z.literal(true).optional(),
});
export type SkillSavedView = z.infer<typeof skillSavedViewSchema>;

export const skillFilterPreferencesSchema = z.object({
  active_filters: z.array(skillFilterSchema).max(20).default([]),
  custom_views: z.array(skillSavedViewSchema).max(50).default([]),
});
export type SkillFilterPreferences = z.infer<typeof skillFilterPreferencesSchema>;
