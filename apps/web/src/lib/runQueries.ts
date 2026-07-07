"use client";

import type {
  ModelsResponse,
  ProviderConnectionRow,
  ProviderConnectionsResponse,
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
