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

export const companionSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
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
    last_observed_at: z.string().datetime().nullable(),
    last_started_at: z.string().datetime().nullable(),
    last_stopped_at: z.string().datetime().nullable(),
  }),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Companion = z.infer<typeof companionSchema>;

export const createCompanionInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
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

export const startCompanionRuntimeInputSchema = z.object({}).strict();
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

