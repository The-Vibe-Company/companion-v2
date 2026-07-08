import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { AgentModelsResponse, AgentsListResponse, LabelsResponse, SkillListRow } from "@companion/contracts";
import { loadOrgContext } from "@/lib/currentOrg";
import { serverApiFetch } from "@/lib/apiServer";
import { AgentsApp } from "@/components/agents/AgentsApp";
import { parseAgentsRoute } from "@/components/agents/route";
import { WorkspaceLoadError } from "@/components/org/WorkspaceLoadError";
import { mapSkill, type MeVM, type SkillVM } from "@/lib/types";

export const dynamic = "force-dynamic";

const EMPTY_LABELS: LabelsResponse = { tree: [], flat: [] };
const EMPTY_AGENTS: AgentsListResponse = {
  agents: [],
  summary: { total: 0, running: 0, sleeping: 0, provisioning: 0, error: 0, outdated: 0 },
  updates: [],
};
const EMPTY_MODELS: AgentModelsResponse = { models: [], providers: [] };

/** The web origin for agent chat URLs, computed server-side to avoid hydration drift. */
async function resolveAppOrigin(): Promise<string> {
  const env = process.env.COMPANION_WEB_URL;
  if (env) return env.replace(/\/+$/, "");
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host");
  if (!host) return "";
  const proto = h.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const initialRoute = parseAgentsRoute(params);
  const whoami = await serverApiFetch<{
    userId: string;
    email: string;
    name: string;
    avatarUrl?: string | null;
    needsOnboarding?: boolean;
  }>("/v1/auth/whoami").catch(() => null);
  if (!whoami) redirect("/login");
  if (whoami.needsOnboarding) redirect("/onboarding");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return <WorkspaceLoadError />;
  const { orgs, current } = orgContext;
  if (!current) redirect("/onboarding");
  const orgHeaders = { "x-companion-org": current.id };

  const [agentsMine, agentsOrg, skillsMine, skillsOrg, labels, personalLabels, models] = await Promise.all([
    serverApiFetch<AgentsListResponse>("/v1/agents?lib=mine", { headers: orgHeaders }).catch(() => null),
    serverApiFetch<AgentsListResponse>("/v1/agents?lib=org", { headers: orgHeaders }).catch(() => null),
    serverApiFetch<SkillListRow[]>("/v1/skills?lib=mine", { headers: orgHeaders }).catch(() => null),
    serverApiFetch<SkillListRow[]>("/v1/skills?lib=org", { headers: orgHeaders }).catch(() => null),
    serverApiFetch<LabelsResponse>("/v1/labels", { headers: orgHeaders }).catch(() => null),
    serverApiFetch<LabelsResponse>("/v1/personal-labels", { headers: orgHeaders }).catch(() => null),
    serverApiFetch<AgentModelsResponse>("/v1/agents/models", { headers: orgHeaders }).catch(() => null),
  ]);
  // Both agents lists are required (each drives a library the console can land on); everything
  // else degrades gracefully. If EITHER failed, we cannot render a trustworthy console.
  if (!agentsMine || !agentsOrg) return <WorkspaceLoadError />;

  const mineSkills = (skillsMine ?? []).map(mapSkill);
  const orgSkills = (skillsOrg ?? []).map(mapSkill);
  // Pickable registry: org skills + the caller's authored personal skills, non-archived with a version.
  const pickable = (s: SkillVM) => !s.archived && !!s.version;
  const registrySkills = [
    ...orgSkills.filter(pickable),
    ...mineSkills.filter((s) => s.scope === "personal" && s.source === "authored" && pickable(s)),
  ];

  const me: MeVM = {
    id: whoami.userId,
    name: whoami.name || whoami.email || "You",
    email: whoami.email,
    initials: (whoami.name?.[0] ?? whoami.email?.[0] ?? "?").toUpperCase(),
    avatarUrl: whoami.avatarUrl ?? null,
  };

  return (
    <AgentsApp
      initialRoute={initialRoute}
      initialMineAgents={agentsMine ?? EMPTY_AGENTS}
      initialOrgAgents={agentsOrg ?? EMPTY_AGENTS}
      initialModels={models ?? EMPTY_MODELS}
      registrySkills={registrySkills}
      mineSkills={mineSkills}
      orgSkills={orgSkills}
      initialPersonalLabels={personalLabels ?? EMPTY_LABELS}
      initialLabels={labels ?? EMPTY_LABELS}
      me={me}
      orgs={orgs}
      currentOrg={current}
      appOrigin={await resolveAppOrigin()}
    />
  );
}
