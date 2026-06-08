import { redirect } from "next/navigation";
import type { SkillListRow } from "@companion/contracts";
import { loadOrgContext } from "@/lib/currentOrg";
import { serverApiFetch } from "@/lib/apiServer";
import { SkillsApp } from "@/components/skills/SkillsApp";
import { mapSkill, type MeVM, type TeamVM } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const whoami = await serverApiFetch<{ userId: string; email: string; name: string; needsOnboarding?: boolean }>(
    "/v1/auth/whoami",
  ).catch(() => null);
  if (!whoami) redirect("/login");
  if (whoami.needsOnboarding) redirect("/onboarding");

  const { orgs, current } = await loadOrgContext();
  // A user who has finished onboarding always has an org; if not, send them (back) to onboarding.
  if (!current) redirect("/onboarding");
  const orgHeaders = { "x-companion-org": current.id };

  const skills = (await serverApiFetch<SkillListRow[]>("/v1/skills", { headers: orgHeaders })).map(mapSkill);

  const me: MeVM = {
    id: whoami.userId,
    name: whoami.name || whoami.email || "You",
    initials: (whoami.name?.[0] ?? whoami.email?.[0] ?? "?").toUpperCase(),
  };

  const teams: TeamVM[] = (await serverApiFetch<Array<{ slug: string; name: string }>>("/v1/teams", { headers: orgHeaders })).map((t) => ({
    id: t.slug,
    name: t.name,
    initial: (t.name[0] ?? "T").toUpperCase(),
  }));

  return <SkillsApp initialSkills={skills} me={me} teams={teams} orgs={orgs} currentOrg={current} />;
}
