"use client";

import type { SkillCommentRow, SkillVersionRow } from "@companion/contracts";
import { apiFetch } from "./apiClient";

export interface SkillDetailData {
  versions: SkillVersionRow[];
  comments: SkillCommentRow[];
  frontmatter: string | null;
}

export async function fetchSkillDetail(
  slug: string,
  currentVersion: string | null,
): Promise<SkillDetailData> {
  const [versions, comments] = await Promise.all([
    apiFetch<SkillVersionRow[]>(`/v1/skills/${slug}/versions`),
    apiFetch<SkillCommentRow[]>(`/v1/skills/${slug}/comments`),
  ]);
  const cur = versions.find((v) => v.version === currentVersion) ?? versions[0];
  return { versions, comments, frontmatter: cur?.frontmatter ?? null };
}

export async function toggleStar(slug: string): Promise<boolean> {
  const data = await apiFetch<{ starred: boolean }>(`/v1/skills/${slug}/star`, { method: "POST" });
  return data.starred;
}

export async function addComment(slug: string, body: string): Promise<SkillCommentRow> {
  return apiFetch<SkillCommentRow>(`/v1/skills/${slug}/comments`, {
    method: "POST",
    body: JSON.stringify({ body }),
  });
}

export async function fetchSkillDownloadUrl(slug: string, version: string | null): Promise<string> {
  const qs = version ? `?version=${encodeURIComponent(version)}` : "";
  const data = await apiFetch<{ url: string }>(`/v1/skills/${slug}/download${qs}`);
  return data.url;
}

export async function setSkillScope(
  slug: string,
  scope: string,
  teamSlug: string | null = null,
  _orgId: string | null = null,
): Promise<void> {
  await apiFetch(`/v1/skills/${slug}/scope`, {
    method: "PUT",
    body: JSON.stringify({ scope, teamSlug }),
  });
}
