import "server-only";

import { orgSettingsResponseSchema, type OrgSettingsResponse } from "@companion/contracts";
import { redirect } from "next/navigation";
import { loadOrgContext } from "@/lib/currentOrg";
import { serverApiFetch } from "@/lib/apiServer";
import { formatDate } from "@/lib/format";
import type { OrgFull, SeedUser, SettingsAppData, SettingsDialog, SettingsTab } from "@/components/org/model";
import type { MeVM } from "@/lib/types";

export type SettingsSearchParams = Promise<Record<string, string | string[] | undefined>>;

function initialsOf(name: string): string {
  const p = name.trim().split(/[.\s@]+/).filter(Boolean);
  return ((p[0]?.[0] ?? "?") + (p[1]?.[0] ?? "")).toUpperCase();
}

export function parseOrgSettingsResponse(raw: unknown): OrgSettingsResponse | null {
  const result = orgSettingsResponseSchema.safeParse(raw);
  if (result.success) return result.data;
  console.error(
    "Invalid org settings response",
    result.error.issues.slice(0, 5).map((issue) => ({
      path: issue.path.join(".") || "<root>",
      message: issue.message,
    })),
  );
  return null;
}

function parseSettingsState(sp: Record<string, string | string[] | undefined>): {
  initialTab: SettingsTab;
  initialDialog: SettingsDialog;
} {
  const tabRaw = typeof sp.tab === "string" ? sp.tab : undefined;
  const initialTab: SettingsTab = tabRaw === "general" || tabRaw === "teams" ? tabRaw : "members";
  const dialogRaw = typeof sp.dialog === "string" ? sp.dialog : undefined;
  const initialDialog: SettingsDialog = dialogRaw === "invite" || dialogRaw === "team" ? dialogRaw : null;
  return { initialTab, initialDialog };
}

export async function loadSettingsPageData(searchParams: SettingsSearchParams): Promise<{
  data: SettingsAppData;
  initialTab: SettingsTab;
  initialDialog: SettingsDialog;
} | null> {
  const whoami = await serverApiFetch<{ userId: string; email: string; name: string; needsOnboarding?: boolean }>(
    "/v1/auth/whoami",
  ).catch(() => null);
  if (!whoami) redirect("/login");
  if (whoami.needsOnboarding) redirect("/onboarding");

  const orgContext = await loadOrgContext().catch(() => null);
  if (!orgContext) return null;
  const { current } = orgContext;
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

  const settingsRaw = await serverApiFetch<unknown>("/v1/orgs/current/settings", {
    headers: orgHeaders,
  }).catch(() => null);
  if (settingsRaw === null) return null;
  const settings = parseOrgSettingsResponse(settingsRaw);
  if (!settings) return null;
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

  const state = parseSettingsState(await searchParams);
  return {
    ...state,
    data: {
      me,
      current: currentFull,
      users,
    },
  };
}
