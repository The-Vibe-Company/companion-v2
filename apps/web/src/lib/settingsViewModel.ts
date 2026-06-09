import { orgSettingsResponseSchema, type OrgSettingsResponse } from "@companion/contracts";
import type { OrgFull, SeedUser, SettingsAppData } from "@/components/org/model";
import { formatDate } from "./format";
import type { MeVM, OrgVM } from "./types";

export function initialsOf(name: string): string {
  const parts = name.trim().split(/[.\s@]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
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

export function buildSettingsAppData(input: {
  me: MeVM;
  current: OrgVM;
  settings: OrgSettingsResponse;
}): SettingsAppData {
  const { me, current, settings } = input;
  const users: Record<string, SeedUser> = {
    [me.id]: { id: me.id, name: me.name, email: me.email, initials: me.initials },
  };

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
    teams: settings.teams.map((team) => ({
      id: team.id,
      slug: team.slug,
      name: team.name,
      members: team.members.map((member) => ({ userId: member.userId, role: member.role })),
    })),
  };

  return {
    me,
    current: currentFull,
    users,
  };
}
