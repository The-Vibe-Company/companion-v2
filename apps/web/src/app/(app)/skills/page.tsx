import { redirect } from "next/navigation";
import type { SkillFilterPreferences, SkillListRow } from "@companion/contracts";
import { loadOrgContext } from "@/lib/currentOrg";
import { serverApiFetch } from "@/lib/apiServer";
import { SkillsApp } from "@/components/skills/SkillsApp";
import { FirstRun } from "@/components/org/FirstRun";
import { WorkspaceLoadError } from "@/components/org/WorkspaceLoadError";
import { mapSkill, type MeVM, type TeamVM } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const whoami = await serverApiFetch<{ userId: string; email: string; name: string }>("/v1/auth/whoami").catch(() => null);
  if (!whoami) redirect("/login");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return <WorkspaceLoadError />;
  const { orgs, current } = orgContext;
  if (!current) return <FirstRun />;
  const orgHeaders = { "x-companion-org": current.id };

  const [skillsResult, filterPreferences, teamsResult] = await Promise.all([
    serverApiFetch<SkillListRow[]>("/v1/skills", { headers: orgHeaders }).catch(() => null),
    serverApiFetch<SkillFilterPreferences>("/v1/skill-filter-preferences", { headers: orgHeaders }).catch(() => null),
    serverApiFetch<Array<{ slug: string; name: string }>>("/v1/teams", { headers: orgHeaders }).catch(() => null),
  ]);
  if (!skillsResult || !filterPreferences || !teamsResult) return <WorkspaceLoadError />;
  const skills = skillsResult.map(mapSkill);

  const me: MeVM = {
    id: whoami.userId,
    name: whoami.name || whoami.email || "You",
    initials: (whoami.name?.[0] ?? whoami.email?.[0] ?? "?").toUpperCase(),
  };

  const teams: TeamVM[] = teamsResult.map((t) => ({
    id: t.slug,
    name: t.name,
    initial: (t.name[0] ?? "T").toUpperCase(),
  }));

  return (
    <SkillsApp
      initialSkills={skills}
      initialFilterPreferences={filterPreferences}
      me={me}
      teams={teams}
      orgs={orgs}
      currentOrg={current}
    />
  );
}
