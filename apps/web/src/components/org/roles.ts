import type { OrgRole, TeamRole } from "@companion/contracts";

/** Label + description for each role, shown in the role-pick menus. */
export interface RoleDef {
  id: string;
  label: string;
  desc: string;
}

/* Two distinct sets: organization roles vs team roles (the design model).
   Typed Record<string, RoleDef> so the shared RoleSelect can take either map. */
export const ORG_ROLES: Record<string, RoleDef> = {
  owner: { id: "owner", label: "Owner", desc: "Full control. Billing, members, teams, and every workspace setting." },
  admin: { id: "admin", label: "Admin", desc: "Manage members and teams. Cannot change billing or owners." },
  developer: { id: "developer", label: "Developer", desc: "Create, edit, and install skills. Cannot manage members." },
};
export const ORG_ROLE_ORDER: OrgRole[] = ["owner", "admin", "developer"];

export const TEAM_ROLES: Record<string, RoleDef> = {
  admin: { id: "admin", label: "Admin", desc: "Manage this team's members and settings." },
  editor: { id: "editor", label: "Editor", desc: "Create and edit the team's skills." },
  reader: { id: "reader", label: "Reader", desc: "Read-only access to the team's skills." },
};
export const TEAM_ROLE_ORDER: TeamRole[] = ["admin", "editor", "reader"];

export function orgRole(id: string): RoleDef {
  return ORG_ROLES[id as OrgRole] ?? { id, label: id, desc: "" };
}
export function teamRole(id: string): RoleDef {
  return TEAM_ROLES[id as TeamRole] ?? { id, label: id, desc: "" };
}
