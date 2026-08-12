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

export const startCompanionRuntimeInputSchema = z.object({
  credentials: z.array(companionProviderCredentialSchema).max(20).default([]),
}).strict().superRefine((input, context) => {
  const seen = new Set<string>();
  input.credentials.forEach((credential, index) => {
    if (seen.has(credential.env_key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["credentials", index, "env_key"],
        message: "credential env_key values must be unique",
      });
    }
    seen.add(credential.env_key);
  });
});
export type StartCompanionRuntimeInput = z.infer<typeof startCompanionRuntimeInputSchema>;

export const companionRuntimeStatusSchema = z.object({
  companion: companionSchema,
  source: z.enum(["control_plane", "box"]),
});
export type CompanionRuntimeStatus = z.infer<typeof companionRuntimeStatusSchema>;

