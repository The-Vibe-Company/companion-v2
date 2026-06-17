"use client";

import type {
  DependencyPlan,
  IssuedToken,
  ReportLocalSkillInstallResult,
  ReportSkillInstallResult,
  SkillUninstallResult,
  SkillCommentRow,
  SkillDependenciesResponse,
  SkillFile,
  SkillFilesResponse,
  SkillFilterPreferences,
  SkillListRow,
  SkillVisibilityInput,
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
  dependency_plan?: DependencyPlan;
}

/** Public API base used in the guided assistant prompts (an external agent hits it directly). */
export function apiBase(): string {
  const env = process.env.NEXT_PUBLIC_COMPANION_API_BASE;
  if (env) return env.replace(/\/$/, "");
  if (typeof window !== "undefined") return `${window.location.origin}/v1`;
  return "/v1";
}

/** Mint a scoped personal access token (used by the guided-prompt methods). */
export async function issueToken(scopes: TokenScope[], name?: string): Promise<IssuedToken> {
  return apiFetch<IssuedToken>("/v1/tokens", {
    method: "POST",
    body: JSON.stringify({ scopes, name }),
  });
}

/** Publish a packaged skill (.zip or .tar.gz) via the multipart upload path. */
export async function publishSkillPackage(
  file: File,
  opts: {
    ownerTeam?: string | null;
    visibility: SkillVisibilityInput;
    version?: string;
    expectSlug?: string;
    expectSkillId?: string;
    dependencies?: string[];
  },
): Promise<PublishResult> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("action", "publish");
  fd.append("everyone", String(opts.visibility.everyone));
  if (opts.ownerTeam) fd.append("owner_team", opts.ownerTeam);
  for (const team of opts.visibility.teams) fd.append("team", team);
  if (opts.version) fd.append("version", opts.version);
  // In update mode, bind the upload to the skill being updated (server rejects a mismatch).
  if (opts.expectSlug) fd.append("expect_slug", opts.expectSlug);
  if (opts.expectSkillId) fd.append("expect_skill_id", opts.expectSkillId);
  for (const dep of opts.dependencies ?? []) fd.append("dependency", dep);
  return apiFetch<PublishResult>("/v1/skills", { method: "POST", body: fd });
}

/**
 * Validate a packaged skill without publishing it. Returns the validation result plus the
 * dependency preflight plan (declared / published / to-upload / removed / archival candidates).
 * Warnings are non-blocking.
 */
export async function validateSkillPackage(
  file: File,
  opts: {
    version?: string;
    expectSlug?: string;
    expectSkillId?: string;
    dependencies?: string[];
    /** Pass the selected visibility so the dependency plan's visibility checks match publish. */
    visibility?: SkillVisibilityInput;
    ownerTeam?: string | null;
  } = {},
): Promise<{ result: ValidationResult; dependencyPlan: DependencyPlan | null }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("action", "validate");
  if (opts.version) fd.append("version", opts.version);
  if (opts.expectSlug) fd.append("expect_slug", opts.expectSlug);
  if (opts.expectSkillId) fd.append("expect_skill_id", opts.expectSkillId);
  for (const dep of opts.dependencies ?? []) fd.append("dependency", dep);
  if (opts.visibility) {
    fd.append("everyone", String(opts.visibility.everyone));
    for (const team of opts.visibility.teams) fd.append("team", team);
  }
  if (opts.ownerTeam) fd.append("owner_team", opts.ownerTeam);
  const data = await apiFetch<{ result: ValidationResult; dependency_plan?: DependencyPlan }>("/v1/skills", {
    method: "POST",
    body: fd,
  });
  return { result: data.result, dependencyPlan: data.dependency_plan ?? null };
}

/** Author a SKILL.md inline ("Create in the browser") and publish it. */
export async function createSkillInline(input: {
  id: string;
  description: string;
  body: string;
  owner_team?: string | null;
  visibility: SkillVisibilityInput;
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

/** Mark a published skill as installed for the current user (manual mark or agent report). */
export async function markSkillInstalled(
  slug: string,
  version?: string | null,
): Promise<ReportSkillInstallResult> {
  return apiFetch<ReportSkillInstallResult>(`/v1/skills/${slug}/install`, {
    method: "POST",
    body: JSON.stringify(version ? { version } : {}),
  });
}

/** Mark a published skill as not installed for the current user (uninstall / correct a false state). */
export async function markSkillUninstalled(slug: string): Promise<SkillUninstallResult> {
  return apiFetch<SkillUninstallResult>(`/v1/skills/${slug}/install`, { method: "DELETE" });
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

/**
 * Change a skill's visibility. With `cascade`, the server also raises the skill's (transitive)
 * dependencies so they stay at least as visible — returns the slugs it raised.
 */
export async function setSkillVisibility(
  slug: string,
  visibility: SkillVisibilityInput,
  opts: { cascade?: boolean } = {},
): Promise<{ cascaded: string[] }> {
  const res = await apiFetch<{ ok: true; cascaded: string[] }>(`/v1/skills/${slug}/visibility`, {
    method: "PUT",
    body: JSON.stringify({ ...visibility, cascade: opts.cascade ?? false }),
  });
  return { cascaded: res.cascaded ?? [] };
}

export async function saveSkillFilterPreferences(
  preferences: SkillFilterPreferences,
): Promise<SkillFilterPreferences> {
  return apiFetch<SkillFilterPreferences>("/v1/skill-filter-preferences", {
    method: "PUT",
    body: JSON.stringify(preferences),
  });
}

// --- Dependencies + archive ---------------------------------------------------------------------

/** Resolve the Requires + Used by graph for a skill (optionally a specific version). */
export async function fetchSkillDependencies(
  slug: string,
  version: string | null,
): Promise<SkillDependenciesResponse> {
  const qs = version ? `?version=${encodeURIComponent(version)}` : "";
  return apiFetch<SkillDependenciesResponse>(`/v1/skills/${slug}/dependencies${qs}`);
}

/** Archive a skill (hide it from normal lists; stays restorable + downloadable while referenced). */
export async function archiveSkill(slug: string, reason?: string): Promise<void> {
  await apiFetch(`/v1/skills/${slug}/archive`, {
    method: "POST",
    body: JSON.stringify(reason ? { reason } : {}),
  });
}

/** Restore an archived skill back into the normal lists. */
export async function restoreSkill(slug: string): Promise<void> {
  await apiFetch(`/v1/skills/${slug}/restore`, { method: "POST", body: "{}" });
}

/** Fetch the archived skills for the workspace (the Archived view). */
export async function fetchArchivedSkills(): Promise<SkillListRow[]> {
  return apiFetch<SkillListRow[]>("/v1/skills?archived=true");
}

// --- Local skills (the "Companion skills" section) ----------------------------------------------

/** Public download URL for a local skill package (referenced by the assistant prompt). */
export function localSkillPackageUrl(key: string): string {
  return `${apiBase()}/local-skills/${encodeURIComponent(key)}/package`;
}

/** Manual fallback: record that this member installed the local skill at a version. */
export async function reportLocalSkillInstalled(
  key: string,
  version: string,
  agent?: string,
): Promise<ReportLocalSkillInstallResult> {
  return apiFetch<ReportLocalSkillInstallResult>(
    `/v1/local-skills/${encodeURIComponent(key)}/installed`,
    { method: "POST", body: JSON.stringify({ version, agent }) },
  );
}
