"use client";

import type {
  CreateGitHubDestinationInput,
  CreateGitHubRepositoryInput,
  GitHubIntegrationResponse,
  GitHubInstallation,
  GitHubRepositoryCandidate,
  UpdateGitHubDestinationInput,
} from "@companion/contracts";
import { apiFetch } from "./apiClient";

export function fetchGitHubIntegration(): Promise<GitHubIntegrationResponse> {
  return apiFetch("/v1/integrations/github");
}

export function beginGitHubConnection(): Promise<{ url: string; install_url: string }> {
  return apiFetch("/v1/integrations/github/connect", { method: "POST", body: "{}" });
}

export function disconnectGitHubAccount(): Promise<{ ok: true }> {
  return apiFetch("/v1/integrations/github/account", { method: "DELETE" });
}

export function fetchGitHubRepositories(): Promise<{
  repositories: GitHubRepositoryCandidate[];
  installations: GitHubInstallation[];
  install_url: string;
}> {
  return apiFetch("/v1/integrations/github/repositories");
}

export function createGitHubRepository(input: CreateGitHubRepositoryInput): Promise<{ repository: GitHubRepositoryCandidate }> {
  return apiFetch("/v1/integrations/github/repositories", { method: "POST", body: JSON.stringify(input) });
}

export function createGitHubDestination(input: CreateGitHubDestinationInput): Promise<{ ok: true; id: string }> {
  return apiFetch("/v1/integrations/github/destinations", { method: "POST", body: JSON.stringify(input) });
}

export function updateGitHubDestination(id: string, input: UpdateGitHubDestinationInput): Promise<{ ok: true }> {
  return apiFetch(`/v1/integrations/github/destinations/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function syncGitHubDestination(id: string, resumeDisconnected = false): Promise<{ ok: true }> {
  return apiFetch(`/v1/integrations/github/destinations/${id}/sync`, {
    method: "POST",
    body: JSON.stringify({ resume_disconnected: resumeDisconnected }),
  });
}

export function deleteGitHubDestination(id: string): Promise<{ ok: true }> {
  return apiFetch(`/v1/integrations/github/destinations/${id}`, { method: "DELETE" });
}
