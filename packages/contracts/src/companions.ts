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
}).strict();
export type CreateCompanionInput = z.infer<typeof createCompanionInputSchema>;

export const companionProviderCredentialSchema = z.object({
  provider: z.string().trim().regex(/^[a-z][a-z0-9-]{0,62}$/),
  env_key: z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),
  value: z.string().min(1).max(32_768).refine((value) => !/[\r\n\0]/.test(value), {
    message: "credential value must be a single line",
  }),
}).strict();

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
  credentials: z.array(companionProviderCredentialSchema).max(20).default([]),
  mcp_accounts: z.array(companionMcpAccountSchema).max(50).default([]),
}).strict().superRefine((input, context) => {
  const seenEnvironmentKeys = new Set<string>();
  input.credentials.forEach((credential, index) => {
    if (seenEnvironmentKeys.has(credential.env_key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentials", index, "env_key"],
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
          message: `MCP environment reference ${envKey} has no matching credential`,
        });
      }
    });
  });
});
export type StartCompanionRuntimeInput = z.infer<typeof startCompanionRuntimeInputSchema>;

export const companionRuntimeStatusSchema = z.object({
  companion: companionSchema,
  source: z.enum(["control_plane", "box"]),
});
export type CompanionRuntimeStatus = z.infer<typeof companionRuntimeStatusSchema>;

