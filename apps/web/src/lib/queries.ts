"use client";

import type { SkillCommentRow, SkillVersionRow } from "@companion/contracts";
import { getBrowserSupabase } from "./supabase/client";

export interface SkillDetailData {
  versions: SkillVersionRow[];
  comments: SkillCommentRow[];
  frontmatter: string | null;
}

/** Fetch a skill's versions (activity) + comments from the browser (RLS-filtered). */
export async function fetchSkillDetail(
  skillUuid: string,
  currentVersion: string | null,
): Promise<SkillDetailData> {
  const supabase = getBrowserSupabase();
  const [vRes, cRes] = await Promise.all([
    supabase
      .from("skill_versions")
      .select("*")
      .eq("skill_id", skillUuid)
      .order("created_at", { ascending: false }),
    supabase
      .from("skill_comments")
      .select("id, skill_id, author_id, body, created_at, profiles(name, initials)")
      .eq("skill_id", skillUuid)
      .order("created_at", { ascending: true }),
  ]);

  const versions = (vRes.data ?? []) as SkillVersionRow[];
  const comments = ((cRes.data ?? []) as Record<string, unknown>[]).map((r) => {
    const author = r.profiles as { name?: string; initials?: string } | null;
    return {
      id: String(r.id),
      skill_id: String(r.skill_id),
      author_id: String(r.author_id),
      body: String(r.body),
      created_at: String(r.created_at),
      author_name: author?.name ?? null,
      author_initials: author?.initials ?? null,
    } satisfies SkillCommentRow;
  });

  const cur = versions.find((v) => v.version === currentVersion) ?? versions[0];
  return { versions, comments, frontmatter: cur?.frontmatter ?? null };
}

/** Toggle the current user's star on a skill. Returns the new starred state. */
export async function toggleStar(slug: string): Promise<boolean> {
  const supabase = getBrowserSupabase();
  const { data, error } = await supabase.rpc("toggle_star", { p_slug: slug });
  if (error) throw new Error(error.message);
  return Boolean(data);
}

/** Add a comment; returns the new row (author fields filled from the current profile). */
export async function addComment(slug: string, body: string): Promise<SkillCommentRow> {
  const supabase = getBrowserSupabase();
  const { data, error } = await supabase.rpc("add_comment", { p_slug: slug, p_body: body });
  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown>;
  return {
    id: String(row.id),
    skill_id: String(row.skill_id),
    author_id: String(row.author_id),
    body: String(row.body),
    created_at: String(row.created_at),
  };
}

/** Change a skill's visibility scope (owner/admin only). */
export async function setSkillScope(
  slug: string,
  scope: string,
  teamSlug: string | null = null,
): Promise<void> {
  const supabase = getBrowserSupabase();
  const { error } = await supabase.rpc("set_skill_scope", {
    p_slug: slug,
    p_scope: scope,
    p_team_slug: teamSlug,
  });
  if (error) throw new Error(error.message);
}
