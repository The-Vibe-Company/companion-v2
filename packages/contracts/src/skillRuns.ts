import { z } from "zod";
import { SEMVER_RE, SKILL_NAME_RE, SKILL_REQUIREMENT_KEY_RE } from "./frontmatter";
import { modelRowSchema } from "./modelProviders";
import { secretCandidateSchema } from "./secrets";

/**
 * Skill runs are private, durable sandbox sessions launched from a published skill version.
 *
 * The contracts in this module deliberately contain metadata and references only. Secret plaintext
 * is never part of a regular run response, saved configuration, event, or snapshot contract.
 */

/* ---- Limits and shared primitives ------------------------------------------------------- */

export const RUN_PROMPT_MAX = 8_000;
export const RUN_ATTACHMENT_MAX_FILES = 5;
export const RUN_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
export const RUN_MAX_DEPENDENCIES = 64;
export const RUN_MAX_SECRET_INPUTS = 128;
export const RUN_MAX_VARIABLE_INPUTS = 128;
export const RUN_VARIABLE_VALUE_MAX_BYTES = 32 * 1024;
export const RUN_CONFIGURATION_NAME_MAX = 120;
export const RUN_MODEL_ID_MAX = 240;
export const RUN_ERROR_CODE_MAX = 80;

/** Runtime-owned names may never be supplied by a skill or saved configuration. */
export const RUN_RESERVED_ENV_PREFIX = "OPENCODE_SERVER_";

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

const runUuidSchema = z.string().uuid();
const runModelIdSchema = z.string().trim().min(1).max(RUN_MODEL_ID_MAX);
const environmentKeyNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(SKILL_REQUIREMENT_KEY_RE, "environment keys must look like environment variables");
const runEnvKeySchema = environmentKeyNameSchema
  .refine((key) => !key.startsWith(RUN_RESERVED_ENV_PREFIX), "this environment key is reserved by the runtime");
const runErrorCodeSchema = z
  .string()
  .min(1)
  .max(RUN_ERROR_CODE_MAX)
  .regex(/^[a-z][a-z0-9_]*$/, "run error codes must be lower snake case");

export const skillRunStatusSchema = z.enum(["queued", "starting", "running", "frozen", "error", "canceled"]);
export type SkillRunStatus = z.infer<typeof skillRunStatusSchema>;

/** Fine-grained durable worker phase; status remains the stable user-facing lifecycle. */
export const runPhaseSchema = z.enum([
  "queued",
  "resolve_inputs",
  "fork",
  "push_workspace",
  "start_server",
  "healthcheck",
  "create_session",
  "prompt",
  "record",
  "collect_artifacts",
  "freeze",
  "cancel",
  "cleanup",
  "complete",
]);
export type RunPhase = z.infer<typeof runPhaseSchema>;

export const runSecretProvenanceSchema = z.enum(["skill", "model_provider", "runtime"]);
export type RunSecretProvenance = z.infer<typeof runSecretProvenanceSchema>;

/* ---- Resolved launch options ------------------------------------------------------------ */

/** One exact skill version in the root skill's dependency closure. */
export const runDependencySchema = z
  .object({
    skill_id: runUuidSchema,
    skill_version_id: runUuidSchema,
    slug: z.string().regex(SKILL_NAME_RE),
    version: z.string().regex(SEMVER_RE),
    root: z.boolean(),
    depth: z.number().int().nonnegative().max(RUN_MAX_DEPENDENCIES),
    via: z.string().regex(SKILL_NAME_RE).nullable(),
  })
  .strict();
export type RunDependency = z.infer<typeof runDependencySchema>;

export const runSecretCandidateSchema = secretCandidateSchema;
export type RunSecretCandidate = z.infer<typeof runSecretCandidateSchema>;

/** A manifest-declared secret slot, grouped by the exact skill version which declared it. */
export const runDeclaredSecretSchema = z
  .object({
    skill_id: runUuidSchema,
    skill_version_id: runUuidSchema,
    skill_slug: z.string().regex(SKILL_NAME_RE),
    slot_id: runUuidSchema,
    env_key: runEnvKeySchema,
    description: z.string().max(2_000).default(""),
    required: z.boolean(),
    candidates: z.array(runSecretCandidateSchema).max(250).default([]),
    /** Existing install/sync binding, offered as a draft prefill only. */
    prefill_secret_id: runUuidSchema.nullable().default(null),
  })
  .strict();
export type RunDeclaredSecret = z.infer<typeof runDeclaredSecretSchema>;

/** A manifest-declared non-sensitive environment variable. */
export const runDeclaredVariableSchema = z
  .object({
    skill_id: runUuidSchema,
    skill_version_id: runUuidSchema,
    skill_slug: z.string().regex(SKILL_NAME_RE),
    env_key: runEnvKeySchema,
    description: z.string().max(2_000).default(""),
    required: z.boolean(),
  })
  .strict();
export type RunDeclaredVariable = z.infer<typeof runDeclaredVariableSchema>;

export const runModelReadinessSchema = z.enum([
  "ready",
  "not_activated",
  "provider_disconnected",
  "runtime_unavailable",
]);
export type RunModelReadiness = z.infer<typeof runModelReadinessSchema>;

export const runModelOptionSchema = z
  .object({
    model: modelRowSchema,
    readiness: runModelReadinessSchema,
    message: z.string().max(2_000).nullable().default(null),
  })
  .strict();
export type RunModelOption = z.infer<typeof runModelOptionSchema>;

/* ---- Authoritative run/configuration inputs -------------------------------------------- */

export const runSecretSelectionSchema = z
  .object({
    skill_id: runUuidSchema,
    slot_id: runUuidSchema,
    secret_id: runUuidSchema,
  })
  .strict();
export type RunSecretSelection = z.infer<typeof runSecretSelectionSchema>;

export const runVariableSelectionSchema = z
  .object({
    skill_id: runUuidSchema,
    env_key: runEnvKeySchema,
    value: z
      .string()
      .refine((value) => !value.includes("\0"), "environment values must not contain NUL")
      .refine(
        (value) => utf8ByteLength(value) <= RUN_VARIABLE_VALUE_MAX_BYTES,
        `environment values must be at most ${RUN_VARIABLE_VALUE_MAX_BYTES} bytes`,
      ),
  })
  .strict();
export type RunVariableSelection = z.infer<typeof runVariableSelectionSchema>;

function addDuplicateInputIssues(
  inputs: { secrets: RunSecretSelection[]; variables: RunVariableSelection[] },
  ctx: z.RefinementCtx,
): void {
  const secretKeys = new Set<string>();
  inputs.secrets.forEach((selection, index) => {
    const key = `${selection.skill_id}:${selection.slot_id}`;
    if (secretKeys.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["secrets", index], message: "duplicate secret slot selection" });
    }
    secretKeys.add(key);
  });

  const variableKeys = new Set<string>();
  inputs.variables.forEach((selection, index) => {
    const key = `${selection.skill_id}:${selection.env_key}`;
    if (variableKeys.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["variables", index], message: "duplicate variable selection" });
    }
    variableKeys.add(key);
  });
}

/** The complete, explicit input selection. The server must not add implicit secret bindings. */
export const runInputSelectionSchema = z
  .object({
    secrets: z.array(runSecretSelectionSchema).max(RUN_MAX_SECRET_INPUTS).default([]),
    variables: z.array(runVariableSelectionSchema).max(RUN_MAX_VARIABLE_INPUTS).default([]),
  })
  .strict()
  .superRefine(addDuplicateInputIssues);
export type RunInputSelection = z.infer<typeof runInputSelectionSchema>;

/** Multipart fields send the selection as JSON; internal callers may provide the parsed object. */
export const runInputSelectionJsonSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, runInputSelectionSchema);

/* ---- Personal saved configurations ------------------------------------------------------ */

export const runConfigurationStatusSchema = z.enum(["ready", "needs_attention"]);
export type RunConfigurationStatus = z.infer<typeof runConfigurationStatusSchema>;

/** Mutable payload shared by create and replacement/update flows. */
export const runConfigurationInputSchema = z
  .object({
    name: z.string().trim().min(1).max(RUN_CONFIGURATION_NAME_MAX),
    model: runModelIdSchema,
    inputs: runInputSelectionSchema,
    is_default: z.boolean().default(false),
  })
  .strict();
export type RunConfigurationInput = z.infer<typeof runConfigurationInputSchema>;

export const createRunConfigurationInputSchema = runConfigurationInputSchema;
export type CreateRunConfigurationInput = z.infer<typeof createRunConfigurationInputSchema>;

export const updateRunConfigurationInputSchema = z
  .object({
    revision: z.number().int().positive(),
    name: z.string().trim().min(1).max(RUN_CONFIGURATION_NAME_MAX).optional(),
    model: runModelIdSchema.optional(),
    inputs: runInputSelectionSchema.optional(),
    is_default: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => value.name !== undefined || value.model !== undefined || value.inputs !== undefined || value.is_default !== undefined,
    "at least one configuration field is required",
  );
export type UpdateRunConfigurationInput = z.infer<typeof updateRunConfigurationInputSchema>;

export const deleteRunConfigurationInputSchema = z.object({ revision: z.number().int().positive() }).strict();
export type DeleteRunConfigurationInput = z.infer<typeof deleteRunConfigurationInputSchema>;

export const runConfigurationIssueSchema = z
  .object({
    code: runErrorCodeSchema,
    message: z.string().min(1).max(2_000),
    skill_id: runUuidSchema.nullable().default(null),
    slot_id: runUuidSchema.nullable().default(null),
    env_key: runEnvKeySchema.nullable().default(null),
  })
  .strict();
export type RunConfigurationIssue = z.infer<typeof runConfigurationIssueSchema>;

export const runConfigurationSchema = z
  .object({
    id: runUuidSchema,
    skill_id: runUuidSchema,
    skill_slug: z.string().regex(SKILL_NAME_RE),
    name: z.string().min(1).max(RUN_CONFIGURATION_NAME_MAX),
    model: runModelIdSchema,
    revision: z.number().int().positive(),
    is_default: z.boolean(),
    status: runConfigurationStatusSchema,
    issues: z.array(runConfigurationIssueSchema).default([]),
    inputs: runInputSelectionSchema,
    created_at: z.string(),
    updated_at: z.string(),
    last_used_at: z.string().nullable(),
  })
  .strict();
export type RunConfiguration = z.infer<typeof runConfigurationSchema>;

export const runConfigurationsResponseSchema = z.object({ configurations: z.array(runConfigurationSchema) }).strict();
export type RunConfigurationsResponse = z.infer<typeof runConfigurationsResponseSchema>;

export const runOptionsSchema = z
  .object({
    root: runDependencySchema,
    dependencies: z.array(runDependencySchema).max(RUN_MAX_DEPENDENCIES),
    declared_secrets: z.array(runDeclaredSecretSchema).max(RUN_MAX_SECRET_INPUTS),
    declared_variables: z.array(runDeclaredVariableSchema).max(RUN_MAX_VARIABLE_INPUTS),
    configurations: z.array(runConfigurationSchema),
    models: z.array(runModelOptionSchema),
    runtime: z
      .object({
        available: z.boolean(),
        message: z.string().max(2_000).nullable().default(null),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.root.root) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["root", "root"], message: "the root option must identify the root skill" });
    }
    if (value.dependencies.some((dependency) => dependency.root)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dependencies"], message: "dependencies must not contain another root skill" });
    }
  });
export type RunOptions = z.infer<typeof runOptionsSchema>;

/* ---- Redacted immutable run snapshots -------------------------------------------------- */

export const runSecretInputSnapshotSchema = z
  .object({
    provenance: runSecretProvenanceSchema,
    skill_id: runUuidSchema.nullable(),
    skill_slug: z.string().regex(SKILL_NAME_RE).nullable(),
    slot_id: runUuidSchema.nullable(),
    env_key: environmentKeyNameSchema,
    required: z.boolean(),
    secret_id: runUuidSchema.nullable(),
    secret_version: z.number().int().positive().nullable(),
    /** Display metadata only; never a value. */
    secret_name: z.string().min(1).max(120).nullable(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.provenance !== "runtime" && (!value.secret_id || !value.secret_version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "skill and model provider snapshots require an exact secret version",
      });
    }
    if (value.provenance === "runtime" && (value.secret_id !== null || value.secret_version !== null)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "runtime-generated credentials must not reference a vault secret",
      });
    }
  });
export type RunSecretInputSnapshot = z.infer<typeof runSecretInputSnapshotSchema>;

export const runVariableInputSnapshotSchema = z
  .object({
    skill_id: runUuidSchema,
    skill_slug: z.string().regex(SKILL_NAME_RE),
    env_key: runEnvKeySchema,
    value: runVariableSelectionSchema.shape.value,
  })
  .strict();
export type RunVariableInputSnapshot = z.infer<typeof runVariableInputSnapshotSchema>;

export const runInputSnapshotSchema = z
  .object({
    skills: z.array(runDependencySchema).max(RUN_MAX_DEPENDENCIES + 1),
    secrets: z.array(runSecretInputSnapshotSchema).max(RUN_MAX_SECRET_INPUTS),
    variables: z.array(runVariableInputSnapshotSchema).max(RUN_MAX_VARIABLE_INPUTS),
  })
  .strict();
export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;

/* ---- Chat vocabulary ------------------------------------------------------------------- */

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
 * The payload is redacted before it reaches this boundary.
 */
export const runWorkingStateSchema = z.enum(["busy", "idle", "retry"]);
export type RunWorkingState = z.infer<typeof runWorkingStateSchema>;

export const runChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), session_id: z.string() }),
  z.object({
    type: z.literal("tool.start"),
    call_id: z.string(),
    skill: z.string().nullable().default(null),
    tool: z.string(),
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
  z.object({ type: z.literal("reasoning.delta"), part_id: z.string(), delta: z.string() }),
  z.object({ type: z.literal("reasoning.done"), part_id: z.string() }),
  z.object({
    type: z.literal("status"),
    state: runWorkingStateSchema,
    attempt: z.number().int().nonnegative().nullable().default(null),
    message: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal("session.idle"), session_id: z.string() }),
  z.object({
    type: z.literal("run.warning"),
    code: runErrorCodeSchema,
    message: z.string().min(1).max(4_000),
    phase: runPhaseSchema.nullable().default(null),
  }),
  z.object({
    type: z.literal("run.error"),
    code: runErrorCodeSchema,
    message: z.string().min(1).max(4_000),
    phase: runPhaseSchema.nullable().default(null),
  }),
  /** Legacy PR #133 event; consumers accept it while producers migrate to `run.error`. */
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type RunChatEvent = z.infer<typeof runChatEventSchema>;

/** Persisted event record and SSE replay cursor. */
export const runEventEnvelopeSchema = z
  .object({
    sequence: z.number().int().positive(),
    event: runChatEventSchema,
    created_at: z.string(),
  })
  .strict();
export type RunEventEnvelope = z.infer<typeof runEventEnvelopeSchema>;

/* ---- Row shapes ------------------------------------------------------------------------ */

/** One run in the skill's Sessions tab (`GET /v1/skills/:slug/runs` — caller's runs only). */
export const skillRunRowSchema = z.object({
  id: z.string(),
  skill_slug: z.string(),
  /** Published skill version pinned at launch. */
  skill_version: z.string().nullable(),
  model: z.string(),
  prompt_excerpt: z.string(),
  status: skillRunStatusSchema,
  /** Kept during the PR #133 migration; new code should use phase/error fields below. */
  status_detail: z.string().nullable(),
  phase: runPhaseSchema.nullable().optional(),
  error_code: runErrorCodeSchema.nullable().optional(),
  error_message: z.string().nullable().optional(),
  run_config_id: runUuidSchema.nullable().optional(),
  run_config_name_snapshot: z.string().max(RUN_CONFIGURATION_NAME_MAX).nullable().optional(),
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
  input_snapshot: runInputSnapshotSchema.optional(),
});
export type SkillRunDetail = z.infer<typeof skillRunDetailSchema>;

export const skillRunsResponseSchema = z.object({ runs: z.array(skillRunRowSchema) });
export type SkillRunsResponse = z.infer<typeof skillRunsResponseSchema>;

/* ---- Request inputs -------------------------------------------------------------------- */

/** Body of `POST /v1/runs/:id/prompt` — persisted to the durable prompt outbox. */
export const runPromptInputSchema = z
  .object({
    text: z.string().trim().min(1).max(RUN_PROMPT_MAX),
  })
  .strict();
export type RunPromptInput = z.infer<typeof runPromptInputSchema>;

/**
 * Text fields of multipart `POST /v1/skills/:slug/runs`. Files arrive as repeated `file` parts.
 * `skill_version_id` makes stale launchers fail closed and `inputs` is the complete selection.
 */
export const launchRunFieldsSchema = z
  .object({
    prompt: z.string().trim().min(1).max(RUN_PROMPT_MAX),
    model: runModelIdSchema,
    skill_version_id: runUuidSchema,
    inputs: runInputSelectionJsonSchema,
    /** Optional provenance only; the selected payload remains authoritative. */
    run_config_id: runUuidSchema.nullable().optional(),
  })
  .strict();
export type LaunchRunFields = z.infer<typeof launchRunFieldsSchema>;
