import { notFound, redirect } from "next/navigation";
import type { ModelsResponse, SkillListRow } from "@companion/contracts";
import { ProjectsApp } from "@/components/projects/ProjectsApp";
import {
  AuthUnavailable,
  WorkspaceLoadError,
} from "@/components/org/WorkspaceLoadError";
import {
  normalizeProjectDetail,
  normalizeProjectFilesResponse,
  normalizeProjectSessionResponse,
  normalizeProjectsResponse,
  type ProjectModelChoice,
  type ProjectSkillChoice,
} from "@/lib/projectsModel";
import { ServerApiError, serverApiFetch } from "@/lib/apiServer";
import { loadOrgContext } from "@/lib/currentOrg";
import { loadServerAuth } from "@/lib/serverAuth";
import { projectsFeatureEnabled } from "@/lib/projectsFeature";

export const dynamic = "force-dynamic";
export const metadata = { title: "Companion · Projects" };

function availableSkillChoices(
  mine: SkillListRow[],
  organization: SkillListRow[],
): ProjectSkillChoice[] {
  const choices = new Map<string, ProjectSkillChoice>();
  for (const skill of [...mine, ...organization]) {
    if (skill.archived || !skill.current_version || choices.has(skill.slug))
      continue;
    choices.set(skill.slug, {
      slug: skill.slug,
      name: skill.display.name ?? skill.slug,
      summary: skill.display.summary ?? skill.description,
      source: skill.scope === "personal" ? "My Skills" : "Organization",
      version: skill.current_version,
    });
  }
  return [...choices.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function availableModelChoices(
  response: ModelsResponse | null,
): ProjectModelChoice[] {
  if (!response) return [];
  const activated = new Set([
    ...response.activated.personal,
    ...response.activated.org,
  ]);
  const connected = new Set(
    response.providers
      .filter((provider) => provider.connected)
      .map((provider) => provider.id),
  );
  return response.models
    .filter((model) => activated.has(model.id) && connected.has(model.provider))
    .map((model) => ({
      id: model.id,
      name: model.name,
      providerName: model.provider_name,
    }))
    .sort(
      (left, right) =>
        left.providerName.localeCompare(right.providerName) ||
        left.name.localeCompare(right.name),
    );
}

export default async function ProjectsPage({
  params,
  searchParams,
}: {
  params: Promise<{ path?: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ path = [] }, query] = await Promise.all([params, searchParams]);
  const validRoute =
    path.length === 0 ||
    path.length === 1 ||
    (path.length === 3 && path[1] === "sessions");
  if (!validRoute) notFound();

  const authState = await loadServerAuth<{
    userId: string;
    email: string;
    name: string;
    avatarUrl?: string | null;
    needsOnboarding?: boolean;
  }>();
  if (authState.status === "unauthenticated") redirect("/login");
  if (authState.status === "unavailable") return <AuthUnavailable />;
  if (authState.user.needsOnboarding) redirect("/onboarding");
  if (!projectsFeatureEnabled(authState.user.email)) redirect("/skills");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return <WorkspaceLoadError />;
  const { orgs, current } = orgContext;
  if (!current) redirect("/onboarding");

  const headers = { "x-companion-org": current.id };
  const projectId = path[0] ?? null;
  const sessionId = path.length === 3 ? (path[2] ?? null) : null;
  const [projectsRaw, mineSkills, orgSkills, models] = await Promise.all([
    serverApiFetch<unknown>("/v1/projects", { headers }).catch(() => null),
    serverApiFetch<SkillListRow[]>("/v1/skills?lib=mine", { headers }).catch(
      () => null,
    ),
    serverApiFetch<SkillListRow[]>("/v1/skills?lib=org", { headers }).catch(
      () => null,
    ),
    serverApiFetch<ModelsResponse>("/v1/models", { headers }).catch(() => null),
  ]);
  if (!projectsRaw) return <WorkspaceLoadError />;
  const projects = normalizeProjectsResponse(projectsRaw);

  let project = null;
  let session = null;
  if (projectId) {
    try {
      const projectPath = `/v1/projects/${encodeURIComponent(projectId)}`;
      const [projectRaw, filesRaw] = await Promise.all([
        serverApiFetch<unknown>(projectPath, { headers }),
        serverApiFetch<unknown>(`${projectPath}/files`, { headers }),
      ]);
      project = {
        ...normalizeProjectDetail(projectRaw),
        files: normalizeProjectFilesResponse(filesRaw),
      };
    } catch (cause) {
      if (cause instanceof ServerApiError && cause.status === 404) notFound();
      return <WorkspaceLoadError />;
    }
    if (sessionId) {
      try {
        const raw = await serverApiFetch<unknown>(
          `/v1/projects/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(sessionId)}`,
          { headers },
        );
        session = normalizeProjectSessionResponse(raw);
      } catch (cause) {
        if (cause instanceof ServerApiError && cause.status === 404) notFound();
        return <WorkspaceLoadError />;
      }
    }
  }

  const skill = typeof query.skill === "string" ? query.skill : null;
  const initialDialog =
    query.new === "1"
      ? { kind: "new-project" as const, initialSkillSlug: skill }
      : project && !project.archivedAt && query.newSession === "1"
        ? {
            kind: "new-session" as const,
            projectId: project.id,
            initialSkillSlug: skill,
          }
        : project && query.settings === "1"
          ? { kind: "settings" as const, projectId: project.id }
          : null;
  return (
    <ProjectsApp
      initialProjects={projects.projects}
      initialProject={project}
      initialSession={session}
      availableSkills={availableSkillChoices(mineSkills ?? [], orgSkills ?? [])}
      availableModels={availableModelChoices(models)}
      runtime={projects.runtime}
      orgs={orgs}
      currentOrg={current}
      initialDialog={initialDialog}
      choiceErrors={{
        skills:
          mineSkills === null || orgSkills === null
            ? "Some Skills could not be loaded. Retry before changing the Project skill set."
            : null,
        models:
          models === null
            ? "Connected models could not be loaded. Retry before choosing a model."
            : null,
      }}
    />
  );
}
