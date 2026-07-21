import type {
  OrgRole,
  CompanionDisplay,
  LabelVM,
  SkillIcon,
  SkillListRow,
  SkillModifier,
  SkillRequirement,
  ValidationState,
} from "@companion/contracts";
import { formatBytes, formatDate, relativeTime } from "./format";

export type { LabelVM };

export type SkillContributorVM = {
  id: string;
  name: string;
  initials: string;
  avatarUrl: string | null;
};

/** The UI-facing skill shape consumed by the ported direction-C+C components. */
export interface SkillVM {
  uuid: string; // db id
  id: string; // slug (the displayed machine name)
  shareToken: string;
  version: string | null;
  validation: ValidationState;
  description: string;
  display?: CompanionDisplay;
  /** Portable catalog icon declared by the current companion.json version. */
  icon: SkillIcon | null;
  notes: string | null;
  error: string | null;
  /** Which library this row belongs to: 'org' (shared) or 'personal' (private to the creator). */
  scope: "personal" | "org";
  /**
   * Only set in the My Skills view: 'authored' = a personal skill the caller created; 'installed' =
   * an org skill the caller installed, surfaced under My Skills. Null in the org view.
   */
  source: "authored" | "installed" | null;
  /** Label paths this skill is filed under (org folders in the org view, personal folders in mine). */
  labels: string[];
  /** Who first published the skill (provenance / Activity). For a personal skill, also the owner. */
  authorId: string;
  authorName: string;
  authorInitials: string;
  /** Resolved avatar URL for the creator (custom upload or Gravatar); null falls back to initials. */
  authorAvatarUrl: string | null;
  /** "Last updated by" — the member who uploaded the current version (falls back to the creator). */
  updaterId: string;
  updaterName: string;
  updaterInitials: string;
  /** Resolved avatar URL for the last updater (custom upload or Gravatar); null falls back to initials. */
  updaterAvatarUrl: string | null;
  /** Distinct members who published versions after the creator, latest publisher first. */
  modifiers: SkillContributorVM[];
  tools: string[];
  requirements: SkillRequirement[]; // declared secrets / env vars + install notes
  compatibility: string | null;
  metadata: Record<string, string>;
  size: string;
  license: string | null;
  checksum: string | null;
  created: string; // formatted date (server-computed)
  updated: string; // relative label (server-computed)
  installStatus: "none" | "installed" | "update"; // caller's install state for this skill
  installedVersion: string | null; // version the caller recorded installing, if any
  requiresCount: number; // dependencies the current version declares
  usedByCount: number; // other skills (current versions) that depend on this one
  depWarn: boolean; // any declared dependency is not satisfied
  archived: boolean; // hidden from normal lists
  referenced?: boolean; // referenced by ANY published version (gates archived download)
}

function mapModifier(row: SkillModifier): SkillContributorVM {
  return {
    id: row.user_id,
    name: row.name,
    initials: row.initials,
    avatarUrl: row.avatar_url ?? null,
  };
}

/** Map a skill_list_v row to the UI view-model. Date formatting runs server-side. */
export function mapSkill(row: SkillListRow): SkillVM {
  return {
    uuid: row.id,
    id: row.slug,
    shareToken: row.share_token,
    version: row.current_version,
    validation: row.validation,
    description: row.description,
    display: row.display ?? {},
    icon: row.icon ?? null,
    notes: row.notes ?? null,
    error: row.validation_error,
    scope: row.scope ?? "org",
    source: row.source ?? null,
    labels: row.labels ?? [],
    authorId: row.creator_id,
    authorName: row.creator_name,
    authorInitials: row.creator_initials,
    authorAvatarUrl: row.creator_avatar_url ?? null,
    updaterId: row.updater_id ?? row.creator_id,
    updaterName: row.updater_name ?? row.creator_name,
    updaterInitials: row.updater_initials ?? row.creator_initials,
    // Resolve the avatar ATOMICALLY against the updater identity: only borrow the creator's avatar when
    // there is no updater (updater_id null). When the updater is known but has no avatar, keep null so
    // UserAvatar renders the updater's initials — never the creator's face under the updater's name.
    updaterAvatarUrl: row.updater_id ? (row.updater_avatar_url ?? null) : (row.creator_avatar_url ?? null),
    modifiers: (row.modifiers ?? []).map(mapModifier),
    tools: row.tools ?? [],
    requirements: row.requirements ?? [],
    compatibility: row.compatibility,
    metadata: row.metadata ?? {},
    size: formatBytes(row.size_bytes),
    license: row.license,
    checksum: row.checksum,
    created: formatDate(row.created_at),
    updated: relativeTime(row.updated_at),
    installStatus: row.install_status ?? "none",
    installedVersion: row.installed_version ?? null,
    requiresCount: row.requires_count ?? 0,
    usedByCount: row.used_by_count ?? 0,
    depWarn: row.dep_warn ?? false,
    archived: row.archived ?? false,
    referenced: row.referenced ?? false,
  };
}

export interface MeVM {
  id: string;
  name: string;
  email: string;
  initials: string;
  /** Resolved avatar URL (custom upload or Gravatar); null falls back to initials. */
  avatarUrl: string | null;
}

/* ---- Org / membership view-models (settings surface + switcher) ----------- */

/** One workspace the current user belongs to (the org switcher + General pane). */
export interface OrgVM {
  id: string; // organizations.id (the explicit current-org id the RPCs accept)
  name: string;
  slug: string;
  kind: "personal" | "team";
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
  avatarUrl: string | null; // resolved avatar (custom upload or Gravatar); null → initials
  role: OrgRole;
  joined: string; // formatted date, or "—" / "pending"
  pending: boolean; // true => from invitations, not memberships
  inviteId?: string; // invitations.id (pending rows only)
  inviteToken?: string; // shareable join token (pending rows only)
  isMe: boolean;
}

/** Everything the /settings route renders, computed server-side for the current org. */
export interface OrgSettingsData {
  me: MeVM;
  orgs: OrgVM[]; // for the switcher
  current: OrgVM; // resolved active org
  members: MemberVM[]; // active (memberships) + pending (invitations)
}
