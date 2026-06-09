import { z } from "zod";
import { inviteStatusSchema, orgRoleSchema, teamRoleSchema } from "./scope";

export const orgSettingsMemberSchema = z.object({
  userId: z.string(),
  role: orgRoleSchema,
  joined: z.string(),
  pending: z.boolean().default(false),
  inviteId: z.string().optional(),
  inviteToken: z.string().optional(),
  name: z.string(),
  email: z.string(),
  initials: z.string(),
});
export type OrgSettingsMember = z.infer<typeof orgSettingsMemberSchema>;

export const orgSettingsTeamMemberSchema = z.object({
  userId: z.string(),
  role: teamRoleSchema,
  name: z.string(),
  email: z.string(),
  initials: z.string(),
});
export type OrgSettingsTeamMember = z.infer<typeof orgSettingsTeamMemberSchema>;

export const orgSettingsTeamSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  color: z.string().nullable().default(null),
  icon: z.string().nullable().default(null),
  members: z.array(orgSettingsTeamMemberSchema).default([]),
});
export type OrgSettingsTeam = z.infer<typeof orgSettingsTeamSchema>;

/** A pending invitation, surfaced on its own Invitations pane (admins only). */
export const orgSettingsInvitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: orgRoleSchema,
  token: z.string(),
  status: inviteStatusSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
});
export type OrgSettingsInvitation = z.infer<typeof orgSettingsInvitationSchema>;

/** Current org identity shown on the Workspace → General "Details" block. */
export const orgSettingsOrgSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  kind: z.enum(["personal", "team"]),
  plan: z.enum(["free", "team"]),
  createdAt: z.string(),
  domain: z.string().nullable().default(null),
  domainAutoJoin: z.boolean().default(false),
});
export type OrgSettingsOrg = z.infer<typeof orgSettingsOrgSchema>;

/** Signed-in actor context for the domain auto-join control (Workspace › General). */
export const orgSettingsDomainJoinSchema = z.object({
  actorDomain: z.string().nullable(),
  actorDomainIsPersonal: z.boolean(),
});
export type OrgSettingsDomainJoin = z.infer<typeof orgSettingsDomainJoinSchema>;

export const orgSettingsResponseSchema = z.object({
  org: orgSettingsOrgSchema,
  domainJoin: orgSettingsDomainJoinSchema,
  members: z.array(orgSettingsMemberSchema).default([]),
  teams: z.array(orgSettingsTeamSchema).default([]),
  invitations: z.array(orgSettingsInvitationSchema).default([]),
});
export type OrgSettingsResponse = z.infer<typeof orgSettingsResponseSchema>;

/** Body of `PUT /v1/users/me` — self-service profile rename. */
export const updateUserProfileInputSchema = z.object({
  name: z.string().min(1).max(120),
});
export type UpdateUserProfileInput = z.infer<typeof updateUserProfileInputSchema>;

/** Body of `PUT /v1/orgs/current` — rename, re-slug, and/or edit domain auto-join. */
export const updateOrgInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z.string().min(1).max(120).optional(),
    domainAutoJoin: z.boolean().optional(),
  })
  .refine((v) => v.name !== undefined || v.slug !== undefined || v.domainAutoJoin !== undefined, {
    message: "Provide at least one field to update.",
  });
export type UpdateOrgInput = z.infer<typeof updateOrgInputSchema>;

/** Allowed team avatar swatches (CSS colors rendered inline in the UI). */
export const TEAM_BRAND_COLORS = [
  "oklch(0.56 0.13 250)", // blue
  "oklch(0.54 0.10 168)", // teal
  "oklch(0.55 0.13 300)", // violet
  "oklch(0.60 0.10 66)", // amber
  "oklch(0.55 0.13 24)", // terracotta
  "oklch(0.50 0.035 265)", // slate
] as const;

export const teamBrandColorSchema = z.enum(TEAM_BRAND_COLORS);

/** Body of `PUT /v1/teams/:teamId` — rename, re-slug, describe, and/or edit branding. */
export const updateTeamInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullish(),
    color: teamBrandColorSchema.nullish(),
    icon: z.string().max(32).nullish(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.slug !== undefined ||
      v.description !== undefined ||
      v.color !== undefined ||
      v.icon !== undefined,
    { message: "Provide at least one field to update." },
  );
export type UpdateTeamInput = z.infer<typeof updateTeamInputSchema>;
