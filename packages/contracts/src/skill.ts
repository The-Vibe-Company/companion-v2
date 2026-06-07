import { z } from "zod";
import { scopeSchema, validationStateSchema } from "./scope";

/**
 * One row of the `skill_list_v` view — the denormalized read shape the web table
 * and the CLI list both consume. Machine-facing snake_case (mirrors the DB).
 */
export const skillListRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  slug: z.string(),
  description: z.string(),
  scope: scopeSchema,
  team_id: z.string().nullable(),
  team_name: z.string().nullable(),
  team_slug: z.string().nullable(),
  validation: validationStateSchema,
  validation_error: z.string().nullable(),
  owner_id: z.string(),
  owner_name: z.string(),
  owner_handle: z.string().nullable(),
  owner_initials: z.string(),
  current_version: z.string().nullable(),
  license: z.string().nullable(),
  checksum: z.string().nullable(),
  size_bytes: z.number().nullable(),
  tools: z.array(z.string()),
  star_count: z.number().int().nonnegative(),
  starred: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type SkillListRow = z.infer<typeof skillListRowSchema>;

/** A comment on a skill (with the author's display fields joined in). */
export const skillCommentRowSchema = z.object({
  id: z.string(),
  skill_id: z.string(),
  author_id: z.string(),
  body: z.string(),
  created_at: z.string(),
  author_name: z.string().nullable().optional(),
  author_initials: z.string().nullable().optional(),
});
export type SkillCommentRow = z.infer<typeof skillCommentRowSchema>;

/** Immutable `skill_versions` row. */
export const skillVersionRowSchema = z.object({
  id: z.string(),
  skill_id: z.string(),
  version: z.string(),
  note: z.string(),
  frontmatter: z.string(),
  tools: z.array(z.string()),
  license: z.string().nullable(),
  size_bytes: z.number().int().nonnegative(),
  checksum: z.string(),
  storage_path: z.string(),
  validation: validationStateSchema,
  validation_error: z.string().nullable(),
  created_by: z.string(),
  created_at: z.string(),
});
export type SkillVersionRow = z.infer<typeof skillVersionRowSchema>;

/** Argument shape for the `publish_skill_version` RPC (web route + CLI share this). */
export const publishSkillInputSchema = z.object({
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  scope: scopeSchema,
  team_slug: z.string().nullable().optional(),
  version: z.string(),
  description: z.string(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  storage_path: z.string(),
  size_bytes: z.number().int().nonnegative(),
  frontmatter: z.string(),
  tools: z.array(z.string()),
  license: z.string().nullable().optional(),
  note: z.string().default(""),
});
export type PublishSkillInput = z.infer<typeof publishSkillInputSchema>;
