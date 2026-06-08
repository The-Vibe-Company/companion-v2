import { redirect } from "next/navigation";
import { loadOrgContext } from "@/lib/currentOrg";
import { serverApiFetch } from "@/lib/apiServer";
import { formatDate } from "@/lib/format";
import { SettingsApp, type SettingsAppData } from "@/components/org/SettingsApp";
import type { OrgFull, SeedUser, SettingsDialog, SettingsTab } from "@/components/org/model";
import type { MeVM } from "@/lib/types";

export const dynamic = "force-dynamic";

function initialsOf(name: string): string {
  const p = name.trim().split(/[.\s@]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p[1]?.[0] ?? "")).toUpperCase();
}

interface OrgSettingsResponse {
  members: Array<{
    userId: string;
    role: OrgFull["members"][number]["role"];
    joined: string;
    pending: boolean;
    inviteId?: string;
    inviteToken?: string;
    name: string;
    email: string;
    initials: string;
  }>;
  teams: Array<{
    id: string;
    slug: string;
    name: string;
    members: Array<{
      userId: string;
      role: OrgFull["teams"][number]["members"][number]["role"];
      name: string;
      email: string;
      initials: string;
    }>;
  }>;
}

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const whoami = await serverApiFetch<{ userId: string; email: string; name: string; needsOnboarding?: boolean }>(
    "/v1/auth/whoami",
  ).catch(() => null);
  if (!whoami) redirect("/login");
  if (whoami.needsOnboarding) redirect("/onboarding");

  const { current } = await loadOrgContext();
  if (!current) redirect("/onboarding");
  const orgHeaders = { "x-companion-org": current.id };

  const me: MeVM = {
    id: whoami.userId,
    name: whoami.name || whoami.email || "You",
    initials: initialsOf(whoami.name || whoami.email || "You"),
  };

  const users: Record<string, SeedUser> = {
    [me.id]: { id: me.id, name: me.name, email: whoami.email, initials: me.initials },
  };

  const settings = await serverApiFetch<OrgSettingsResponse>("/v1/orgs/current/settings", { headers: orgHeaders });
  for (const member of settings.members) {
    users[member.userId] = {
      id: member.userId,
      name: member.name,
      email: member.email,
      initials: member.initials || initialsOf(member.name || member.email || member.userId),
    };
  }
  for (const team of settings.teams) {
    for (const member of team.members) {
      users[member.userId] = {
        id: member.userId,
        name: member.name,
        email: member.email,
        initials: member.initials || initialsOf(member.name || member.email || member.userId),
      };
    }
  }

  const currentFull: OrgFull = {
    id: current.id,
    name: current.name,
    slug: current.slug,
    kind: current.kind,
    plan: current.plan,
    myRole: current.myRole,
    members: settings.members.map((member) => ({
      userId: member.userId,
      role: member.role,
      joined: member.pending ? "pending" : formatDate(member.joined),
      pending: member.pending,
      inviteId: member.inviteId,
      inviteToken: member.inviteToken,
    })),
    teams: settings.teams.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      members: t.members.map((member) => ({ userId: member.userId, role: member.role })),
    })),
  };

  const sp = await searchParams;
  const tabRaw = typeof sp.tab === "string" ? sp.tab : undefined;
  const tab: SettingsTab = tabRaw === "general" || tabRaw === "teams" ? tabRaw : "members";
  const dialogRaw = typeof sp.dialog === "string" ? sp.dialog : undefined;
  const dialog: SettingsDialog = dialogRaw === "invite" || dialogRaw === "team" ? dialogRaw : null;

  const data: SettingsAppData = {
    me,
    current: currentFull,
    users,
  };
  return <SettingsApp data={data} initialTab={tab} initialDialog={dialog} />;
}
