import { z } from "zod";

/**
 * Visibility scope on every resource. Rendered literally (machine value) in the UI.
 * `private` = owner only, `team` = a specific team, `public` = anyone with the link.
 * (There is no org-wide tier: sharing is team-centric.)
 */
export const scopeSchema = z.enum(["private", "team", "public"]);
export type Scope = z.infer<typeof scopeSchema>;

/** Org roles, most-privileged first. */
export const orgRoleSchema = z.enum(["owner", "admin", "member", "guest"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/** Team roles. */
export const teamRoleSchema = z.enum(["admin", "member"]);
export type TeamRole = z.infer<typeof teamRoleSchema>;

/** Validation lifecycle of a skill / version. */
export const validationStateSchema = z.enum(["valid", "validating", "invalid"]);
export type ValidationState = z.infer<typeof validationStateSchema>;

export const SCOPES: readonly Scope[] = ["private", "team", "public"] as const;
export const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "member", "guest"] as const;
export const TEAM_ROLES: readonly TeamRole[] = ["admin", "member"] as const;

/** Scope ordering, narrowest to broadest. */
export const SCOPE_RANK: Record<Scope, number> = { private: 0, team: 1, public: 2 };
