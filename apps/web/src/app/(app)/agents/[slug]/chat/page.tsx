import { notFound, redirect } from "next/navigation";
import { agentChatHref } from "@/components/agents/route";
import { serverApiFetch } from "@/lib/apiServer";
import { findAgentWorkspace } from "@/lib/agentChatPage";
import { loadOrgContext } from "@/lib/currentOrg";

export const dynamic = "force-dynamic";

/** Legacy chat URL — redirects to the workspace-scoped route. */
export default async function AgentChatRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { slug } = await params;
  const { session } = await searchParams;
  const initialSessionId = (Array.isArray(session) ? session[0] : session)?.trim() || undefined;

  const whoami = await serverApiFetch("/v1/auth/whoami").catch(() => null);
  if (!whoami) redirect("/login");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext?.current) redirect("/onboarding");

  const org = await findAgentWorkspace(slug, orgContext.orgs);
  if (!org) notFound();

  const href = agentChatHref(org.slug, slug);
  redirect(initialSessionId ? `${href}?session=${encodeURIComponent(initialSessionId)}` : href);
}
