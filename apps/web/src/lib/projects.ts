"use client";

import { apiFetch } from "./apiClient";
import {
  normalizeProjectDetail,
  normalizeProjectFileVersionsResponse,
  normalizeProjectFilesResponse,
  normalizeProjectSessionResponse,
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

export async function fetchProjects() {
  return normalizeProjectsResponse(await apiFetch<unknown>("/v1/projects"));
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
