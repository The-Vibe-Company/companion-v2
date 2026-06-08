import type { OrgRole, TeamRole } from "@companion/contracts";
import type { MeVM } from "@/lib/types";

/** Display fields for any user referenced by a membership. */
export interface SeedUser {
  id: string;
  name: string;
  initials: string;
  email: string;
}

/** An org member row — active, or a pending invite (pending=true). */
export interface OrgMember {
  userId: string; // profiles.id (active) or a synthetic id (pending)
  role: OrgRole;
  joined: string;
  pending?: boolean;
  inviteId?: string; // invitations.id (pending only)
  inviteToken?: string; // shareable token (pending only)
}

export interface OrgTeamMember {
  userId: string;
  role: TeamRole;
}

export interface OrgTeam {
  id: string; // teams.id
  slug: string;
  name: string;
  members: OrgTeamMember[];
}

/** The current org with its full membership + team graph (powers the settings panes). */
export interface OrgFull {
  id: string;
  name: string;
  slug: string;
  kind: "personal" | "team";
  plan: "free" | "team";
  myRole: OrgRole;
  members: OrgMember[];
  teams: OrgTeam[];
}

export interface SettingsAppData {
  me: MeVM;
  current: OrgFull;
  users: Record<string, SeedUser>;
}

export type SettingsTab = "general" | "members" | "teams";
export type SettingsDialog = null | "invite" | "team";
/** Where a sidebar affordance wants to land the user inside Settings. */
export interface SettingsIntent {
  tab?: SettingsTab;
  dialog?: Exclude<SettingsDialog, null>;
}

/**
 * The bridge object the ported design settings components consume — same shape as the
 * prototype's useOrg() return (minus the switcher/onboarding bits, which the shell owns),
 * backed by the Companion API (built in SettingsApp).
 */
export interface OrgCtx {
  user: (id: string) => SeedUser;
  currentOrg: OrgFull;
  myId: string;
  myRole: OrgRole;
  canManage: boolean;
  isOwner: boolean;
  ownerCount: (org: OrgFull) => number;
  setMemberRole: (orgId: string, userId: string, role: OrgRole) => void;
  removeMember: (orgId: string, userId: string) => void;
  inviteMember: (orgId: string, email: string, role: OrgRole) => Promise<string>;
  revokeInvite: (orgId: string, inviteId: string) => void;
  setTeamMemberRole: (orgId: string, teamId: string, userId: string, role: TeamRole) => void;
  removeTeamMember: (orgId: string, teamId: string, userId: string) => void;
  addTeamMember: (orgId: string, teamId: string, userId: string, role: TeamRole) => void;
  createTeam: (orgId: string, name: string) => Promise<void>;
  error: string | null;
  setError: (msg: string | null) => void;
  busy: boolean;
}
