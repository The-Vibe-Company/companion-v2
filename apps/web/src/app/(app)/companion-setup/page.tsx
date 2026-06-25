import { redirect } from "next/navigation";
import type { LocalSkillRow } from "@companion/contracts";
import { serverApiFetch } from "@/lib/apiServer";
import { loadOrgContext } from "@/lib/currentOrg";
import { REQUIRED_LOCAL_SKILL_KEY, requiresCompanionSkillInstall } from "@/lib/companionSkillGate";
import { LocalSkillsView } from "@/components/skills/LocalSkillsView";
import { WorkspaceLoadError } from "@/components/org/WorkspaceLoadError";

export const dynamic = "force-dynamic";

export default async function CompanionSetupPage() {
  const whoami = await serverApiFetch<{ needsOnboarding?: boolean }>("/v1/auth/whoami").catch(() => null);
  if (!whoami) redirect("/login");
  if (whoami.needsOnboarding) redirect("/onboarding");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return <WorkspaceLoadError />;
  const { current } = orgContext;
  if (!current) redirect("/onboarding");

  const localSkills = await serverApiFetch<LocalSkillRow[]>("/v1/local-skills", {
    headers: { "x-companion-org": current.id },
  }).catch(() => null);
  if (!localSkills) return <WorkspaceLoadError />;
  if (!requiresCompanionSkillInstall(localSkills)) redirect("/skills");
  const companionSkill = localSkills.find((skill) => skill.key === REQUIRED_LOCAL_SKILL_KEY);
  if (!companionSkill) return <WorkspaceLoadError />;

  return (
    <LocalSkillsView
      skills={[companionSkill]}
      workspaceId={current.id}
      workspaceName={current.name}
      required
    />
  );
}
