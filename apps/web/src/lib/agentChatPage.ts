import "server-only";
import { notFound } from "next/navigation";
import type { AgentDetail } from "@companion/contracts";
import { serverApiFetch } from "./apiServer";
import { loadOrgContext } from "./currentOrg";
import type { OrgVM } from "./types";

/** Find which of the caller's workspaces owns an agent slug (for legacy URL redirects). */
export async function findAgentWorkspace(slug: string, orgs: OrgVM[]): Promise<OrgVM | null> {
  for (const org of orgs) {
    const row = await serverApiFetch<AgentDetail>(`/v1/agents/${encodeURIComponent(slug)}`, {
      headers: { "x-companion-org": org.id },
    }).catch(() => null);
    if (row) return org;
  }
  return null;
}

/** Resolve an agent in a workspace by slug; sets the org cookie when found. */
export async function loadWorkspaceAgentChat(
  workspaceSlug: string,
  agentSlug: string,
): Promise<{ org: OrgVM; agent: AgentDetail } | null> {
  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return null;

  const org = orgContext.orgs.find((o) => o.slug === workspaceSlug);
  if (!org) return null;

  const row = await serverApiFetch<AgentDetail>(`/v1/agents/${encodeURIComponent(agentSlug)}`, {
    headers: { "x-companion-org": org.id },
  }).catch(() => null);
  if (!row) return null;

  return { org, agent: row };
}

export async function requireWorkspaceAgentChat(
  workspaceSlug: string,
  agentSlug: string,
): Promise<{ org: OrgVM; agent: AgentDetail }> {
  const loaded = await loadWorkspaceAgentChat(workspaceSlug, agentSlug);
  if (!loaded) notFound();
  return loaded;
}
