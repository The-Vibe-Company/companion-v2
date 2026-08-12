import { companionsEnabled } from "@companion/core";
import type {
  Companion,
  CompanionProvidersResponse,
  LabelsResponse,
  LocalSkillRow,
  SkillListRow,
} from "@companion/contracts";
import { notFound, redirect } from "next/navigation";
import { CompanionsApp } from "@/components/companions/CompanionsApp";
import { AuthUnavailable, WorkspaceLoadError } from "@/components/org/WorkspaceLoadError";
import { deriveTreeRows } from "@/components/skills/sidebarTree";
import { serverApiFetch } from "@/lib/apiServer";
import { loadOrgContext } from "@/lib/currentOrg";
import { loadServerAuth } from "@/lib/serverAuth";
import { mapSkill } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function CompanionsPage() {
  if (!companionsEnabled()) notFound();

  const authState = await loadServerAuth<{ needsOnboarding?: boolean }>();
  if (authState.status === "unauthenticated") redirect("/login");
  if (authState.status === "unavailable") return <AuthUnavailable />;
  if (authState.user.needsOnboarding) redirect("/onboarding");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return <WorkspaceLoadError />;
  const { orgs, current } = orgContext;
  if (!current) redirect("/onboarding");

  const headers = { "x-companion-org": current.id };
  const emptyLabels: LabelsResponse = { tree: [], flat: [] };
  const [
    mineRows,
    orgRows,
    personalLabels,
    orgLabels,
    localSkills,
    archivedMine,
    archivedOrg,
    companionsResponse,
    providers,
  ] =
    await Promise.all([
      serverApiFetch<SkillListRow[]>("/v1/skills?lib=mine", { headers }).catch(() => null),
      serverApiFetch<SkillListRow[]>("/v1/skills?lib=org", { headers }).catch(() => null),
      serverApiFetch<LabelsResponse>("/v1/personal-labels", { headers }).catch(() => emptyLabels),
      serverApiFetch<LabelsResponse>("/v1/labels", { headers }).catch(() => emptyLabels),
      serverApiFetch<LocalSkillRow[]>("/v1/local-skills", { headers }).catch(() => []),
      serverApiFetch<SkillListRow[]>("/v1/skills?lib=mine&archived=true", { headers }).catch(() => []),
      serverApiFetch<SkillListRow[]>("/v1/skills?lib=org&archived=true", { headers }).catch(() => []),
      serverApiFetch<{ companions: Companion[] }>("/v1/companions", { headers }).catch(() => null),
      serverApiFetch<CompanionProvidersResponse>("/v1/companion-providers", { headers }).catch(() => null),
    ]);
  if (!mineRows || !orgRows || !companionsResponse || !providers) return <WorkspaceLoadError />;

  const mineSkills = mineRows.map(mapSkill);
  const orgSkills = orgRows.map(mapSkill);
  return (
    <CompanionsApp
      orgs={orgs}
      currentOrg={current}
      initialCompanions={companionsResponse.companions}
      initialProviders={providers}
      navigation={{
        mineTreeRows: deriveTreeRows(
          mineSkills.filter((skill) => skill.source === "authored"),
          personalLabels.flat,
        ),
        orgTreeRows: deriveTreeRows(orgSkills, orgLabels.flat),
        mineCount: mineSkills.length,
        orgCount: orgSkills.length,
        installedCount: mineSkills.filter((skill) => skill.source === "installed").length,
        installedUpdateCount: mineSkills.filter(
          (skill) => skill.source === "installed" && skill.installStatus === "update",
        ).length,
        localUpdateCount: localSkills.filter((skill) => skill.status === "update").length,
        archivedCount: new Set([...archivedMine, ...archivedOrg].map((skill) => skill.id)).size,
      }}
    />
  );
}
