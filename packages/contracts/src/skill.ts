import { z } from "zod";
import { validationStateSchema } from "./scope";
import { SKILL_NAME_RE } from "./frontmatter";

export const teamVisibilitySchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  color: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
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

/**
 * Body of `PUT /v1/skills/:slug/visibility`. `cascade` opts into also raising the skill's
 * (transitive) dependencies so they stay at least as visible as the skill — without it, a
 * broadening change that would leave a dependency less visible is rejected.
 */
export const setSkillVisibilityInputSchema = skillVisibilityInputSchema.extend({
  cascade: z.boolean().default(false),
});
export type SetSkillVisibilityInput = z.infer<typeof setSkillVisibilityInputSchema>;

/** Result of a visibility change: the slugs of dependencies raised to cover the new audience. */
export const setSkillVisibilityResultSchema = z.object({
  ok: z.literal(true),
  cascaded: z.array(z.string()),
});
export type SetSkillVisibilityResult = z.infer<typeof setSkillVisibilityResultSchema>;

/**
 * The visibility-cover rule: can everyone who sees `dependent` also see `target`? A skill must
 * never be more visible than the dependencies it pulls in. Pure + shared by core (enforcement),
 * the API, and the web app (pre-flight warning) so the rule has one source of truth.
 *
 * - target Everyone → always covers.
 * - dependent Everyone but target not → mismatch.
 * - dependent private (no teams) → owner-managed, always covered.
 * - otherwise dependent's teams must be a subset of target's teams.
 *
 * `teams` are opaque identifiers; callers must compare like-for-like (all slugs or all ids).
 */
export function visibilityCovers(
  dependent: { everyone: boolean; teams: string[] },
  target: { everyone: boolean; teams: string[] },
): boolean {
  if (target.everyone) return true;
  if (dependent.everyone) return false;
  if (dependent.teams.length === 0) return true;
  const targetTeams = new Set(target.teams);
  return dependent.teams.every((team) => targetTeams.has(team));
}

export const skillOwnerKindSchema = z.enum(["user", "team"]);
export type SkillOwnerKind = z.infer<typeof skillOwnerKindSchema>;

export const skillOwnerTeamInputSchema = z.string().min(1).max(128).nullable().optional();

/**
 * Live status of a single skill→skill dependency edge, computed from current state on every read.
 * Dependencies are un-versioned (pure skill→skill links): there is deliberately no "update
 * available" status — versions are a skill's own publish concern, not the dependency graph's.
 */
export const skillDependencyStatusSchema = z.enum([
  "satisfied", // target published, not archived, visible-enough, no cycle
  "missing", // declared slug has no published skill in the workspace
  "archived", // target exists but is archived
  "visibility", // target's audience does not cover the dependent's audience
  "cycle", // edge participates in a directed dependency cycle
]);
export type SkillDependencyStatus = z.infer<typeof skillDependencyStatusSchema>;

/** A "Requires" row: a skill the current version pulls in when it is installed. */
export const skillDependencyRowSchema = z.object({
  slug: z.string(),
  status: skillDependencyStatusSchema,
  /** The resolved target's visibility (null when missing/unpublished). */
  visibility: skillVisibilitySchema.nullable(),
  /** Short human note (e.g. "not published to this workspace", cycle hint). */
  note: z.string().nullable(),
  /** True when the target exists and is visible to the actor (the slug links to its detail). */
  can_open: z.boolean(),
});
export type SkillDependencyRow = z.infer<typeof skillDependencyRowSchema>;

/** A "Used by" row: a skill version that declares this skill as a dependency. */
export const skillDependentRowSchema = z.object({
  slug: z.string(),
  status: skillDependencyStatusSchema,
  visibility: skillVisibilitySchema,
  archived: z.boolean(),
  note: z.string().nullable(),
  can_open: z.boolean(),
});
export type SkillDependentRow = z.infer<typeof skillDependentRowSchema>;

/** Response of `GET /v1/skills/:slug/dependencies` — the Requires + Used by graph for one skill. */
export const skillDependenciesResponseSchema = z.object({
  slug: z.string(),
  version: z.string().nullable(),
  requires: z.array(skillDependencyRowSchema),
  used_by: z.array(skillDependentRowSchema),
  requires_n: z.number().int().nonnegative(),
  used_by_n: z.number().int().nonnegative(),
});
export type SkillDependenciesResponse = z.infer<typeof skillDependenciesResponseSchema>;

/**
 * Dependency preflight returned by `POST /v1/skills?action=validate` and echoed on publish.
 * Drives the upload dialog's "Dependency preflight" step.
 */
export const dependencyPlanSchema = z.object({
  declared: z.array(z.string()),
  /** Declared dependencies already published in the workspace registry. */
  ready: z.array(z.string()),
  /** Declared but not in the registry — must be uploaded too, or the version stays unresolved. */
  upload: z.array(z.object({ slug: z.string(), msg: z.string() })),
  /** Required by the previous version and dropped from this one. */
  removed: z.array(z.string()),
  /** Removed dependencies that no published skill references anymore — candidates to archive. */
  archive_candidates: z.array(z.object({ slug: z.string(), reason: z.string() })),
  /** Blocking reasons (missing/cycle/visibility) that must be resolved before publish. */
  blocked: z.array(z.object({ slug: z.string(), status: skillDependencyStatusSchema, msg: z.string() })),
});
export type DependencyPlan = z.infer<typeof dependencyPlanSchema>;

/** Body of `POST /v1/skills/:slug/archive` — archive a skill (reason optional). */
export const archiveSkillInputSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type ArchiveSkillInput = z.infer<typeof archiveSkillInputSchema>;

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
  /** Number of dependencies the current version declares. */
  requires_count: z.number().int().nonnegative().default(0),
  /** Number of other skills (current versions) that depend on this one. */
  used_by_count: z.number().int().nonnegative().default(0),
  /** True when any declared dependency is not satisfied (drives the warn-tinted Deps pill). */
  dep_warn: z.boolean().default(false),
  /** True when the skill is archived (hidden from normal lists). */
  archived: z.boolean().default(false),
  /** True when ANY published version (current or older) references this skill — gates archived download. */
  referenced: z.boolean().default(false),
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
  /** Declared required dependencies (target skill slugs). Un-versioned: no ranges. */
  dependencies: z
    .array(z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/))
    .max(64)
    .default([]),
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
