import type { OrgRole } from "@companion/contracts";

/** Label + description for each role, shown in the role-pick menus. */
export interface RoleDef {
  id: string;
  label: string;
  desc: string;
}

/* Organization roles (the design model).
   Typed Record<string, RoleDef> so the shared RoleSelect can consume it. */
export const ORG_ROLES: Record<string, RoleDef> = {
  owner: { id: "owner", label: "Owner", desc: "Full control. Billing, members, and every workspace setting." },
  admin: { id: "admin", label: "Admin", desc: "Manage members. Cannot change billing or owners." },
  developer: { id: "developer", label: "Developer", desc: "Create, edit, and install skills. Cannot manage members." },
};
export const ORG_ROLE_ORDER: OrgRole[] = ["owner", "admin", "developer"];

export function orgRole(id: string): RoleDef {
  return ORG_ROLES[id as OrgRole] ?? { id, label: id, desc: "" };
}
