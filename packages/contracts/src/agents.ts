import { z } from "zod";
import { SKILL_NAME_RE, SEMVER_RE, SKILL_REQUIREMENT_KEY_RE } from "./frontmatter";

/**
 * Companion Agents (phase 1): an agent is a declared row of intent — a named, persistent sandbox
 * (forked from a golden snapshot with OpenCode pre-installed) that runs curated skills. Agents live
 * in one of two libraries (`scope`), mirroring skills: the flat org library (any member may manage)
 * or a private personal library (creator-only, no admin override).
 *
 * The database stores a coarse LIFECYCLE (`provisioning | ready | error`); the user-facing STATUS
 * (`running | sleeping`) is derived at read time from activity vs the sandbox timeout so that
 * rendering a list never wakes a sandbox.
 */

export const agentScopeSchema = z.enum(["personal", "org"]);
export type AgentScope = z.infer<typeof agentScopeSchema>;

export const agentLifecycleSchema = z.enum(["provisioning", "ready", "error"]);
export type AgentLifecycle = z.infer<typeof agentLifecycleSchema>;

/** Derived, user-facing status word (always paired with a dot + text in the UI). */
export const agentStatusSchema = z.enum(["provisioning", "running", "sleeping", "error"]);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

/* ---- Provisioning progress ---------------------------------------------------- */

export const PROVISION_STEP_KEYS = ["fork", "push", "serve", "health"] as const;
export const provisionStepKeySchema = z.enum(PROVISION_STEP_KEYS);
export type ProvisionStepKey = z.infer<typeof provisionStepKeySchema>;

export const provisionStepStateSchema = z.enum(["pending", "running", "done", "failed"]);
export type ProvisionStepState = z.infer<typeof provisionStepStateSchema>;

/** One row of the provisioning screen; persisted as `agents.provision_steps` jsonb. */
export const provisionStepSchema = z.object({
  key: provisionStepKeySchema,
  /** Human label, e.g. "Fork snapshot" / "Push 2 skills". */
  label: z.string(),
  /** Mono detail line, e.g. "golden-snap-08 → sb-01jb2k" / "opencode serve --port 4096". */
  detail: z.string().default(""),
  state: provisionStepStateSchema,
  duration_ms: z.number().int().nonnegative().nullable().default(null),
});
export type ProvisionStep = z.infer<typeof provisionStepSchema>;

/** Persisted as `agents.provision_error` jsonb; the fields the error block renders. */
export const provisionErrorSchema = z.object({
  message: z.string(),
  sandbox_name: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  /** Which step failed, as "push skills (2/4)"-style copy is derived client-side from steps. */
  step: provisionStepKeySchema.nullable().default(null),
  exit_code: z.number().int().nullable().default(null),
  /** Extra mono lines below the message (e.g. missing secret hint). */
  detail: z.string().nullable().default(null),
});
export type ProvisionError = z.infer<typeof provisionErrorSchema>;

/** Slim polling shape for the provisioning screen (`GET /v1/agents/:slug/provision`). */
export const provisionProgressSchema = z.object({
  lifecycle: agentLifecycleSchema,
  status: agentStatusSchema,
  attempt: z.number().int().positive(),
  steps: z.array(provisionStepSchema),
  error: provisionErrorSchema.nullable(),
});
export type ProvisionProgress = z.infer<typeof provisionProgressSchema>;

/* ---- Pending single-skill operation (push update) ------------------------------ */

export const agentPendingOpPhaseSchema = z.enum(["pushing", "restarting", "updated", "failed"]);
export type AgentPendingOpPhase = z.infer<typeof agentPendingOpPhaseSchema>;

/** Persisted as `agents.pending_op` jsonb while a skill push is in flight (409-guards a second op). */
export const agentPendingOpSchema = z.object({
  kind: z.literal("skill-push"),
  skill_slug: z.string(),
  from_version: z.string().nullable().default(null),
  to_version: z.string(),
  phase: agentPendingOpPhaseSchema,
  error: z.string().nullable().default(null),
  started_at: z.string(),
});
export type AgentPendingOp = z.infer<typeof agentPendingOpSchema>;

/* ---- Row shapes ----------------------------------------------------------------- */

/** One pinned skill on an agent. `outdated` is computed live vs the skill's current version. */
export const agentSkillPinSchema = z.object({
  skill_id: z.string(),
  slug: z.string(),
  version: z.string(),
  latest_version: z.string().nullable().default(null),
  outdated: z.boolean().default(false),
  position: z.number().int().nonnegative().default(0),
});
export type AgentSkillPin = z.infer<typeof agentSkillPinSchema>;

/** Secret state exposed to the UI: names only — values are write-only and never returned. */
export const agentSecretStateSchema = z.object({
  key: z.string(),
  set: z.boolean(),
  /** Skill slugs whose manifests require this key. */
  required_by: z.array(z.string()).default([]),
  required: z.boolean().default(true),
});
export type AgentSecretState = z.infer<typeof agentSecretStateSchema>;

/** Cached session summary (kept on the agent row so the detail view never wakes a sandbox). */
export const agentSessionSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  message_count: z.number().int().nonnegative(),
  last_at: z.string().nullable().default(null),
});
export type AgentSessionSummary = z.infer<typeof agentSessionSummarySchema>;

export const agentListRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  slug: z.string(),
  scope: agentScopeSchema,
  creator_id: z.string(),
  /** Free-form "Client" column value (e.g. "Monka"); null renders as the org name. */
  client_label: z.string().nullable(),
  /** Sidebar grouping label under the Agents root (e.g. "Ops"); color/icon derived client-side. */
  group_label: z.string().nullable(),
  description: z.string(),
  model: z.string(),
  region: z.string(),
  lifecycle: agentLifecycleSchema,
  status: agentStatusSchema,
  sandbox_name: z.string().nullable(),
  skills: z.array(agentSkillPinSchema),
  outdated_count: z.number().int().nonnegative(),
  sessions_count: z.number().int().nonnegative(),
  pending_op: agentPendingOpSchema.nullable().default(null),
  last_active_at: z.string().nullable(),
  created_at: z.string(),
});
export type AgentListRow = z.infer<typeof agentListRowSchema>;

export const agentDetailSchema = agentListRowSchema.extend({
  instructions: z.string(),
  /** Provider sandbox id (sb-…), for the Properties rail. The domain is never exposed. */
  sandbox_id: z.string().nullable(),
  golden_snapshot_id: z.string().nullable(),
  opencode_version: z.string().nullable(),
  last_resume_ms: z.number().int().nonnegative().nullable(),
  provision: z.object({
    attempt: z.number().int().positive(),
    steps: z.array(provisionStepSchema),
    error: provisionErrorSchema.nullable(),
  }),
  secrets: z.array(agentSecretStateSchema),
  sessions: z.array(agentSessionSummarySchema),
});
export type AgentDetail = z.infer<typeof agentDetailSchema>;

/** Library summary counts for the list header line. */
export const agentsSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  sleeping: z.number().int().nonnegative(),
  provisioning: z.number().int().nonnegative(),
  error: z.number().int().nonnegative(),
  outdated: z.number().int().nonnegative(),
});
export type AgentsSummary = z.infer<typeof agentsSummarySchema>;

/** One "a newer skill version affects agents" notice (drives the list banner). */
export const agentsUpdateNoticeSchema = z.object({
  skill_id: z.string(),
  slug: z.string(),
  latest_version: z.string(),
  affected_count: z.number().int().positive(),
  released_at: z.string().nullable().default(null),
});
export type AgentsUpdateNotice = z.infer<typeof agentsUpdateNoticeSchema>;

/** Response of `GET /v1/agents?lib=mine|org`. */
export const agentsListResponseSchema = z.object({
  agents: z.array(agentListRowSchema),
  summary: agentsSummarySchema,
  updates: z.array(agentsUpdateNoticeSchema),
});
export type AgentsListResponse = z.infer<typeof agentsListResponseSchema>;

/* ---- Inputs ---------------------------------------------------------------------- */

export const AGENT_SLUG_MAX = 40;
export const AGENT_INSTRUCTIONS_MAX = 20_000;
export const AGENT_SECRET_VALUE_MAX = 8_192;
/** Model ids are OpenCode-style `provider/model` refs (models.dev catalog). */
export const AGENT_MODEL_RE = /^[a-z0-9][a-z0-9_-]*\/[A-Za-z0-9][A-Za-z0-9_.:\/-]*$/;

/** Env var names the runtime owns — a user secret must never shadow these (would break the server). */
export const RESERVED_AGENT_SECRET_KEYS: readonly string[] = ["OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER_USERNAME"];

const agentSecretKeySchema = z
  .string()
  .regex(SKILL_REQUIREMENT_KEY_RE, "secret keys must look like environment variables (letters, digits, underscores)")
  .max(120)
  .refine((key) => !RESERVED_AGENT_SECRET_KEYS.includes(key), "this key name is reserved by the runtime");

/**
 * Body of `POST /v1/agents`. Creating an agent starts provisioning immediately. Missing required
 * secrets do NOT block creation — the push step fails with a designed, retryable error instead
 * (set the secret on the detail view, then retry).
 */
export const createAgentInputSchema = z.object({
  slug: z
    .string()
    .trim()
    .regex(SKILL_NAME_RE, "slug must be kebab-case (lowercase letters, digits, hyphens)")
    .max(AGENT_SLUG_MAX, `slug must be at most ${AGENT_SLUG_MAX} characters`),
  scope: agentScopeSchema.default("personal"),
  client_label: z.string().trim().max(80).optional(),
  group_label: z.string().trim().max(80).optional(),
  instructions: z.string().max(AGENT_INSTRUCTIONS_MAX).default(""),
  model: z.string().regex(AGENT_MODEL_RE, "model must be a provider/model id"),
  skills: z
    .array(z.object({ slug: z.string().regex(SKILL_NAME_RE) }))
    .min(1, "pick at least one skill")
    .max(20),
  /** Write-only secret values, keyed by env-var name. Encrypted at rest; never returned. */
  secrets: z.record(agentSecretKeySchema, z.string().min(1).max(AGENT_SECRET_VALUE_MAX)).default({}),
});
export type CreateAgentInput = z.infer<typeof createAgentInputSchema>;

/** Body of `PUT /v1/agents/:slug/secrets` — write-only; `null` deletes a key. */
export const updateAgentSecretsInputSchema = z.object({
  secrets: z.record(agentSecretKeySchema, z.string().min(1).max(AGENT_SECRET_VALUE_MAX).nullable()),
});
export type UpdateAgentSecretsInput = z.infer<typeof updateAgentSecretsInputSchema>;

/** Body of `DELETE /v1/agents/:slug` — the typed name must match exactly. */
export const destroyAgentInputSchema = z.object({
  confirm: z.string(),
});
export type DestroyAgentInput = z.infer<typeof destroyAgentInputSchema>;

/** Response of `POST /v1/agents/:slug/wake`. */
export const wakeAgentResultSchema = z.object({
  ok: z.literal(true),
  resume_ms: z.number().int().nonnegative().nullable(),
  status: agentStatusSchema,
});
export type WakeAgentResult = z.infer<typeof wakeAgentResultSchema>;

/* ---- Model catalog ---------------------------------------------------------------- */

/**
 * One pickable model (`GET /v1/agents/models`). The catalog is the FULL tool-capable models.dev
 * registry — the control plane never injects its own provider keys; each user supplies the chosen
 * model's key (`env_keys`) as a write-only agent secret.
 */
export const agentModelRowSchema = z.object({
  /** OpenCode model ref: `provider/model-id`. */
  id: z.string(),
  provider: z.string(),
  provider_name: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  context: z.number().int().nonnegative().nullable().default(null),
  /** USD per 1M tokens, when the catalog knows it. */
  cost_input: z.number().nonnegative().nullable().default(null),
  cost_output: z.number().nonnegative().nullable().default(null),
  /** Env var name(s) the provider accepts for its API key (any one suffices). */
  env_keys: z.array(z.string()).default([]),
});
export type AgentModelRow = z.infer<typeof agentModelRowSchema>;

export const agentModelsResponseSchema = z.object({
  models: z.array(agentModelRowSchema),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** Env var name(s) the provider's API key can be supplied under. */
      env_keys: z.array(z.string()).default([]),
      /** True when the current user has saved a connection (API key) for this provider. */
      connected: z.boolean().default(false),
    }),
  ),
});
export type AgentModelsResponse = z.infer<typeof agentModelsResponseSchema>;

/* ---- Provider connections (saved per-user model-provider API keys) ------------------- */

/** One saved provider connection (`GET /v1/provider-connections`) — key NAME + state only. */
export const providerConnectionRowSchema = z.object({
  provider: z.string(),
  key_name: z.string(),
  set: z.literal(true),
  created_at: z.string(),
});
export type ProviderConnectionRow = z.infer<typeof providerConnectionRowSchema>;

export const providerConnectionsResponseSchema = z.object({
  connections: z.array(providerConnectionRowSchema),
});
export type ProviderConnectionsResponse = z.infer<typeof providerConnectionsResponseSchema>;

/** Body of `PUT /v1/provider-connections` — save/replace a provider API key (write-only). */
export const setProviderConnectionInputSchema = z.object({
  provider: z.string().min(1).max(120),
  /** The env var name to store the key under (from the model catalog's `env_keys`). */
  key_name: agentSecretKeySchema,
  key: z.string().min(1).max(AGENT_SECRET_VALUE_MAX),
});
export type SetProviderConnectionInput = z.infer<typeof setProviderConnectionInputSchema>;

/* ---- Skill update fan-out ----------------------------------------------------------- */

/** Response of `GET /v1/agents/skill-updates/:skillSlug`. */
export const affectedAgentsResponseSchema = z.object({
  skill: z.object({
    id: z.string(),
    slug: z.string(),
    latest_version: z.string(),
    released_at: z.string().nullable().default(null),
    description: z.string().default(""),
    /** Best-effort changelog bullets from the version manifest; empty hides the section. */
    changelog: z.array(z.string()).default([]),
  }),
  agents: z.array(
    z.object({
      id: z.string(),
      slug: z.string(),
      scope: agentScopeSchema,
      status: agentStatusSchema,
      pinned_version: z.string(),
    }),
  ),
});
export type AffectedAgentsResponse = z.infer<typeof affectedAgentsResponseSchema>;

/** Body of `POST /v1/agents/:slug/skills/:skillSlug/push` (defaults to the latest version). */
export const pushAgentSkillInputSchema = z.object({
  version: z.string().regex(SEMVER_RE, "version must be a valid semver").optional(),
});
export type PushAgentSkillInput = z.infer<typeof pushAgentSkillInputSchema>;

/* ---- Chat ------------------------------------------------------------------------- */

export const agentPromptInputSchema = z.object({
  session_id: z.string().min(1),
  text: z.string().trim().min(1).max(8_000),
});
export type AgentPromptInput = z.infer<typeof agentPromptInputSchema>;

export const createAgentSessionResultSchema = z.object({
  session_id: z.string(),
});
export type CreateAgentSessionResult = z.infer<typeof createAgentSessionResultSchema>;

/** A prior message when reloading a session's history (`GET .../sessions/:id/messages`). */
export const agentChatHistoryItemSchema = z.discriminatedUnion("kind", [
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
export type AgentChatHistoryItem = z.infer<typeof agentChatHistoryItemSchema>;

export const agentSessionMessagesResponseSchema = z.object({
  items: z.array(agentChatHistoryItemSchema),
});
export type AgentSessionMessagesResponse = z.infer<typeof agentSessionMessagesResponseSchema>;

/**
 * Normalized chat event vocabulary streamed over `GET /v1/agents/:slug/events`.
 * The API translates pinned-SDK OpenCode events into this stable shape so OpenCode's near-daily
 * churn stays server-side, next to the pinned `@opencode-ai/sdk`.
 */
export const agentWorkingStateSchema = z.enum(["busy", "idle", "retry"]);
export type AgentWorkingState = z.infer<typeof agentWorkingStateSchema>;

export const agentChatEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), session_id: z.string() }),
  z.object({
    type: z.literal("tool.start"),
    call_id: z.string(),
    /** Best-effort skill slug when the tool run maps to an installed skill. */
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
    state: agentWorkingStateSchema,
    attempt: z.number().int().positive().nullable().default(null),
    message: z.string().nullable().default(null),
  }),
  z.object({ type: z.literal("session.idle"), session_id: z.string() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type AgentChatEvent = z.infer<typeof agentChatEventSchema>;
