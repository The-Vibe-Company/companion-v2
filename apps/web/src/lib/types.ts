import type { OrgRole, Scope, SkillListRow, TeamRole, ValidationState } from "@companion/contracts";
import { formatBytes, formatDate, relativeTime } from "./format";

export interface SkillOwnerVM {
  name: string;
  initials: string;
  handle: string | null;
  team: string | null;
}

/** The UI-facing skill shape consumed by the ported direction-C+C components. */
export interface SkillVM {
  uuid: string; // db id
  id: string; // slug (the displayed machine name)
  scope: Scope;
  version: string | null;
  validation: ValidationState;
  description: string;
  error: string | null;
  owner: SkillOwnerVM;
  tools: string[];
  size: string;
  license: string | null;
  checksum: string | null;
  created: string; // formatted date (server-computed)
  updated: string; // relative label (server-computed)
  stars: number;
  starred: boolean;
  team: string | null; // team display name (visibility team)
  teamSlug: string | null; // team slug (for filtering)
}

/** Map a skill_list_v row to the UI view-model. Date formatting runs server-side. */
export function mapSkill(row: SkillListRow): SkillVM {
  return {
    uuid: row.id,
    id: row.slug,
    scope: row.scope,
    version: row.current_version,
    validation: row.validation,
    description: row.description,
    error: row.validation_error,
    owner: {
      name: row.owner_name,
      initials: row.owner_initials,
      handle: row.owner_handle,
      team: row.team_name,
    },
    tools: row.tools ?? [],
    size: formatBytes(row.size_bytes),
    license: row.license,
    checksum: row.checksum,
    created: formatDate(row.created_at),
    updated: relativeTime(row.updated_at),
    stars: row.star_count,
    starred: row.starred,
    team: row.team_name,
    teamSlug: row.team_slug,
  };
}

export interface TeamVM {
  id: string; // slug
  name: string;
  initial: string;
}

export interface MeVM {
  id: string;
  name: string;
  initials: string;
}

/* ---- Org / membership view-models (settings surface + switcher) ----------- */

/** One workspace the current user belongs to (the org switcher + General pane). */
export interface OrgVM {
  id: string; // organizations.id (the explicit current-org id the RPCs accept)
  name: string;
  slug: string;
  kind: "personal" | "team";
  plan: "free" | "team";
  myRole: OrgRole; // this user's role in THIS org
}

/** A row in the Members table — an active member, or a pending invite. */
export interface MemberVM {
  userId: string; // profiles.id for active members; invite id for pending
  name: string;
  email: string;
  initials: string;
  role: OrgRole;
  joined: string; // formatted date, or "—" / "pending"
  pending: boolean; // true => from invitations, not memberships
  inviteId?: string; // invitations.id (pending rows only)
  inviteToken?: string; // shareable join token (pending rows only)
  isMe: boolean;
}

export interface TeamMemberVM {
  userId: string;
  name: string;
  email: string;
  initials: string;
  role: TeamRole;
  isMe: boolean;
}

/** A team with its members (the Teams tab). */
export interface TeamWithMembersVM {
  id: string; // teams.id (for mutations)
  slug: string;
  name: string;
  initial: string;
  members: TeamMemberVM[];
  myRole: TeamRole | null;
}

/** Everything the /settings route renders, computed server-side for the current org. */
export interface OrgSettingsData {
  me: MeVM;
  orgs: OrgVM[]; // for the switcher
  current: OrgVM; // resolved active org
  members: MemberVM[]; // active (memberships) + pending (invitations)
  teams: TeamWithMembersVM[];
}
