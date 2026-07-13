import { z } from "zod";
import { SKILL_REQUIREMENT_KEY_RE } from "./frontmatter";

/**
 * Model provider connections: saved per-user (and workspace-shared) model-provider API keys, plus
 * the model catalog surfaced by `GET /v1/models`. The catalog is the FULL tool-capable models.dev
 * registry — the control plane never injects its own provider keys; each user (or the workspace)
 * supplies the chosen model's key (`env_keys`) as a write-only connection, decrypted live at serve
 * time and never copied onto a run.
 */

/** The runtime owns this whole namespace; provider bindings must never shadow it. */
export const RESERVED_SECRET_KEY_PREFIX = "OPENCODE_SERVER_";

export const secretKeyNameSchema = z
  .string()
  .regex(SKILL_REQUIREMENT_KEY_RE, "secret keys must look like environment variables (letters, digits, underscores)")
  .max(120)
  .refine((key) => !key.startsWith(RESERVED_SECRET_KEY_PREFIX), "this key name is reserved by the runtime");

/* ---- Model catalog ---------------------------------------------------------------- */

/** One pickable model (`GET /v1/models`). */
export const modelRowSchema = z.object({
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
export type ModelRow = z.infer<typeof modelRowSchema>;

/**
 * Activated (curated) model ids per scope, pruned to the live catalog by the API. The effective
 * set a member can pick AND run = `personal ∪ org` (enforced hard in `createRun`).
 */
export const activatedModelsSchema = z.object({
  personal: z.array(z.string()).max(200).default([]),
  org: z.array(z.string()).max(200).default([]),
});
export type ActivatedModels = z.infer<typeof activatedModelsSchema>;

export const modelsResponseSchema = z.object({
  models: z.array(modelRowSchema),
  providers: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** Env var name(s) the provider's API key can be supplied under. */
      env_keys: z.array(z.string()).default([]),
      /** True when the current user (or the workspace) has saved a connection for this provider. */
      connected: z.boolean().default(false),
    }),
  ),
  activated: activatedModelsSchema.default({ personal: [], org: [] }),
});
export type ModelsResponse = z.infer<typeof modelsResponseSchema>;

/** Body of `PUT /v1/model-preferences` and `PUT /v1/org-model-preferences` — full replacement list. */
export const setActivatedModelsInputSchema = z.object({
  models: z.array(z.string().min(1).max(200)).max(200),
});
export type SetActivatedModelsInput = z.infer<typeof setActivatedModelsInputSchema>;

/* ---- Provider connections (saved model-provider API keys) ------------------------- */

/** One saved provider connection. It references vault metadata and never contains a value. */
export const providerConnectionRowSchema = z.object({
  provider: z.string(),
  key_name: z.string(),
  secret_id: z.string().uuid(),
  secret_name: z.string(),
  secret_audience: z.enum(["personal", "restricted", "organization"]),
  secret_owner_name: z.string(),
  set: z.literal(true),
  created_at: z.string(),
});
export type ProviderConnectionRow = z.infer<typeof providerConnectionRowSchema>;

export const providerConnectionsResponseSchema = z.object({
  connections: z.array(providerConnectionRowSchema),
});
export type ProviderConnectionsResponse = z.infer<typeof providerConnectionsResponseSchema>;

/** Body of `PUT /v1/provider-connections` — bind a provider to an accessible vault secret. */
export const setProviderConnectionInputSchema = z.object({
  provider: z.string().min(1).max(120),
  /** Env name expected by the provider (from the model catalog's `env_keys`). */
  key_name: secretKeyNameSchema,
  secret_id: z.string().uuid(),
}).strict();
export type SetProviderConnectionInput = z.infer<typeof setProviderConnectionInputSchema>;
