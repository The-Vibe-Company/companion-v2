import { z } from "zod";

export const githubSyncModeSchema = z.enum(["all", "selected"]);
export type GitHubSyncMode = z.infer<typeof githubSyncModeSchema>;

export const githubSyncStatusSchema = z.enum(["pending", "syncing", "synced", "error", "disconnected"]);
export type GitHubSyncStatus = z.infer<typeof githubSyncStatusSchema>;

export const githubConnectionSchema = z.object({
  configured: z.boolean(),
  app_slug: z.string().nullable(),
  app_name: z.string(),
  managed: z.boolean(),
  connected: z.boolean(),
  github_login: z.string().nullable(),
  github_avatar_url: z.string().url().nullable(),
  connected_at: z.string().datetime().nullable(),
});
export type GitHubConnection = z.infer<typeof githubConnectionSchema>;

export const githubRepositoryCandidateSchema = z.object({
  installation_id: z.string(),
  repository_id: z.string(),
  owner: z.string(),
  name: z.string(),
  full_name: z.string(),
  html_url: z.string().url(),
  default_branch: z.string().nullable(),
  private: z.boolean(),
  empty: z.boolean(),
});
export type GitHubRepositoryCandidate = z.infer<typeof githubRepositoryCandidateSchema>;

export const githubInstallationSchema = z.object({
  installation_id: z.string(),
  owner: z.string(),
  owner_type: z.enum(["User", "Organization"]),
  avatar_url: z.string().url().nullable(),
});
export type GitHubInstallation = z.infer<typeof githubInstallationSchema>;

export const githubSyncDestinationSchema = z.object({
  id: z.string().uuid(),
  installation_id: z.string(),
  repository_id: z.string(),
  owner: z.string(),
  name: z.string(),
  full_name: z.string(),
  html_url: z.string().url(),
  default_branch: z.string(),
  private: z.boolean(),
  mode: githubSyncModeSchema,
  selected_skill_ids: z.array(z.string().uuid()),
  resolved_skill_count: z.number().int().nonnegative(),
  status: githubSyncStatusSchema,
  desired_revision: z.number().int().nonnegative(),
  applied_revision: z.number().int().nonnegative(),
  last_synced_at: z.string().datetime().nullable(),
  last_commit_sha: z.string().nullable(),
  last_error: z.string().nullable(),
  next_retry_at: z.string().datetime().nullable(),
});
export type GitHubSyncDestination = z.infer<typeof githubSyncDestinationSchema>;

export const githubIntegrationResponseSchema = z.object({
  connection: githubConnectionSchema,
  destinations: z.array(githubSyncDestinationSchema),
});
export type GitHubIntegrationResponse = z.infer<typeof githubIntegrationResponseSchema>;

export const githubSkillInclusionSchema = z.enum(["all", "selected", "dependency", "none"]);
export type GitHubSkillInclusion = z.infer<typeof githubSkillInclusionSchema>;

export const githubSkillSyncDestinationSchema = z.object({
  destination_id: z.string().uuid(),
  inclusion: githubSkillInclusionSchema,
});
export type GitHubSkillSyncDestination = z.infer<typeof githubSkillSyncDestinationSchema>;

export const githubSkillSyncRowSchema = z.object({
  skill_id: z.string().uuid(),
  slug: z.string(),
  display_name: z.string(),
  current_version: z.string().nullable(),
  destinations: z.array(githubSkillSyncDestinationSchema),
});
export type GitHubSkillSyncRow = z.infer<typeof githubSkillSyncRowSchema>;

export const githubSkillSyncResponseSchema = z.object({
  skills: z.array(githubSkillSyncRowSchema),
});
export type GitHubSkillSyncResponse = z.infer<typeof githubSkillSyncResponseSchema>;

export const githubSkillSelectionMutationResponseSchema = z.object({
  ok: z.literal(true),
  changed: z.boolean(),
});
export type GitHubSkillSelectionMutationResponse = z.infer<typeof githubSkillSelectionMutationResponseSchema>;

export const createGitHubRepositoryInputSchema = z.object({
  installation_id: z.string().min(1),
  owner: z.string().min(1).max(100),
  name: z.string().regex(/^[A-Za-z0-9._-]+$/).max(100),
  private: z.boolean().default(true),
});
export type CreateGitHubRepositoryInput = z.infer<typeof createGitHubRepositoryInputSchema>;

export const createGitHubDestinationInputSchema = z.object({
  installation_id: z.string().min(1),
  repository_id: z.string().min(1),
  owner: z.string().min(1).max(100),
  name: z.string().min(1).max(100),
  html_url: z.string().url(),
  default_branch: z.string().min(1).max(255).default("main"),
  private: z.boolean(),
  mode: githubSyncModeSchema,
  selected_skill_ids: z.array(z.string().uuid()).max(500).default([]),
  overwrite_confirmation: z.string().optional(),
  repository_empty: z.boolean().default(false),
}).superRefine((value, ctx) => {
  if (value.mode === "selected" && value.selected_skill_ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selected_skill_ids"], message: "select at least one skill" });
  }
  if (!value.repository_empty && value.overwrite_confirmation !== `${value.owner}/${value.name}`) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["overwrite_confirmation"], message: "confirm the repository name" });
  }
});
export type CreateGitHubDestinationInput = z.infer<typeof createGitHubDestinationInputSchema>;

export const updateGitHubDestinationInputSchema = z.object({
  mode: githubSyncModeSchema,
  selected_skill_ids: z.array(z.string().uuid()).max(500).default([]),
}).superRefine((value, ctx) => {
  if (value.mode === "selected" && value.selected_skill_ids.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["selected_skill_ids"], message: "select at least one skill" });
  }
});
export type UpdateGitHubDestinationInput = z.infer<typeof updateGitHubDestinationInputSchema>;

export const requestGitHubDestinationSyncInputSchema = z.object({
  resume_disconnected: z.boolean().default(false),
});
export type RequestGitHubDestinationSyncInput = z.infer<typeof requestGitHubDestinationSyncInputSchema>;
