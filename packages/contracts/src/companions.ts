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

export const COMPANION_PROVIDER_CATALOG = [
  {
    id: "anthropic",
    name: "Claude",
    auth_methods: ["api_key", "subscription"],
    description: "Anthropic API key or Claude Pro/Max authentication exported by Pi.",
  },
  {
    id: "openai-codex",
    name: "Codex",
    auth_methods: ["subscription"],
    description: "ChatGPT Plus/Pro authentication exported by Pi.",
  },
  {
    id: "zai",
    name: "z.ai",
    auth_methods: ["api_key"],
    description: "z.ai API key, including Coding Plan keys.",
  },
] as const satisfies ReadonlyArray<{
  id: string;
  name: string;
  auth_methods: readonly CompanionProviderAuthMethod[];
  description: string;
}>;

export const companionProviderDefinitionSchema = z.object({
  id: companionProviderIdSchema,
  name: z.string(),
  auth_methods: z.array(companionProviderAuthMethodSchema),
  description: z.string(),
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

export const companionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  /** One short line describing what this Companion is for; shown under the name in the list. */
  persona: z.string().nullable(),
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

export const companionShareMemberSchema = z.object({
  user_id: z.string(),
  name: z.string(),
  email: z.string().email(),
  role: companionAccessSchema,
  is_owner: z.boolean(),
});
export type CompanionShareMember = z.infer<typeof companionShareMemberSchema>;

export const companionSharesSchema = z.object({
  companion_id: z.string().uuid(),
  workspace_role: companionShareRoleSchema.nullable(),
  members: z.array(companionShareMemberSchema),
});
export type CompanionShares = z.infer<typeof companionSharesSchema>;

export const setCompanionWorkspaceShareInputSchema = z.object({
  role: companionShareRoleSchema.nullable(),
}).strict();

export const inviteCompanionMemberInputSchema = z.object({
  email: z.string().trim().email().max(320),
  role: companionShareRoleSchema,
}).strict();

export const updateCompanionMemberRoleInputSchema = z.object({
  role: companionShareRoleSchema,
}).strict();

export const companionTranscriptEntrySchema = z.object({
  event_id: z.string().min(1).max(200),
  ordinal: z.number().int().nonnegative(),
  role: z.enum(["user", "assistant", "system"]),
  content: z.string(),
  /**
   * Member who sent a user message. A shared thread has several writers, so the reader compares
   * this against `viewer_id` instead of assuming every user message is its own. Null for Pi.
   */
  author_id: z.string().nullable(),
  author_name: z.string().nullable(),
  created_at: z.string().datetime(),
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

export const sendCompanionMessageInputSchema = z.object({
  content: z.string().trim().min(1).max(16_384),
}).strict();
export type SendCompanionMessageInput = z.infer<typeof sendCompanionMessageInputSchema>;

export const createCompanionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  persona: companionPersonaSchema.optional(),
  provider_id: companionProviderIdSchema.optional(),
}).strict();
export type CreateCompanionInput = z.infer<typeof createCompanionInputSchema>;

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

const subscriptionProviderAuthInputSchema = z.object({
  auth_method: z.literal("subscription"),
  credential: z.record(z.unknown()).refine(
    (credential) => credential.type === "oauth",
    "subscription credential must be a Pi OAuth auth.json entry",
  ).refine(
    (credential) => JSON.stringify(credential).length <= 65_536,
    "subscription credential is too large",
  ),
}).strict();

export const saveCompanionProviderInputSchema = z.discriminatedUnion("auth_method", [
  apiKeyProviderAuthInputSchema,
  subscriptionProviderAuthInputSchema,
]);
export type SaveCompanionProviderInput = z.infer<typeof saveCompanionProviderInputSchema>;

export const setDefaultCompanionProviderInputSchema = z.object({
  provider_id: companionProviderIdSchema,
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

export const companionClientSurfaceSchema = z.enum(["web", "mobile_web", "native_mobile"]);
export type CompanionClientSurface = z.infer<typeof companionClientSurfaceSchema>;

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

