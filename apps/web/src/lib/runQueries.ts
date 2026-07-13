"use client";

import type {
  ActivatedModels,
  CreateRunConfigurationInput,
  ModelsResponse,
  ProviderConnectionRow,
  ProviderConnectionsResponse,
  RunConfiguration,
  RunInputSelection,
  RunOptions,
  SkillRunDetail,
  SkillRunsResponse,
  UpdateRunConfigurationInput,
} from "@companion/contracts";
import { apiFetch } from "./apiClient";

/** Thin, typed wrappers over the skill-run + provider-connection REST surface. */

/** The models.dev catalog with per-provider connected flags (personal ∪ workspace). */
export async function fetchModels(): Promise<ModelsResponse> {
  return apiFetch<ModelsResponse>("/v1/models");
}

/* ---- Activated models (the curated lists the launcher's picker shows) ---- */

/** Replace the caller's personal activated-model list. */
export async function saveActivatedModels(models: string[]): Promise<{ activated: ActivatedModels }> {
  return apiFetch<{ activated: ActivatedModels }>("/v1/model-preferences", {
    method: "PUT",
    body: JSON.stringify({ models }),
  });
}

/** Replace the workspace-shared activated-model list (owner/admin only). */
export async function saveOrgActivatedModels(models: string[]): Promise<{ activated: ActivatedModels }> {
  return apiFetch<{ activated: ActivatedModels }>("/v1/org-model-preferences", {
    method: "PUT",
    body: JSON.stringify({ models }),
  });
}

/* ---- Saved per-user model-provider connections (API keys) ---- */

export async function fetchProviderConnections(): Promise<ProviderConnectionsResponse> {
  return apiFetch<ProviderConnectionsResponse>("/v1/provider-connections");
}

/** Bind a provider to an accessible vault secret. The secret value never crosses this route. */
export async function setProviderConnection(input: {
  provider: string;
  key_name: string;
  secret_id: string;
}): Promise<{ connection: ProviderConnectionRow }> {
  return apiFetch<{ connection: ProviderConnectionRow }>("/v1/provider-connections", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteProviderConnection(provider: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/provider-connections/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
}

/* ---- Workspace-shared provider connections (owner/admin write; any member reads) ---- */

export async function fetchOrgProviderConnections(): Promise<ProviderConnectionsResponse> {
  return apiFetch<ProviderConnectionsResponse>("/v1/org-provider-connections");
}

export async function setOrgProviderConnection(input: {
  provider: string;
  key_name: string;
  secret_id: string;
}): Promise<{ connection: ProviderConnectionRow }> {
  return apiFetch<{ connection: ProviderConnectionRow }>("/v1/org-provider-connections", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteOrgProviderConnection(provider: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/org-provider-connections/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
}

/* ---- Skill runs ---- */

export async function fetchRunOptions(slug: string): Promise<RunOptions> {
  return apiFetch<RunOptions>(`/v1/skills/${encodeURIComponent(slug)}/run-options`);
}

function unwrapConfiguration(value: RunConfiguration | { configuration: RunConfiguration }): RunConfiguration {
  return "configuration" in value ? value.configuration : value;
}

export async function createRunConfiguration(
  slug: string,
  input: CreateRunConfigurationInput,
): Promise<RunConfiguration> {
  const response = await apiFetch<RunConfiguration | { configuration: RunConfiguration }>(
    `/v1/skills/${encodeURIComponent(slug)}/run-configurations`,
    { method: "POST", body: JSON.stringify(input) },
  );
  return unwrapConfiguration(response);
}

export async function updateRunConfiguration(
  id: string,
  input: UpdateRunConfigurationInput,
): Promise<RunConfiguration> {
  const response = await apiFetch<RunConfiguration | { configuration: RunConfiguration }>(
    `/v1/run-configurations/${encodeURIComponent(id)}`,
    { method: "PATCH", body: JSON.stringify(input) },
  );
  return unwrapConfiguration(response);
}

export async function deleteRunConfiguration(id: string, revision: number): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/run-configurations/${encodeURIComponent(id)}`, {
    method: "DELETE",
    body: JSON.stringify({ revision }),
  });
}

/** Launch a run: multipart with a complete explicit input selection and idempotency key. */
export async function launchRun(
  slug: string,
  input: {
    prompt: string;
    model: string;
    skillVersionId: string;
    inputs: RunInputSelection;
    runConfigId: string | null;
    files: File[];
    idempotencyKey: string;
  },
): Promise<SkillRunDetail> {
  const form = new FormData();
  form.set("prompt", input.prompt);
  form.set("model", input.model);
  form.set("skill_version_id", input.skillVersionId);
  form.set("inputs", JSON.stringify(input.inputs));
  if (input.runConfigId) form.set("run_config_id", input.runConfigId);
  for (const file of input.files) form.append("file", file, file.name);
  return apiFetch<SkillRunDetail>(`/v1/skills/${encodeURIComponent(slug)}/runs`, {
    method: "POST",
    body: form,
    headers: { "Idempotency-Key": input.idempotencyKey },
  });
}

/** The caller's runs of one skill (Sessions tab), newest first. */
export async function fetchRuns(slug: string): Promise<SkillRunsResponse> {
  return apiFetch<SkillRunsResponse>(`/v1/skills/${encodeURIComponent(slug)}/runs`);
}

/** Full run detail (transcript + attachments + artifacts). Polled at 1.5s while `starting`. */
export async function fetchRun(runId: string): Promise<SkillRunDetail> {
  return apiFetch<SkillRunDetail>(`/v1/runs/${encodeURIComponent(runId)}`);
}

/** Fire-and-forget follow-up prompt (202); the reply arrives over the `/events` SSE stream. */
export async function sendRunPrompt(
  runId: string,
  text: string,
  idempotencyKey: string,
): Promise<{ accepted: true; prompt_id: string }> {
  return apiFetch<{ accepted: true; prompt_id: string }>(`/v1/runs/${encodeURIComponent(runId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
    headers: { "Idempotency-Key": idempotencyKey },
  });
}

export async function cancelRun(runId: string): Promise<SkillRunDetail> {
  const response = await apiFetch<
    SkillRunDetail | { run: SkillRunDetail } | { ok: true } | { status: string; requested: boolean }
  >(
    `/v1/runs/${encodeURIComponent(runId)}/cancel`,
    { method: "POST" },
  );
  if ("run" in response) return response.run;
  if ("id" in response) return response;
  return fetchRun(runId);
}

/** Download href for a run attachment (streamed by the API, creator-only). */
export function runAttachmentHref(runId: string, attachmentId: string): string {
  return `/v1/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
