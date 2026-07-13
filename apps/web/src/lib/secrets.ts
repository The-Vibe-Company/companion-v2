"use client";

import type { CreateSecretInput, SecretRow, SkillSecretConfiguration, UpdateSecretInput } from "@companion/contracts";
import { apiFetch } from "./apiClient";

export function fetchSecrets(orgId: string): Promise<SecretRow[]> {
  return apiFetch("/v1/secrets", { headers: { "x-companion-org": orgId } });
}

export function createSecret(orgId: string, input: CreateSecretInput): Promise<SecretRow> {
  return apiFetch("/v1/secrets", {
    method: "POST",
    headers: { "x-companion-org": orgId },
    body: JSON.stringify(input),
  });
}

export function updateSecret(orgId: string, id: string, input: UpdateSecretInput): Promise<SecretRow> {
  return apiFetch(`/v1/secrets/${id}`, {
    method: "PATCH",
    headers: { "x-companion-org": orgId },
    body: JSON.stringify(input),
  });
}

export function rotateSecret(orgId: string, id: string, value: string): Promise<SecretRow> {
  return apiFetch(`/v1/secrets/${id}/rotate`, {
    method: "POST",
    headers: { "x-companion-org": orgId },
    body: JSON.stringify({ value }),
  });
}

export async function deleteSecret(orgId: string, id: string): Promise<void> {
  await apiFetch(`/v1/secrets/${id}`, { method: "DELETE", headers: { "x-companion-org": orgId } });
}

export function fetchSkillSecretConfiguration(slug: string): Promise<SkillSecretConfiguration> {
  return apiFetch(`/v1/skills/${encodeURIComponent(slug)}/secret-configuration`);
}

export function setSkillSecretBinding(slug: string, slotId: string, secretId: string): Promise<SkillSecretConfiguration> {
  return apiFetch(`/v1/skills/${encodeURIComponent(slug)}/secret-bindings/${slotId}`, {
    method: "PUT",
    body: JSON.stringify({ secret_id: secretId }),
  });
}

export function removeSkillSecretBinding(slug: string, slotId: string): Promise<SkillSecretConfiguration> {
  return apiFetch(`/v1/skills/${encodeURIComponent(slug)}/secret-bindings/${slotId}`, { method: "DELETE" });
}

export function setSkillSecretSuggestion(slug: string, slotId: string, secretId: string): Promise<SkillSecretConfiguration> {
  return apiFetch(`/v1/skills/${encodeURIComponent(slug)}/secret-suggestions/${slotId}`, {
    method: "PUT",
    body: JSON.stringify({ secret_id: secretId }),
  });
}

export function removeSkillSecretSuggestion(slug: string, slotId: string): Promise<SkillSecretConfiguration> {
  return apiFetch(`/v1/skills/${encodeURIComponent(slug)}/secret-suggestions/${slotId}`, { method: "DELETE" });
}

export function acceptSkillSecretSuggestion(slug: string, slotId: string): Promise<SkillSecretConfiguration> {
  return apiFetch(`/v1/skills/${encodeURIComponent(slug)}/secret-suggestions/${slotId}/accept`, { method: "POST" });
}
