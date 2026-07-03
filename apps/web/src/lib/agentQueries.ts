"use client";

import type {
  AffectedAgentsResponse,
  AgentDetail,
  AgentModelsResponse,
  AgentPendingOp,
  AgentSecretState,
  AgentsListResponse,
  CreateAgentInput,
  CreateAgentSessionResult,
  ProvisionProgress,
  WakeAgentResult,
} from "@companion/contracts";
import { apiFetch } from "./apiClient";

/** Thin, typed wrappers over the agents REST surface. ALL agent RPCs live here. */

export async function fetchAgents(lib: "mine" | "org"): Promise<AgentsListResponse> {
  return apiFetch<AgentsListResponse>(`/v1/agents?lib=${lib}`);
}

export async function fetchAgent(slug: string): Promise<AgentDetail> {
  return apiFetch<AgentDetail>(`/v1/agents/${encodeURIComponent(slug)}`);
}

/** Slim polling shape for the provisioning card (~750ms while the agent provisions). */
export async function fetchProvision(slug: string): Promise<ProvisionProgress> {
  return apiFetch<ProvisionProgress>(`/v1/agents/${encodeURIComponent(slug)}/provision`);
}

export async function createAgent(input: CreateAgentInput): Promise<AgentDetail> {
  return apiFetch<AgentDetail>("/v1/agents", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function retryProvision(slug: string): Promise<ProvisionProgress> {
  return apiFetch<ProvisionProgress>(`/v1/agents/${encodeURIComponent(slug)}/provision/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

/** Write-only secret values; `null` deletes a key. Values are never returned. */
export async function setAgentSecrets(
  slug: string,
  secrets: Record<string, string | null>,
): Promise<{ secrets: AgentSecretState[] }> {
  return apiFetch<{ secrets: AgentSecretState[] }>(`/v1/agents/${encodeURIComponent(slug)}/secrets`, {
    method: "PUT",
    body: JSON.stringify({ secrets }),
  });
}

export async function pauseAgent(slug: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/agents/${encodeURIComponent(slug)}/pause`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function wakeAgent(slug: string): Promise<WakeAgentResult> {
  return apiFetch<WakeAgentResult>(`/v1/agents/${encodeURIComponent(slug)}/wake`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function destroyAgent(slug: string, confirm: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(`/v1/agents/${encodeURIComponent(slug)}`, {
    method: "DELETE",
    body: JSON.stringify({ confirm }),
  });
}

/** Push the skill's latest version to one agent (pushing → restarting → updated | failed). */
export async function pushAgentSkill(slug: string, skillSlug: string): Promise<{ pending_op: AgentPendingOp }> {
  return apiFetch<{ pending_op: AgentPendingOp }>(
    `/v1/agents/${encodeURIComponent(slug)}/skills/${encodeURIComponent(skillSlug)}/push`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );
}

export async function fetchAgentModels(): Promise<AgentModelsResponse> {
  return apiFetch<AgentModelsResponse>("/v1/agents/models");
}

/** The skill-update fan-out payload: skill meta + the agents NOT on the latest version. */
export async function fetchSkillUpdates(skillSlug: string): Promise<AffectedAgentsResponse> {
  return apiFetch<AffectedAgentsResponse>(`/v1/agents/skill-updates/${encodeURIComponent(skillSlug)}`);
}

export async function createChatSession(slug: string, title?: string): Promise<CreateAgentSessionResult> {
  return apiFetch<CreateAgentSessionResult>(`/v1/agents/${encodeURIComponent(slug)}/sessions`, {
    method: "POST",
    body: JSON.stringify(title ? { title } : {}),
  });
}

/** Fire-and-forget prompt (202); the reply arrives over the `/events` SSE stream. */
export async function sendChatPrompt(slug: string, sessionId: string, text: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>(
    `/v1/agents/${encodeURIComponent(slug)}/sessions/${encodeURIComponent(sessionId)}/prompt`,
    {
      method: "POST",
      body: JSON.stringify({ text }),
    },
  );
}
