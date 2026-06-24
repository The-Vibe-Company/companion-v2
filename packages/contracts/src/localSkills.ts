import { z } from "zod";
import { SEMVER_RE } from "./frontmatter";

/**
 * "Companion skills" (local skills) — official helper skills Companion publishes for the user to
 * install on their machine or hand to a coding assistant. The catalog is built-in (currently one
 * entry, `companion`); only per-user install reports are persisted. Status is derived by comparing
 * the reported `installedVersion` against the bundled package's `availableVersion`.
 */

/** Install state for a local skill, from the caller's point of view. */
export const localSkillStatusSchema = z.enum(["none", "installed", "update"]);
export type LocalSkillStatus = z.infer<typeof localSkillStatusSchema>;

/** A capability the skill exposes ("What it can do"). */
export const localSkillCommandSchema = z.object({
  name: z.string(),
  desc: z.string(),
});
export type LocalSkillCommand = z.infer<typeof localSkillCommandSchema>;

/**
 * Prompt templates handed to the assistant. The client fills `{base}` (the API base URL),
 * `{workspaceId}` (organizations.id), and `{token}` (a freshly minted personal access token) before
 * copying or sending.
 */
export const localSkillPromptsSchema = z.object({
  install: z.string(),
  update: z.string(),
  use: z.string(),
});
export type LocalSkillPrompts = z.infer<typeof localSkillPromptsSchema>;

/** Denormalized read shape for the Companion skills view and the CLI. */
export const localSkillRowSchema = z.object({
  /** Companion workspace id (`organizations.id`) for local credential and lockfile keys. */
  workspaceId: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string(),
  status: localSkillStatusSchema,
  /** Version the caller last reported installing, or null if never installed. */
  installedVersion: z.string().nullable(),
  /** Version baked into the bundled package (the single source of truth). */
  availableVersion: z.string(),
  /** ISO timestamp of the caller's latest install report, or null. */
  lastReportedAt: z.string().nullable(),
  /** Optional source label the assistant reported. */
  agentLabel: z.string().nullable(),
  /** Markdown-compatible notes from the bundled skill's companion.json. */
  notes: z.string(),
  commands: z.array(localSkillCommandSchema),
  /** What changes in the available version (shown when status === "update"). */
  changes: z.array(z.string()),
  prompts: localSkillPromptsSchema,
});
export type LocalSkillRow = z.infer<typeof localSkillRowSchema>;

/** Body the local skill posts to `POST /v1/local-skills/:key/installed`. */
export const reportLocalSkillInstallInputSchema = z.object({
  version: z.string().regex(SEMVER_RE, "version must be a valid semver"),
  agent: z.string().min(1).max(120).optional(),
});
export type ReportLocalSkillInstallInput = z.infer<typeof reportLocalSkillInstallInputSchema>;

/** Response from the report endpoint. */
export const reportLocalSkillInstallResultSchema = z.object({
  ok: z.literal(true),
  status: localSkillStatusSchema,
  availableVersion: z.string(),
});
export type ReportLocalSkillInstallResult = z.infer<typeof reportLocalSkillInstallResultSchema>;
