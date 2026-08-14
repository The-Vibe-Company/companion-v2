import { z } from "zod";

export const companionRuntimeStateSchema = z.enum([
  "not_created",
  "provisioning",
  "running",
  "stopping",
  "stopped",
  "error",
]);
export type CompanionRuntimeState = z.infer<typeof companionRuntimeStateSchema>;

export const companionDaemonStateSchema = z.enum(["unknown", "starting", "running", "stopped", "error"]);
export type CompanionDaemonState = z.infer<typeof companionDaemonStateSchema>;

export const companionAccessSchema = z.enum(["owner", "editor", "viewer"]);
export type CompanionAccess = z.infer<typeof companionAccessSchema>;
export const companionShareRoleSchema = z.enum(["editor", "viewer"]);
export type CompanionShareRole = z.infer<typeof companionShareRoleSchema>;

export const companionProviderIdSchema = z.string().trim().regex(/^[a-z][a-z0-9-]{0,62}$/);
export type CompanionProviderId = z.infer<typeof companionProviderIdSchema>;

export const companionProviderAuthMethodSchema = z.enum(["api_key", "subscription"]);
export type CompanionProviderAuthMethod = z.infer<typeof companionProviderAuthMethodSchema>;

export const companionModelIdSchema = z.string().trim().min(1).max(200).refine(
  (value) => !/[\r\n\0]/.test(value),
  "Model id must be a single line",
);
export type CompanionModelId = z.infer<typeof companionModelIdSchema>;

export const COMPANION_PROVIDER_CATALOG = [
  {
    id: "anthropic",
    name: "Claude",
    auth_methods: ["api_key", "subscription"],
    description: "Anthropic API key or Claude Pro/Max browser authentication.",
    models: [
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", default: true },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "claude-haiku-4-5", name: "Claude Haiku 4.5" },
    ],
  },
  {
    id: "openai-codex",
    name: "Codex",
    auth_methods: ["subscription"],
    description: "ChatGPT Plus/Pro device authentication.",
    models: [
      { id: "gpt-5.5", name: "GPT-5.5", default: true },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ],
  },
  {
    id: "kimi-coding",
    name: "Kimi",
    auth_methods: ["api_key"],
    description: "Kimi For Coding API key.",
    models: [
      { id: "kimi-for-coding", name: "Kimi K2.7 Code", default: true },
      { id: "kimi-for-coding-highspeed", name: "Kimi For Coding HighSpeed" },
    ],
  },
  {
    id: "moonshotai",
    name: "Moonshot",
    auth_methods: ["api_key"],
    description: "Moonshot AI API key.",
    models: [
      { id: "kimi-k2.6", name: "Kimi K2.6", default: true },
      { id: "kimi-k2.7-code", name: "Kimi K2.7 Code" },
      { id: "kimi-k2.7-code-highspeed", name: "Kimi K2.7 Code HighSpeed" },
    ],
  },
  {
    id: "zai",
    name: "z.ai",
    auth_methods: ["api_key"],
    description: "z.ai API key, including Coding Plan keys.",
    models: [
      { id: "glm-4.7", name: "GLM-4.7", default: true },
      { id: "glm-5-turbo", name: "GLM-5-Turbo" },
    ],
  },
  {
    id: "openai",
    name: "OpenAI API",
    auth_methods: ["api_key"],
    description: "OpenAI API key.",
    models: [
      { id: "gpt-5.5", name: "GPT-5.5", default: true },
      { id: "gpt-5.4", name: "GPT-5.4" },
      { id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    ],
  },
  {
    id: "google",
    name: "Google Gemini",
    auth_methods: ["api_key"],
    description: "Google Gemini API key.",
    models: [
      { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview", default: true },
      { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
      { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    ],
  },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  auth_methods: readonly CompanionProviderAuthMethod[];
  description: string;
  models: ReadonlyArray<{ id: string; name: string; default?: true }>;
}>;

export function companionProviderDefaultModel(providerId: string): string | undefined {
  return COMPANION_PROVIDER_CATALOG
    .find((provider) => provider.id === providerId)
    ?.models.find((model) => "default" in model && model.default)?.id;
}

export function companionProviderHasModel(providerId: string, modelId: string): boolean {
  return COMPANION_PROVIDER_CATALOG
    .find((provider) => provider.id === providerId)
    ?.models.some((model) => model.id === modelId) ?? false;
}

export const companionProviderDefinitionSchema = z.object({
  id: companionProviderIdSchema,
  name: z.string(),
  auth_methods: z.array(companionProviderAuthMethodSchema),
  description: z.string(),
  models: z.array(z.object({
    id: companionModelIdSchema,
    name: z.string(),
    default: z.literal(true).optional(),
  }).strict()).min(1),
});
export type CompanionProviderDefinition = z.infer<typeof companionProviderDefinitionSchema>;

export const companionProviderConnectionSchema = z.object({
  provider_id: companionProviderIdSchema,
  auth_method: companionProviderAuthMethodSchema,
  connected_by: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type CompanionProviderConnection = z.infer<typeof companionProviderConnectionSchema>;

export const companionProvidersResponseSchema = z.object({
  catalog: z.array(companionProviderDefinitionSchema),
  connections: z.array(companionProviderConnectionSchema),
  default_provider_id: companionProviderIdSchema.nullable(),
  can_manage: z.boolean(),
});
export type CompanionProvidersResponse = z.infer<typeof companionProvidersResponseSchema>;

export const companionPersonaSchema = z.string().trim().max(280);

/** Exact Skills Hub skill ids a Companion may stage onto its Box. Empty = no library skills. */
export const companionSelectedSkillIdsSchema = z.array(z.string().uuid()).max(100);

/**
 * Exact already-connected MCP account ids a Companion may stage onto its Box.
 * Empty = no extra member MCP pins (adapter binary only).
 */
export const companionSelectedMcpAccountIdsSchema = z.array(z.string().uuid()).max(50);

export const companionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** One short line describing what this Companion is for; shown under the name in the list. */
  persona: z.string().nullable(),
  /** Null only for legacy rows created before a provider was selected. */
  model_id: companionModelIdSchema.nullable(),
  /**
   * Skills Hub packages this Companion is allowed to receive on its Box. The bundled Companion
   * agent skill is staged separately when the Box needs Skills Hub access and is not listed here.
   */
  selected_skill_ids: companionSelectedSkillIdsSchema,
  /**
   * When true, the Companion may publish and update skills on the owner's behalf. Off by default.
   */
  can_write_skills: z.boolean(),
  /**
   * Already-connected member MCP accounts this Companion may receive on its Box. Detach never
   * disconnects the workspace/member plugin; credentials stay write-only at connect time.
   */
  selected_mcp_account_ids: companionSelectedMcpAccountIdsSchema,
  owner_id: z.string(),
  access: companionAccessSchema,
  runtime: z.object({
    state: companionRuntimeStateSchema,
    daemon_state: companionDaemonStateSchema,
    box_id: z.string().nullable(),
    provider_ids: z.array(z.string()),
    provider_credential_generation: z.string().uuid().nullable(),
    disk_layout_version: z.number().int().positive(),
    desktop_available: z.boolean(),
    /**
     * One sanitized line explaining an `error` state, so the surface never shows a bare status
     * word. Null in every other state. A Viewer receives a generic line instead of the operator
     * detail, and no configuration or credential material appears here for anyone.
     */
    last_error: z.string().nullable(),
    last_observed_at: z.string().datetime().nullable(),
    last_started_at: z.string().datetime().nullable(),
    last_stopped_at: z.string().datetime().nullable(),
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Companion = z.infer<typeof companionSchema>;

/**
 * Companion sharing is workspace-only: access is `private` (no row), `viewer`, or `editor` for the
 * whole organization. There are no per-member grants and no email invites — those were cut in
 * THE-329. Personal workspaces hide sharing entirely because the owner is the only member.
 */
export const companionSharesSchema = z.object({
  companion_id: z.string().uuid(),
  workspace_role: companionShareRoleSchema.nullable(),
});
export type CompanionShares = z.infer<typeof companionSharesSchema>;

export const setCompanionWorkspaceShareInputSchema = z.object({
  role: companionShareRoleSchema.nullable(),
}).strict();

/**
 * What one tool run touched, so a chip can name it in a word and pick its icon. `computer` is the
 * Box desktop Lux drives; `tool` is the honest fallback for a name this catalog does not recognize,
 * because a chip that guesses wrong is worse than one that only says a run happened.
 */
export const companionToolRunKindSchema = z.enum(["shell", "file", "browse", "computer", "tool"]);
export type CompanionToolRunKind = z.infer<typeof companionToolRunKindSchema>;

/** A run is `running` until Pi reports its result; the chip spins until then. */
export const companionToolRunStatusSchema = z.enum(["running", "ok", "error"]);
export type CompanionToolRunStatus = z.infer<typeof companionToolRunStatusSchema>;

/**
 * How much of a Box frame a transcript will carry. One downscaled JPEG per visual run stays inside
 * the row it belongs to, so it is read by exactly the readers who may read the thread and is removed
 * with the Companion; anything larger is dropped rather than stored.
 */
export const COMPANION_TOOL_RUN_SCREENSHOT_MAX_CHARACTERS = 196_608;

/**
 * A `data:` image URL and nothing else. The transcript hands this string straight to an `img`, so
 * the shape is enforced here rather than trusted: no remote origin, no `javascript:`, no SVG.
 */
const COMPANION_TOOL_RUN_SCREENSHOT_PATTERN = /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * One tool run Pi performed inside a turn, projected from its RPC log. The chip reports the run; the
 * detail carries the arguments and the result excerpt behind a disclosure, and a visual run also
 * carries one frame of the Box desktop as it stood when the run ended.
 */
export const companionToolRunSchema = z.object({
  /** Pi's own id for the call, so the result that closes it finds the chip it belongs to. */
  call_id: z.string().min(1).max(200).nullable(),
  kind: companionToolRunKindSchema,
  /** Pi's tool name, verbatim, so an unrecognized tool still reports what actually ran. */
  name: z.string().min(1).max(120),
  /** One line naming what the run did: the command, the path, the URL. */
  title: z.string().max(300),
  status: companionToolRunStatusSchema,
  /** The disclosed body: arguments and the result excerpt, already truncated. */
  detail: z.string().max(16_000).nullable(),
  screenshot: z
    .string()
    .max(COMPANION_TOOL_RUN_SCREENSHOT_MAX_CHARACTERS)
    .regex(COMPANION_TOOL_RUN_SCREENSHOT_PATTERN)
    .nullable(),
}).strict();
export type CompanionToolRun = z.infer<typeof companionToolRunSchema>;

export const companionTranscriptEntrySchema = z.object({
  event_id: z.string().min(1).max(200),
  ordinal: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.string(),
  /**
   * Member who sent a user message. A shared thread has several writers, so the reader compares
   * this against `viewer_id` instead of assuming every user message is its own. Null for Pi.
   */
  author_id: z.string().nullable(),
  author_name: z.string().nullable(),
  /** Set on exactly the `tool` entries; every other role carries null. */
  tool: companionToolRunSchema.nullable().default(null),
  created_at: z.string().datetime(),
}).superRefine((entry, ctx) => {
  if ((entry.role === "tool") === (entry.tool !== null)) return;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    path: ["tool"],
    message: "a tool entry carries a tool run and no other role may",
  });
});
export type CompanionTranscriptEntry = z.infer<typeof companionTranscriptEntrySchema>;
export type CompanionTranscriptRole = CompanionTranscriptEntry["role"];

/**
 * One Companion owns exactly one chat thread. The payload is the control-plane read model, so a
 * Viewer reads it without any Box contact; `can_send` reflects the Owner/Editor run boundary and
 * `pending_count` counts messages Pi has not received yet.
 */
export const companionThreadSchema = z.object({
  companion_id: z.string().uuid(),
  /** The reader this payload was built for; entries authored by them render as their own. */
  viewer_id: z.string(),
  access: companionAccessSchema,
  read_only: z.boolean(),
  can_send: z.boolean(),
  entries: z.array(companionTranscriptEntrySchema),
  pending_count: z.number().int().nonnegative(),
  last_message_at: z.string().datetime().nullable(),
});
export type CompanionThread = z.infer<typeof companionThreadSchema>;

/**
 * One send, one turn. The sender names the message it is creating, and the control plane stores that
 * name as the transcript event id, so a request that arrives twice — a retried fetch, a proxy replay,
 * a client that resent the same submission — persists the same turn instead of a second one.
 */
export const companionClientMessageIdSchema = z.string().uuid();

/**
 * The transcript event id one client message id owns. Sent messages and projected Pi events keep
 * separate id namespaces, so a sender can never name an entry the Pi log will claim later, and the
 * message a composer shows before the control plane answers already carries its final id.
 */
export function companionMessageEventId(clientMessageId: string): string {
  return `msg:${clientMessageId}`;
}

export const companionClientSurfaceSchema = z.enum(["web", "mobile_web", "native_mobile"]);
export type CompanionClientSurface = z.infer<typeof companionClientSurfaceSchema>;

export const sendCompanionMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(16_384),
  client_message_id: companionClientMessageIdSchema.optional(),
  client_surface: companionClientSurfaceSchema.default("web"),
}).strict();
export type SendCompanionMessageInput = z.infer<typeof sendCompanionMessageInputSchema>;

export const createCompanionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  persona: companionPersonaSchema.optional(),
  provider_id: companionProviderIdSchema.optional(),
  model_id: companionModelIdSchema.optional(),
  selected_skill_ids: companionSelectedSkillIdsSchema.optional(),
  can_write_skills: z.boolean().optional(),
  selected_mcp_account_ids: companionSelectedMcpAccountIdsSchema.optional(),
}).strict();
export type CreateCompanionInput = z.infer<typeof createCompanionInputSchema>;

export const updateCompanionInputSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  persona: companionPersonaSchema.nullable().optional(),
  provider_id: companionProviderIdSchema.optional(),
  model_id: companionModelIdSchema.optional(),
  selected_skill_ids: companionSelectedSkillIdsSchema.optional(),
  can_write_skills: z.boolean().optional(),
  selected_mcp_account_ids: companionSelectedMcpAccountIdsSchema.optional(),
}).strict().refine(
  (input) =>
    input.name !== undefined
    || input.persona !== undefined
    || input.provider_id !== undefined
    || input.model_id !== undefined
    || input.selected_skill_ids !== undefined
    || input.can_write_skills !== undefined
    || input.selected_mcp_account_ids !== undefined,
  "At least one Companion setting is required",
);
export type UpdateCompanionInput = z.infer<typeof updateCompanionInputSchema>;

export const setCompanionProviderInputSchema = z.object({
  provider_id: companionProviderIdSchema,
}).strict();
export type SetCompanionProviderInput = z.infer<typeof setCompanionProviderInputSchema>;

const apiKeyProviderAuthInputSchema = z.object({
  auth_method: z.literal("api_key"),
  credential: z.string().min(1).max(32_768).refine((value) => !/[\r\n\0]/.test(value), {
    message: "API key must be a single line",
  }),
}).strict();

/**
 * The public credential write accepts API keys only. Subscription credentials are minted by the
 * server-side OAuth broker, so a browser can never submit or receive a Pi auth.json entry.
 */
export const saveCompanionProviderInputSchema = apiKeyProviderAuthInputSchema;
export type SaveCompanionProviderInput = z.infer<typeof saveCompanionProviderInputSchema>;

export const setDefaultCompanionProviderInputSchema = z.object({
  provider_id: companionProviderIdSchema,
}).strict();

export const companionProviderOAuthStartInputSchema = z.object({
  provider_id: z.enum(["anthropic", "openai-codex"]),
}).strict();
export type CompanionProviderOAuthStartInput = z.infer<
  typeof companionProviderOAuthStartInputSchema
>;

export const companionProviderOAuthStartResponseSchema = z.discriminatedUnion("flow", [
  z.object({
    flow: z.literal("authorization_code"),
    provider_id: z.literal("anthropic"),
    authorization_url: z.string().url(),
  }).strict(),
  z.object({
    flow: z.literal("device_code"),
    provider_id: z.literal("openai-codex"),
    verification_url: z.string().url(),
    user_code: z.string().min(1).max(128),
    poll_interval_seconds: z.number().int().min(1).max(60),
    expires_at: z.string().datetime(),
  }).strict(),
]);
export type CompanionProviderOAuthStartResponse = z.infer<
  typeof companionProviderOAuthStartResponseSchema
>;

export const companionProviderOAuthCompleteInputSchema = z.object({
  authorization_code: z.string().trim().min(1).max(4_096).refine(
    (value) => !/[\r\n\0]/.test(value),
    "authorization code must be a single line",
  ),
}).strict();

/**
 * Runtime environment value for a labeled MCP account. Model-provider authentication is resolved
 * from the encrypted workspace connection instead and never travels in a start request.
 */
export const companionMcpCredentialSchema = z.object({
  env_key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  value: z.string().min(1).max(32_768).refine((value) => !/[\r\n\0]/.test(value), {
    message: "credential value must be a single line",
  }),
}).strict();
export type CompanionMcpCredential = z.infer<typeof companionMcpCredentialSchema>;

const mcpRuntimeEnvKeySchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
const mcpEnvironmentBindingsSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  mcpRuntimeEnvKeySchema,
).default({});
const mcpHeaderBindingsSchema = z.record(
  z.string().trim().min(1).max(128).refine((value) => !/[\r\n:]/.test(value), {
    message: "header names must not contain control characters or a colon",
  }),
  mcpRuntimeEnvKeySchema,
).default({});

const companionMcpAccountBaseSchema = z.object({
  id: z.string().trim().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  label: z.string().trim().min(1).max(80),
  lifecycle: z.enum(["lazy", "eager", "keep-alive", "lazy-keep-alive"]).default("lazy"),
  direct_tools: z.union([z.boolean(), z.array(z.string().trim().min(1).max(128)).max(50)])
    .default(false),
});

export const companionMcpAccountSchema = z.discriminatedUnion("transport", [
  companionMcpAccountBaseSchema.extend({
    transport: z.literal("stdio"),
    command: z.string().trim().min(1).max(1_024).refine((value) => !/[\r\n\0]/.test(value), {
      message: "command must be a single line",
    }),
    args: z.array(z.string().max(8_192).refine((value) => !value.includes("\0"), {
      message: "arguments must not contain null bytes",
    })).max(100).default([]),
    env: mcpEnvironmentBindingsSchema,
  }).strict(),
  companionMcpAccountBaseSchema.extend({
    transport: z.literal("http"),
    url: z.string().url().max(4_096).refine(
      (value) => /^https?:\/\//i.test(value),
      { message: "MCP URL must use http or https" },
    ),
    headers: mcpHeaderBindingsSchema,
  }).strict(),
]);
export type CompanionMcpAccount = z.infer<typeof companionMcpAccountSchema>;

export const companionPluginTransportSchema = z.enum(["http", "stdio"]);

/**
 * One member-owned MCP connection. Authentication is deliberately write-only: ordinary reads
 * expose the provider, account label, and transport metadata, never the connector credential.
 */
export const companionPluginAccountSchema = z.object({
  id: z.string().uuid(),
  provider: z.string(),
  label: z.string(),
  transport: companionPluginTransportSchema,
  endpoint: z.string(),
  connected: z.literal(true),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
}).strict();
export type CompanionPluginAccount = z.infer<typeof companionPluginAccountSchema>;

export const companionPluginsResponseSchema = z.object({
  accounts: z.array(companionPluginAccountSchema),
}).strict();
export type CompanionPluginsResponse = z.infer<typeof companionPluginsResponseSchema>;

/**
 * The compact Plugins form supports the adapter's HTTP and stdio transports while keeping secret
 * values separate from durable transport metadata. `credential_name` is a header for HTTP and an
 * environment variable for stdio.
 */
export const saveCompanionPluginInputSchema = z.object({
  provider: z.string().trim().regex(/^[a-z][a-z0-9-]{0,62}$/),
  label: z.string().trim().min(1).max(40),
  transport: companionPluginTransportSchema,
  url: z.string().trim().url().max(4_096).refine(
    (value) => /^https?:\/\//i.test(value),
    { message: "MCP URL must use http or https" },
  ).optional(),
  command: z.string().trim().min(1).max(1_024).refine(
    (value) => !/[\r\n\0]/.test(value),
    { message: "command must be a single line" },
  ).optional(),
  args: z.array(z.string().max(8_192).refine((value) => !value.includes("\0"), {
    message: "arguments must not contain null bytes",
  })).max(100).default([]),
  credential_name: z.string().trim().min(1).max(128).refine(
    (value) => /^[A-Za-z_][A-Za-z0-9_-]{0,127}$/.test(value),
    { message: "credential name must be a header or environment variable name" },
  ).optional(),
  credential_value: z.string().min(1).max(32_768).refine(
    (value) => !/[\r\n\0]/.test(value),
    { message: "credential value must be a single line" },
  ).optional(),
}).strict().superRefine((input, context) => {
  if (input.transport === "http" && !input.url) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["url"], message: "HTTP MCP needs a URL" });
  }
  if (input.transport === "stdio" && !input.command) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["command"],
      message: "stdio MCP needs a command",
    });
  }
  if (Boolean(input.credential_name) !== Boolean(input.credential_value)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: [input.credential_name ? "credential_value" : "credential_name"],
      message: "credential name and value must be supplied together",
    });
  }
  if (
    input.transport === "stdio"
    && input.credential_name
    && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(input.credential_name)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["credential_name"],
      message: "stdio credential names must be environment variable names",
    });
  }
});
export type SaveCompanionPluginInput = z.infer<typeof saveCompanionPluginInputSchema>;

export const startCompanionRuntimeInputSchema = z.object({
  client_surface: companionClientSurfaceSchema.default("web"),
  mcp_credentials: z.array(companionMcpCredentialSchema).max(20).default([]),
  mcp_accounts: z.array(companionMcpAccountSchema).max(50).default([]),
}).strict().superRefine((input, context) => {
  const seenEnvironmentKeys = new Set<string>();
  input.mcp_credentials.forEach((credential, index) => {
    if (seenEnvironmentKeys.has(credential.env_key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcp_credentials", index, "env_key"],
        message: "credential env_key values must be unique",
      });
    }
    seenEnvironmentKeys.add(credential.env_key);
  });

  const seenAccountIds = new Set<string>();
  const seenLabels = new Set<string>();
  input.mcp_accounts.forEach((account, index) => {
    if (seenAccountIds.has(account.id)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcp_accounts", index, "id"],
        message: "MCP account ids must be unique",
      });
    }
    if (seenLabels.has(account.label.toLocaleLowerCase("en-US"))) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcp_accounts", index, "label"],
        message: "MCP account labels must be unique",
      });
    }
    seenAccountIds.add(account.id);
    seenLabels.add(account.label.toLocaleLowerCase("en-US"));

    const referencedKeys = account.transport === "stdio"
      ? Object.values(account.env)
      : Object.values(account.headers);
    referencedKeys.forEach((envKey) => {
      if (!seenEnvironmentKeys.has(envKey)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mcp_accounts", index, account.transport === "stdio" ? "env" : "headers"],
          message: `MCP environment reference ${envKey} has no matching mcp_credentials entry`,
        });
      }
    });
  });
});
export type StartCompanionRuntimeInput = z.infer<typeof startCompanionRuntimeInputSchema>;

export const companionProviderErrorSchema = z.object({
  code: z.enum([
    "provider_not_configured",
    "provider_model_invalid",
    "provider_auth_invalid",
    "provider_auth_expired",
    "provider_unavailable",
  ]),
  provider_id: companionProviderIdSchema.nullable(),
  message: z.string(),
});
export type CompanionProviderError = z.infer<typeof companionProviderErrorSchema>;

export const companionRuntimeStatusSchema = z.object({
  companion: companionSchema,
  source: z.enum(["control_plane", "box"]),
});
export type CompanionRuntimeStatus = z.infer<typeof companionRuntimeStatusSchema>;

/**
 * How the minted desktop URL carries the screen. VNC is a plain WebSocket stream that survives
 * networks which block peer-to-peer traffic, so it is asked for first; `webrtc` is the fallback Box
 * offers when a Box has no VNC stream to give.
 */
export const companionDesktopTransportSchema = z.enum(["vnc", "webrtc"]);
export type CompanionDesktopTransport = z.infer<typeof companionDesktopTransportSchema>;

/**
 * Owner/Editor handoff to the Box desktop. Computer use is that desktop driven by Lux and nothing
 * else, so the payload names the automation instead of leaving the surface to pick one. The URL is
 * secret-bearing and belongs to the authorized caller alone: it is never stored or logged, and it
 * is null while Box is still provisioning the desktop of a Box that is already running.
 *
 * Every request mints a fresh URL. Box rotates the stream token on each state change, so a stored
 * one is a URL that has already stopped working, and `transport` names which stream this mint got
 * rather than leaving the surface to guess at the one it was handed.
 */
export const companionDesktopSchema = z.object({
  desktop_url: z.string().url().nullable(),
  provisioning: z.boolean(),
  automation: z.literal("lux"),
  transport: companionDesktopTransportSchema.nullable(),
}).strict();
export type CompanionDesktop = z.infer<typeof companionDesktopSchema>;

