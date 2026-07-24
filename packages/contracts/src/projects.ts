import { z } from "zod";
import {
  runChatEventSchema,
  runChatHistoryItemSchema,
} from "./skillRuns";

export const PROJECT_NAME_MAX = 120;
export const PROJECT_SESSION_TITLE_MAX = 160;
export const PROJECT_PROMPT_MAX = 8_000;
export const PROJECT_MODEL_ID_MAX = 240;
export const PROJECT_ATTACHMENT_MAX_FILES = 5;
export const PROJECT_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const PROJECT_SECRET_MAX = 128;
/** Maximum UTF-8 JSON size of the durable, redacted recovery transcript. */
export const PROJECT_TRANSCRIPT_MAX_BYTES = 512 * 1024;

const uuidSchema = z.string().uuid();
const projectNameSchema = z.string().trim().min(1).max(PROJECT_NAME_MAX);
const sessionTitleSchema = z.string().trim().min(1).max(PROJECT_SESSION_TITLE_MAX);
const promptSchema = z.string().trim().min(1).max(PROJECT_PROMPT_MAX);
const modelSchema = z.string().trim().min(1).max(PROJECT_MODEL_ID_MAX);
const isoDateSchema = z.string().datetime();

export const projectWorkspaceStatusSchema = z.enum([
  "queued",
  "provisioning",
  "ready",
  "running",
  "stopping",
  "stopped",
  "needs_attention",
  "deleting",
  "deleted",
  "error",
]);
export type ProjectWorkspaceStatus = z.infer<typeof projectWorkspaceStatusSchema>;

export const projectSessionStatusSchema = z.enum([
  "queued",
  "working",
  "idle",
  "stopping",
  "stopped",
  "completed",
  "error",
]);
export type ProjectSessionStatus = z.infer<typeof projectSessionStatusSchema>;

export const projectPromptStatusSchema = z.enum([
  "queued",
  "dispatching",
  "running",
  "completed",
  "failed",
  "cancelled",
]);
export type ProjectPromptStatus = z.infer<typeof projectPromptStatusSchema>;

export const projectSkillSchema = z
  .object({
    skill_id: uuidSchema,
    slug: z.string().min(1).max(200),
    display_name: z.string().min(1).max(200),
    summary: z.string().max(4_000),
    version: z.string().min(1).max(100),
    archived: z.boolean(),
  })
  .strict();
export type ProjectSkill = z.infer<typeof projectSkillSchema>;

export const projectSessionRowSchema = z
  .object({
    id: uuidSchema,
    project_id: uuidSchema,
    title: sessionTitleSchema,
    model: modelSchema,
    status: projectSessionStatusSchema,
    stop_requested_at: isoDateSchema.nullable(),
    last_active_at: isoDateSchema,
    error_code: z.string().nullable(),
    message: z.string().nullable(),
    created_at: isoDateSchema,
    updated_at: isoDateSchema,
  })
  .strict();
export type ProjectSessionRow = z.infer<typeof projectSessionRowSchema>;

export const projectRowSchema = z
  .object({
    id: uuidSchema,
    name: projectNameSchema,
    default_model: modelSchema,
    revision: z.number().int().positive(),
    status: projectWorkspaceStatusSchema,
    skill_count: z.number().int().nonnegative(),
    session_count: z.number().int().nonnegative(),
    file_count: z.number().int().nonnegative(),
    recent_sessions: z.array(projectSessionRowSchema).max(5),
    last_activity_at: isoDateSchema,
    error_code: z.string().nullable(),
    message: z.string().nullable(),
    created_at: isoDateSchema,
    updated_at: isoDateSchema,
  })
  .strict();
export type ProjectRow = z.infer<typeof projectRowSchema>;

export const projectDetailSchema = projectRowSchema
  .extend({
    skills: z.array(projectSkillSchema),
    sessions: z.array(projectSessionRowSchema),
    secret_count: z.number().int().nonnegative(),
    model_connection_count: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectDetail = z.infer<typeof projectDetailSchema>;

export const projectRuntimeStatusSchema = z
  .object({
    available: z.boolean(),
    message: z.string().nullable(),
  })
  .strict();
export type ProjectRuntimeStatus = z.infer<typeof projectRuntimeStatusSchema>;

export const projectsResponseSchema = z
  .object({
    projects: z.array(projectRowSchema),
    runtime: projectRuntimeStatusSchema,
  })
  .strict();
export type ProjectsResponse = z.infer<typeof projectsResponseSchema>;

export const createProjectInputSchema = z
  .object({
    name: projectNameSchema,
    default_model: modelSchema,
    skill_slugs: z.array(z.string().trim().min(1).max(200)).max(100).default([]),
  })
  .strict();
export type CreateProjectInput = z.infer<typeof createProjectInputSchema>;

export const updateProjectInputSchema = z
  .object({
    revision: z.number().int().positive(),
    name: projectNameSchema.optional(),
    default_model: modelSchema.optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.default_model !== undefined,
    "at least one project field is required",
  );
export type UpdateProjectInput = z.infer<typeof updateProjectInputSchema>;

export const setProjectSkillsInputSchema = z
  .object({
    revision: z.number().int().positive(),
    skill_slugs: z.array(z.string().trim().min(1).max(200)).max(100),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.skill_slugs).size !== value.skill_slugs.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "skill slugs must be unique" });
    }
  });
export type SetProjectSkillsInput = z.infer<typeof setProjectSkillsInputSchema>;

/** Multipart fields used by both session creation and follow-up prompts. */
export const createProjectSessionFieldsSchema = z
  .object({
    prompt: promptSchema,
    model: modelSchema.optional(),
    title: sessionTitleSchema.optional(),
  })
  .strict();
export type CreateProjectSessionFields = z.infer<typeof createProjectSessionFieldsSchema>;

export const projectPromptFieldsSchema = z
  .object({
    prompt: promptSchema,
    /** Optional assertion only; sessions never change model after creation. */
    model: modelSchema.optional(),
  })
  .strict();
export const projectPromptInputSchema = projectPromptFieldsSchema;
export type ProjectPromptInput = z.infer<typeof projectPromptInputSchema>;

export const projectPromptRowSchema = z
  .object({
    id: uuidSchema,
    session_id: uuidSchema,
    sequence: z.number().int().positive(),
    text: promptSchema,
    status: projectPromptStatusSchema,
    error_code: z.string().nullable(),
    error_message: z.string().nullable(),
    created_at: isoDateSchema,
    started_at: isoDateSchema.nullable(),
    completed_at: isoDateSchema.nullable(),
  })
  .strict();
export type ProjectPromptRow = z.infer<typeof projectPromptRowSchema>;

/** Projects persist exactly the same bounded event vocabulary as Skill Runs. */
export const projectSessionEventSchema = runChatEventSchema;
export type ProjectSessionEvent = z.infer<typeof projectSessionEventSchema>;

export const projectTranscriptSchema = z.array(runChatHistoryItemSchema);

export const projectEventEnvelopeSchema = z
  .object({
    sequence: z.number().int().positive(),
    created_at: isoDateSchema,
    event: projectSessionEventSchema,
  })
  .strict();
export type ProjectEventEnvelope = z.infer<typeof projectEventEnvelopeSchema>;

export const projectSessionDetailSchema = projectSessionRowSchema
  .extend({
    prompts: z.array(projectPromptRowSchema),
    transcript: projectTranscriptSchema,
    latest_event_sequence: z.number().int().nonnegative(),
  })
  .strict();
export type ProjectSessionDetail = z.infer<typeof projectSessionDetailSchema>;

export const projectFileRowSchema = z
  .object({
    id: uuidSchema,
    project_id: uuidSchema,
    path: z.string().startsWith("files/"),
    version: z.number().int().positive(),
    content_type: z.string().min(1),
    byte_size: z.number().int().nonnegative(),
    checksum: z.string().min(32).max(128),
    conflict_detected: z.boolean(),
    created_at: isoDateSchema,
    updated_at: isoDateSchema,
  })
  .strict();
export type ProjectFileRow = z.infer<typeof projectFileRowSchema>;

export const projectFileDownloadSchema = projectFileRowSchema
  .extend({ storage_key: z.string().min(1) })
  .strict();
export type ProjectFileDownload = z.infer<typeof projectFileDownloadSchema>;

export const projectFileVersionRowSchema = z
  .object({
    project_id: uuidSchema,
    file_id: uuidSchema,
    path: z.string().startsWith("files/"),
    version: z.number().int().positive(),
    content_type: z.string().min(1),
    byte_size: z.number().int().nonnegative(),
    checksum: z.string().min(32).max(128),
    modified_by_session_id: uuidSchema.nullable(),
    /** Zero identifies a file that did not exist at the start of the writer's turn. */
    base_version: z.number().int().nonnegative().nullable(),
    conflict_detected: z.boolean(),
    created_at: isoDateSchema,
  })
  .strict();
export type ProjectFileVersionRow = z.infer<
  typeof projectFileVersionRowSchema
>;

export const projectFileVersionsResponseSchema = z
  .object({ versions: z.array(projectFileVersionRowSchema) })
  .strict();
export type ProjectFileVersionsResponse = z.infer<
  typeof projectFileVersionsResponseSchema
>;

/** Worker-facing types deliberately contain no decrypted credential values. */
export interface ProjectWorkspaceJob {
  orgId: string;
  projectId: string;
  creatorId: string;
  status: ProjectWorkspaceStatus;
  sandboxName: string;
  sandboxId: string | null;
  sandboxDomain: string | null;
  checkpointId: string | null;
  checkpointGeneration: number;
  desiredGeneration: number;
  appliedGeneration: number;
  lastActivityAt: Date;
  idleDeadlineAt: Date | null;
  activationRevision: number;
  authorityRevision: string | null;
  activationAdmissionToken: string | null;
  activationAdmissionRevision: number | null;
  activationAdmissionAuthorityRevision: string | null;
  activationAdmittedAt: Date | null;
  environmentExposureAttemptedAt: Date | null;
  recycleRequestedAt: Date | null;
  recycleReason: string | null;
  skillSyncErrorAt: Date | null;
  skillSyncErrorCode: string | null;
  skillSyncErrorMessage: string | null;
  leaseGeneration: number;
  deleteRequestedAt: Date | null;
}

export interface ProjectMaterializedSkill {
  rootSkillId: string;
  skillId: string;
  skillVersionId: string;
  slug: string;
  version: string;
  mountOrder: number;
  checksum: string;
  storagePath: string;
}

export interface ProjectSecretPin {
  envKey: string;
  secretId: string;
  secretVersion: number;
}

export interface ProjectModelProviderPin {
  provider: string;
  envKey: string;
  connectionId: string;
  credentialVersion: number;
  connectionScope: "personal" | "organization";
}

export interface ProjectMaterializationPlan {
  projectId: string;
  creatorId: string;
  /** Current durable generations, re-read under the exact workspace lease. */
  desiredGeneration: number;
  appliedGeneration: number;
  /** Projection generation contained by the durable checkpoint, or zero for the golden snapshot. */
  checkpointGeneration: number;
  /** @deprecated Use desiredGeneration. Kept while the worker seam migrates. */
  generation: number;
  skills: ProjectMaterializedSkill[];
  secrets: ProjectSecretPin[];
  modelProviders: ProjectModelProviderPin[];
  bootstrapFiles: Array<{
    storageKey: string;
    workspacePath: string;
    checksum: string;
  }>;
}

export interface ProjectPromptJob {
  id: string;
  orgId: string;
  projectId: string;
  sessionId: string;
  creatorId: string;
  sequence: number;
  text: string;
  model: string;
  opencodeSessionId: string | null;
  opencodeMessageId: string;
  /** Non-null means promptAsync may have reached OpenCode and must never be blindly replayed. */
  sendAttemptedAt: Date | null;
  leaseOwner: string;
}

export interface ProjectSessionStopJob {
  orgId: string;
  projectId: string;
  creatorId: string;
  sessionId: string;
  opencodeSessionId: string | null;
}

export interface ProjectAuthorityState {
  authorityRevision: string;
  recycleRequired: boolean;
  /** Boundary changes wait until no turn is active; immediate changes close admission now. */
  mode: "current" | "boundary" | "immediate";
  reason:
    | "current"
    | "not_activated"
    | "membership_revoked"
    | "activation_changed"
    | "recycle_requested"
    | "secrets_changed"
    | "model_connections_changed"
    | "environment_invalid";
}
