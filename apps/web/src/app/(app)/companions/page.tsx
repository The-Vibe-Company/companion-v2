import { companionsAvailableToUser, companionsEnabled } from "@companion/core";
import type {
  Companion,
  CompanionPluginsResponse,
  SkillListRow,
} from "@companion/contracts";
import { notFound, redirect } from "next/navigation";
import { CompanionsApp } from "@/components/companions/CompanionsApp";
import { AuthUnavailable, WorkspaceLoadError } from "@/components/org/WorkspaceLoadError";
import { serverApiFetch } from "@/lib/apiServer";
import { loadOrgContext } from "@/lib/currentOrg";
import { loadServerAuth } from "@/lib/serverAuth";
import { initialsOf } from "@/lib/settingsViewModel";

export const dynamic = "force-dynamic";

/** A route address is one value; repeated query keys are ignored instead of guessed at. */
function singleSearchParam(value: string | string[] | undefined): string | null {
  return Array.isArray(value) ? null : value ?? null;
}

export default async function CompanionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (!companionsEnabled()) notFound();

  const resolvedSearchParams = await searchParams;
  const initialCompanionId = singleSearchParam(resolvedSearchParams.companion);
  const initialSettingsCompanionId = singleSearchParam(resolvedSearchParams.settings);
  const initialPluginsOpen = resolvedSearchParams.view === "plugins";

  const authState = await loadServerAuth<{
    userId: string;
    email: string;
    name?: string | null;
    avatarUrl?: string | null;
    needsOnboarding?: boolean;
  }>();
  if (authState.status === "unauthenticated") redirect("/login");
  if (authState.status === "unavailable") return <AuthUnavailable />;
  if (!companionsAvailableToUser(authState.user.email)) notFound();
  if (authState.user.needsOnboarding) redirect("/onboarding");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return <WorkspaceLoadError />;
  const { orgs, current } = orgContext;
  if (!current) redirect("/onboarding");

  const headers = { "x-companion-org": current.id };
  const [
    mineRows,
    orgRows,
    companionsResponse,
    plugins,
  ] =
    await Promise.all([
      // The context panel names and describes attached Skills. Keep the public library queries
      // separate, then union them without loading the hidden Skills trees or labels.
      serverApiFetch<SkillListRow[]>("/v1/skills?lib=mine", { headers }).catch(() => []),
      serverApiFetch<SkillListRow[]>("/v1/skills?lib=org", { headers }).catch(() => []),
      serverApiFetch<{ companions: Companion[] }>("/v1/companions", { headers }).catch(() => null),
      serverApiFetch<CompanionPluginsResponse>("/v1/companion-plugins", { headers }).catch(() => null),
    ]);
  if (!companionsResponse || !plugins) {
    return <WorkspaceLoadError />;
  }
  if (
    initialSettingsCompanionId
    && !companionsResponse.companions.some(
      (companion) => companion.id === initialSettingsCompanionId,
    )
  ) {
    notFound();
  }

  const viewerName = authState.user.name || authState.user.email || "You";
  const viewer = {
    id: authState.user.userId,
    name: viewerName,
    email: authState.user.email,
    initials: initialsOf(viewerName),
    avatarUrl: authState.user.avatarUrl ?? null,
  };

  // What the context panel can show for a Companion's attached Skills. An id not in here belongs to
  // somebody else's personal library, and the panel counts it rather than guessing at its details.
  const visibleSkills = [...new Map(
    [...mineRows, ...orgRows].map((skill) => [skill.id, {
      id: skill.id,
      slug: skill.slug,
      description: skill.description,
      scope: skill.scope,
    }]),
  ).values()];
  return (
    <CompanionsApp
      key={current.id}
      orgs={orgs}
      currentOrg={current}
      viewer={viewer}
      skills={visibleSkills}
      initialCompanions={companionsResponse.companions}
      initialProviders={null}
      initialPlugins={plugins.accounts}
      initialCompanionId={initialCompanionId}
      initialSettingsCompanionId={initialSettingsCompanionId}
      initialPluginsOpen={initialPluginsOpen}
      navigation={{
        // These fields belong to Skills mode and are deliberately absent from the Companions-mode
        // DOM. Keep the shared Sidebar contract without paying for hidden data on every switch.
        mineTreeRows: [],
        orgTreeRows: [],
        mineCount: 0,
        orgCount: 0,
        installedCount: 0,
        installedUpdateCount: 0,
        localUpdateCount: 0,
        archivedCount: 0,
      }}
    />
  );
}
