import { z } from "zod";
import { orgRoleSchema, teamRoleSchema } from "./scope";

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
  members: z.array(orgSettingsTeamMemberSchema).default([]),
});
export type OrgSettingsTeam = z.infer<typeof orgSettingsTeamSchema>;

export const orgSettingsResponseSchema = z.object({
  members: z.array(orgSettingsMemberSchema).default([]),
  teams: z.array(orgSettingsTeamSchema).default([]),
});
export type OrgSettingsResponse = z.infer<typeof orgSettingsResponseSchema>;
