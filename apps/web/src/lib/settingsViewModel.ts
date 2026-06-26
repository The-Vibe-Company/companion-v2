import {
  apiTokenRowSchema,
  orgSettingsResponseSchema,
  TEAM_BRAND_COLORS,
  type ApiTokenRow,
  type OrgSettingsResponse,
} from "@companion/contracts";
import type { ApiKeyVM, Invite, OrgFull, SeedUser, SettingsAppData } from "@/components/org/model";
import { formatDate, relativeTime } from "./format";
import type { MeVM, OrgVM } from "./types";

export function hashColor(str: string): string {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h * 31 + str.charCodeAt(i)) >>> 0);
  return TEAM_BRAND_COLORS[h % TEAM_BRAND_COLORS.length]!;
}

export function initialsOf(name: string): string {
  // Keep the delimiter set in sync with the server's initialsFor (@companion/db ids) so an
  // optimistic avatar (e.g. after a self-rename) doesn't flip once the server value comes back.
  const parts = name.trim().split(/[.\s@_-]+/).filter(Boolean);
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
    expires: formatDate(row.expires_at),
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
    [me.id]: { id: me.id, name: me.name, email: me.email, initials: me.initials, avatarUrl: me.avatarUrl },
  };

  for (const member of settings.members) {
    users[member.userId] = {
      id: member.userId,
      name: member.name,
      email: member.email,
      initials: member.initials || initialsOf(member.name || member.email || member.userId),
      avatarUrl: member.avatarUrl ?? null,
    };
  }

  const currentFull: OrgFull = {
    // Prefer the fresh settings.org payload for identity fields (name/slug/kind/plan); the
    // `current` (OrgVM) prop can be stale in the in-app drawer after a rename/reslug. Role
    // isn't part of settings.org, so it still comes from `current`.
    id: settings.org.id,
    name: settings.org.name,
    slug: settings.org.slug,
    kind: settings.org.kind,
    plan: settings.org.plan,
    myRole: current.myRole,
    created: formatDate(settings.org.createdAt),
    domain: settings.org.domain ?? null,
    domainAutoJoin: settings.org.domainAutoJoin,
    accessDomains: settings.org.accessDomains.map((domain) => ({
      id: domain.id,
      domain: domain.domain,
      createdAt: formatDate(domain.createdAt),
    })),
    color: settings.org.color ?? current.color ?? null,
    logoUrl: settings.org.logoUrl ?? current.logoUrl ?? null,
    members: settings.members.map((member) => ({
      userId: member.userId,
      role: member.role,
      joined: member.pending ? "pending" : formatDate(member.joined),
      pending: member.pending,
      inviteId: member.inviteId,
      inviteToken: member.inviteToken,
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
    domainJoin: {
      actorDomain: settings.domainJoin.actorDomain,
      actorDomainIsPersonal: settings.domainJoin.actorDomainIsPersonal,
    },
    users,
    invites,
    apiKeys: tokens.map(mapApiKey),
  };
}
