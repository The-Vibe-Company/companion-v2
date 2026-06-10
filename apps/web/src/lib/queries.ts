"use client";

import type {
  IssuedToken,
  Scope,
  SkillCommentRow,
  SkillFile,
  SkillFilesResponse,
  SkillFilterPreferences,
  SkillVersionRow,
  TokenScope,
  ValidationResult,
  FrontmatterWarning,
} from "@companion/contracts";
import { apiFetch } from "./apiClient";

export type { SkillFile };

export interface PublishResult {
  ok: boolean;
  id: string;
  slug: string;
  version: string;
  checksum: string;
  sizeBytes?: number;
  warnings?: FrontmatterWarning[];
}

/** Public API base used in the copy-paste curl prompts (an external agent hits it directly). */
export function apiBase(): string {
  const env = process.env.NEXT_PUBLIC_COMPANION_API_BASE;
  if (env) return env.replace(/\/$/, "");
  if (typeof window !== "undefined") return `${window.location.origin}/v1`;
  return "/v1";
}

/** Mint a short-lived scoped personal access token (used by the guided-prompt methods). */
export async function issueToken(scopes: TokenScope[], name?: string): Promise<IssuedToken> {
  return apiFetch<IssuedToken>("/v1/tokens", {
    method: "POST",
    body: JSON.stringify({ scopes, name }),
  });
}

/** Publish a packaged skill (.zip or .tar.gz) via the multipart upload path. */
export async function publishSkillPackage(
  file: File,
  opts: { scope: Scope; team: string | null; version?: string; expectSlug?: string },
): Promise<PublishResult> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("action", "publish");
  fd.append("scope", opts.scope);
  if (opts.scope === "team" && opts.team) fd.append("team", opts.team);
  if (opts.version) fd.append("version", opts.version);
  // In update mode, bind the upload to the skill being updated (server rejects a mismatch).
  if (opts.expectSlug) fd.append("expect_slug", opts.expectSlug);
  return apiFetch<PublishResult>("/v1/skills", { method: "POST", body: fd });
}

/** Validate a packaged skill without publishing it. Warnings are non-blocking. */
export async function validateSkillPackage(file: File): Promise<ValidationResult> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("action", "validate");
  const data = await apiFetch<{ result: ValidationResult }>("/v1/skills", { method: "POST", body: fd });
  return data.result;
}

/** Author a SKILL.md inline ("Create in the browser") and publish it. */
export async function createSkillInline(input: {
  id: string;
  description: string;
  body: string;
  scope: Scope;
  team: string | null;
}): Promise<PublishResult> {
  return apiFetch<PublishResult>("/v1/skills/create", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Direct URL for a specific version packaged as a `.zip` (the install download button). */
export function versionPackageUrl(slug: string, version: string): string {
  return `/v1/skills/${encodeURIComponent(slug)}/versions/${encodeURIComponent(version)}/package`;
}

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

/** Fetch every file inside a packaged skill version (eager: one fetch per slug+version). */
export async function fetchSkillVersionFiles(
  slug: string,
  version: string,
): Promise<SkillFilesResponse> {
  return apiFetch<SkillFilesResponse>(
    `/v1/skills/${slug}/versions/${encodeURIComponent(version)}/files`,
  );
}

export async function addComment(
  slug: string,
  body: string,
  opts?: { parentId?: string | null; versionId?: string | null },
): Promise<SkillCommentRow> {
  return apiFetch<SkillCommentRow>(`/v1/skills/${slug}/comments`, {
    method: "POST",
    body: JSON.stringify({
      body,
      parent_id: opts?.parentId ?? null,
      version_id: opts?.versionId ?? null,
    }),
  });
}

/** Deprecate (or restore) a comment thread; returns the updated row. */
export async function setCommentDeprecated(
  slug: string,
  id: string,
  deprecated: boolean,
): Promise<SkillCommentRow> {
  return apiFetch<SkillCommentRow>(`/v1/skills/${slug}/comments/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ deprecated }),
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

export async function saveSkillFilterPreferences(
  preferences: SkillFilterPreferences,
): Promise<SkillFilterPreferences> {
  return apiFetch<SkillFilterPreferences>("/v1/skill-filter-preferences", {
    method: "PUT",
    body: JSON.stringify(preferences),
  });
}
