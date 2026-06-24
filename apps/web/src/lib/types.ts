import type {
  OrgRole,
  CompanionDisplay,
  LabelVM,
  SkillListRow,
  SkillRequirement,
  ValidationState,
} from "@companion/contracts";
import { formatBytes, formatDate, relativeTime } from "./format";

export type { LabelVM };

/** The UI-facing skill shape consumed by the ported direction-C+C components. */
export interface SkillVM {
  uuid: string; // db id
  id: string; // slug (the displayed machine name)
  version: string | null;
  validation: ValidationState;
  description: string;
  display?: CompanionDisplay;
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
    version: row.current_version,
    validation: row.validation,
    description: row.description,
    display: row.display ?? {},
    error: row.validation_error,
    scope: row.scope ?? "org",
    source: row.source ?? null,
    labels: row.labels ?? [],
    authorId: row.creator_id,
    authorName: row.creator_name,
    authorInitials: row.creator_initials,
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

/** Everything the /settings route renders, computed server-side for the current org. */
export interface OrgSettingsData {
  me: MeVM;
  orgs: OrgVM[]; // for the switcher
  current: OrgVM; // resolved active org
  members: MemberVM[]; // active (memberships) + pending (invitations)
}
