import { z } from "zod";
import { validationStateSchema } from "./scope";
import { SKILL_NAME_RE, SEMVER_RE, skillRequirementSchema } from "./frontmatter";
import { companionDisplaySchema } from "./companionManifest";
import { localSkillStatusSchema } from "./localSkills";

/**
 * A skill has exactly one Owner, encoded by `owner_team`: `null` = **Personal** (private to the
 * owning user); a team slug = **Team** (owned by that team, readable by every workspace member).
 * The Owner is the single access axis — it decides both who can read and who can edit. There is no
 * separate visibility flag and no per-team read sharing.
 */
export const skillOwnerKindSchema = z.enum(["user", "team"]);
export type SkillOwnerKind = z.infer<typeof skillOwnerKindSchema>;

/** Owner on publish/create: omitted = keep current / Personal; `null` = Personal; slug = Team. */
export const skillOwnerTeamInputSchema = z.string().min(1).max(128).nullable().optional();

/**
 * Body of `PUT /v1/skills/:slug/owner` — move a skill between Personal and a Team. `null` makes it
 * Personal (private to its owner); a team slug makes that team the owner (workspace-visible).
 */
export const setSkillOwnerInputSchema = z.object({
  owner_team: z.string().min(1).max(128).nullable(),
});
export type SetSkillOwnerInput = z.infer<typeof setSkillOwnerInputSchema>;

/** Result of an owner change. */
export const setSkillOwnerResultSchema = z.object({
  ok: z.literal(true),
});
export type SetSkillOwnerResult = z.infer<typeof setSkillOwnerResultSchema>;

/**
 * The owner-cover rule: can everyone who can see `dependent` also see `target`? A skill must never
 * be more widely visible than the dependencies it pulls in. Team-owned skills are visible to the
 * whole workspace, so a team-owned target covers any dependent. A Personal target (private to its
 * owner) only covers a dependent that is Personal and owned by the same user. Pure + shared by core
 * (enforcement) and the web app so the rule has one source of truth.
 */
export function ownerCovers(
  dependent: { ownerKind: SkillOwnerKind; ownerUserId: string },
  target: { ownerKind: SkillOwnerKind; ownerUserId: string },
): boolean {
  if (target.ownerKind === "team") return true;
  return dependent.ownerKind === "user" && dependent.ownerUserId === target.ownerUserId;
}

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
  /** The resolved target's owner kind (null when missing/unpublished) — drives the access pill. */
  owner_kind: skillOwnerKindSchema.nullable(),
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
  owner_kind: skillOwnerKindSchema,
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
 * Body of `POST /v1/skills/:slug/install` — record a published skill as installed for the caller.
 * The assistant posts this at the end of the normal install flow (`source: "agent"`); a member can
 * also mark a skill installed by hand from the UI (`source: "manual"`, e.g. installed another way).
 * Every field is optional so a bare manual mark with no version is valid.
 */
export const reportSkillInstallInputSchema = z.object({
  /** The installed semver. Drives "update" detection; omitted = version-unknown (stays "installed"). */
  version: z.string().regex(SEMVER_RE, "version must be a valid semver").optional(),
  /** Optional source label, e.g. "Claude Code". */
  agent: z.string().min(1).max(120).optional(),
  /** Who recorded it. Defaults to "manual"; the agent prompt passes "agent". */
  source: z.enum(["agent", "manual"]).optional(),
});
export type ReportSkillInstallInput = z.infer<typeof reportSkillInstallInputSchema>;

/** Response from `POST /v1/skills/:slug/install`. */
export const reportSkillInstallResultSchema = z.object({
  ok: z.literal(true),
  installed: z.literal(true),
  status: localSkillStatusSchema,
  installed_version: z.string().nullable(),
  current_version: z.string().nullable(),
});
export type ReportSkillInstallResult = z.infer<typeof reportSkillInstallResultSchema>;

/** Response from `DELETE /v1/skills/:slug/install` — mark a published skill not installed. */
export const skillUninstallResultSchema = z.object({
  ok: z.literal(true),
  installed: z.literal(false),
  status: z.literal("none"),
});
export type SkillUninstallResult = z.infer<typeof skillUninstallResultSchema>;

/**
 * One row of the `skill_list_v` view — the denormalized read shape the web table
 * and the CLI list both consume. Machine-facing snake_case (mirrors the DB).
 */
export const skillListRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  slug: z.string(),
  description: z.string(),
  /** Human display fields normalized from companion.json, with SKILL.md fallbacks. */
  display: companionDisplaySchema.default({}),
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
  /** Declared required secrets / env vars + install notes (parsed from the version frontmatter). */
  requirements: z.array(skillRequirementSchema).default([]),
  star_count: z.number().int().nonnegative(),
  starred: z.boolean(),
  /** Whether the caller has this skill recorded as installed (any version). */
  installed: z.boolean().default(false),
  /** Version the caller recorded installing, or null (never installed, or marked without a version). */
  installed_version: z.string().nullable().default(null),
  /** "none" (not installed) | "installed" (current, or version-unknown) | "update" (behind current). */
  install_status: localSkillStatusSchema.default("none"),
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

/** An image attached to a comment. `url` is the auth-checked serve path for the stored object. */
export const skillCommentImageSchema = z.object({
  id: z.string(),
  content_type: z.string(),
  byte_size: z.number(),
  position: z.number(),
  url: z.string(),
});
export type SkillCommentImage = z.infer<typeof skillCommentImageSchema>;

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
  /** Image attachments, ordered by `position` (empty when the comment has none). */
  images: z.array(skillCommentImageSchema).default([]),
});
export type SkillCommentRow = z.infer<typeof skillCommentRowSchema>;

/** Body of `POST /v1/skills/:slug/comments` — add a comment (optionally a reply / version-linked). */
export const addCommentInputSchema = z.object({
  body: z.string().min(1),
  parent_id: z.string().nullable().optional(),
  version_id: z.string().nullable().optional(),
});
export type AddCommentInput = z.infer<typeof addCommentInputSchema>;

/** Allowed comment image attachments (PNG, JPEG, WebP, GIF). */
export const COMMENT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type CommentImageMimeType = (typeof COMMENT_IMAGE_MIME_TYPES)[number];

const COMMENT_IMAGE_EXTENSION_TO_MIME: Record<string, CommentImageMimeType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** `accept` value for `<input type="file">` — extensions only (Finder ignores mixed MIME filters). */
export const COMMENT_IMAGE_FILE_ACCEPT = Object.keys(COMMENT_IMAGE_EXTENSION_TO_MIME).join(",");

/** Per-comment attachment limits, enforced on both the client and the API. */
export const MAX_COMMENT_IMAGES = 6;
export const MAX_COMMENT_IMAGE_BYTES = 10 * 1024 * 1024;

/** Resolve a file's stored content type, falling back to its extension; null when not an allowed image. */
export function resolveCommentImageContentType(file: { type: string; name: string }): CommentImageMimeType | null {
  if ((COMMENT_IMAGE_MIME_TYPES as readonly string[]).includes(file.type)) {
    return file.type as CommentImageMimeType;
  }
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (ext && ext in COMMENT_IMAGE_EXTENSION_TO_MIME) return COMMENT_IMAGE_EXTENSION_TO_MIME[ext]!;
  return null;
}

export function isAllowedCommentImageFile(file: { type: string; name: string }): boolean {
  return resolveCommentImageContentType(file) !== null;
}

/**
 * Sniff an image's real format from its leading bytes (magic numbers), independent of the
 * client-declared MIME/extension. Returns the matched allowed type, or null when the bytes are not a
 * recognized PNG/JPEG/GIF/WebP — used to reject non-images disguised with a fake extension or header.
 */
export function sniffCommentImageMime(bytes: Uint8Array): CommentImageMimeType | null {
  const b = bytes;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
    b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a
  ) return "image/png";
  // JPEG: FF D8 FF
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  // GIF: "GIF87a" / "GIF89a"
  if (
    b.length >= 6 &&
    b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 &&
    (b[4] === 0x37 || b[4] === 0x39) && b[5] === 0x61
  ) return "image/gif";
  // WebP: "RIFF" .... "WEBP"
  if (
    b.length >= 12 &&
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) return "image/webp";
  return null;
}

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
  display: companionDisplaySchema.default({}),
  requirements: z.array(skillRequirementSchema).default([]),
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
  version: z.string(),
  description: z.string(),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  storage_path: z.string(),
  size_bytes: z.number().int().nonnegative(),
  frontmatter: z.string(),
  /** The SKILL.md markdown body, persisted server-side to power full-text content search. */
  body: z.string().default(""),
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
 * it, and publishes a new version. The owner is applied on the request, never in the skill.
 */
export const createSkillInputSchema = z.object({
  id: z.string().regex(SKILL_NAME_RE, "id must be kebab-case (lowercase letters, digits, hyphens)"),
  description: z.string().min(1, "description is required").max(1024),
  body: z.string().max(1024 * 1024, "body is too large").default(""),
  owner_team: skillOwnerTeamInputSchema,
});
export type CreateSkillInput = z.infer<typeof createSkillInputSchema>;
