import { redirect } from "next/navigation";
import type { OrgRole, TeamRole } from "@companion/contracts";
import { getServerSupabase } from "@/lib/supabase/server";
import { loadOrgContext } from "@/lib/currentOrg";
import { formatDate } from "@/lib/format";
import { SettingsApp, type SettingsAppData } from "@/components/org/SettingsApp";
import type { OrgFull, OrgMember, OrgTeam, SeedUser, SettingsDialog, SettingsTab } from "@/components/org/model";
import type { MeVM } from "@/lib/types";

export const dynamic = "force-dynamic";

function initialsOf(name: string): string {
  const p = name.trim().split(/[.\s@]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p[1]?.[0] ?? "")).toUpperCase();
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { orgs, current } = await loadOrgContext(supabase);
  if (!current) redirect("/skills");

  const { data: profile } = await supabase.from("profiles").select("name, initials").eq("id", user.id).maybeSingle();
  const me: MeVM = {
    id: user.id,
    name: (profile?.name as string | undefined) || user.email || "You",
    initials: (profile?.initials as string | undefined) || "?",
  };

  const users: Record<string, SeedUser> = {};
  const addUser = (id: string, name: string, email: string, initials?: string) => {
    if (!users[id]) {
      const display = name || email || id;
      users[id] = { id, name: display, email: email || "", initials: initials || initialsOf(display) };
    }
  };
  addUser(user.id, me.name, user.email ?? "", me.initials);

  // Active members.
  const { data: memRows } = await supabase
    .from("memberships")
    .select("user_id, org_role, created_at, profiles(name, email, initials)")
    .eq("org_id", current.id)
    .order("created_at", { ascending: true });
  const members: OrgMember[] = [];
  for (const r of (memRows ?? []) as Record<string, unknown>[]) {
    const uid = String(r.user_id);
    const p = r.profiles as { name?: string; email?: string; initials?: string } | null;
    addUser(uid, p?.name ?? "", p?.email ?? "", p?.initials);
    members.push({ userId: uid, role: r.org_role as OrgRole, joined: formatDate(String(r.created_at)), pending: false });
  }

  // Pending invites (RLS-gated to org admins of this org).
  const { data: invRows } = await supabase
    .from("invitations")
    .select("id, email, org_role, token, created_at")
    .eq("org_id", current.id)
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  for (const r of (invRows ?? []) as Record<string, unknown>[]) {
    const synthetic = "invite:" + String(r.id);
    const email = String(r.email);
    addUser(synthetic, email.split("@")[0] ?? email, email);
    members.push({
      userId: synthetic,
      role: r.org_role as OrgRole,
      joined: "—",
      pending: true,
      inviteId: String(r.id),
      inviteToken: String(r.token),
    });
  }

  // Teams + their members.
  const { data: teamRows } = await supabase
    .from("teams")
    .select("id, slug, name, team_memberships(user_id, team_role, profiles(name, email, initials))")
    .eq("org_id", current.id)
    .order("created_at", { ascending: true });
  const teams: OrgTeam[] = [];
  for (const t of (teamRows ?? []) as Record<string, unknown>[]) {
    const tms = (t.team_memberships ?? []) as Record<string, unknown>[];
    const tmembers = tms.map((tm) => {
      const uid = String(tm.user_id);
      const p = tm.profiles as { name?: string; email?: string; initials?: string } | null;
      addUser(uid, p?.name ?? "", p?.email ?? "", p?.initials);
      return { userId: uid, role: tm.team_role as TeamRole };
    });
    teams.push({ id: String(t.id), slug: String(t.slug), name: String(t.name), members: tmembers });
  }

  const currentFull: OrgFull = {
    id: current.id,
    name: current.name,
    slug: current.slug,
    kind: current.kind,
    plan: current.plan,
    myRole: current.myRole,
    members,
    teams,
  };

  // Sidebar skill counts for the current org (the team list is derived client-side from the
  // live membership graph in SettingsApp).
  const { data: skillRows } = await supabase.from("skill_list_v").select("owner_id, team_slug").eq("org_id", current.id);
  const sr = (skillRows ?? []) as Record<string, unknown>[];
  const totalCount = sr.length;
  const myCount = sr.filter((s) => String(s.owner_id) === user.id).length;
  const teamCounts: Record<string, number> = {};
  for (const s of sr) {
    const ts = s.team_slug ? String(s.team_slug) : null;
    if (ts) teamCounts[ts] = (teamCounts[ts] ?? 0) + 1;
  }

  const sp = await searchParams;
  const tabRaw = typeof sp.tab === "string" ? sp.tab : undefined;
  const tab: SettingsTab = tabRaw === "general" || tabRaw === "teams" ? tabRaw : "members";
  const dialogRaw = typeof sp.dialog === "string" ? sp.dialog : undefined;
  const dialog: SettingsDialog = dialogRaw === "invite" || dialogRaw === "team" ? dialogRaw : null;

  const data: SettingsAppData = { me, orgs, current: currentFull, users, teamCounts, totalCount, myCount };
  return <SettingsApp data={data} initialTab={tab} initialDialog={dialog} />;
}
