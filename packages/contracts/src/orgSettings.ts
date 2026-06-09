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
});
export type OrgSettingsOrg = z.infer<typeof orgSettingsOrgSchema>;

export const orgSettingsResponseSchema = z.object({
  org: orgSettingsOrgSchema,
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

/** Body of `PUT /v1/orgs/current` — rename and/or re-slug the workspace. */
export const updateOrgInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z.string().min(1).max(120).optional(),
  })
  .refine((v) => v.name !== undefined || v.slug !== undefined, {
    message: "Provide at least one field to update.",
  });
export type UpdateOrgInput = z.infer<typeof updateOrgInputSchema>;

/** Body of `PUT /v1/teams/:teamId` — rename, re-slug, and/or edit description. */
export const updateTeamInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z.string().min(1).max(120).optional(),
    description: z.string().max(2000).nullish(),
  })
  .refine(
    (v) => v.name !== undefined || v.slug !== undefined || v.description !== undefined,
    { message: "Provide at least one field to update." },
  );
export type UpdateTeamInput = z.infer<typeof updateTeamInputSchema>;
