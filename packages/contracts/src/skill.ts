import { z } from "zod";
import { validationStateSchema } from "./scope";
import { SKILL_NAME_RE } from "./frontmatter";

export const teamVisibilitySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
});
export type TeamVisibility = z.infer<typeof teamVisibilitySchema>;

export const skillVisibilitySchema = z.object({
  everyone: z.boolean(),
  teams: z.array(teamVisibilitySchema),
});
export type SkillVisibility = z.infer<typeof skillVisibilitySchema>;

export const skillVisibilityInputSchema = z.object({
  everyone: z.boolean().default(false),
  teams: z.array(z.string().min(1).max(128)).default([]),
});
export type SkillVisibilityInput = z.infer<typeof skillVisibilityInputSchema>;

export const skillOwnerKindSchema = z.enum(["user", "team"]);
export type SkillOwnerKind = z.infer<typeof skillOwnerKindSchema>;

export const skillOwnerTeamInputSchema = z.string().min(1).max(128).nullable().optional();

/**
 * One row of the `skill_list_v` view — the denormalized read shape the web table
 * and the CLI list both consume. Machine-facing snake_case (mirrors the DB).
 */
export const skillListRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  slug: z.string(),
  description: z.string(),
  visibility: skillVisibilitySchema,
  validation: validationStateSchema,
  validation_error: z.string().nullable(),
  owner_kind: skillOwnerKindSchema,
  owner_id: z.string(),
  owner_user_id: z.string(),
  owner_team_id: z.string().nullable(),
  owner_name: z.string(),
  owner_handle: z.string().nullable(),
  owner_initials: z.string(),
  current_version: z.string().nullable(),
  license: z.string().nullable(),
  compatibility: z.string().nullable(),
  metadata: z.record(z.string()),
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
  /** `null` = a root thread; a non-null value points at the root comment it replies to. */
  parent_id: z.string().nullable(),
  /** `null` = global thread; else the linked `skill_versions.id`. */
  version_id: z.string().nullable(),
  /** Joined `X.Y.Z` label for the version chip (null when global or unknown). */
  version: z.string().nullable(),
  deprecated: z.boolean(),
});
export type SkillCommentRow = z.infer<typeof skillCommentRowSchema>;

/** Body of `POST /v1/skills/:slug/comments` — add a comment (optionally a reply / version-linked). */
export const addCommentInputSchema = z.object({
  body: z.string().min(1),
  parent_id: z.string().nullable().optional(),
  version_id: z.string().nullable().optional(),
});
export type AddCommentInput = z.infer<typeof addCommentInputSchema>;

/** Body of `PATCH /v1/skills/:slug/comments/:id` — deprecate or restore a comment thread. */
export const setCommentDeprecatedInputSchema = z.object({
  deprecated: z.boolean(),
});
export type SetCommentDeprecatedInput = z.infer<typeof setCommentDeprecatedInputSchema>;

/** One file inside a skill package version (`content` is null for binary or over-cap files). */
export const skillFileSchema = z.object({
  path: z.string(),
  size: z.number().int().nonnegative(),
  content: z.string().nullable(),
  binary: z.boolean(),
  truncated: z.boolean(),
});
export type SkillFile = z.infer<typeof skillFileSchema>;

/** Response of `GET /v1/skills/:slug/versions/:version/files`. */
export const skillFilesResponseSchema = z.object({
  version: z.string(),
  files: z.array(skillFileSchema),
});
export type SkillFilesResponse = z.infer<typeof skillFilesResponseSchema>;

/** Immutable `skill_versions` row. */
export const skillVersionRowSchema = z.object({
  id: z.string(),
  skill_id: z.string(),
  version: z.string(),
  note: z.string(),
  frontmatter: z.string(),
  tools: z.array(z.string()),
  license: z.string().nullable(),
  compatibility: z.string().nullable().optional(),
  metadata: z.record(z.string()).optional(),
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
  skill_id: z.string().uuid().optional(),
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  owner_team: skillOwnerTeamInputSchema,
  visibility: skillVisibilityInputSchema,
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

/**
 * Body of `POST /v1/skills/create` — author a SKILL.md inline ("Create in the browser").
 * The server assembles the standard frontmatter (`name` + `description`) and the body, packs
 * it, and publishes a new version. Visibility is applied on the request, never in the skill.
 */
export const createSkillInputSchema = z.object({
  id: z.string().regex(SKILL_NAME_RE, "id must be kebab-case (lowercase letters, digits, hyphens)"),
  description: z.string().min(1, "description is required").max(1024),
  body: z.string().max(1024 * 1024, "body is too large").default(""),
  owner_team: skillOwnerTeamInputSchema,
  visibility: skillVisibilityInputSchema,
});
export type CreateSkillInput = z.infer<typeof createSkillInputSchema>;
