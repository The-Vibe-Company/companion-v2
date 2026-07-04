import { redirect } from "next/navigation";
import { ChatApp } from "@/components/agents/ChatApp";
import { serverApiFetch } from "@/lib/apiServer";
import { requireWorkspaceAgentChat } from "@/lib/agentChatPage";
import { mapAgentDetail } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Full-viewport end-user chat surface for one agent in a specific workspace. */
export default async function WorkspaceAgentChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; slug: string }>;
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { workspaceSlug, slug } = await params;
  const { session } = await searchParams;
  const initialSessionId = (Array.isArray(session) ? session[0] : session)?.trim() || undefined;

  const whoami = await serverApiFetch("/v1/auth/whoami").catch(() => null);
  if (!whoami) redirect("/login");

  const { org, agent } = await requireWorkspaceAgentChat(workspaceSlug, slug);

  return <ChatApp agent={mapAgentDetail(agent)} orgId={org.id} orgName={org.name} initialSessionId={initialSessionId} />;
}
