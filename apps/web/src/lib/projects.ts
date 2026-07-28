"use client";

import { apiFetch } from "./apiClient";
import {
  normalizeProjectDetail,
  normalizeProjectFileVersionsResponse,
  normalizeProjectFilesResponse,
  normalizeProjectSessionResponse,
  normalizeProjectSessionsResponse,
  normalizeProjectsResponse,
  type ProjectDetailVM,
  type ProjectSessionVM,
} from "./projectsModel";

export type CreateProjectRequest = {
  name: string;
  defaultModel: string;
  skillSlugs: string[];
  idempotencyKey: string;
};

export type UpdateProjectRequest = {
  revision: number;
  name?: string;
  defaultModel?: string;
  archived?: boolean;
};

export type UpdateProjectSessionRequest = {
  title?: string;
  archived?: boolean;
  viewed?: true;
  stopActive?: boolean;
};

export type ListProjectSessionsRequest = {
  query?: string;
  view?: "active" | "archived";
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
};

export type CreateProjectSessionRequest = {
  prompt: string;
  model: string;
  files: File[];
  title?: string;
  idempotencyKey: string;
};

function projectPath(projectId: string): string {
  return `/v1/projects/${encodeURIComponent(projectId)}`;
}

function sessionPath(projectId: string, sessionId: string): string {
  return `${projectPath(projectId)}/sessions/${encodeURIComponent(sessionId)}`;
}

function promptBody(input: {
  prompt: string;
  model?: string;
  title?: string;
  files: File[];
}): FormData {
  const body = new FormData();
  body.set("prompt", input.prompt);
  if (input.model) body.set("model", input.model);
  if (input.title) body.set("title", input.title);
  for (const file of input.files) body.append("file", file, file.name);
  return body;
}

export async function fetchProjects(view: "active" | "archived" = "active") {
  const suffix = view === "active" ? "" : "?view=archived";
  return normalizeProjectsResponse(await apiFetch<unknown>(`/v1/projects${suffix}`));
}

export async function createProject(input: CreateProjectRequest): Promise<ProjectDetailVM> {
  return normalizeProjectDetail(await apiFetch<unknown>("/v1/projects", {
    method: "POST",
    body: JSON.stringify({
      name: input.name,
      default_model: input.defaultModel,
      skill_slugs: input.skillSlugs,
    }),
    headers: { "Idempotency-Key": input.idempotencyKey },
  }));
}

export async function fetchProjectFiles(projectId: string) {
  return normalizeProjectFilesResponse(
    await apiFetch<unknown>(`${projectPath(projectId)}/files`),
  );
}

export async function uploadProjectFiles(projectId: string, files: File[]) {
  const body = new FormData();
  for (const file of files) body.append("file", file, file.name);
  return normalizeProjectFilesResponse(
    await apiFetch<unknown>(`${projectPath(projectId)}/files`, {
      method: "POST",
      body,
    }),
  );
}

export async function fetchProjectFileVersions(
  projectId: string,
  fileId: string,
) {
  return normalizeProjectFileVersionsResponse(
    await apiFetch<unknown>(
      `${projectPath(projectId)}/files/${encodeURIComponent(fileId)}/versions`,
    ),
  );
}

export async function fetchProject(projectId: string): Promise<ProjectDetailVM> {
  const [rawProject, rawFiles] = await Promise.all([
    apiFetch<unknown>(projectPath(projectId)),
    fetchProjectFiles(projectId),
  ]);
  return {
    ...normalizeProjectDetail(rawProject),
    files: rawFiles,
  };
}

export async function updateProject(
  projectId: string,
  input: UpdateProjectRequest,
): Promise<ProjectDetailVM> {
  const [rawProject, files] = await Promise.all([
    apiFetch<unknown>(projectPath(projectId), {
      method: "PATCH",
      body: JSON.stringify({
        revision: input.revision,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.defaultModel !== undefined ? { default_model: input.defaultModel } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
      }),
    }),
    fetchProjectFiles(projectId),
  ]);
  return { ...normalizeProjectDetail(rawProject), files };
}

export async function retryProjectWorkspace(
  projectId: string,
): Promise<ProjectDetailVM> {
  const [rawProject, files] = await Promise.all([
    apiFetch<unknown>(`${projectPath(projectId)}/retry`, {
      method: "POST",
    }),
    fetchProjectFiles(projectId),
  ]);
  return { ...normalizeProjectDetail(rawProject), files };
}

export async function deleteProject(projectId: string): Promise<void> {
  await apiFetch<unknown>(projectPath(projectId), { method: "DELETE" });
}

export async function replaceProjectSkills(
  projectId: string,
  revision: number,
  skillSlugs: string[],
): Promise<ProjectDetailVM> {
  const [rawProject, files] = await Promise.all([
    apiFetch<unknown>(`${projectPath(projectId)}/skills`, {
      method: "PUT",
      body: JSON.stringify({ revision, skill_slugs: skillSlugs }),
    }),
    fetchProjectFiles(projectId),
  ]);
  return { ...normalizeProjectDetail(rawProject), files };
}

/** Attach one skill without accidentally removing the project's existing closure. */
export async function ensureProjectSkill(projectId: string, slug: string): Promise<ProjectDetailVM> {
  let project = await fetchProject(projectId);
  if (project.skills.some((skill) => skill.slug === slug)) return project;
  const skillSlugs = [...project.skills.map((skill) => skill.slug), slug];
  try {
    return await replaceProjectSkills(projectId, project.revision, skillSlugs);
  } catch (cause) {
    // Project settings use optimistic revisions. A concurrent edit is safe to
    // resolve once by rebuilding the union from the latest exact skill set.
    if (!(cause instanceof Error) || !("status" in cause) || cause.status !== 409) throw cause;
    project = await fetchProject(projectId);
    if (project.skills.some((skill) => skill.slug === slug)) return project;
    return replaceProjectSkills(
      projectId,
      project.revision,
      [...project.skills.map((skill) => skill.slug), slug],
    );
  }
}

export async function fetchProjectSession(
  projectId: string,
  sessionId: string,
): Promise<ProjectSessionVM> {
  return normalizeProjectSessionResponse(await apiFetch<unknown>(sessionPath(projectId, sessionId)));
}

export async function fetchProjectSessions(
  projectId: string,
  input: ListProjectSessionsRequest = {},
): Promise<{ sessions: ProjectSessionVM[]; nextCursor: string | null }> {
  const query = new URLSearchParams();
  if (input.query?.trim()) query.set("q", input.query.trim());
  query.set("view", input.view ?? "active");
  if (input.cursor) query.set("cursor", input.cursor);
  query.set("limit", String(input.limit ?? 50));
  return normalizeProjectSessionsResponse(
    await apiFetch<unknown>(
      `${projectPath(projectId)}/sessions?${query.toString()}`,
      { signal: input.signal },
    ),
  );
}

export async function updateProjectSession(
  projectId: string,
  sessionId: string,
  input: UpdateProjectSessionRequest,
): Promise<ProjectSessionVM> {
  return normalizeProjectSessionResponse(
    await apiFetch<unknown>(sessionPath(projectId, sessionId), {
      method: "PATCH",
      body: JSON.stringify({
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.archived !== undefined ? { archived: input.archived } : {}),
        ...(input.viewed !== undefined ? { viewed: input.viewed } : {}),
        ...(input.stopActive !== undefined
          ? { stop_active: input.stopActive }
          : {}),
      }),
    }),
  );
}

export async function createProjectSession(
  projectId: string,
  input: CreateProjectSessionRequest,
): Promise<ProjectSessionVM> {
  return normalizeProjectSessionResponse(await apiFetch<unknown>(`${projectPath(projectId)}/sessions`, {
    method: "POST",
    body: promptBody(input),
    headers: { "Idempotency-Key": input.idempotencyKey },
  }));
}

export async function sendProjectPrompt(
  projectId: string,
  sessionId: string,
  input: { prompt: string; model: string; files: File[]; idempotencyKey: string },
): Promise<ProjectSessionVM> {
  return normalizeProjectSessionResponse(await apiFetch<unknown>(`${sessionPath(projectId, sessionId)}/prompts`, {
    method: "POST",
    body: promptBody(input),
    headers: { "Idempotency-Key": input.idempotencyKey },
  }));
}

export async function cancelProjectPrompt(
  projectId: string,
  sessionId: string,
  promptId: string,
): Promise<ProjectSessionVM> {
  return normalizeProjectSessionResponse(
    await apiFetch<unknown>(
      `${sessionPath(projectId, sessionId)}/prompts/${encodeURIComponent(promptId)}/cancel`,
      { method: "POST" },
    ),
  );
}

export async function replyProjectQuestion(
  projectId: string,
  sessionId: string,
  requestId: string,
  answers: string[][],
): Promise<ProjectSessionVM> {
  return normalizeProjectSessionResponse(
    await apiFetch<unknown>(
      `${sessionPath(projectId, sessionId)}/questions/${encodeURIComponent(requestId)}/reply`,
      {
        method: "POST",
        body: JSON.stringify({ answers }),
      },
    ),
  );
}

export async function rejectProjectQuestion(
  projectId: string,
  sessionId: string,
  requestId: string,
): Promise<ProjectSessionVM> {
  return normalizeProjectSessionResponse(
    await apiFetch<unknown>(
      `${sessionPath(projectId, sessionId)}/questions/${encodeURIComponent(requestId)}/reject`,
      { method: "POST" },
    ),
  );
}

export async function stopProjectSession(
  projectId: string,
  sessionId: string,
): Promise<ProjectSessionVM> {
  return normalizeProjectSessionResponse(await apiFetch<unknown>(`${sessionPath(projectId, sessionId)}/stop`, {
    method: "POST",
  }));
}

export function projectSessionEventsHref(projectId: string, sessionId: string): string {
  return `${sessionPath(projectId, sessionId)}/events`;
}

export function projectPromptAttachmentHref(
  projectId: string,
  sessionId: string,
  attachmentId: string,
  download = false,
): string {
  const path =
    `${sessionPath(projectId, sessionId)}/attachments/` +
    encodeURIComponent(attachmentId);
  return download ? `${path}?download=1` : path;
}

export function projectFileHref(
  projectId: string,
  fileId: string,
  download = false,
): string {
  const path = `${projectPath(projectId)}/files/${encodeURIComponent(fileId)}`;
  return download ? `${path}?download=1` : path;
}

export function projectFileVersionHref(
  projectId: string,
  fileId: string,
  version: number,
  download = false,
): string {
  const path =
    `${projectPath(projectId)}/files/${encodeURIComponent(fileId)}` +
    `/versions/${encodeURIComponent(String(version))}`;
  return download ? `${path}?download=1` : path;
}
