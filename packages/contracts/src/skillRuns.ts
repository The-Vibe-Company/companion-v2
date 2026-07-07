import { z } from "zod";

/**
 * Skill runs: one-shot sandboxed sessions launched from a skill's page. A run is a fresh sandbox
 * forked from the golden snapshot with exactly one skill mounted; after the first answer the user
 * may follow up while the sandbox lives, then the run freezes into a read-only transcript.
 *
 * Runs are PRIVATE to their creator (like personal skills: no admin override). The transcript is a
 * server-side snapshot (jsonb on the run row), replaced wholesale on every `session.idle`.
 */

export const skillRunStatusSchema = z.enum(["starting", "running", "frozen", "error"]);
export type SkillRunStatus = z.infer<typeof skillRunStatusSchema>;

/* ---- Chat vocabulary ---------------------------------------------------------------- */

/** A prior message when reloading a run's transcript. */
export const runChatHistoryItemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), text: z.string() }),
  z.object({ kind: z.literal("assistant"), text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    call_id: z.string(),
    tool: z.string(),
    skill: z.string().nullable().default(null),
    title: z.string().nullable().default(null),
    input: z.string().default(""),
    output: z.string().default(""),
    duration_ms: z.number().int().nonnegative().nullable().default(null),
  }),
]);
export type RunChatHistoryItem = z.infer<typeof runChatHistoryItemSchema>;

/**
 * Normalized chat event vocabulary streamed over `GET /v1/runs/:id/events`.
 * The API translates pinned-SDK OpenCode events into this stable shape so OpenCode's near-daily
 * churn stays server-side, next to the pinned `@opencode-ai/sdk`.
 */
export const runWorkingStateSchema = z.enum(["busy", "idle", "retry"]);
export type RunWorkingState = z.infer<typeof runWorkingStateSchema>;

export const runChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), session_id: z.string() }),
  z.object({
    type: z.literal("tool.start"),
    call_id: z.string(),
    /** Best-effort skill slug when the tool run maps to the mounted skill. */
    skill: z.string().nullable().default(null),
    tool: z.string(),
    /** OpenCode's human-readable summary of the run (e.g. "Read SKILL.md"), when available. */
    title: z.string().nullable().default(null),
    input: z.string().default(""),
  }),
  z.object({
    type: z.literal("tool.done"),
    call_id: z.string(),
    title: z.string().nullable().default(null),
    output: z.string().default(""),
    duration_ms: z.number().int().nonnegative().nullable().default(null),
  }),
  z.object({ type: z.literal("text.delta"), message_id: z.string(), delta: z.string() }),
  z.object({ type: z.literal("text.done"), message_id: z.string() }),
  /** The model's reasoning ("thinking") stream — surfaced live, collapses when the answer starts. */
  z.object({ type: z.literal("reasoning.delta"), part_id: z.string(), delta: z.string() }),
  z.object({ type: z.literal("reasoning.done"), part_id: z.string() }),
  /**
   * Live working state from OpenCode's `session.status` — the reliable "is it running?" signal
   * (busy while the model works, retry with an attempt/message, idle when done).
   */
  z.object({
    type: z.literal("status"),
    state: runWorkingStateSchema,
    // `nonnegative`, not `positive`: OpenCode's retry counter may be 0-based, and the client
    // schema-validates events (a `positive()` bound would silently drop a legitimate `attempt: 0`).
    attempt: z.number().int().nonnegative().nullable().default(null),
    message: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal("session.idle"), session_id: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type RunChatEvent = z.infer<typeof runChatEventSchema>;

/* ---- Row shapes ----------------------------------------------------------------------- */

/** One run in the skill's Sessions tab (`GET /v1/skills/:slug/runs` — caller's runs only). */
export const skillRunRowSchema = z.object({
  id: z.string(),
  skill_slug: z.string(),
  /** Published skill version pinned at launch. */
  skill_version: z.string().nullable(),
  model: z.string(),
  prompt_excerpt: z.string(),
  status: skillRunStatusSchema,
  /** Launch step in progress (while `starting`) or a human error message (when `error`). */
  status_detail: z.string().nullable(),
  artifacts_count: z.number().int().nonnegative(),
  created_at: z.string(),
  last_active_at: z.string().nullable(),
});
export type SkillRunRow = z.infer<typeof skillRunRowSchema>;

export const skillRunAttachmentRowSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  content_type: z.string(),
  byte_size: z.number().int().nonnegative(),
});
export type SkillRunAttachmentRow = z.infer<typeof skillRunAttachmentRowSchema>;

/** One published artifact (a file the agent saved into `artifacts/`, shared via Vanish). */
export const skillRunArtifactRowSchema = z.object({
  id: z.string(),
  file_name: z.string(),
  /** Path relative to the sandbox `artifacts/` directory. */
  path: z.string(),
  content_type: z.string().nullable(),
  byte_size: z.number().int().nonnegative(),
  url: z.string(),
  expires_at: z.string().nullable(),
  published_at: z.string(),
});
export type SkillRunArtifactRow = z.infer<typeof skillRunArtifactRowSchema>;

/** Full run for the chat/transcript view (`GET /v1/runs/:id`). */
export const skillRunDetailSchema = skillRunRowSchema.extend({
  prompt: z.string(),
  transcript: z.array(runChatHistoryItemSchema),
  attachments: z.array(skillRunAttachmentRowSchema),
  artifacts: z.array(skillRunArtifactRowSchema),
});
export type SkillRunDetail = z.infer<typeof skillRunDetailSchema>;

export const skillRunsResponseSchema = z.object({
  runs: z.array(skillRunRowSchema),
});
export type SkillRunsResponse = z.infer<typeof skillRunsResponseSchema>;

/* ---- Inputs ---------------------------------------------------------------------------- */

export const RUN_PROMPT_MAX = 8_000;
export const RUN_ATTACHMENT_MAX_FILES = 5;
export const RUN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/** Body of `POST /v1/runs/:id/prompt` — a follow-up while the sandbox lives. */
export const runPromptInputSchema = z.object({
  text: z.string().trim().min(1).max(RUN_PROMPT_MAX),
});
export type RunPromptInput = z.infer<typeof runPromptInputSchema>;

/**
 * Text fields of the multipart `POST /v1/skills/:slug/runs` launch body (files arrive as repeated
 * `file` parts and are validated by the route, not this schema).
 */
export const launchRunFieldsSchema = z.object({
  prompt: z.string().trim().min(1).max(RUN_PROMPT_MAX),
  model: z.string().min(1),
});
export type LaunchRunFields = z.infer<typeof launchRunFieldsSchema>;
