import { z } from "zod";
import { SEMVER_RE, SKILL_NAME_RE, SKILL_REQUIREMENT_KEY_RE } from "./frontmatter";
import { modelRowSchema } from "./modelProviders";
import { secretCandidateSchema } from "./secrets";
import { sandboxUsageOverviewSchema } from "./billing";

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
export const RUN_ATTACHMENT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const RUN_ARTIFACT_MAX_FILES = 20;
export const RUN_ARTIFACT_MAX_BYTES = 10 * 1024 * 1024;
export const RUN_ARTIFACT_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const RUN_ARTIFACT_RETENTION_MS = 24 * 60 * 60 * 1_000;
export const RUN_MAX_DEPENDENCIES = 64;
export const RUN_MAX_SECRET_INPUTS = 128;
export const RUN_MAX_VARIABLE_INPUTS = 128;
export const RUN_VARIABLE_VALUE_MAX_BYTES = 32 * 1024;
export const RUN_CONFIGURATION_NAME_MAX = 120;
export const RUN_MODEL_ID_MAX = 240;
export const RUN_ERROR_CODE_MAX = 80;
export const RUN_WARNING_SNAPSHOT_MAX = 100;
export const RUN_REACTIVATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** Follow-ups waiting behind the active turn. The processing prompt is not included in this cap. */
export const RUN_PROMPT_MAX_QUEUED = 5;

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

export const skillRunStatusSchema = z.enum([
  "queued",
  "starting",
  "running",
  "frozen",
  "interrupted",
  "error",
  "canceled",
]);
export type SkillRunStatus = z.infer<typeof skillRunStatusSchema>;
export const runRuntimeStateSchema = z.enum(["healthy", "degraded"]);
export type RunRuntimeState = z.infer<typeof runRuntimeStateSchema>;

export const runPrewarmStatusSchema = z.enum(["queued", "warming", "ready", "failed", "canceled"]);
export type RunPrewarmStatus = z.infer<typeof runPrewarmStatusSchema>;

/** Browser-visible handle only. Provider identities and domains never leave the control plane. */
export const runPrewarmTicketSchema = z
  .object({
    id: runUuidSchema,
    status: runPrewarmStatusSchema,
    expires_at: z.string().datetime(),
  })
  .strict();
export type RunPrewarmTicket = z.infer<typeof runPrewarmTicketSchema>;

export const runPrewarmResponseSchema = z
  .object({ prewarm: runPrewarmTicketSchema.nullable() })
  .strict();
export type RunPrewarmResponse = z.infer<typeof runPrewarmResponseSchema>;

export const runPreferencesSchema = z.object({ prewarm_enabled: z.boolean() }).strict();
export type RunPreferences = z.infer<typeof runPreferencesSchema>;

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
  "freeze",
  "cancel",
  "cleanup",
  "complete",
]);
export type RunPhase = z.infer<typeof runPhaseSchema>;

/** Redacted, non-terminal warning retained after live-event rows expire. */
export const runWarningSnapshotSchema = z
  .object({
    code: runErrorCodeSchema,
    message: z.string().min(1).max(4_000),
    phase: runPhaseSchema.nullable().default(null),
  })
  .strict();
export type RunWarningSnapshot = z.infer<typeof runWarningSnapshotSchema>;

export const runSecretProvenanceSchema = z.enum(["skill", "runtime"]);
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

/** Exact dependency-version identity returned by run-options and echoed by the launch payload. */
export const runDependencyPinSchema = z
  .object({
    skill_id: runUuidSchema,
    skill_version_id: runUuidSchema,
  })
  .strict();
export type RunDependencyPin = z.infer<typeof runDependencyPinSchema>;

export const runDependencyPinsSchema = z
  .array(runDependencyPinSchema)
  .max(RUN_MAX_DEPENDENCIES)
  .superRefine((pins, ctx) => {
    const skillIds = new Set<string>();
    pins.forEach((pin, index) => {
      if (skillIds.has(pin.skill_id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "skill_id"],
          message: "duplicate dependency pin",
        });
      }
      skillIds.add(pin.skill_id);
    });
  });

/** Multipart fields encode dependency pins as JSON. */
export const runDependencyPinsJsonSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}, runDependencyPinsSchema);

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

/** Exact dedicated provider credential that will supply the model key; never contains plaintext. */
export const runModelProviderCredentialPinSchema = z
  .object({
    env_key: runEnvKeySchema,
    connection_id: runUuidSchema,
    credential_version: z.number().int().positive(),
    scope: z.enum(["personal", "organization"]),
  })
  .strict();
export type RunModelProviderCredentialPin = z.infer<typeof runModelProviderCredentialPinSchema>;

export const runModelOptionSchema = z
  .object({
    model: modelRowSchema,
    readiness: runModelReadinessSchema,
    message: z.string().max(2_000).nullable().default(null),
    provider_credential_pin: runModelProviderCredentialPinSchema.nullable().default(null),
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
    sandbox_usage: sandboxUsageOverviewSchema,
    preferences: runPreferencesSchema,
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
    if (value.provenance === "skill" && (!value.secret_id || !value.secret_version)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "skill snapshots require an exact secret version",
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

/** Redacted immutable reference to the dedicated model-provider credential used by a run. */
export const runModelProviderInputSnapshotSchema = z
  .object({
    provider: z.string().min(1).max(120),
    env_key: runEnvKeySchema,
    connection_id: runUuidSchema,
    credential_version: z.number().int().positive(),
    scope: z.enum(["personal", "organization"]),
  })
  .strict();
export type RunModelProviderInputSnapshot = z.infer<typeof runModelProviderInputSnapshotSchema>;

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
    model_provider: runModelProviderInputSnapshotSchema.nullable(),
  })
  .strict();
export type RunInputSnapshot = z.infer<typeof runInputSnapshotSchema>;

/* ---- Chat vocabulary ------------------------------------------------------------------- */

/** Persistence/SSE bounds are applied only after injected literals have been redacted. */
export const RUN_CHAT_ID_MAX = 512;
export const RUN_CHAT_NAME_MAX = 256;
export const RUN_CHAT_TITLE_MAX = 512;
export const RUN_CHAT_TOOL_INPUT_MAX = 2_000;
export const RUN_CHAT_TOOL_OUTPUT_MAX = 4_000;
export const RUN_CHAT_DELTA_MAX = 32_768;
export const RUN_CHAT_MESSAGE_MAX = 4_000;
export const RUN_CHAT_TRANSCRIPT_TEXT_MAX = 256 * 1024;

/** A prior message when reloading a run's transcript. */
export const runChatHistoryItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    text: z.string().max(RUN_CHAT_TRANSCRIPT_TEXT_MAX),
    /** Deterministic OpenCode id; absent only on transcripts persisted before attachment-aware chat. */
    message_id: z.string().max(RUN_CHAT_ID_MAX).optional(),
  }),
  z.object({
    kind: z.literal("assistant"),
    text: z.string().max(RUN_CHAT_TRANSCRIPT_TEXT_MAX),
    /** Stable OpenCode assistant message id; absent only on legacy persisted snapshots. */
    message_id: z.string().max(RUN_CHAT_ID_MAX).optional(),
  }),
  z.object({
    kind: z.literal("tool"),
    call_id: z.string().max(RUN_CHAT_ID_MAX),
    tool: z.string().max(RUN_CHAT_NAME_MAX),
    skill: z.string().max(RUN_CHAT_NAME_MAX).nullable().default(null),
    title: z.string().max(RUN_CHAT_TITLE_MAX).nullable().default(null),
    input: z.string().max(RUN_CHAT_TOOL_INPUT_MAX).default(""),
    output: z.string().max(RUN_CHAT_TOOL_OUTPUT_MAX).default(""),
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
  z.object({ type: z.literal("ready"), session_id: z.string().max(RUN_CHAT_ID_MAX) }),
  z.object({
    type: z.literal("tool.start"),
    call_id: z.string().max(RUN_CHAT_ID_MAX),
    skill: z.string().max(RUN_CHAT_NAME_MAX).nullable().default(null),
    tool: z.string().max(RUN_CHAT_NAME_MAX),
    title: z.string().max(RUN_CHAT_TITLE_MAX).nullable().default(null),
    input: z.string().max(RUN_CHAT_TOOL_INPUT_MAX).default(""),
  }),
  z.object({
    type: z.literal("tool.done"),
    call_id: z.string().max(RUN_CHAT_ID_MAX),
    title: z.string().max(RUN_CHAT_TITLE_MAX).nullable().default(null),
    output: z.string().max(RUN_CHAT_TOOL_OUTPUT_MAX).default(""),
    duration_ms: z.number().int().nonnegative().nullable().default(null),
  }),
  z.object({ type: z.literal("text.delta"), message_id: z.string().max(RUN_CHAT_ID_MAX), delta: z.string().max(RUN_CHAT_DELTA_MAX) }),
  z.object({ type: z.literal("text.done"), message_id: z.string().max(RUN_CHAT_ID_MAX) }),
  z.object({ type: z.literal("reasoning.delta"), part_id: z.string().max(RUN_CHAT_ID_MAX), delta: z.string().max(RUN_CHAT_DELTA_MAX) }),
  z.object({ type: z.literal("reasoning.done"), part_id: z.string().max(RUN_CHAT_ID_MAX) }),
  z.object({
    type: z.literal("status"),
    state: runWorkingStateSchema,
    attempt: z.number().int().nonnegative().nullable().default(null),
    message: z.string().max(RUN_CHAT_MESSAGE_MAX).nullable().default(null),
  }),
  z.object({ type: z.literal("session.idle"), session_id: z.string().max(RUN_CHAT_ID_MAX) }),
  z.object({ type: z.literal("artifacts.collecting") }),
  z.object({
    type: z.literal("artifacts.updated"),
    count: z.number().int().nonnegative().max(RUN_ARTIFACT_MAX_FILES),
    /**
     * Projects use the originating prompt as an idempotency key for their post-turn file
     * reconciliation signal. Skill Runs omit it.
     */
    prompt_id: runUuidSchema.optional(),
  }),
  z.object({
    type: z.literal("prompt.status"),
    prompt_id: runUuidSchema,
    message_id: z.string().max(RUN_CHAT_ID_MAX),
    ordinal: z.number().int().nonnegative(),
    status: z.enum(["queued", "processing", "cancel_requested", "completed", "error", "canceled"]),
  }),
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
  z.object({ type: z.literal("error"), message: z.string().max(RUN_CHAT_MESSAGE_MAX) }),
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
  created_at: z.string(),
  last_active_at: z.string().nullable(),
});
export type SkillRunRow = z.infer<typeof skillRunRowSchema>;

export const runFilePreviewKindSchema = z.enum([
  "text",
  "markdown",
  "csv",
  "image",
  "video",
  "pdf",
  "xlsx",
]);
export type RunFilePreviewKind = z.infer<typeof runFilePreviewKindSchema>;

export const skillRunAttachmentRowSchema = z.object({
  id: z.string(),
  prompt_id: runUuidSchema,
  message_id: z.string().max(RUN_CHAT_ID_MAX),
  prompt_ordinal: z.number().int().nonnegative(),
  file_name: z.string(),
  content_type: z.string(),
  preview_content_type: z.string().nullable().default(null),
  preview_kind: runFilePreviewKindSchema.nullable().optional(),
  byte_size: z.number().int().nonnegative(),
  created_at: z.string().datetime().optional(),
});
export type SkillRunAttachmentRow = z.infer<typeof skillRunAttachmentRowSchema>;

export const runPromptStatusSchema = z.enum([
  "queued",
  "processing",
  "cancel_requested",
  "completed",
  "error",
  "canceled",
]);
export type RunPromptStatus = z.infer<typeof runPromptStatusSchema>;

export const pendingRunPromptSchema = z
  .object({
    id: runUuidSchema,
    message_id: z.string().max(RUN_CHAT_ID_MAX),
    ordinal: z.number().int().nonnegative(),
    kind: z.enum(["initial", "follow_up"]),
    text: z.string().max(RUN_PROMPT_MAX),
    status: z.enum(["queued", "processing", "cancel_requested"]),
    created_at: z.string().datetime(),
    attachments: z.array(skillRunAttachmentRowSchema).max(RUN_ATTACHMENT_MAX_FILES),
  })
  .strict();
export type PendingRunPrompt = z.infer<typeof pendingRunPromptSchema>;

/** Creator-private cached output produced by a run. Bytes expire independently from the sandbox. */
export const skillRunArtifactRowSchema = z.object({
  id: runUuidSchema,
  file_name: z.string().min(1).max(255),
  path: z.string().min(1).max(1_024),
  content_type: z.string().min(1).max(255),
  byte_size: z.number().int().positive().max(RUN_ARTIFACT_MAX_BYTES),
  previewable: z.boolean(),
  preview_kind: runFilePreviewKindSchema.nullable().optional(),
  expires_at: z.string().datetime(),
  updated_at: z.string().datetime().optional(),
});
export type SkillRunArtifactRow = z.infer<typeof skillRunArtifactRowSchema>;

/** Full run for the chat/transcript view (`GET /v1/runs/:id`). */
export const skillRunDetailSchema = skillRunRowSchema.extend({
  prompt: z.string(),
  transcript: z.array(runChatHistoryItemSchema),
  warnings: z.array(runWarningSnapshotSchema).max(RUN_WARNING_SNAPSHOT_MAX),
  /** Highest replay sequence already folded into `transcript`. */
  transcript_event_sequence: z.number().int().nonnegative(),
  /** Monotonic generation used to distinguish a legitimate terminal -> queued transition. */
  activation_revision: z.number().int().nonnegative(),
  reactivatable_until: z.string().nullable(),
  can_reactivate: z.boolean(),
  /** Optional during the mixed-version rollout; new API replicas always populate both fields. */
  runtime_state: runRuntimeStateSchema.optional(),
  runtime_degraded_at: z.string().datetime().nullable().optional(),
  attachments: z.array(skillRunAttachmentRowSchema),
  pending_prompts: z.array(pendingRunPromptSchema).max(RUN_PROMPT_MAX_QUEUED + 1).default([]),
  artifacts: z.array(skillRunArtifactRowSchema).max(RUN_ARTIFACT_MAX_FILES),
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

/** Text fields of multipart `POST /v1/runs/:id/prompt`; files arrive as repeated `file` parts. */
export const runPromptFieldsSchema = z
  .object({
    text: z.string().trim().max(RUN_PROMPT_MAX).default(""),
  })
  .strict();
export type RunPromptFields = z.infer<typeof runPromptFieldsSchema>;

export const runPromptAcceptedSchema = z
  .object({
    accepted: z.literal(true),
    prompt_id: runUuidSchema,
    message_id: z.string().max(RUN_CHAT_ID_MAX),
    ordinal: z.number().int().nonnegative(),
    status: runPromptStatusSchema,
    attachments: z.array(skillRunAttachmentRowSchema).max(RUN_ATTACHMENT_MAX_FILES),
    reactivated: z.boolean(),
  })
  .strict();
export type RunPromptAccepted = z.infer<typeof runPromptAcceptedSchema>;
export const runPromptResponseSchema = runPromptAcceptedSchema;
export type RunPromptResponse = z.infer<typeof runPromptResponseSchema>;

export const runPromptCancellationResponseSchema = z
  .object({
    prompt_id: runUuidSchema,
    status: runPromptStatusSchema,
    requested: z.boolean(),
  })
  .strict();
export type RunPromptCancellationResponse = z.infer<typeof runPromptCancellationResponseSchema>;

/**
 * Text fields of multipart `POST /v1/skills/:slug/runs`. Files arrive as repeated `file` parts.
 * `skill_version_id` makes stale launchers fail closed. Secret ids are authoritative references;
 * their latest accessible versions and the current personal-then-workspace provider credential are
 * resolved transactionally when the run is committed. Legacy provider observations remain optional.
 */
export const launchRunFieldsSchema = z
  .object({
    prompt: z.string().trim().max(RUN_PROMPT_MAX),
    model: runModelIdSchema,
    skill_version_id: runUuidSchema,
    /** Exact non-root closure displayed by run-options; stale pins reject the launch. */
    dependency_pins: runDependencyPinsJsonSchema,
    inputs: runInputSelectionJsonSchema,
    model_provider_connection_id: runUuidSchema.optional(),
    model_provider_credential_version: z.coerce.number().int().positive().optional(),
    prewarm_id: runUuidSchema.optional(),
    /** Optional provenance only; the selected payload remains authoritative. */
    run_config_id: runUuidSchema.nullable().optional(),
  })
  .strict();
export type LaunchRunFields = z.infer<typeof launchRunFieldsSchema>;
