import {
  apiTokenRowSchema,
  orgSettingsResponseSchema,
  type ApiTokenRow,
  type OrgSettingsResponse,
} from "@companion/contracts";
import type { ApiKeyVM, Invite, OrgFull, SeedUser, SettingsAppData } from "@/components/org/model";
import { formatDate, relativeTime } from "./format";
import type { MeVM, OrgVM } from "./types";

const LOGO_COLORS = [
  "oklch(0.56 0.13 250)",
  "oklch(0.54 0.10 168)",
  "oklch(0.55 0.13 300)",
  "oklch(0.60 0.10 66)",
  "oklch(0.55 0.13 24)",
  "oklch(0.50 0.035 265)",
];

export function hashColor(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h * 31 + str.charCodeAt(i)) >>> 0);
  return LOGO_COLORS[h % LOGO_COLORS.length]!;
}

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

/** Validate the raw `GET /v1/tokens` payload; drops any malformed rows. */
export function parseApiTokensResponse(raw: unknown): ApiTokenRow[] {
  if (!Array.isArray(raw)) return [];
  const rows: ApiTokenRow[] = [];
  for (const item of raw) {
    const result = apiTokenRowSchema.safeParse(item);
    if (result.success) rows.push(result.data);
  }
  return rows;
}

/** Map a stored token row to its masked, display-ready view-model. */
export function mapApiKey(row: ApiTokenRow): ApiKeyVM {
  return {
    id: row.id,
    name: row.name,
    scope: row.scopes.includes("skills:write") ? "write" : "read",
    prefix: row.prefix,
    // The raw secret is never stored; the prefix is the only post-creation visible part.
    last4: row.prefix.slice(-4),
    created: formatDate(row.created_at),
    lastUsed: row.last_used_at ? relativeTime(row.last_used_at) : "never",
  };
}

export function buildSettingsAppData(input: {
  me: MeVM;
  current: OrgVM;
  settings: OrgSettingsResponse;
  tokens?: ApiTokenRow[];
}): SettingsAppData {
  const { me, current, settings, tokens = [] } = input;
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
    created: formatDate(settings.org.createdAt),
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
      description: team.description ?? "",
      members: team.members.map((member) => ({ userId: member.userId, role: member.role })),
    })),
  };

  // The Invitations pane reads pending invites on their own; `by` (inviter name) isn't
  // surfaced by the settings response, so it's left blank.
  const invites: Invite[] = settings.invitations.map((inv) => ({
    id: inv.id,
    email: inv.email,
    role: inv.role,
    invited: relativeTime(inv.createdAt),
    by: "",
    token: inv.token,
  }));

  return {
    me,
    current: currentFull,
    users,
    invites,
    apiKeys: tokens.map(mapApiKey),
  };
}
