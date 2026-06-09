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
  color: z.string().nullable().default(null),
  logoUrl: z.string().nullable().default(null),
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

/** Body of `PUT /v1/orgs/current` — rename, re-slug, domain auto-join, and/or branding. */
export const updateOrgInputSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    slug: z.string().min(1).max(120).optional(),
    domainAutoJoin: z.boolean().optional(),
    color: teamBrandColorSchema.nullish(),
    logoUrl: z.string().url().max(2048).nullish(),
  })
  .refine(
    (v) =>
      v.name !== undefined ||
      v.slug !== undefined ||
      v.domainAutoJoin !== undefined ||
      v.color !== undefined ||
      v.logoUrl !== undefined,
    { message: "Provide at least one field to update." },
  );
export type UpdateOrgInput = z.infer<typeof updateOrgInputSchema>;

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

/** Allowed workspace logo uploads (PNG, JPEG, WebP, GIF). */
export const ORG_LOGO_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type OrgLogoMimeType = (typeof ORG_LOGO_MIME_TYPES)[number];

const ORG_LOGO_EXTENSION_TO_MIME: Record<string, OrgLogoMimeType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

export const ORG_LOGO_FILE_EXTENSIONS = Object.keys(ORG_LOGO_EXTENSION_TO_MIME) as Array<
  keyof typeof ORG_LOGO_EXTENSION_TO_MIME
>;

/**
 * `accept` value for `<input type="file">`.
 * Extensions only — macOS Finder ignores the filter when MIME types are mixed in.
 */
export const ORG_LOGO_FILE_ACCEPT = ORG_LOGO_FILE_EXTENSIONS.join(",");

export function resolveOrgLogoContentType(file: { type: string; name: string }): OrgLogoMimeType | null {
  if ((ORG_LOGO_MIME_TYPES as readonly string[]).includes(file.type)) {
    return file.type as OrgLogoMimeType;
  }
  const ext = file.name.toLowerCase().match(/\.[^.]+$/)?.[0];
  if (ext && ext in ORG_LOGO_EXTENSION_TO_MIME) return ORG_LOGO_EXTENSION_TO_MIME[ext]!;
  return null;
}

export function isAllowedOrgLogoFile(file: { type: string; name: string }): boolean {
  return resolveOrgLogoContentType(file) !== null;
}
