import type { OrgRole } from "@companion/contracts";
import type { MeVM } from "@/lib/types";

/** Display fields for any user referenced by a membership. */
export interface SeedUser {
  id: string;
  name: string;
  initials: string;
  email: string;
  /** Resolved avatar URL (custom upload or Gravatar); null falls back to initials. */
  avatarUrl: string | null;
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

export interface OrgAccessDomain {
  id: string;
  domain: string;
  createdAt: string;
}

/** The current org with its full membership (powers the settings panes). */
export interface OrgFull {
  id: string;
  name: string;
  slug: string;
  kind: "personal" | "team";
  plan: "free" | "team";
  myRole: OrgRole;
  created: string; // formatted creation date (Workspace › General "Details")
  domain: string | null;
  domainAutoJoin: boolean;
  accessDomains: OrgAccessDomain[];
  color: string | null;
  logoUrl: string | null;
  /** The org's own skill-naming policy prompt (Workspace › General); null = none. */
  skillNamingPolicy: string | null;
  members: OrgMember[];
}

/** Signed-in actor context for the domain access editor. */
export interface DomainJoinVM {
  actorDomain: string | null;
  actorDomainIsPersonal: boolean;
}

/** A pending workspace invitation (Workspace › Invitations pane). */
export interface Invite {
  id: string;
  email: string;
  role: OrgRole;
  invited: string; // relative label, e.g. "2 days ago"
  by: string; // inviter display name ("" when unknown)
  token: string; // shareable join token
}

/** A personal API key, masked for display (the raw secret is shown once at creation). */
export interface ApiKeyVM {
  id: string;
  name: string;
  scope: "read" | "write";
  prefix: string; // e.g. "cmp_pat_…"
  last4: string; // last 4 visible chars (from the prefix; the secret is never stored)
  created: string; // formatted creation date
  lastUsed: string; // relative label, or "never"
  expires: string; // formatted expiry date (keys are time-limited)
}

export interface SettingsAppData {
  me: MeVM;
  current: OrgFull;
  domainJoin: DomainJoinVM;
  users: Record<string, SeedUser>;
  invites: Invite[];
  apiKeys: ApiKeyVM[];
}

/** Which settings pane is mounted. */
export type SettingsView =
  | "profile"
  | "preferences"
  | "providers"
  | "apikeys"
  | "general"
  | "members"
  | "invitations";

/** A resolved settings destination — a pane. */
export interface SettingsRoute {
  view: SettingsView;
}

/** Top-level dialogs the shell owns. Key create/reveal dialogs are local to ApiKeysPane. */
export type SettingsDialog = null | "invite";
/** Where a sidebar affordance wants to land the user inside Settings. */
export interface SettingsIntent {
  view?: SettingsView;
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
  /** Personal display prefs (theme + accent), persisted per-device in localStorage. */
  prefs: { theme: "light" | "dark" | "system"; accent: string };
  /** Signed-in actor context for the domain access editor (Workspace › General). */
  domainJoin: DomainJoinVM;
  setTheme: (theme: "light" | "dark" | "system") => void;
  setAccent: (accent: string) => void;
  setMyName: (name: string) => void;
  setWorkspace: (patch: {
    name?: string;
    slug?: string;
    color?: string | null;
    logoUrl?: string | null;
    skillNamingPolicy?: string | null;
  }) => void;
  addAccessDomain: (domain: string) => Promise<void>;
  removeAccessDomain: (domainId: string) => Promise<void>;
  uploadWorkspaceLogo: (file: File) => Promise<void>;
  uploadUserAvatar: (file: File) => Promise<void>;
  removeUserAvatar: () => Promise<void>;
  createApiKey: (name: string, scope: "read" | "write") => Promise<string>;
  revokeApiKey: (id: string) => void;
  setMemberRole: (orgId: string, userId: string, role: OrgRole) => void;
  removeMember: (orgId: string, userId: string) => void;
  inviteMember: (orgId: string, email: string, role: OrgRole) => Promise<string>;
  revokeInvite: (orgId: string, inviteId: string) => void;
  error: string | null;
  setError: (msg: string | null) => void;
  busy: boolean;
}
