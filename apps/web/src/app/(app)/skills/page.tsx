import { redirect } from "next/navigation";
import type { SkillListRow } from "@companion/contracts";
import { getServerSupabase } from "@/lib/supabase/server";
import { loadOrgContext } from "@/lib/currentOrg";
import { SkillsApp } from "@/components/skills/SkillsApp";
import { FirstRun } from "@/components/org/FirstRun";
import { mapSkill, type MeVM, type TeamVM } from "@/lib/types";

export const dynamic = "force-dynamic";

export default async function SkillsPage() {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { orgs, current } = await loadOrgContext(supabase);
  if (!current) return <FirstRun />;

  // Skills for the active workspace only (per-org Hub).
  const { data } = await supabase
    .from("skill_list_v")
    .select("*")
    .eq("org_id", current.id)
    .order("updated_at", { ascending: false });
  const skills = ((data ?? []) as SkillListRow[]).map(mapSkill);

  const { data: profile } = await supabase
    .from("profiles")
    .select("name, initials")
    .eq("id", user.id)
    .maybeSingle();
  const me: MeVM = {
    id: user.id,
    name: (profile?.name as string | undefined) || user.email || "You",
    initials: (profile?.initials as string | undefined) || "?",
  };

  // Only the current user's teams in the active org (org admins can see everyone's via RLS).
  const { data: tmRows } = await supabase
    .from("team_memberships")
    .select("teams(slug, name)")
    .eq("user_id", user.id)
    .eq("org_id", current.id);
  const bySlug = new Map<string, TeamVM>();
  for (const r of (tmRows ?? []) as Record<string, unknown>[]) {
    const t = r.teams as { slug?: string; name?: string } | null;
    if (!t?.slug) continue;
    const name = t.name ?? t.slug;
    if (!bySlug.has(t.slug)) {
      bySlug.set(t.slug, { id: t.slug, name, initial: (name[0] ?? "T").toUpperCase() });
    }
  }
  const teams: TeamVM[] = [...bySlug.values()].sort((a, b) => (a.name < b.name ? -1 : 1));

  return <SkillsApp initialSkills={skills} me={me} teams={teams} orgs={orgs} currentOrg={current} />;
}
