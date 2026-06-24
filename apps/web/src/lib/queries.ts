"use client";

import type {
  DependencyPlan,
  IssuedToken,
  LabelColor,
  LabelIcon,
  LabelsResponse,
  ReportLocalSkillInstallResult,
  ReportSkillInstallResult,
  SkillUninstallResult,
  SkillCommentRow,
  SkillDependenciesResponse,
  SkillFile,
  SkillFilesResponse,
  SkillFilterPreferences,
  SkillListRow,
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
    /** Folder paths to file the skill under (personal or org folders per scope). Applied on create. */
    labels?: string[];
    /** Library to publish into on create: 'personal' (My Skills) or 'org'. */
    scope?: "personal" | "org";
    version?: string;
    expectSlug?: string;
    expectSkillId?: string;
    dependencies?: string[];
  },
): Promise<PublishResult> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("action", "publish");
  if (opts.scope) fd.append("scope", opts.scope);
  // The API parses repeatable `label` fields (one per path) into the publish `labels` payload.
  for (const path of opts.labels ?? []) fd.append("label", path);
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
  } = {},
): Promise<{ result: ValidationResult; dependencyPlan: DependencyPlan | null }> {
  const fd = new FormData();
  fd.append("file", file);
  fd.append("action", "validate");
  if (opts.version) fd.append("version", opts.version);
  if (opts.expectSlug) fd.append("expect_slug", opts.expectSlug);
  if (opts.expectSkillId) fd.append("expect_skill_id", opts.expectSkillId);
  for (const dep of opts.dependencies ?? []) fd.append("dependency", dep);
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
  /** Library to create into: 'personal' (default, My Skills) or 'org'. */
  scope?: "personal" | "org";
  /** Folder paths to file the new skill under (personal or org folders per scope). */
  labels?: string[];
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
  opts?: { parentId?: string | null; versionId?: string | null; images?: File[] },
): Promise<SkillCommentRow> {
  // With attachments the request is multipart (the browser sets the boundary); otherwise plain JSON.
  if (opts?.images?.length) {
    const fd = new FormData();
    fd.append("body", body);
    fd.append("parent_id", opts.parentId ?? "");
    fd.append("version_id", opts.versionId ?? "");
    for (const file of opts.images) fd.append("image", file);
    return apiFetch<SkillCommentRow>(`/v1/skills/${slug}/comments`, { method: "POST", body: fd });
  }
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

// --- Labels (org-wide shared folders) ------------------------------------------------------------

/** Fetch the org-wide label tree (derived parents + roll-up counts) plus the flat appearance list. */
export async function fetchSkillLabels(): Promise<LabelsResponse> {
  return apiFetch<LabelsResponse>("/v1/labels");
}

/** Create (upsert) a label path, optionally with appearance. Intermediate ancestors are implicit. */
export async function createLabel(
  path: string,
  opts?: { displayName?: string; color?: LabelColor | null; icon?: LabelIcon | null },
): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/labels", {
    method: "POST",
    body: JSON.stringify({ path, displayName: opts?.displayName, color: opts?.color, icon: opts?.icon }),
  });
}

/** Move a label path (and its whole subtree) to a new path. Rejected on collision. */
export async function renameLabel(from: string, to: string, opts?: { displayName?: string }): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/labels/rename", {
    method: "PUT",
    body: JSON.stringify({ from, to, displayName: opts?.displayName }),
  });
}

/** Set (or clear, with `null`) a label path's color. */
export async function setLabelColor(path: string, color: LabelColor | null): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/labels/color", {
    method: "PUT",
    body: JSON.stringify({ path, color }),
  });
}

/** Set (or clear, with `null`) a label path's icon. */
export async function setLabelIcon(path: string, icon: LabelIcon | null): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/labels/icon", {
    method: "PUT",
    body: JSON.stringify({ path, icon }),
  });
}

/** Delete a label path and its whole subtree across both tables. */
export async function deleteLabel(path: string): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/labels", {
    method: "DELETE",
    body: JSON.stringify({ path }),
  });
}

/** Assign a label path to a skill (path lives in the body so slashes survive). */
export async function assignSkillLabel(slug: string, path: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/v1/skills/${slug}/labels`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

/** Unassign a label path from a skill (path lives in the body so slashes survive). */
export async function unassignSkillLabel(slug: string, path: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/v1/skills/${slug}/labels`, {
    method: "DELETE",
    body: JSON.stringify({ path }),
  });
}

// --- Personal folders ("My Skills") — same shapes as org labels, owner-scoped on the server -------

export async function fetchPersonalLabels(): Promise<LabelsResponse> {
  return apiFetch<LabelsResponse>("/v1/personal-labels");
}

export async function createPersonalLabel(
  path: string,
  opts?: { displayName?: string; color?: LabelColor | null; icon?: LabelIcon | null },
): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/personal-labels", {
    method: "POST",
    body: JSON.stringify({ path, displayName: opts?.displayName, color: opts?.color, icon: opts?.icon }),
  });
}

export async function renamePersonalLabel(from: string, to: string, opts?: { displayName?: string }): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/personal-labels/rename", {
    method: "PUT",
    body: JSON.stringify({ from, to, displayName: opts?.displayName }),
  });
}

export async function setPersonalLabelColor(path: string, color: LabelColor | null): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/personal-labels/color", { method: "PUT", body: JSON.stringify({ path, color }) });
}

export async function setPersonalLabelIcon(path: string, icon: LabelIcon | null): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/personal-labels/icon", { method: "PUT", body: JSON.stringify({ path, icon }) });
}

export async function deletePersonalLabel(path: string): Promise<void> {
  await apiFetch<{ ok: true }>("/v1/personal-labels", { method: "DELETE", body: JSON.stringify({ path }) });
}

export async function assignPersonalSkillLabel(slug: string, path: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/v1/skills/${slug}/personal-labels`, { method: "POST", body: JSON.stringify({ path }) });
}

export async function unassignPersonalSkillLabel(slug: string, path: string): Promise<void> {
  await apiFetch<{ ok: true }>(`/v1/skills/${slug}/personal-labels`, {
    method: "DELETE",
    body: JSON.stringify({ path }),
  });
}

/** Share a personal skill into the org library (owner-only; flips scope personal → org). */
export async function shareSkillToOrg(slug: string): Promise<{ ok: true; slug: string; scope: "org" }> {
  return apiFetch<{ ok: true; slug: string; scope: "org" }>(`/v1/skills/${slug}/share`, { method: "POST" });
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

/** Merge two library result sets, de-duped by skill id (the My-Skills copy wins). */
function mergeBySkillId(mine: SkillListRow[], org: SkillListRow[]): SkillListRow[] {
  const seen = new Set(mine.map((s) => s.id));
  return [...mine, ...org.filter((s) => !seen.has(s.id))];
}

/**
 * Fetch the archived skills for the Archived view. The view is library-independent, so it shows
 * everything the caller can restore: their archived personal skills (My Skills) plus archived org
 * skills. Each library is fetched separately and merged (the org library defaults when `lib` is absent).
 */
export async function fetchArchivedSkills(): Promise<SkillListRow[]> {
  const [mine, org] = await Promise.all([
    apiFetch<SkillListRow[]>("/v1/skills?lib=mine&archived=true").catch(() => [] as SkillListRow[]),
    apiFetch<SkillListRow[]>("/v1/skills?lib=org&archived=true"),
  ]);
  return mergeBySkillId(mine, org);
}

/**
 * Relevance-ranked full-text search across skills (slug, description, tools, labels, and the
 * SKILL.md body). Searches BOTH libraries (My Skills + Organization) so a member's private skills
 * are findable in the ⌘K palette, then merges the results de-duped by id.
 */
export async function fetchSkillSearch(query: string, signal?: AbortSignal): Promise<SkillListRow[]> {
  const q = encodeURIComponent(query);
  const [mine, org] = await Promise.all([
    apiFetch<SkillListRow[]>(`/v1/skills?lib=mine&q=${q}`, { signal }).catch(() => [] as SkillListRow[]),
    apiFetch<SkillListRow[]>(`/v1/skills?lib=org&q=${q}`, { signal }),
  ]);
  return mergeBySkillId(mine, org);
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
