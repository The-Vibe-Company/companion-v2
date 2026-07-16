"use client";

import type {
  ActivatedModels,
  CreateRunConfigurationInput,
  ModelProviderConnectionRow,
  ModelProviderConnectionsResponse,
  ModelsResponse,
  RunConfiguration,
  RunDependencyPin,
  RunInputSelection,
  RunOptions,
  RunPreferences,
  RunPromptAccepted,
  RunPromptStatus,
  RunPrewarmResponse,
  RunPrewarmTicket,
  SkillRunDetail,
  SkillRunsResponse,
  UpdateRunConfigurationInput,
} from "@companion/contracts";
import {
  runPromptAcceptedSchema,
  skillRunDetailSchema,
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

/* ---- Dedicated model-provider credentials (write-only API keys) ---- */

export async function fetchModelProviderConnections(): Promise<ModelProviderConnectionsResponse> {
  return apiFetch<ModelProviderConnectionsResponse>("/v1/provider-connections");
}

/** Encrypt a personal provider key. It is write-only and never enters the generic Secrets vault. */
export async function setModelProviderConnection(input: {
  provider: string;
  key_name: string;
  api_key: string;
}): Promise<{ connection: ModelProviderConnectionRow }> {
  return apiFetch<{ connection: ModelProviderConnectionRow }>("/v1/provider-connections", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteModelProviderConnection(provider: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/provider-connections/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
}

/* ---- Workspace-shared provider connections (owner/admin write; any member reads) ---- */

export async function fetchOrgModelProviderConnections(): Promise<ModelProviderConnectionsResponse> {
  return apiFetch<ModelProviderConnectionsResponse>("/v1/org-provider-connections");
}

export async function setOrgModelProviderConnection(input: {
  provider: string;
  key_name: string;
  api_key: string;
}): Promise<{ connection: ModelProviderConnectionRow }> {
  return apiFetch<{ connection: ModelProviderConnectionRow }>("/v1/org-provider-connections", {
    method: "PUT",
    body: JSON.stringify(input),
  });
}

export async function deleteOrgModelProviderConnection(provider: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/org-provider-connections/${encodeURIComponent(provider)}`, {
    method: "DELETE",
  });
}

/* ---- Skill runs ---- */

export async function fetchRunOptions(slug: string): Promise<RunOptions> {
  return apiFetch<RunOptions>(`/v1/skills/${encodeURIComponent(slug)}/run-options`);
}

export async function updateRunPreferences(preferences: RunPreferences): Promise<RunPreferences> {
  return apiFetch<RunPreferences>("/v1/run-preferences", {
    method: "PATCH",
    body: JSON.stringify(preferences),
  });
}

export async function startRunPrewarm(slug: string): Promise<RunPrewarmTicket | null> {
  const response = await apiFetch<RunPrewarmResponse>(`/v1/skills/${encodeURIComponent(slug)}/run-prewarms`, {
    method: "POST",
  });
  return response.prewarm;
}

export async function heartbeatRunPrewarm(id: string): Promise<void> {
  try {
    await apiFetch<RunPrewarmResponse>(`/v1/run-prewarms/${encodeURIComponent(id)}/heartbeat`, {
      method: "POST",
    });
  } catch {
    // A stale ticket is a harmless cold miss at launch. Keep it so a transient heartbeat failure
    // does not prevent a later heartbeat or best-effort cancellation from reaching the server.
  }
}

/** Best-effort abandonment signal; missed requests are covered by the 30-second client lease. */
export function abandonRunPrewarm(id: string): void {
  void fetch(`/v1/run-prewarms/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
    credentials: "same-origin",
    keepalive: true,
  }).catch(() => undefined);
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
    dependencyPins: RunDependencyPin[];
    inputs: RunInputSelection;
    modelProviderConnectionId?: string;
    modelProviderCredentialVersion?: number;
    prewarmId?: string | null;
    runConfigId: string | null;
    files: File[];
    idempotencyKey: string;
  },
): Promise<SkillRunDetail> {
  const form = new FormData();
  form.set("prompt", input.prompt);
  form.set("model", input.model);
  form.set("skill_version_id", input.skillVersionId);
  form.set("dependency_pins", JSON.stringify(input.dependencyPins));
  form.set("inputs", JSON.stringify(input.inputs));
  if (input.modelProviderConnectionId) form.set("model_provider_connection_id", input.modelProviderConnectionId);
  if (input.modelProviderCredentialVersion) form.set("model_provider_credential_version", String(input.modelProviderCredentialVersion));
  if (input.prewarmId) form.set("prewarm_id", input.prewarmId);
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

/** Full run detail (transcript + attachments). Polled at 1.5s while `starting`. */
export async function fetchRun(runId: string): Promise<SkillRunDetail> {
  const response = await apiFetch<unknown>(`/v1/runs/${encodeURIComponent(runId)}`);
  return skillRunDetailSchema.parse(response);
}

/**
 * A rolling deploy can briefly pair this client with the previous prompt API. Keep that response
 * usable, but mark it so the chat refreshes instead of inventing a durable queue row the old API
 * cannot report or complete through `prompt.status` events.
 */
export type RunPromptAcceptedResult = RunPromptAccepted & { legacy: boolean };

export function normalizeRunPromptAccepted(response: unknown): RunPromptAcceptedResult {
  const current = runPromptAcceptedSchema.safeParse(response);
  if (current.success) return { ...current.data, legacy: false };

  if (!response || typeof response !== "object") throw current.error;
  const candidate = response as Record<string, unknown>;
  const attachments = Array.isArray(candidate.attachments)
    ? candidate.attachments.map((attachment) => (
        attachment && typeof attachment === "object"
          ? { preview_content_type: null, ...(attachment as Record<string, unknown>) }
          : attachment
      ))
    : candidate.attachments;
  const firstAttachment = Array.isArray(attachments) && attachments[0] && typeof attachments[0] === "object"
    ? attachments[0] as Record<string, unknown>
    : null;
  const legacy = runPromptAcceptedSchema.parse({
    ...candidate,
    // The previous API accepted exactly one prompt at a time and returned it as queued. Its
    // attachment rows still carry the exact ordinal; text-only prompts do not need one locally
    // because legacy acknowledgements bypass the new queue reconciliation below.
    ordinal: firstAttachment?.prompt_ordinal ?? 0,
    status: "queued",
    attachments,
  });
  return { ...legacy, legacy: true };
}

/** Fire-and-forget follow-up prompt (202); the reply arrives over the `/events` SSE stream. */
export async function sendRunPrompt(
  runId: string,
  text: string,
  files: File[],
  idempotencyKey: string,
  onUploadProgress?: (percent: number) => void,
): Promise<RunPromptAcceptedResult> {
  const form = new FormData();
  form.set("text", text);
  for (const file of files) form.append("file", file, file.name);
  if (onUploadProgress && files.length > 0 && typeof XMLHttpRequest !== "undefined") {
    return new Promise<RunPromptAcceptedResult>((resolve, reject) => {
      const request = new XMLHttpRequest();
      request.open("POST", `/v1/runs/${encodeURIComponent(runId)}/prompt`);
      request.setRequestHeader("Idempotency-Key", idempotencyKey);
      request.responseType = "json";
      request.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable && event.total > 0) {
          onUploadProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        }
      });
      request.addEventListener("load", () => {
        const response = request.response as RunPromptAccepted | { error?: string; message?: string } | null;
        if (request.status >= 200 && request.status < 300 && response) {
          onUploadProgress(100);
          try {
            resolve(normalizeRunPromptAccepted(response));
          } catch (error) {
            reject(error);
          }
          return;
        }
        const error = response && "message" in response ? response.message : response && "error" in response ? response.error : null;
        reject(new Error(error ?? `Request failed: ${request.status}`));
      });
      request.addEventListener("error", () => reject(new Error("The upload connection failed.")));
      request.addEventListener("abort", () => reject(new Error("The upload was interrupted.")));
      onUploadProgress(0);
      request.send(form);
    });
  }
  const response = await apiFetch<unknown>(`/v1/runs/${encodeURIComponent(runId)}/prompt`, {
    method: "POST",
    body: form,
    headers: { "Idempotency-Key": idempotencyKey },
  });
  return normalizeRunPromptAccepted(response);
}

export async function cancelRunPrompt(
  runId: string,
  promptId: string,
): Promise<{ prompt_id: string; status: RunPromptStatus; requested: boolean }> {
  return apiFetch(`/v1/runs/${encodeURIComponent(runId)}/prompts/${encodeURIComponent(promptId)}/cancel`, {
    method: "POST",
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
export function runAttachmentHref(runId: string, attachmentId: string, download = false): string {
  const base = `/v1/runs/${encodeURIComponent(runId)}/attachments/${encodeURIComponent(attachmentId)}`;
  return download ? `${base}?download=1` : base;
}

/** Creator-only artifact href. Raster images render inline unless download is forced. */
export function runArtifactHref(runId: string, artifactId: string, download = false): string {
  const base = `/v1/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`;
  return download ? `${base}?download=1` : base;
}
