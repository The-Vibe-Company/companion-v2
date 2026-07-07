"use client";

import type {
  ModelsResponse,
  ProviderConnectionRow,
  ProviderConnectionsResponse,
  SkillRunDetail,
  SkillRunsResponse,
} from "@companion/contracts";
import { apiFetch } from "./apiClient";

/** Thin, typed wrappers over the skill-run + provider-connection REST surface. */

/** The models.dev catalog with per-provider connected flags (personal ∪ workspace). */
export async function fetchModels(): Promise<ModelsResponse> {
  return apiFetch<ModelsResponse>("/v1/models");
}

/* ---- Saved per-user model-provider connections (API keys) ---- */

export async function fetchProviderConnections(): Promise<ProviderConnectionsResponse> {
  return apiFetch<ProviderConnectionsResponse>("/v1/provider-connections");
}

/** Save/replace the current user's API key for a provider (write-only). */
export async function setProviderConnection(input: {
  provider: string;
  key_name: string;
  key: string;
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
  key: string;
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

/** Launch a run: multipart (prompt + model + up to 5 files). Returns the `starting` run detail. */
export async function launchRun(
  slug: string,
  input: { prompt: string; model: string; files: File[] },
): Promise<SkillRunDetail> {
  const form = new FormData();
  form.set("prompt", input.prompt);
  form.set("model", input.model);
  for (const file of input.files) form.append("file", file, file.name);
  return apiFetch<SkillRunDetail>(`/v1/skills/${encodeURIComponent(slug)}/runs`, {
    method: "POST",
    body: form,
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
export async function sendRunPrompt(runId: string, text: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/runs/${encodeURIComponent(runId)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text }),
  });
}

/** Download href for a run attachment (streamed by the API, creator-only). */
export function runAttachmentHref(runId: string, attachmentId: string): string {
  return `/v1/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}`;
}
