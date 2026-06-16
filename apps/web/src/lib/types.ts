import type {
  OrgRole,
  SkillListRow,
  SkillOwnerKind,
  SkillRequirement,
  SkillVisibility,
  TeamRole,
  ValidationState,
} from "@companion/contracts";
import { formatBytes, formatDate, relativeTime } from "./format";

export interface SkillOwnerVM {
  kind: SkillOwnerKind;
  id: string;
  userId: string;
  teamId: string | null;
  name: string;
  initials: string;
  handle: string | null;
  team: string | null;
}

/** The UI-facing skill shape consumed by the ported direction-C+C components. */
export interface SkillVM {
  uuid: string; // db id
  id: string; // slug (the displayed machine name)
  ownerId: string; // effective owner principal (user id or team id)
  visibility: SkillVisibility;
  version: string | null;
  validation: ValidationState;
  description: string;
  error: string | null;
  owner: SkillOwnerVM;
  tools: string[];
  requirements: SkillRequirement[]; // declared secrets / env vars + install notes
  compatibility: string | null;
  metadata: Record<string, string>;
  size: string;
  license: string | null;
  checksum: string | null;
  created: string; // formatted date (server-computed)
  updated: string; // relative label (server-computed)
  stars: number;
  starred: boolean;
  installStatus: "none" | "installed" | "update"; // caller's install state for this skill
  installedVersion: string | null; // version the caller recorded installing, if any
  teams: SkillVisibility["teams"];
  teamSlugs: string[]; // team slugs (for filtering)
  requiresCount: number; // dependencies the current version declares
  usedByCount: number; // other skills (current versions) that depend on this one
  depWarn: boolean; // any declared dependency is not satisfied
  archived: boolean; // hidden from normal lists
  referenced?: boolean; // referenced by ANY published version (gates archived download)
}

/** Map a skill_list_v row to the UI view-model. Date formatting runs server-side. */
export function mapSkill(row: SkillListRow): SkillVM {
  return {
    uuid: row.id,
    id: row.slug,
    ownerId: row.owner_id,
    visibility: row.visibility,
    version: row.current_version,
    validation: row.validation,
    description: row.description,
    error: row.validation_error,
    owner: {
      kind: row.owner_kind,
      id: row.owner_id,
      userId: row.owner_user_id,
      teamId: row.owner_team_id,
      name: row.owner_name,
      initials: row.owner_initials,
      handle: row.owner_handle,
      team: row.owner_kind === "team" ? row.owner_name : null,
    },
    tools: row.tools ?? [],
    requirements: row.requirements ?? [],
    compatibility: row.compatibility,
    metadata: row.metadata ?? {},
    size: formatBytes(row.size_bytes),
    license: row.license,
    checksum: row.checksum,
    created: formatDate(row.created_at),
    updated: relativeTime(row.updated_at),
    stars: row.star_count,
    starred: row.starred,
    installStatus: row.install_status ?? "none",
    installedVersion: row.installed_version ?? null,
    teams: row.visibility.teams,
    teamSlugs: row.visibility.teams.map((team) => team.slug),
    requiresCount: row.requires_count ?? 0,
    usedByCount: row.used_by_count ?? 0,
    depWarn: row.dep_warn ?? false,
    archived: row.archived ?? false,
    referenced: row.referenced ?? false,
  };
}

export interface TeamVM {
  id: string; // slug
  name: string;
  initial: string;
  color: string | null;
  icon: string | null;
  role: TeamRole;
  dbId?: string;
}

export interface MeVM {
  id: string;
  name: string;
  email: string;
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
  color: string | null;
  logoUrl: string | null;
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
