import { hostname, platform } from "node:os";
import type { AgentHeartbeatInput, AgentHeartbeatOutput } from "@companion/contracts";
import { agentHeartbeatOutputSchema, COMPANION_AGENT_VERSION } from "@companion/contracts";
import { CliError } from "../lib/errors";
import type { AgentCredentials } from "./credentials";
import { readLocalInventory } from "./inventory";

export async function buildHeartbeatPayload(credentials: AgentCredentials): Promise<AgentHeartbeatInput> {
  const inventory = await readLocalInventory({ workspaceId: credentials.orgId, apiUrl: credentials.apiUrl });
  return {
    agent_version: COMPANION_AGENT_VERSION,
    platform: platform() as AgentHeartbeatInput["platform"],
    hostname: hostname() || "unknown-host",
    tools: inventory.tools ?? [],
    companion_skill_version: inventory.companionSkillVersion ?? null,
    inventory,
  };
}

export async function postHeartbeat(credentials: AgentCredentials, payload: AgentHeartbeatInput): Promise<AgentHeartbeatOutput> {
  const res = await fetch(`${credentials.apiUrl.replace(/\/$/, "")}/v1/agent/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${credentials.token}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `heartbeat failed: ${res.status}`;
    throw new CliError(message, res.status === 401 ? 3 : 8);
  }
  return agentHeartbeatOutputSchema.parse(json);
}
