import { notFound, redirect } from "next/navigation";
import type { AgentDetail } from "@companion/contracts";
import { ChatApp } from "@/components/agents/ChatApp";
import { serverApiFetch } from "@/lib/apiServer";
import { loadOrgContext } from "@/lib/currentOrg";
import { mapAgentDetail } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Full-viewport end-user chat surface for one agent — outside the console shell (no sidebar). */
export default async function AgentChatPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const whoami = await serverApiFetch("/v1/auth/whoami").catch(() => null);
  if (!whoami) redirect("/login");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext?.current) redirect("/onboarding");
  const current = orgContext.current;

  const row = await serverApiFetch<AgentDetail>(`/v1/agents/${encodeURIComponent(slug)}`, {
    headers: { "x-companion-org": current.id },
  }).catch(() => null);
  if (!row) notFound();

  return <ChatApp agent={mapAgentDetail(row)} orgName={current.name} />;
}
