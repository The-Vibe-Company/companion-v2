"use client";

import { apiFetch } from "./apiClient";

export interface AgentCapabilityGrantVM {
  id: string;
  capability: string;
  constraints: Record<string, unknown> | null;
  status: string;
  created_at: string;
  /** Null until Agent Auth persists canonical capability-level activity. */
  last_used_at: string | null;
}

export interface ConnectedAgentVM {
  id: string;
  name: string;
  status: string;
  host: { id: string; name: string; status: string };
  last_used_at: string | null;
  created_at: string;
  grants: AgentCapabilityGrantVM[];
}

function constraintRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function exactWorkspaceConstraint(constraints: Record<string, unknown> | null): string | null {
  if (!constraints) return null;
  const value = constraints.workspaceId;
  if (typeof value === "string") return value;
  const operators = constraintRecord(value);
  return operators && Object.keys(operators).length === 1 && typeof operators.eq === "string"
    ? operators.eq
    : null;
}

function constraintValueText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  const operators = constraintRecord(value);
  if (operators && Object.keys(operators).length === 1) {
    if (typeof operators.eq === "string" || typeof operators.eq === "number" || typeof operators.eq === "boolean") {
      return String(operators.eq);
    }
    if (Array.isArray(operators.in)) return `[${operators.in.map((entry) => JSON.stringify(entry)).join(", ")}]`;
  }
  return JSON.stringify(value);
}

/** Human-readable without collapsing operator objects to `[object Object]`. */
export function formatAgentConstraints(constraints: Record<string, unknown> | null): string {
  if (!constraints || Object.keys(constraints).length === 0) return "Instance-wide";
  return Object.entries(constraints)
    .map(([name, value]) => `${name}=${constraintValueText(value)}`)
    .join(", ");
}

export async function fetchConnectedAgents(): Promise<ConnectedAgentVM[]> {
  const result = await apiFetch<{ agents: ConnectedAgentVM[] }>("/v1/agent-auth/grants");
  return result.agents;
}

export async function revokeAgentGrant(id: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/v1/agent-auth/grants/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function revokeConnectedAgent(id: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/v1/agent-auth/agents/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export async function revokeAgentHost(id: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/v1/agent-auth/hosts/${encodeURIComponent(id)}`, { method: "DELETE" });
}
