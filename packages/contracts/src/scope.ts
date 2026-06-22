import { z } from "zod";

/**
 * Skill owner filters. A skill is owned by a user (`personal`, private to that user) or a team
 * (`team`, readable by the whole workspace). The owner is the single access axis.
 */
export const visibilityFilterSchema = z.enum(["personal", "team"]);
export type VisibilityFilter = z.infer<typeof visibilityFilterSchema>;

/** Org roles, most-privileged first. */
export const orgRoleSchema = z.enum(["owner", "admin", "developer"]);
export type OrgRole = z.infer<typeof orgRoleSchema>;

/** Team roles, most-privileged first. */
export const teamRoleSchema = z.enum(["admin", "editor", "reader"]);
export type TeamRole = z.infer<typeof teamRoleSchema>;

/** Validation lifecycle of a skill / version. */
export const validationStateSchema = z.enum(["valid", "validating", "invalid"]);
export type ValidationState = z.infer<typeof validationStateSchema>;

export const ORG_ROLES: readonly OrgRole[] = ["owner", "admin", "developer"] as const;
export const TEAM_ROLES: readonly TeamRole[] = ["admin", "editor", "reader"] as const;
export const VISIBILITY_FILTERS: readonly VisibilityFilter[] = ["personal", "team"] as const;

/** Lifecycle of a membership invitation. */
export const inviteStatusSchema = z.enum(["pending", "accepted", "revoked", "expired"]);
export type InviteStatus = z.infer<typeof inviteStatusSchema>;

/** A pending/closed invitation row (read shape for the Members tab). */
export const invitationRowSchema = z.object({
  id: z.string(),
  org_id: z.string(),
  email: z.string(),
  org_role: orgRoleSchema,
  token: z.string(),
  status: inviteStatusSchema,
  created_at: z.string(),
  expires_at: z.string(),
});
export type InvitationRow = z.infer<typeof invitationRowSchema>;

/** One row of `my_orgs()` — the org switcher summary. */
export const orgSummarySchema = z.object({
  org_id: z.string(),
  name: z.string(),
  slug: z.string(),
  kind: z.enum(["personal", "team"]),
  plan: z.enum(["free", "team"]),
  org_role: orgRoleSchema,
  member_count: z.number().int().nonnegative(),
  color: z.string().nullable().optional(),
  logo_url: z.string().nullable().optional(),
});
export type OrgSummary = z.infer<typeof orgSummarySchema>;
