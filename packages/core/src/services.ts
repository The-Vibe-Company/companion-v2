import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, exists, gt, inArray, isNull, ne, not, or, sql } from "drizzle-orm";
import type {
  ApiTokenRow,
  DependencyPlan,
  LocalSkillStatus,
  OrgRole,
  OrgSettingsDomainJoin,
  OrgSettingsInvitation,
  OrgSettingsOrg,
  SkillCommentRow,
  SkillDependenciesResponse,
  SkillDependencyRow,
  SkillDependencyStatus,
  SkillDependentRow,
  SkillFilterPreferences,
  SkillListRow,
  SkillVisibility,
  SkillVisibilityInput,
  SkillVersionRow,
  TeamRole,
  TokenScope,
  VisibilityFilter,
} from "@companion/contracts";
import {
  API_TOKEN_PREFIX,
  companionManifestSchema,
  fallbackCompanionManifest,
  normalizeTag,
  parseAllowedTools,
  parseStoredSkillFrontmatter,
  publishSkillInputSchema,
  setSkillTagsInputSchema,
  skillFilterPreferencesSchema,
  TEAM_BRAND_COLORS,
  visibilityCovers,
  type CompanionManifest,
  type PublishSkillInput,
} from "@companion/contracts";

// Re-exported so existing importers (tests, callers) keep `visibilityCovers` from core; the rule
// itself now lives in @companion/contracts as the single source of truth shared with the web app.
export { visibilityCovers } from "@companion/contracts";
import { compareSemver } from "@companion/skills";
import { db, schema, type Db } from "@companion/db";
import { initialsFor, slugify } from "@companion/db/ids";
import { listOrgAccessDomains } from "./domainAccess";
import { classifyEmailDomain } from "./email-domains";
import {
  canActAtVisibility,
  canManageOrg,
  canManageTeam,
  canModify,
  canTouchOwner,
  isLastOwner,
  isLastTeamAdmin,
  isOrgAdmin,
} from "./authz";

// Domain-driven onboarding services (create/join/context). Re-exported so callers keep importing
// everything from `@companion/core/services`. `onboarding.ts` only imports `uniqueSlug` (a hoisted
// function declaration) and the `ActorContext` type from here, so the cycle is load-order safe.
export * from "./onboarding";
export {
  addOrgAccessDomain,
  listJoinableOrgsByDomain,
  listOrgAccessDomains,
  normalizeAccessDomain,
  orgAllowsEmailDomain,
  removeOrgAccessDomain,
} from "./domainAccess";

export interface ActorContext {
  id: string;
  email: string;
  name: string;
}

export interface OrgSummary {
  org_id: string;
  name: string;
  slug: string;
  kind: "personal" | "team";
  plan: "free" | "team";
  org_role: OrgRole;
  member_count: number;
  color: string | null;
  logo_url: string | null;
}

export interface OrgSettingsMember {
  userId: string;
  role: OrgRole;
  joined: string;
  pending: boolean;
  inviteId?: string;
  inviteToken?: string;
  name: string;
  email: string;
  initials: string;
}

export interface OrgSettingsTeam {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  color: string | null;
  icon: string | null;
  members: Array<{
    userId: string;
    role: TeamRole;
    name: string;
    email: string;
    initials: string;
  }>;
}

export function uniqueSlug(base: string, suffix: string): string {
  return `${slugify(base)}-${suffix.slice(0, 8).toLowerCase()}`;
}

/** True when an error is a Postgres unique-constraint violation (SQLSTATE 23505). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === "23505";
}

function parseStoredCompanionManifest(frontmatter: string, fallbackSummary: string): CompanionManifest {
  const legacy = parseStoredSkillFrontmatter(frontmatter);
  try {
    const raw = JSON.parse(frontmatter) as { companion?: unknown };
    const parsed = raw.companion ? companionManifestSchema.safeParse(raw.companion) : null;
    if (parsed?.success) {
      return fallbackCompanionManifest({
        summary: fallbackSummary,
        display: {
          ...parsed.data.display,
          description: parsed.data.display.description ?? legacy?.description,
        },
        requirements: parsed.data.requirements,
        dependencies: parsed.data.dependencies,
      });
    }
  } catch {
    // Fall back to legacy frontmatter fields below.
  }
  return fallbackCompanionManifest({
    summary: fallbackSummary,
    display: {
      description: legacy?.description,
    },
    requirements: legacy?.requirements ?? [],
  });
}

/**
 * Ensure the user has a `profiles` row. Membership is NOT created here: brand-new users have no
 * org and complete the domain-driven onboarding flow (create or join) instead — see `onboarding.ts`.
 * (The legacy "first user owns the seeded Acme org" bootstrap was removed in favor of onboarding.)
 */
export async function ensureUserBootstrap(actor: ActorContext, database: Db = db): Promise<void> {
  await database
    .insert(schema.profiles)
    .values({
      id: actor.id,
      email: actor.email,
      name: actor.name || actor.email,
      initials: initialsFor(actor.name || actor.email),
      handle: actor.email.split("@")[0] ?? null,
    })
    .onConflictDoNothing();
}

/**
 * Self-service profile rename. Trims the name, recomputes `initials`, and writes the `profiles` row.
 * `profiles` carries no RLS (it is keyed by the auth user id), so this runs on the plain `db` handle
 * like `ensureUserBootstrap`. The caller (REST route) separately syncs the Better Auth `user.name`.
 */
export async function updateUserProfile(input: {
  actor: ActorContext;
  name: string;
  database?: Db;
}): Promise<{ id: string; name: string; initials: string }> {
  const database = input.database ?? db;
  const name = input.name.trim();
  if (!name) throw new Error("name is required");
  const initials = initialsFor(name);
  await ensureUserBootstrap(input.actor, database);
  await database
    .update(schema.profiles)
    .set({ name, initials, updatedAt: new Date() })
    .where(eq(schema.profiles.id, input.actor.id));
  return { id: input.actor.id, name, initials };
}

export async function listOrgs(actor: ActorContext, database: Db = db): Promise<OrgSummary[]> {
  await ensureUserBootstrap(actor, database);
  const rows = await database
    .select({
      org_id: schema.organizations.id,
      name: schema.organizations.name,
      slug: schema.organizations.slug,
      kind: schema.organizations.kind,
      plan: schema.organizations.plan,
      org_role: schema.memberships.orgRole,
      color: schema.organizations.color,
      logo_url: schema.organizations.logoUrl,
    })
    .from(schema.organizations)
    .innerJoin(schema.memberships, eq(schema.memberships.orgId, schema.organizations.id))
    .where(eq(schema.memberships.userId, actor.id))
    .orderBy(asc(schema.memberships.createdAt));

  const summaries: OrgSummary[] = [];
  for (const r of rows) {
    const [memberCount] = await database
      .select({ value: count() })
      .from(schema.memberships)
      .where(eq(schema.memberships.orgId, r.org_id));
    summaries.push({
      ...r,
      org_role: r.org_role as OrgRole,
      member_count: Number(memberCount?.value ?? 0),
    });
  }
  return summaries;
}

export async function getOrgRole(orgId: string, userId: string, database: Db = db): Promise<OrgRole | null> {
  const row = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)),
  });
  return (row?.orgRole as OrgRole | undefined) ?? null;
}

export async function createOrg(input: {
  actor: ActorContext;
  name: string;
  kind: "personal" | "team";
  database?: Db;
}): Promise<{ id: string; slug: string }> {
  const database = input.database ?? db;
  await ensureUserBootstrap(input.actor, database);
  const slug = uniqueSlug(input.name, crypto.randomUUID());
  const [org] = await database
    .insert(schema.organizations)
    .values({ name: input.name, slug, kind: input.kind, plan: input.kind === "team" ? "team" : "free" })
    .returning();
  if (!org) throw new Error("could not create organization");
  await database.insert(schema.memberships).values({ orgId: org.id, userId: input.actor.id, orgRole: "owner" });
  return { id: org.id, slug: org.slug };
}

/**
 * Rename, re-slug, and/or edit branding for the current organization. Requires an org admin
 * (`canManageOrg`). Domain access is managed separately through `organization_domains`.
 */
export async function updateOrg(input: {
  actor: ActorContext;
  orgId: string;
  name?: string;
  slug?: string;
  color?: string | null;
  logoUrl?: string | null;
  database?: Db;
}): Promise<{
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  domainAutoJoin: boolean;
  color: string | null;
  logoUrl: string | null;
}> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to update this organization");

  const orgRow = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, input.orgId),
  });
  if (!orgRow) throw new Error("organization not found");

  const patch: {
    name?: string;
    slug?: string;
    color?: string | null;
    logoUrl?: string | null;
    updatedAt: Date;
  } = { updatedAt: new Date() };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("name is required");
    patch.name = name;
  }
  if (input.slug !== undefined) {
    const slug = slugify(input.slug);
    const conflict = await database.query.organizations.findFirst({
      where: and(eq(schema.organizations.slug, slug), ne(schema.organizations.id, input.orgId)),
    });
    if (conflict) throw new Error("that workspace URL is already taken");
    patch.slug = slug;
  }
  if (input.color !== undefined) {
    patch.color = input.color;
  }
  if (input.logoUrl !== undefined) {
    patch.logoUrl = input.logoUrl;
  }
  if (
    patch.name === undefined &&
    patch.slug === undefined &&
    patch.color === undefined &&
    patch.logoUrl === undefined
  ) {
    throw new Error("nothing to update");
  }

  let row;
  try {
    [row] = await database
      .update(schema.organizations)
      .set(patch)
      .where(eq(schema.organizations.id, input.orgId))
      .returning({
        id: schema.organizations.id,
        name: schema.organizations.name,
        slug: schema.organizations.slug,
        domain: schema.organizations.domain,
        domainAutoJoin: schema.organizations.domainAutoJoin,
        color: schema.organizations.color,
        logoUrl: schema.organizations.logoUrl,
      });
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("that workspace URL is already taken");
    throw error;
  }
  if (!row) throw new Error("organization not found");
  return row;
}

export function orgLogoPublicPath(orgId: string): string {
  return `/v1/orgs/${orgId}/logo`;
}

/**
 * Persist a hosted workspace logo URL after the binary has been stored. Requires an org admin.
 */
export async function setOrgLogoFromUpload(input: {
  actor: ActorContext;
  orgId: string;
  logoUrl: string;
  database?: Db;
}): Promise<{ id: string; name: string; slug: string; domain: string | null; domainAutoJoin: boolean; color: string | null; logoUrl: string | null }> {
  return updateOrg({ actor: input.actor, orgId: input.orgId, logoUrl: input.logoUrl, database: input.database });
}

/** Read access to a hosted workspace logo binary — any org member. */
export async function getOrgLogoAsset(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
}

export async function listTeamsForUser(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<Array<{ id: string; slug: string; name: string; color: string | null; icon: string | null; teamRole: TeamRole }>> {
  const database = input.database ?? db;
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  if (canManageOrg(orgRole)) {
    return database
      .select({
        id: schema.teams.id,
        slug: schema.teams.slug,
        name: schema.teams.name,
        color: schema.teams.color,
        icon: schema.teams.icon,
        teamRole: sql<TeamRole>`'admin'::team_role`,
      })
      .from(schema.teams)
      .where(eq(schema.teams.orgId, input.orgId))
      .orderBy(asc(schema.teams.name));
  }
  const rows = await database
    .select({
      id: schema.teams.id,
      slug: schema.teams.slug,
      name: schema.teams.name,
      color: schema.teams.color,
      icon: schema.teams.icon,
      teamRole: schema.teamMemberships.teamRole,
    })
    .from(schema.teams)
    .innerJoin(schema.teamMemberships, eq(schema.teamMemberships.teamId, schema.teams.id))
    .where(
      and(
        eq(schema.teams.orgId, input.orgId),
        eq(schema.teamMemberships.orgId, input.orgId),
        eq(schema.teamMemberships.userId, input.actor.id),
      ),
    )
    .orderBy(asc(schema.teams.name));
  return rows;
}

export async function getOrgSettings(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<{
  org: OrgSettingsOrg;
  domainJoin: OrgSettingsDomainJoin;
  members: OrgSettingsMember[];
  teams: OrgSettingsTeam[];
  invitations: OrgSettingsInvitation[];
}> {
  const database = input.database ?? db;
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");

  const { domain: actorDomain, isPersonal: actorDomainIsPersonal } = classifyEmailDomain(input.actor.email);
  const domainJoin: OrgSettingsDomainJoin = { actorDomain, actorDomainIsPersonal };

  const orgRow = await database.query.organizations.findFirst({
    where: eq(schema.organizations.id, input.orgId),
  });
  if (!orgRow) throw new Error("organization not found");
  const org: OrgSettingsOrg = {
    id: orgRow.id,
    name: orgRow.name,
    slug: orgRow.slug,
    kind: orgRow.kind,
    plan: orgRow.plan,
    createdAt: orgRow.createdAt.toISOString(),
    domain: orgRow.domain,
    domainAutoJoin: orgRow.domainAutoJoin,
    accessDomains: await listOrgAccessDomains(input.orgId, database),
    color: orgRow.color,
    logoUrl: orgRow.logoUrl,
  };

  const memberRows = await database
    .select({
      userId: schema.memberships.userId,
      role: schema.memberships.orgRole,
      joined: schema.memberships.createdAt,
      name: schema.profiles.name,
      email: schema.profiles.email,
      initials: schema.profiles.initials,
    })
    .from(schema.memberships)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.memberships.userId))
    .where(eq(schema.memberships.orgId, input.orgId))
    .orderBy(asc(schema.memberships.createdAt));

  const members: OrgSettingsMember[] = memberRows.map((r) => ({
    userId: r.userId,
    role: r.role as OrgRole,
    joined: r.joined.toISOString(),
    pending: false,
    name: r.name,
    email: r.email,
    initials: r.initials,
  }));

  // Admins additionally see pending invitations: folded into `members[]` (legacy, for the existing
  // Members UI) and surfaced as a clean `invitations[]` for the dedicated Invitations pane.
  const invitations: OrgSettingsInvitation[] = [];
  if (canManageOrg(orgRole)) {
    const inviteRows = await database
      .select({
        id: schema.invitations.id,
        email: schema.invitations.email,
        role: schema.invitations.orgRole,
        token: schema.invitations.token,
        status: schema.invitations.status,
        createdAt: schema.invitations.createdAt,
        expiresAt: schema.invitations.expiresAt,
      })
      .from(schema.invitations)
      .where(and(eq(schema.invitations.orgId, input.orgId), eq(schema.invitations.status, "pending")))
      .orderBy(asc(schema.invitations.createdAt));
    for (const invite of inviteRows) {
      const display = invite.email.split("@")[0] ?? invite.email;
      members.push({
        userId: `invite:${invite.id}`,
        role: invite.role as OrgRole,
        joined: invite.createdAt.toISOString(),
        pending: true,
        inviteId: invite.id,
        inviteToken: invite.token,
        name: display,
        email: invite.email,
        initials: initialsFor(display),
      });
      invitations.push({
        id: invite.id,
        email: invite.email,
        role: invite.role as OrgRole,
        token: invite.token,
        status: invite.status,
        createdAt: invite.createdAt.toISOString(),
        expiresAt: invite.expiresAt.toISOString(),
      });
    }
  }

  const teamRows = await database
    .select({
      id: schema.teams.id,
      slug: schema.teams.slug,
      name: schema.teams.name,
      description: schema.teams.description,
      color: schema.teams.color,
      icon: schema.teams.icon,
    })
    .from(schema.teams)
    .where(eq(schema.teams.orgId, input.orgId))
    .orderBy(asc(schema.teams.name));

  const teams: OrgSettingsTeam[] = [];
  for (const team of teamRows) {
    const teamMembers = await database
      .select({
        userId: schema.teamMemberships.userId,
        role: schema.teamMemberships.teamRole,
        name: schema.profiles.name,
        email: schema.profiles.email,
        initials: schema.profiles.initials,
      })
      .from(schema.teamMemberships)
      .innerJoin(schema.profiles, eq(schema.profiles.id, schema.teamMemberships.userId))
      .where(eq(schema.teamMemberships.teamId, team.id))
      .orderBy(asc(schema.profiles.name));
    teams.push({
      id: team.id,
      slug: team.slug,
      name: team.name,
      description: team.description,
      color: team.color,
      icon: team.icon,
      members: teamMembers.map((m) => ({
        userId: m.userId,
        role: m.role as TeamRole,
        name: m.name,
        email: m.email,
        initials: m.initials,
      })),
    });
  }

  return { org, domainJoin, members, teams, invitations };
}

export async function createTeam(input: {
  actor: ActorContext;
  orgId: string;
  name: string;
  database?: Db;
}): Promise<{ id: string; slug: string }> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to create teams");
  const slug = uniqueSlug(input.name, crypto.randomUUID());
  const [team] = await database
    .insert(schema.teams)
    .values({ orgId: input.orgId, name: input.name, slug })
    .returning();
  if (!team) throw new Error("could not create team");
  await database.insert(schema.teamMemberships).values({
    orgId: input.orgId,
    teamId: team.id,
    userId: input.actor.id,
    teamRole: "admin",
  });
  return { id: team.id, slug: team.slug };
}

/**
 * Rename, re-slug, and/or edit a team's description. Allowed for an org admin OR a team admin (reuses
 * `assertCanManageTeam`). The slug is normalized and unique per-org (`org_id` + `slug`); description is
 * trimmed and an empty string collapses to `null`.
 */
export async function updateTeam(input: {
  actor: ActorContext;
  orgId: string;
  teamId: string;
  name?: string;
  slug?: string;
  description?: string | null;
  color?: string | null;
  icon?: string | null;
  database?: Db;
}): Promise<{ id: string; name: string; slug: string; description: string | null; color: string | null; icon: string | null }> {
  const database = input.database ?? db;
  await assertCanManageTeam({ actor: input.actor, orgId: input.orgId, teamId: input.teamId, database });

  const patch: {
    name?: string;
    slug?: string;
    description?: string | null;
    color?: string | null;
    icon?: string | null;
    updatedAt: Date;
  } = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new Error("name is required");
    patch.name = name;
  }
  if (input.slug !== undefined) {
    const slug = slugify(input.slug);
    const conflict = await database.query.teams.findFirst({
      where: and(
        eq(schema.teams.orgId, input.orgId),
        eq(schema.teams.slug, slug),
        ne(schema.teams.id, input.teamId),
      ),
    });
    if (conflict) throw new Error("that team URL is already taken");
    patch.slug = slug;
  }
  if (input.description !== undefined) {
    const description = input.description?.trim() ?? "";
    patch.description = description ? description : null;
  }
  if (input.color !== undefined) {
    const color = input.color?.trim() ?? "";
    if (color && !(TEAM_BRAND_COLORS as readonly string[]).includes(color)) {
      throw new Error("invalid team color");
    }
    patch.color = color ? color : null;
  }
  if (input.icon !== undefined) {
    const icon = input.icon?.trim() ?? "";
    patch.icon = icon ? icon : null;
  }
  if (
    patch.name === undefined &&
    patch.slug === undefined &&
    patch.description === undefined &&
    patch.color === undefined &&
    patch.icon === undefined
  ) {
    throw new Error("nothing to update");
  }

  let row;
  try {
    [row] = await database
      .update(schema.teams)
      .set(patch)
      .where(and(eq(schema.teams.orgId, input.orgId), eq(schema.teams.id, input.teamId)))
      .returning({
        id: schema.teams.id,
        name: schema.teams.name,
        slug: schema.teams.slug,
        description: schema.teams.description,
        color: schema.teams.color,
        icon: schema.teams.icon,
      });
  } catch (error) {
    if (isUniqueViolation(error)) throw new Error("that team URL is already taken");
    throw error;
  }
  if (!row) throw new Error("team not found");
  return row;
}

/**
 * Delete a team. Requires an org admin (`canManageOrg`), and the org must keep at least one team.
 * Skill team shares cascade through `skill_team_shares`, so deleting a team only removes that team's
 * visibility grant; a skill becomes private if it is not shared with Everyone and has no teams left.
 * Team-owned skills fall back to their stored user owner when `owner_team_id` is set null by the FK.
 */
export async function deleteTeam(input: {
  actor: ActorContext;
  orgId: string;
  teamId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to delete teams");
  const team = await database.query.teams.findFirst({
    where: and(eq(schema.teams.orgId, input.orgId), eq(schema.teams.id, input.teamId)),
  });
  if (!team) throw new Error("team not found");

  await database.transaction(async (tx) => {
    // Serialize concurrent deletes for this org so the "keep at least one team" invariant can't be
    // raced (two deletes both seeing count > 1 and leaving zero teams). Mirrors the org-owner guard.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:org-teams:${input.orgId}`}))`);
    const [teamCount] = await tx
      .select({ value: count() })
      .from(schema.teams)
      .where(eq(schema.teams.orgId, input.orgId));
    if (Number(teamCount?.value ?? 0) <= 1) throw new Error("organization must keep at least one team");
    const affectedShares = await tx
      .select({ skillId: schema.skillTeamShares.skillId })
      .from(schema.skillTeamShares)
      .where(and(eq(schema.skillTeamShares.orgId, input.orgId), eq(schema.skillTeamShares.teamId, input.teamId)));
    const ownedSkills = await tx
      .select({ skillId: schema.skills.id })
      .from(schema.skills)
      .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.ownerTeamId, input.teamId)));
    const affectedSkillIds = [...new Set([...affectedShares.map((share) => share.skillId), ...ownedSkills.map((skill) => skill.skillId)])];
    if (affectedSkillIds.length) {
      await tx
        .update(schema.skills)
        .set({ updatedAt: new Date() })
        .where(and(eq(schema.skills.orgId, input.orgId), inArray(schema.skills.id, affectedSkillIds)));
    }
    const ownedSkillIds = ownedSkills.map((skill) => skill.skillId);
    if (ownedSkillIds.length) {
      await tx
        .update(schema.skills)
        .set({ ownerTeamId: null, updatedAt: new Date() })
        .where(and(eq(schema.skills.orgId, input.orgId), inArray(schema.skills.id, ownedSkillIds)));
    }
    await tx
      .delete(schema.teams)
      .where(and(eq(schema.teams.orgId, input.orgId), eq(schema.teams.id, input.teamId)));
  });
}

export async function revokeInvitation(input: {
  actor: ActorContext;
  orgId: string;
  inviteId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to revoke invites");
  await database
    .update(schema.invitations)
    .set({ status: "revoked" })
    .where(and(eq(schema.invitations.orgId, input.orgId), eq(schema.invitations.id, input.inviteId)));
}

async function ownerCount(orgId: string, database: Db): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(schema.memberships)
    .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.orgRole, "owner")));
  return Number(row?.value ?? 0);
}

export async function setMemberRole(input: {
  actor: ActorContext;
  orgId: string;
  userId: string;
  role: OrgRole;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const actorRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!actorRole || !canManageOrg(actorRole)) throw new Error("not allowed to change member roles");
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:org-owner:${input.orgId}`}))`);
  const target = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.userId)),
  });
  if (!target) throw new Error("member not found");
  const targetRole = target.orgRole as OrgRole;
  if ((targetRole === "owner" || input.role === "owner") && !canTouchOwner(actorRole)) {
    throw new Error("only owners can change owner roles");
  }
  if (isLastOwner(await ownerCount(input.orgId, database), targetRole === "owner") && input.role !== "owner") {
    throw new Error("organization must keep at least one owner");
  }
  await database
    .update(schema.memberships)
    .set({ orgRole: input.role, updatedAt: new Date() })
    .where(and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.userId)));
}

export async function removeMember(input: {
  actor: ActorContext;
  orgId: string;
  userId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const actorRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!actorRole || !canManageOrg(actorRole)) throw new Error("not allowed to remove members");
  await database.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:org-owner:${input.orgId}`}))`);
  const target = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.userId)),
  });
  if (!target) throw new Error("member not found");
  const targetRole = target.orgRole as OrgRole;
  if (targetRole === "owner" && !canTouchOwner(actorRole)) throw new Error("only owners can remove owners");
  if (isLastOwner(await ownerCount(input.orgId, database), targetRole === "owner")) {
    throw new Error("organization must keep at least one owner");
  }
  await database.transaction(async (tx) => {
    await tx
      .delete(schema.teamMemberships)
      .where(and(eq(schema.teamMemberships.orgId, input.orgId), eq(schema.teamMemberships.userId, input.userId)));
    await tx
      .delete(schema.memberships)
      .where(and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.userId)));
  });
}

async function assertCanManageTeam(input: {
  actor: ActorContext;
  orgId: string;
  teamId: string;
  database: Db;
}): Promise<void> {
  const orgRole = await getOrgRole(input.orgId, input.actor.id, input.database);
  if (!orgRole) throw new Error("not a member of this organization");
  const team = await input.database.query.teams.findFirst({
    where: and(eq(schema.teams.orgId, input.orgId), eq(schema.teams.id, input.teamId)),
  });
  if (!team) throw new Error("team not found");
  const teamMembership = await input.database.query.teamMemberships.findFirst({
    where: and(eq(schema.teamMemberships.teamId, input.teamId), eq(schema.teamMemberships.userId, input.actor.id)),
  });
  if (!canManageTeam({ orgRole, teamRole: teamMembership?.teamRole as TeamRole | null })) {
    throw new Error("not allowed to manage team members");
  }
}

async function teamAdminCount(teamId: string, database: Db): Promise<number> {
  const [row] = await database
    .select({ value: count() })
    .from(schema.teamMemberships)
    .where(and(eq(schema.teamMemberships.teamId, teamId), eq(schema.teamMemberships.teamRole, "admin")));
  return Number(row?.value ?? 0);
}

export async function addTeamMember(input: {
  actor: ActorContext;
  orgId: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertCanManageTeam({ actor: input.actor, orgId: input.orgId, teamId: input.teamId, database });
  const orgMembership = await database.query.memberships.findFirst({
    where: and(eq(schema.memberships.orgId, input.orgId), eq(schema.memberships.userId, input.userId)),
  });
  if (!orgMembership) throw new Error("member not found in organization");
  await database
    .insert(schema.teamMemberships)
    .values({ orgId: input.orgId, teamId: input.teamId, userId: input.userId, teamRole: input.role })
    .onConflictDoUpdate({
      target: [schema.teamMemberships.teamId, schema.teamMemberships.userId],
      set: { teamRole: input.role, updatedAt: new Date() },
    });
}

export async function setTeamMemberRole(input: {
  actor: ActorContext;
  orgId: string;
  teamId: string;
  userId: string;
  role: TeamRole;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertCanManageTeam({ actor: input.actor, orgId: input.orgId, teamId: input.teamId, database });
  const target = await database.query.teamMemberships.findFirst({
    where: and(eq(schema.teamMemberships.teamId, input.teamId), eq(schema.teamMemberships.userId, input.userId)),
  });
  if (!target) throw new Error("team member not found");
  if (isLastTeamAdmin(await teamAdminCount(input.teamId, database), target.teamRole === "admin") && input.role !== "admin") {
    throw new Error("team must keep at least one admin");
  }
  await database
    .update(schema.teamMemberships)
    .set({ teamRole: input.role, updatedAt: new Date() })
    .where(and(eq(schema.teamMemberships.teamId, input.teamId), eq(schema.teamMemberships.userId, input.userId)));
}

export async function removeTeamMember(input: {
  actor: ActorContext;
  orgId: string;
  teamId: string;
  userId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  await assertCanManageTeam({ actor: input.actor, orgId: input.orgId, teamId: input.teamId, database });
  const target = await database.query.teamMemberships.findFirst({
    where: and(eq(schema.teamMemberships.teamId, input.teamId), eq(schema.teamMemberships.userId, input.userId)),
  });
  if (!target) throw new Error("team member not found");
  if (isLastTeamAdmin(await teamAdminCount(input.teamId, database), target.teamRole === "admin")) {
    throw new Error("team must keep at least one admin");
  }
  await database
    .delete(schema.teamMemberships)
    .where(and(eq(schema.teamMemberships.teamId, input.teamId), eq(schema.teamMemberships.userId, input.userId)));
}

async function visibleSkillPredicate(database: Db, actor: ActorContext, orgId: string) {
  const orgRole = await getOrgRole(orgId, actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  if (orgRole && canManageOrg(orgRole)) return eq(schema.skills.orgId, orgId);
  const teamsForActor = database
    .select({ teamId: schema.teamMemberships.teamId })
    .from(schema.teamMemberships)
    .where(and(eq(schema.teamMemberships.orgId, orgId), eq(schema.teamMemberships.userId, actor.id)));
  const teamSharedSkillsForActor = database
    .select({ skillId: schema.skillTeamShares.skillId })
    .from(schema.skillTeamShares)
    .where(and(eq(schema.skillTeamShares.orgId, orgId), inArray(schema.skillTeamShares.teamId, teamsForActor)));
  const editableOwnerTeamsForActor = database
    .select({ teamId: schema.teamMemberships.teamId })
    .from(schema.teamMemberships)
    .where(
      and(
        eq(schema.teamMemberships.orgId, orgId),
        eq(schema.teamMemberships.userId, actor.id),
        inArray(schema.teamMemberships.teamRole, ["admin", "editor"]),
      ),
    );
  return and(
    eq(schema.skills.orgId, orgId),
    or(
      eq(schema.skills.everyone, true),
      and(isNull(schema.skills.ownerTeamId), eq(schema.skills.ownerId, actor.id)),
      inArray(schema.skills.ownerTeamId, editableOwnerTeamsForActor),
      inArray(schema.skills.id, teamSharedSkillsForActor),
    ),
  );
}

/** The set of skill ids (live + archived) the actor may read — the tenant visibility gate as a Set. */
async function visibleSkillIds(database: Db, actor: ActorContext, orgId: string): Promise<Set<string>> {
  const predicate = await visibleSkillPredicate(database, actor, orgId);
  const rows = await database.select({ id: schema.skills.id }).from(schema.skills).where(predicate);
  // Defensive (mocked DBs in tests may return a non-array for this shape) — see loadDepGraph.
  return new Set((Array.isArray(rows) ? rows : []).map((r) => r.id));
}

function skillHasTeamShare(database: Db, orgId: string) {
  return exists(
    database
      .select({ one: sql`1` })
      .from(schema.skillTeamShares)
      .where(and(eq(schema.skillTeamShares.orgId, orgId), eq(schema.skillTeamShares.skillId, schema.skills.id))),
  );
}

function normalizeTagSet(tags: readonly string[] | undefined): string[] {
  if (!tags?.length) return [];
  return [...new Set(tags.map((tag) => normalizeTag(tag)))].sort((a, b) => a.localeCompare(b));
}

function skillHasAnyTag(database: Db, orgId: string, tags: string[]) {
  return exists(
    database
      .select({ one: sql`1` })
      .from(schema.skillTags)
      .where(
        and(
          eq(schema.skillTags.orgId, orgId),
          eq(schema.skillTags.skillId, schema.skills.id),
          inArray(schema.skillTags.tag, tags),
        ),
      ),
  );
}

/**
 * Turn free-text search input into a prefix `to_tsquery` string ("depl kube" → "depl:* & kube:*").
 * Tokenises to `[a-z0-9]` runs so the query can never carry `to_tsquery` operators (which would
 * raise a syntax error). Returns null when the input has no usable term.
 */
export function toPrefixTsQuery(raw: string): string | null {
  const terms = raw.toLowerCase().match(/[a-z0-9]+/g);
  if (!terms || terms.length === 0) return null;
  return terms.map((t) => `${t}:*`).join(" & ");
}

export async function listSkills(input: {
  actor: ActorContext;
  orgId: string;
  visibility?: VisibilityFilter;
  mine?: boolean;
  /** Return ONLY archived skills (the Archived view). Ignored when `includeArchived` is set. */
  archived?: boolean;
  /** Include both archived and live skills (detail / dependency / download resolution). */
  includeArchived?: boolean;
  /**
   * Free-text query. When set, results are filtered to full-text matches across slug, description,
   * tools, owner name, and the SKILL.md body, and ordered by relevance (`ts_rank`) instead of recency.
   */
  query?: string;
  tags?: string[];
  /** Cap the number of rows (used by the relevance-ranked search path). */
  limit?: number;
  database?: Db;
}): Promise<SkillListRow[]> {
  const database = input.database ?? db;
  const tagFilters = normalizeTagSet(input.tags);
  const baseVisibility = await visibleSkillPredicate(database, input.actor, input.orgId);
  const predicates = [baseVisibility];
  // Archived skills drop out of normal lists; the Archived view shows only them; detail/deps/
  // download resolution includes both so an archived skill stays viewable and downloadable.
  if (!input.includeArchived) {
    predicates.push(input.archived ? not(isNull(schema.skills.archivedAt)) : isNull(schema.skills.archivedAt));
  }
  if (input.visibility === "everyone") predicates.push(eq(schema.skills.everyone, true));
  if (input.visibility === "team") predicates.push(skillHasTeamShare(database, input.orgId));
  if (input.visibility === "private") {
    predicates.push(and(eq(schema.skills.everyone, false), not(skillHasTeamShare(database, input.orgId))));
  }
  if (input.mine) {
    const editableOwnerTeamsForActor = database
      .select({ teamId: schema.teamMemberships.teamId })
      .from(schema.teamMemberships)
      .where(
        and(
          eq(schema.teamMemberships.orgId, input.orgId),
          eq(schema.teamMemberships.userId, input.actor.id),
          inArray(schema.teamMemberships.teamRole, ["admin", "editor"]),
        ),
      );
    predicates.push(
      or(
        and(isNull(schema.skills.ownerTeamId), eq(schema.skills.ownerId, input.actor.id)),
        inArray(schema.skills.ownerTeamId, editableOwnerTeamsForActor),
      ),
    );
  }
  if (tagFilters.length) predicates.push(skillHasAnyTag(database, input.orgId, tagFilters));

  // Relevance-ranked full-text search. Active only when a non-empty query is supplied, so the default
  // list path (and every hand-rolled fakeDb in the tests) is left untouched. Fields are weighted
  // slug (A) > description (B) > tools/owner (C) > SKILL.md body (D) so the strongest signal wins.
  const doSearch = !!input.query && input.query.trim().length > 0;
  const tsQueryStr = doSearch ? toPrefixTsQuery(input.query!) : null;
  // A query with no usable term (e.g. only punctuation) can never match: return nothing rather than all.
  if (doSearch && !tsQueryStr) return [];
  // The body vector is written exactly as the `skill_versions_body_tsv_idx` GIN index expression
  // (`to_tsvector('simple', body)` — body is NOT NULL) so the `@@` filter below can use that index.
  const bodyTsv = sql`to_tsvector('simple', ${schema.skillVersions.body})`;
  // The remaining fields are short, live on the skills/owner rows, and aren't worth their own index.
  const headTsv = sql`(
    setweight(to_tsvector('simple', coalesce(${schema.skills.slug}, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(${schema.skills.description}, '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(${schema.skillVersions.tools}::text, '')), 'C') ||
    setweight(to_tsvector('simple', coalesce(${schema.teams.name}, ${schema.profiles.name}, '')), 'C') ||
    setweight(
      to_tsvector(
        'simple',
        coalesce((
          select string_agg(${schema.skillTags.tag}, ' ')
          from ${schema.skillTags}
          where ${schema.skillTags.orgId} = ${input.orgId}
            and ${schema.skillTags.skillId} = ${schema.skills.id}
        ), '')
      ),
      'C'
    )
  )`;
  const tsQuery = sql`to_tsquery('simple', ${tsQueryStr})`;
  // Rank over the full weighted vector (slug A > description B > tools/owner C > body D).
  const searchRank = doSearch ? sql<number>`ts_rank(${headTsv} || setweight(${bodyTsv}, 'D'), ${tsQuery})` : null;
  // Filter with `@@` (short-circuits, and the body branch is index-eligible) rather than `ts_rank > 0`.
  if (doSearch) predicates.push(sql`(${bodyTsv} @@ ${tsQuery} or ${headTsv} @@ ${tsQuery})`);

  const baseQuery = database
    .select({
      id: schema.skills.id,
      org_id: schema.skills.orgId,
      slug: schema.skills.slug,
      description: schema.skills.description,
      everyone: schema.skills.everyone,
      validation: schema.skills.validation,
      validation_error: schema.skills.validationError,
      owner_kind: sql<"user" | "team">`case when ${schema.skills.ownerTeamId} is null then 'user' else 'team' end`,
      owner_id: sql<string>`coalesce(${schema.skills.ownerTeamId}::text, ${schema.skills.ownerId})`,
      owner_user_id: schema.skills.ownerId,
      owner_team_id: schema.skills.ownerTeamId,
      owner_name: sql<string>`coalesce(${schema.teams.name}, ${schema.profiles.name})`,
      owner_handle: sql<string | null>`case when ${schema.skills.ownerTeamId} is null then ${schema.profiles.handle} else ${schema.teams.slug} end`,
      owner_initials: sql<string>`case when ${schema.skills.ownerTeamId} is null then ${schema.profiles.initials} else upper(left(${schema.teams.name}, 2)) end`,
      current_version: schema.skillVersions.version,
      license: schema.skillVersions.license,
      frontmatter: schema.skillVersions.frontmatter,
      checksum: schema.skillVersions.checksum,
      size_bytes: schema.skillVersions.sizeBytes,
      tools: schema.skillVersions.tools,
      star_count: sql<number>`cast(count(${schema.skillStars.userId}) as int)`,
      starred: exists(
        database
          .select({ one: sql`1` })
          .from(schema.skillStars)
          .where(
            and(
              eq(schema.skillStars.orgId, input.orgId),
              eq(schema.skillStars.skillId, schema.skills.id),
              eq(schema.skillStars.userId, input.actor.id),
            ),
          ),
      ),
      installed: exists(
        database
          .select({ one: sql`1` })
          .from(schema.skillInstalls)
          .where(
            and(
              eq(schema.skillInstalls.orgId, input.orgId),
              eq(schema.skillInstalls.skillId, schema.skills.id),
              eq(schema.skillInstalls.userId, input.actor.id),
            ),
          ),
      ),
      archived_at: schema.skills.archivedAt,
      created_at: schema.skills.createdAt,
      updated_at: schema.skills.updatedAt,
    })
    .from(schema.skills)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.skills.ownerId))
    .leftJoin(schema.teams, and(eq(schema.teams.orgId, input.orgId), eq(schema.teams.id, schema.skills.ownerTeamId)))
    .leftJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skills.currentVersionId))
    .leftJoin(schema.skillStars, eq(schema.skillStars.skillId, schema.skills.id))
    .where(and(...predicates))
    .groupBy(schema.skills.id, schema.profiles.id, schema.teams.id, schema.skillVersions.id);

  // Search path orders by relevance then recency and caps the result count; the default list path keeps
  // its recency-only ordering and never calls `.limit()` (so the fakeDb query mocks stay untouched).
  const rows = await (searchRank
    ? baseQuery.orderBy(desc(searchRank), desc(schema.skills.updatedAt)).limit(input.limit ?? 20)
    : baseQuery.orderBy(desc(schema.skills.updatedAt)));

  const skillIds = rows.map((r) => r.id);
  const sharesBySkill = new Map<string, SkillVisibility["teams"]>();
  const tagsBySkill = new Map<string, string[]>();
  if (skillIds.length) {
    const shareRows = await database
      .select({
        skill_id: schema.skillTeamShares.skillId,
        id: schema.teams.id,
        slug: schema.teams.slug,
        name: schema.teams.name,
        color: schema.teams.color,
        icon: schema.teams.icon,
      })
      .from(schema.skillTeamShares)
      .innerJoin(schema.teams, eq(schema.teams.id, schema.skillTeamShares.teamId))
      .where(and(eq(schema.skillTeamShares.orgId, input.orgId), inArray(schema.skillTeamShares.skillId, skillIds)))
      .orderBy(asc(schema.teams.name));
    for (const row of shareRows) {
      const list = sharesBySkill.get(row.skill_id) ?? [];
      list.push({ id: row.id, slug: row.slug, name: row.name, color: row.color, icon: row.icon });
      sharesBySkill.set(row.skill_id, list);
    }

    const tagRows = await database
      .select({
        skill_id: schema.skillTags.skillId,
        tag: schema.skillTags.tag,
      })
      .from(schema.skillTags)
      .where(and(eq(schema.skillTags.orgId, input.orgId), inArray(schema.skillTags.skillId, skillIds)))
      .orderBy(asc(schema.skillTags.tag));
    for (const row of Array.isArray(tagRows) ? tagRows : []) {
      const list = tagsBySkill.get(row.skill_id) ?? [];
      list.push(row.tag);
      tagsBySkill.set(row.skill_id, list);
    }
  }

  // Dependency counts + warn flag, computed from the org's current-version dependency graph.
  const graph = await loadDepGraph(database, input.orgId);
  // Used-by counts must not leak dependents the actor cannot read — scope to the visibility gate.
  const visibleIds = await visibleSkillIds(database, input.actor, input.orgId);
  // "Referenced by any version" (current or older), matching the archived-download gate; not
  // visibility-scoped, since an install of any referencing version must keep the package fetchable.
  const referencedRows = await database
    .select({ slug: schema.skillVersionDependencies.dependsOnSlug })
    .from(schema.skillVersionDependencies)
    .where(eq(schema.skillVersionDependencies.orgId, input.orgId));
  const referencedSlugs = new Set((Array.isArray(referencedRows) ? referencedRows : []).map((d) => d.slug));

  // The caller's installed version per skill, for status computation. Scoped to the whole org (not
  // just the displayed rows) so dependency-aware roll-up can see installs outside the current filter/
  // view. A separate query (not a join) keeps the grouped main select simple; guarded for mocked DBs.
  const installBySkill = new Map<string, string | null>();
  const installRows = await database
    .select({
      skill_id: schema.skillInstalls.skillId,
      installed_version: schema.skillInstalls.installedVersion,
    })
    .from(schema.skillInstalls)
    .where(
      and(eq(schema.skillInstalls.orgId, input.orgId), eq(schema.skillInstalls.userId, input.actor.id)),
    );
  for (const row of Array.isArray(installRows) ? installRows : []) {
    installBySkill.set(row.skill_id, row.installed_version);
  }

  // Dependency-aware update detection: a skill is "update" if it is behind its own current version,
  // OR any skill in its dependency closure that the caller has installed is behind. Reinstalling the
  // parent re-pulls its dependency set, so a stale dependency means the parent is effectively stale.
  // Current versions come from the org-wide graph so the result is the same in every filtered view.
  const selfBehind = (id: string): boolean => {
    const installedVersion = installBySkill.get(id);
    const current = graph.byId.get(id)?.currentVersion ?? null;
    if (installedVersion == null || current == null) return false;
    return compareSemver(installedVersion, current) < 0;
  };

  return rows.map((r) => {
    const frontmatter = r.frontmatter ?? "";
    const manifest = parseStoredSkillFrontmatter(frontmatter);
    const summary = r.description ?? manifest?.description ?? r.slug ?? "skill";
    const companion = parseStoredCompanionManifest(frontmatter, summary);
    const requires = graph.requiresBySkill.get(r.id) ?? [];
    const usedBy = (graph.dependentsByTarget.get(r.id) ?? []).filter((u) => visibleIds.has(u.dependentId));
    const depWarn = requires.some((edge) => depEdgeStatus(graph, r.id, edge) !== "satisfied");
    return {
      id: r.id,
      org_id: r.org_id,
      slug: r.slug,
      description: summary,
      display: companion.display,
      visibility: { everyone: r.everyone, teams: sharesBySkill.get(r.id) ?? [] },
      validation: r.validation,
      validation_error: r.validation_error,
      owner_kind: r.owner_kind,
      owner_id: r.owner_id,
      owner_user_id: r.owner_user_id,
      owner_team_id: r.owner_team_id,
      owner_name: r.owner_name,
      owner_handle: r.owner_handle,
      owner_initials: r.owner_initials,
      current_version: r.current_version,
      compatibility: manifest?.compatibility ?? null,
      metadata: manifest?.metadata ?? {},
      license: r.license ?? manifest?.license ?? null,
      tools: r.tools?.length ? r.tools : parseAllowedTools(manifest?.["allowed-tools"]),
      tags: tagsBySkill.get(r.id) ?? [],
      requirements: companion.requirements,
      checksum: r.checksum,
      size_bytes: r.size_bytes,
      star_count: r.star_count,
      starred: r.starred,
      installed: Boolean(r.installed),
      installed_version: installBySkill.get(r.id) ?? null,
      install_status: (() => {
        const own = computeSkillInstallStatus(
          Boolean(r.installed),
          installBySkill.get(r.id) ?? null,
          r.current_version,
        );
        // Roll up a stale dependency into an "update" hint on the installed parent.
        if (own === "installed" && depClosureHasUpdate(r.id, graph.requiresBySkill, selfBehind)) {
          return "update";
        }
        return own;
      })(),
      requires_count: requires.length,
      used_by_count: new Set(usedBy.map((u) => u.dependentId)).size,
      dep_warn: depWarn,
      archived: r.archived_at != null,
      referenced: referencedSlugs.has(r.slug),
      created_at: r.created_at.toISOString(),
      updated_at: r.updated_at.toISOString(),
    };
  }) as SkillListRow[];
}

const EMPTY_SKILL_FILTER_PREFERENCES: SkillFilterPreferences = {
  active_filters: [],
  custom_views: [],
};

function normalizePersistedSkillFilter(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const filter = value as Record<string, unknown>;
  if (filter.type !== "scope") return value;
  if (filter.value === "public") return { type: "visibility", value: "everyone" };
  if (filter.value === "team" || filter.value === "private") return { type: "visibility", value: filter.value };
  return value;
}

function normalizePersistedSkillPreferences(input: { activeFilters: unknown[]; customViews: unknown[] }) {
  return {
    active_filters: input.activeFilters.map(normalizePersistedSkillFilter),
    custom_views: input.customViews.map((view) => {
      if (!view || typeof view !== "object" || Array.isArray(view)) return view;
      const record = view as Record<string, unknown>;
      if (!Array.isArray(record.filters)) return view;
      return { ...record, filters: record.filters.map(normalizePersistedSkillFilter) };
    }),
  };
}

export async function getSkillFilterPreferences(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<SkillFilterPreferences> {
  const database = input.database ?? db;
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  const row = await database.query.skillFilterPreferences.findFirst({
    where: and(
      eq(schema.skillFilterPreferences.orgId, input.orgId),
      eq(schema.skillFilterPreferences.userId, input.actor.id),
    ),
  });
  if (!row) return EMPTY_SKILL_FILTER_PREFERENCES;
  return skillFilterPreferencesSchema.parse(normalizePersistedSkillPreferences(row));
}

export async function setSkillFilterPreferences(input: {
  actor: ActorContext;
  orgId: string;
  preferences: SkillFilterPreferences;
  database?: Db;
}): Promise<SkillFilterPreferences> {
  const database = input.database ?? db;
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  const preferences = skillFilterPreferencesSchema.parse(input.preferences);
  await database
    .insert(schema.skillFilterPreferences)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      activeFilters: preferences.active_filters,
      customViews: preferences.custom_views,
    })
    .onConflictDoUpdate({
      target: [schema.skillFilterPreferences.orgId, schema.skillFilterPreferences.userId],
      set: {
        activeFilters: preferences.active_filters,
        customViews: preferences.custom_views,
        updatedAt: new Date(),
      },
    });
  return preferences;
}

export async function getSkillBySlug(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillListRow | null> {
  // Resolve by slug across both live and archived skills — archived ones stay viewable.
  const rows = await listSkills({ ...input, includeArchived: true, database: input.database ?? db });
  return rows.find((r) => r.slug === input.slug) ?? null;
}

export async function setSkillTags(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  tags: string[];
  database?: Db;
}): Promise<{ tags: string[] }> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug({
    actor: input.actor,
    orgId: input.orgId,
    slug: input.slug,
    database,
  });
  if (!skill) throw new Error("skill not found");
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  const canModifyExisting = await canModifySkill({
    database,
    orgId: input.orgId,
    actor: input.actor,
    orgRole,
    ownerUserId: skill.owner_user_id,
    ownerTeamId: skill.owner_team_id,
  });
  if (!canModify({ orgRole }, { isOwner: canModifyExisting })) {
    throw new Error("not allowed to change this skill");
  }

  const tags = normalizeTagSet(setSkillTagsInputSchema.parse({ tags: input.tags }).tags);
  await database.transaction(async (tx) => {
    await tx
      .delete(schema.skillTags)
      .where(and(eq(schema.skillTags.orgId, input.orgId), eq(schema.skillTags.skillId, skill.id)));
    if (tags.length) {
      await tx.insert(schema.skillTags).values(
        tags.map((tag) => ({
          orgId: input.orgId,
          skillId: skill.id,
          tag,
          createdBy: input.actor.id,
        })),
      );
    }
  });

  return { tags };
}

export async function listOrgTags(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<string[]> {
  const database = input.database ?? db;
  const visibility = await visibleSkillPredicate(database, input.actor, input.orgId);
  const frequency = count(schema.skillTags.skillId);
  const rows = await database
    .select({
      tag: schema.skillTags.tag,
      n: frequency,
    })
    .from(schema.skillTags)
    .innerJoin(
      schema.skills,
      and(eq(schema.skills.orgId, schema.skillTags.orgId), eq(schema.skills.id, schema.skillTags.skillId)),
    )
    .where(and(eq(schema.skillTags.orgId, input.orgId), visibility))
    .groupBy(schema.skillTags.tag)
    .orderBy(desc(frequency), asc(schema.skillTags.tag));
  return (Array.isArray(rows) ? rows : []).map((row) => row.tag);
}

function normalizeVisibility(input: SkillVisibilityInput): SkillVisibilityInput {
  return {
    everyone: input.everyone,
    teams: [...new Set(input.teams.map((t) => t.trim()).filter(Boolean))],
  };
}

async function ownerTeamRole(input: {
  database: Db;
  orgId: string;
  actor: ActorContext;
  ownerTeamId: string | null;
}): Promise<TeamRole | null> {
  if (!input.ownerTeamId) return null;
  const row = await input.database.query.teamMemberships.findFirst({
    where: and(
      eq(schema.teamMemberships.orgId, input.orgId),
      eq(schema.teamMemberships.teamId, input.ownerTeamId),
      eq(schema.teamMemberships.userId, input.actor.id),
    ),
  });
  return row?.teamRole ?? null;
}

function canEditOwnerTeam(role: TeamRole | null): boolean {
  return role === "admin" || role === "editor";
}

async function canModifySkill(input: {
  database: Db;
  orgId: string;
  orgRole: OrgRole;
  actor: ActorContext;
  ownerUserId: string;
  ownerTeamId: string | null;
}): Promise<boolean> {
  if (isOrgAdmin(input.orgRole)) return true;
  if (input.ownerTeamId) {
    return canEditOwnerTeam(await ownerTeamRole(input));
  }
  return input.ownerUserId === input.actor.id;
}

async function resolveOwnerTeam(input: {
  actor: ActorContext;
  orgId: string;
  ownerTeam: string | null | undefined;
  orgRole: OrgRole;
  database: Db;
}): Promise<{ id: string; slug: string; name: string } | null> {
  const slug = input.ownerTeam?.trim();
  if (!slug) return null;
  const team = await input.database.query.teams.findFirst({
    where: and(eq(schema.teams.orgId, input.orgId), eq(schema.teams.slug, slug)),
  });
  if (!team) throw new Error("owner team must exist");
  if (canManageOrg(input.orgRole)) return { id: team.id, slug: team.slug, name: team.name };
  const role = await ownerTeamRole({
    database: input.database,
    orgId: input.orgId,
    actor: input.actor,
    ownerTeamId: team.id,
  });
  if (!canEditOwnerTeam(role)) throw new Error("not allowed to create skills for this team");
  return { id: team.id, slug: team.slug, name: team.name };
}

async function resolveVisibilityTeams(input: {
  actor: ActorContext;
  orgId: string;
  visibility: SkillVisibilityInput;
  orgRole: OrgRole;
  database: Db;
}): Promise<{
  visibility: SkillVisibilityInput;
  teams: Array<{ id: string; slug: string; name: string }>;
  memberOfAllTargetTeams: boolean;
}> {
  const database = input.database;
  const visibility = normalizeVisibility(input.visibility);
  if (!visibility.teams.length) return { visibility, teams: [], memberOfAllTargetTeams: true };

  const teams = await database
    .select({ id: schema.teams.id, slug: schema.teams.slug, name: schema.teams.name })
    .from(schema.teams)
    .where(and(eq(schema.teams.orgId, input.orgId), inArray(schema.teams.slug, visibility.teams)));
  if (teams.length !== visibility.teams.length) throw new Error("visibility teams must exist");

  if (canManageOrg(input.orgRole)) return { visibility, teams, memberOfAllTargetTeams: true };

  const memberships = await database
    .select({ teamId: schema.teamMemberships.teamId })
    .from(schema.teamMemberships)
    .where(
      and(
        eq(schema.teamMemberships.orgId, input.orgId),
        eq(schema.teamMemberships.userId, input.actor.id),
        inArray(schema.teamMemberships.teamId, teams.map((t) => t.id)),
      ),
    );
  return { visibility, teams, memberOfAllTargetTeams: memberships.length === teams.length };
}

export async function listSkillVersions(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillVersionRow[]> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const rows = await database
    .select()
    .from(schema.skillVersions)
    .where(and(eq(schema.skillVersions.orgId, input.orgId), eq(schema.skillVersions.skillId, skill.id)))
    .orderBy(desc(schema.skillVersions.createdAt));
  return rows.map((r) => {
    const manifest = parseStoredSkillFrontmatter(r.frontmatter);
    const companion = parseStoredCompanionManifest(r.frontmatter, skill.description);
    return {
      id: r.id,
      skill_id: r.skillId,
      version: r.version,
      note: r.note,
      frontmatter: r.frontmatter,
      tools: r.tools.length ? r.tools : parseAllowedTools(manifest?.["allowed-tools"]),
      license: r.license ?? manifest?.license ?? null,
      compatibility: manifest?.compatibility ?? null,
      metadata: manifest?.metadata ?? {},
      display: companion.display,
      requirements: companion.requirements,
      size_bytes: r.sizeBytes,
      checksum: r.checksum,
      storage_path: r.storagePath,
      validation: r.validation,
      validation_error: r.validationError,
      created_by: r.createdBy,
      created_at: r.createdAt.toISOString(),
    };
  });
}

export async function listSkillComments(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<SkillCommentRow[]> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const rows = await database
    .select({
      id: schema.skillComments.id,
      skill_id: schema.skillComments.skillId,
      author_id: schema.skillComments.authorId,
      body: schema.skillComments.body,
      created_at: schema.skillComments.createdAt,
      author_name: schema.profiles.name,
      author_initials: schema.profiles.initials,
      parent_id: schema.skillComments.parentId,
      version_id: schema.skillComments.versionId,
      version: schema.skillVersions.version,
      deprecated: schema.skillComments.deprecated,
    })
    .from(schema.skillComments)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.skillComments.authorId))
    .leftJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skillComments.versionId))
    .where(and(eq(schema.skillComments.orgId, input.orgId), eq(schema.skillComments.skillId, skill.id)))
    .orderBy(asc(schema.skillComments.createdAt));
  return rows.map((r) => ({
    ...r,
    created_at: r.created_at.toISOString(),
    // A null version_id is always global; otherwise the leftJoin label (null if the version is gone).
    version: r.version_id ? r.version : null,
  }));
}

export async function toggleStar(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<boolean> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const existing = await database.query.skillStars.findFirst({
    where: and(
      eq(schema.skillStars.orgId, input.orgId),
      eq(schema.skillStars.skillId, skill.id),
      eq(schema.skillStars.userId, input.actor.id),
    ),
  });
  if (existing) {
    await database
      .delete(schema.skillStars)
      .where(
        and(
          eq(schema.skillStars.orgId, input.orgId),
          eq(schema.skillStars.skillId, skill.id),
          eq(schema.skillStars.userId, input.actor.id),
        ),
      );
    return false;
  }
  await database.insert(schema.skillStars).values({ orgId: input.orgId, skillId: skill.id, userId: input.actor.id });
  return true;
}

export async function addComment(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  body: string;
  parentId?: string | null;
  versionId?: string | null;
  database?: Db;
}): Promise<SkillCommentRow> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");

  // A reply inherits its thread context, so any caller-supplied versionId is ignored for replies.
  let versionId = input.parentId ? null : input.versionId ?? null;
  let versionLabel: string | null = null;

  // Cross-skill / cross-tenant integrity is not FK-enforceable — validate it here.
  if (versionId) {
    const version = await database.query.skillVersions.findFirst({
      where: and(
        eq(schema.skillVersions.id, versionId),
        eq(schema.skillVersions.orgId, input.orgId),
        eq(schema.skillVersions.skillId, skill.id),
      ),
    });
    if (!version) throw new Error("version does not belong to this skill");
    versionLabel = version.version;
  }

  if (input.parentId) {
    const parent = await database.query.skillComments.findFirst({
      where: and(
        eq(schema.skillComments.id, input.parentId),
        eq(schema.skillComments.orgId, input.orgId),
        eq(schema.skillComments.skillId, skill.id),
      ),
    });
    // Single-level nesting only: a reply must target an existing same-skill root thread.
    if (!parent || parent.parentId !== null) throw new Error("invalid parent comment");
  }

  const [row] = await database
    .insert(schema.skillComments)
    .values({
      orgId: input.orgId,
      skillId: skill.id,
      authorId: input.actor.id,
      body: input.body,
      parentId: input.parentId ?? null,
      versionId,
    })
    .returning();
  if (!row) throw new Error("could not add comment");
  return {
    id: row.id,
    skill_id: row.skillId,
    author_id: row.authorId,
    body: row.body,
    created_at: row.createdAt.toISOString(),
    parent_id: row.parentId,
    version_id: row.versionId,
    version: versionLabel,
    deprecated: row.deprecated,
  };
}

/**
 * Deprecate (or restore) a comment thread. Threads are never deleted — a deprecated thread is
 * greyed/struck-through. Allowed iff the actor authored the comment, is an org admin, or owns the
 * skill. Returns the updated extended row (author display fields + version label re-joined).
 */
export async function setCommentDeprecated(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  commentId: string;
  deprecated: boolean;
  database?: Db;
}): Promise<SkillCommentRow> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");

  const comment = await database.query.skillComments.findFirst({
    where: and(
      eq(schema.skillComments.id, input.commentId),
      eq(schema.skillComments.orgId, input.orgId),
      eq(schema.skillComments.skillId, skill.id),
    ),
  });
  if (!comment) throw new Error("comment not found");

  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  const canModifyExisting = await canModifySkill({
    database,
    orgId: input.orgId,
    orgRole,
    actor: input.actor,
    ownerUserId: skill.owner_user_id,
    ownerTeamId: skill.owner_team_id,
  });
  const allowed =
    comment.authorId === input.actor.id ||
    canModify({ orgRole }, { isOwner: canModifyExisting });
  if (!allowed) throw new Error("not allowed to change this comment");

  const [updated] = await database
    .update(schema.skillComments)
    .set({ deprecated: input.deprecated })
    .where(and(eq(schema.skillComments.id, comment.id), eq(schema.skillComments.orgId, input.orgId)))
    .returning();
  if (!updated) throw new Error("could not update comment");

  const author = await database.query.profiles.findFirst({
    where: eq(schema.profiles.id, updated.authorId),
  });
  let versionLabel: string | null = null;
  if (updated.versionId) {
    const version = await database.query.skillVersions.findFirst({
      where: eq(schema.skillVersions.id, updated.versionId),
    });
    versionLabel = version?.version ?? null;
  }
  return {
    id: updated.id,
    skill_id: updated.skillId,
    author_id: updated.authorId,
    body: updated.body,
    created_at: updated.createdAt.toISOString(),
    author_name: author?.name ?? null,
    author_initials: author?.initials ?? null,
    parent_id: updated.parentId,
    version_id: updated.versionId,
    version: versionLabel,
    deprecated: updated.deprecated,
  };
}

export async function setSkillVisibility(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  visibility: SkillVisibilityInput;
  /**
   * When the new visibility would leave a dependency less visible than the skill, also raise that
   * dependency (transitively) to cover the new audience instead of rejecting. All raised skills are
   * authorized individually; if the actor cannot modify one, the whole change is rejected.
   */
  cascade?: boolean;
  database?: Db;
}): Promise<{ cascaded: string[] }> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  const resolved = await resolveVisibilityTeams({
    actor: input.actor,
    orgId: input.orgId,
    visibility: input.visibility,
    orgRole,
    database,
  });
  const canModifyExisting = await canModifySkill({
    database,
    orgId: input.orgId,
    actor: input.actor,
    orgRole,
    ownerUserId: skill.owner_user_id,
    ownerTeamId: skill.owner_team_id,
  });
  if (
    !canModify({ orgRole }, { isOwner: canModifyExisting }) ||
    !canActAtVisibility(
      { orgRole },
      {
        everyone: resolved.visibility.everyone,
        teamCount: resolved.teams.length,
        memberOfAllTargetTeams: resolved.memberOfAllTargetTeams,
      },
    )
  ) {
    throw new Error("not allowed to change this skill");
  }

  // Changing visibility must not break the dependency visibility-cover invariant: a skill cannot
  // become more visible than the dependencies its current version pulls in (e.g. team → Everyone
  // while it requires a team-only skill). Re-check the current version's edges against the new audience.
  const graph = await loadDepGraph(database, input.orgId);
  const self = graph.bySlug.get(skill.slug);
  const currentEdges = self ? (graph.requiresBySkill.get(self.id) ?? []) : [];
  const dependents = self ? (graph.dependentsByTarget.get(self.id) ?? []) : [];
  const newAudienceTeamIds = new Set(resolved.teams.map((t) => t.id));
  if (skill.owner_team_id) newAudienceTeamIds.add(skill.owner_team_id);
  const newAudience = { everyone: resolved.visibility.everyone, teams: [...newAudienceTeamIds] };

  // The new audience the skill itself will have, as plain team ids (owner team is always included).
  type Change = { id: string; slug: string; everyone: boolean; teamIds: string[] };

  // Outgoing (broadening): dependencies (transitively) the new audience would NOT cover must be
  // raised. Each gets the new audience unioned onto its own — adding the same audience everywhere
  // preserves cover on every edge between dependencies (orig v ⊇ orig u ⇒ v∪P ⊇ u∪P).
  const raises: Change[] = [];
  if (self && currentEdges.length) {
    for (const dep of collectReachableDependencies(graph, self.id)) {
      const depAudience = { everyone: dep.everyone, teams: [...dep.audienceTeams] };
      if (visibilityCovers(newAudience, depAudience)) continue; // already visible enough
      if (!input.cascade) {
        throw new Error(
          `cannot broaden visibility: dependency ${dep.slug} would be less visible than this skill`,
        );
      }
      // Team shares exclude the dep's own owner team (that audience comes from the
      // skills.owner_team_id column, not a share row).
      const raisedTeamIds = new Set<string>([...dep.audienceTeams, ...newAudienceTeamIds]);
      if (dep.ownerTeamId) raisedTeamIds.delete(dep.ownerTeamId);
      raises.push({ id: dep.id, slug: dep.slug, everyone: dep.everyone || newAudience.everyone, teamIds: [...raisedTeamIds] });
    }
  }

  // Incoming (narrowing): dependents (transitively) that the new audience would NOT cover would lose
  // access. Without cascade this is a hard block; with cascade we restrict each to the intersection
  // with the new audience (the mirror of the raise — restricting everywhere preserves every edge).
  const restricts: Change[] = [];
  if (self && dependents.length) {
    for (const dep of collectReachableDependents(graph, self.id)) {
      const depAudience = { everyone: dep.everyone, teams: [...dep.audienceTeams] };
      // A dependent always stays visible to its own owner (a user or a team), so that owner must be
      // able to see the narrowed target too. visibilityCovers() alone treats a private dependent as
      // covered — true only when the same owner manages both — so the owner is part of "still covered":
      // a cross-owned private dependent must NOT be skipped.
      const ownerCovered =
        newAudience.everyone ||
        (dep.ownerTeamId
          ? newAudienceTeamIds.has(dep.ownerTeamId)
          : dep.ownerId === skill.owner_user_id ||
            (await userInAnyTeam(database, input.orgId, dep.ownerId, [...newAudienceTeamIds])));
      if (visibilityCovers(depAudience, newAudience) && ownerCovered) continue; // genuinely still covered
      if (!input.cascade) {
        throw new Error(
          `cannot narrow visibility: ${dep.slug} depends on this skill and would lose access`,
        );
      }
      // Reducing team shares can't drop the dependent's own owner, so if that owner is outside the new
      // audience the dependent can never be covered — narrowing is impossible.
      if (!ownerCovered) {
        throw new Error(
          `cannot narrow visibility: ${dep.slug} would stay visible to an owner outside the new audience`,
        );
      }
      const restricted = restrictAudience(depAudience, newAudience);
      const restrictedTeamIds = new Set(restricted.teams);
      if (dep.ownerTeamId) restrictedTeamIds.delete(dep.ownerTeamId);
      restricts.push({ id: dep.id, slug: dep.slug, everyone: restricted.everyone, teamIds: [...restrictedTeamIds] });
    }
  }

  // Every cascaded skill (raised or restricted) must pass BOTH authorization gates the primary skill
  // does: the capability gate (can the actor modify it?) and the visibility gate (may the actor target
  // the audience it gains?). The visibility gate is checked against the teams a change *adds* — those
  // are always a subset of the new audience the actor already proved they can target, so legitimate
  // cascades pass while any future widening beyond that audience is rejected.
  const changes = [...raises, ...restricts];
  const forbidden: string[] = [];
  for (const change of changes) {
    const dep = graph.byId.get(change.id)!;
    const canModifyDep = await canModifySkill({
      database,
      orgId: input.orgId,
      actor: input.actor,
      orgRole,
      ownerUserId: dep.ownerId,
      ownerTeamId: dep.ownerTeamId,
    });
    const originalShares = new Set([...dep.audienceTeams].filter((t) => t !== dep.ownerTeamId));
    const addedTeams = change.teamIds.filter((t) => !originalShares.has(t));
    const canTargetAudience = canActAtVisibility(
      { orgRole },
      {
        everyone: change.everyone && !dep.everyone,
        teamCount: addedTeams.length,
        memberOfAllTargetTeams: resolved.memberOfAllTargetTeams,
      },
    );
    if (!canModifyDep || !canTargetAudience) forbidden.push(dep.slug);
  }
  if (forbidden.length) {
    throw new Error(
      `cannot update sub-skill${forbidden.length > 1 ? "s" : ""} ${forbidden.join(", ")}: you do not have permission to change ${forbidden.length > 1 ? "their" : "its"} visibility`,
    );
  }

  await database.transaction(async (tx) => {
    const writeVisibility = async (skillId: string, everyone: boolean, teamIds: string[]) => {
      await tx
        .update(schema.skills)
        .set({ everyone, updatedAt: new Date() })
        .where(eq(schema.skills.id, skillId));
      await tx
        .delete(schema.skillTeamShares)
        .where(and(eq(schema.skillTeamShares.orgId, input.orgId), eq(schema.skillTeamShares.skillId, skillId)));
      if (teamIds.length) {
        await tx.insert(schema.skillTeamShares).values(
          teamIds.map((teamId) => ({ orgId: input.orgId, skillId, teamId })),
        );
      }
    };
    await writeVisibility(skill.id, resolved.visibility.everyone, resolved.teams.map((t) => t.id));
    for (const change of changes) await writeVisibility(change.id, change.everyone, change.teamIds);
  });

  return { cascaded: changes.map((c) => c.slug).sort() };
}

/** Skills reachable from `fromId` over current-version dependency edges (resolved by slug, cycle-safe). */
function collectReachableDependencies(graph: DepGraph, fromId: string): DepGraphSkill[] {
  const out: DepGraphSkill[] = [];
  const seen = new Set<string>([fromId]);
  const stack = [fromId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const edge of graph.requiresBySkill.get(id) ?? []) {
      const target = graph.bySlug.get(edge.dependsOnSlug);
      if (!target || seen.has(target.id)) continue;
      seen.add(target.id);
      out.push(target);
      stack.push(target.id);
    }
  }
  return out;
}

/** Whether `userId` belongs to any of `teamIds` in the org (used to check owner coverage on narrow). */
async function userInAnyTeam(database: Db, orgId: string, userId: string, teamIds: string[]): Promise<boolean> {
  if (!teamIds.length) return false;
  const row = await database.query.teamMemberships.findFirst({
    where: and(
      eq(schema.teamMemberships.orgId, orgId),
      eq(schema.teamMemberships.userId, userId),
      inArray(schema.teamMemberships.teamId, teamIds),
    ),
  });
  return !!row;
}

/** Skills that transitively depend on `fromId` over current-version edges (the reverse graph). */
function collectReachableDependents(graph: DepGraph, fromId: string): DepGraphSkill[] {
  const out: DepGraphSkill[] = [];
  const seen = new Set<string>([fromId]);
  const stack = [fromId];
  while (stack.length) {
    const id = stack.pop()!;
    for (const ref of graph.dependentsByTarget.get(id) ?? []) {
      const dependent = graph.byId.get(ref.dependentId);
      if (!dependent || seen.has(dependent.id)) continue;
      seen.add(dependent.id);
      out.push(dependent);
      stack.push(dependent.id);
    }
  }
  return out;
}

/**
 * Reduce `dependent`'s audience to the most it can keep while staying covered by `target` (used when
 * narrowing a skill cascades to its dependents). Mirror of the union used when broadening.
 */
function restrictAudience(
  dependent: { everyone: boolean; teams: string[] },
  target: { everyone: boolean; teams: string[] },
): { everyone: boolean; teams: string[] } {
  if (target.everyone) return { everyone: dependent.everyone, teams: [...dependent.teams] };
  const allowed = new Set(target.teams);
  const teams = dependent.everyone ? [...target.teams] : dependent.teams.filter((t) => allowed.has(t));
  return { everyone: false, teams };
}

export async function publishSkillVersion(input: {
  actor: ActorContext;
  orgId: string;
  payload: PublishSkillInput;
  archiveKey: string;
  database?: Db;
}): Promise<{ id: string; slug: string; version: string }> {
  const database = input.database ?? db;
  const payload = publishSkillInputSchema.parse({ ...input.payload, storage_path: input.archiveKey });
  const ownerTeam = await assertCanPublishSkillVersion({ actor: input.actor, orgId: input.orgId, payload, database });
  // Required dependencies must resolve (no missing/cycle/visibility) before we write anything.
  await assertDependenciesResolvable({
    actor: input.actor,
    orgId: input.orgId,
    slug: payload.slug,
    dependencies: payload.dependencies,
    visibility: payload.visibility,
    ownerTeamSlug: ownerTeam?.slug ?? null,
    database,
  });
  // Re-publishing can change this skill's visibility — narrowing it must not strand skills that
  // already depend on it (the incoming-edge mirror of the dependency cover check).
  await assertDependentsRemainCovered({
    orgId: input.orgId,
    slug: payload.slug,
    visibility: payload.visibility,
    ownerTeamSlug: ownerTeam?.slug ?? null,
    database,
  });

  return database.transaction(async (tx) => {
    const publishPayload = publishSkillInputSchema.parse({ ...payload, storage_path: input.archiveKey });
    return writeSkillVersion({
      actor: input.actor,
      orgId: input.orgId,
      payload: publishPayload,
      archiveKey: input.archiveKey,
      ownerTeam,
      database: tx as unknown as Db,
    });
  });
}

export async function assertCanPublishSkillVersion(input: {
  actor: ActorContext;
  orgId: string;
  payload: PublishSkillInput;
  database?: Db;
}): Promise<{ id: string; slug: string; name: string } | null> {
  const database = input.database ?? db;
  const payload = publishSkillInputSchema.parse(input.payload);
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  const resolved = await resolveVisibilityTeams({
    actor: input.actor,
    orgId: input.orgId,
    visibility: payload.visibility,
    orgRole,
    database,
  });
  const ownerTeam = await resolveOwnerTeam({
    actor: input.actor,
    orgId: input.orgId,
    ownerTeam: payload.owner_team,
    orgRole,
    database,
  });

  const existing = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, payload.slug)),
  });
  if (existing) {
    const existingSkill = await getSkillBySlug({
      actor: input.actor,
      orgId: input.orgId,
      slug: payload.slug,
      database,
    });
    if (!existingSkill) throw new Error("not allowed to publish this skill");
    if (payload.owner_team !== undefined) {
      const requestedOwnerTeamId = ownerTeam?.id ?? null;
      if (requestedOwnerTeamId !== existing.ownerTeamId) throw new Error("skill owner cannot be changed by publish");
    }
    const canModifyExisting = await canModifySkill({
      database,
      orgId: input.orgId,
      actor: input.actor,
      orgRole,
      ownerUserId: existing.ownerId,
      ownerTeamId: existing.ownerTeamId,
    });
    if (!canModify({ orgRole }, { isOwner: canModifyExisting })) {
      throw new Error("not allowed to publish this skill");
    }
    if (payload.skill_id && payload.skill_id !== existing.id) {
      throw new Error("skill_id does not match existing skill");
    }
    if (
      !canActAtVisibility(
        { orgRole },
        {
          everyone: resolved.visibility.everyone,
          teamCount: resolved.teams.length,
          memberOfAllTargetTeams: resolved.memberOfAllTargetTeams,
        },
      )
    ) {
      throw new Error("not allowed to publish at this visibility");
    }
    const versions = await database
      .select({ version: schema.skillVersions.version })
      .from(schema.skillVersions)
      .where(and(eq(schema.skillVersions.orgId, input.orgId), eq(schema.skillVersions.skillId, existing.id)));
    if (versions.some((v) => v.version === payload.version)) throw new Error("version already exists");
    const latest = versions.map((v) => v.version).sort((a, b) => compareSemver(b, a))[0];
    if (latest && compareSemver(payload.version, latest) <= 0) throw new Error("version must increase monotonically");
    return null;
  }

  if (
    !canActAtVisibility(
      { orgRole },
      {
        everyone: resolved.visibility.everyone,
        teamCount: resolved.teams.length,
        memberOfAllTargetTeams: resolved.memberOfAllTargetTeams,
      },
    )
  ) {
    throw new Error("not allowed to publish at this visibility");
  }
  return ownerTeam;
}

async function writeSkillVersion(input: {
  actor: ActorContext;
  orgId: string;
  payload: PublishSkillInput;
  archiveKey: string;
  ownerTeam: { id: string; slug: string; name: string } | null;
  database: Db;
}): Promise<{ id: string; slug: string; version: string }> {
  const database = input.database;
  const payload = input.payload;
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  const resolved = await resolveVisibilityTeams({
    actor: input.actor,
    orgId: input.orgId,
    visibility: payload.visibility,
    orgRole,
    database,
  });
  const existing = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, payload.slug)),
  });
  if (existing && payload.skill_id && payload.skill_id !== existing.id) {
    throw new Error("skill_id does not match existing skill");
  }

  const [skill] = existing
    ? await database
        .update(schema.skills)
        .set({
          description: payload.description,
          everyone: resolved.visibility.everyone,
          validation: "valid",
          validationError: null,
          updatedAt: new Date(),
        })
        .where(eq(schema.skills.id, existing.id))
        .returning()
    : await database
        .insert(schema.skills)
        .values({
          ...(payload.skill_id ? { id: payload.skill_id } : {}),
          orgId: input.orgId,
          slug: payload.slug,
          description: payload.description,
          ownerId: input.actor.id,
          ownerTeamId: input.ownerTeam?.id ?? null,
          creatorId: input.actor.id,
          everyone: resolved.visibility.everyone,
          validation: "valid",
        })
        .returning();
  if (!skill) throw new Error("could not write skill");

  await database
    .delete(schema.skillTeamShares)
    .where(and(eq(schema.skillTeamShares.orgId, input.orgId), eq(schema.skillTeamShares.skillId, skill.id)));
  if (resolved.teams.length) {
    await database.insert(schema.skillTeamShares).values(
      resolved.teams.map((team) => ({
        orgId: input.orgId,
        skillId: skill.id,
        teamId: team.id,
      })),
    );
  }

  const [version] = await database
    .insert(schema.skillVersions)
    .values({
      orgId: input.orgId,
      skillId: skill.id,
      version: payload.version,
      note: payload.note,
      frontmatter: payload.frontmatter,
      body: payload.body,
      tools: payload.tools,
      license: payload.license ?? null,
      sizeBytes: payload.size_bytes,
      checksum: payload.checksum,
      storagePath: input.archiveKey,
      validation: "valid",
      createdBy: input.actor.id,
    })
    .returning();
  if (!version) throw new Error("could not write skill version");

  await database
    .update(schema.skills)
    .set({ currentVersionId: version.id, updatedAt: new Date() })
    .where(eq(schema.skills.id, skill.id));

  // Persist this version's dependency edges (un-versioned skill→skill links). Resolve each declared
  // slug to a current skill id, scoped to skills the actor can read so an edge can never bind to a
  // hidden skill; an unresolved slug is stored with a null target (a "missing" dep). Gate on the
  // self-filtered set so a self-only declaration never asks Drizzle to insert an empty values array.
  const declaredDeps = [...new Set(payload.dependencies)].filter((slug) => slug !== payload.slug);
  if (declaredDeps.length) {
    const declared = declaredDeps;
    const visiblePredicate = await visibleSkillPredicate(database, input.actor, input.orgId);
    const targets = await database
      .select({ id: schema.skills.id, slug: schema.skills.slug })
      .from(schema.skills)
      .where(and(visiblePredicate, inArray(schema.skills.slug, declared)));
    const idBySlug = new Map(targets.map((t) => [t.slug, t.id] as const));
    await database.insert(schema.skillVersionDependencies).values(
      declared.map((slug) => ({
        orgId: input.orgId,
        skillVersionId: version.id,
        skillId: skill.id,
        dependsOnSlug: slug,
        dependsOnSkillId: idBySlug.get(slug) ?? null,
      })),
    );
  }

  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.publish",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: payload.slug, version: payload.version, visibility: resolved.visibility, dependencies: payload.dependencies },
  });
  return { id: skill.id, slug: payload.slug, version: version.version };
}

export async function createInvitation(input: {
  actor: ActorContext;
  orgId: string;
  email: string;
  role: Exclude<OrgRole, "owner">;
  database?: Db;
}): Promise<{ id: string; token: string }> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role || !canManageOrg(role)) throw new Error("not allowed to invite members");
  const token = crypto.randomUUID().replaceAll("-", "");
  const [invite] = await database.insert(schema.invitations).values({
    orgId: input.orgId,
    email: input.email.toLowerCase(),
    orgRole: input.role,
    token,
    createdBy: input.actor.id,
    expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 14),
  }).returning({ id: schema.invitations.id });
  if (!invite) throw new Error("could not create invitation");
  return { id: invite.id, token };
}

export async function acceptInvitation(input: {
  actor: ActorContext;
  token: string;
  database?: Db;
}): Promise<{ orgId: string }> {
  const database = input.database ?? db;
  const invite = await database.query.invitations.findFirst({
    where: and(
      eq(schema.invitations.token, input.token),
      eq(schema.invitations.status, "pending"),
      gt(schema.invitations.expiresAt, new Date()),
    ),
  });
  if (!invite) throw new Error("invite not found or expired");
  if (invite.email.toLowerCase() !== input.actor.email.toLowerCase()) {
    throw new Error("invite email does not match current user");
  }
  await database.transaction(async (tx) => {
    await tx
      .insert(schema.memberships)
      .values({ orgId: invite.orgId, userId: input.actor.id, orgRole: invite.orgRole })
      .onConflictDoNothing();
    await tx.update(schema.invitations).set({ status: "accepted" }).where(eq(schema.invitations.id, invite.id));
    // Accepting an invite means the user has joined an org — they skip the onboarding flow.
    await tx
      .update(schema.profiles)
      .set({ onboardedAt: new Date() })
      .where(and(eq(schema.profiles.id, input.actor.id), isNull(schema.profiles.onboardedAt)));
  });
  return { orgId: invite.orgId };
}

export async function getDownloadVersion(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version?: string | null;
  database?: Db;
}): Promise<{
  storagePath: string;
  version: string;
  checksum: string;
  sizeBytes: number;
  visibility: SkillVisibility;
  dependencies: string[];
}> {
  const database = input.database ?? db;
  // Archived skills stay downloadable ONLY while a published version still references them — across
  // ALL versions (an old published version may still declare a dependency the current one dropped),
  // so existing installs of that version never break. An unreferenced archived skill is not found.
  const visible = (await listSkills({ actor: input.actor, orgId: input.orgId, includeArchived: true, database })).find(
    (s) => s.slug === input.slug,
  );
  if (!visible) throw new Error("skill not found");
  if (visible.archived) {
    const referenced = await database
      .select({ one: sql<number>`1` })
      .from(schema.skillVersionDependencies)
      .where(
        and(
          eq(schema.skillVersionDependencies.orgId, input.orgId),
          eq(schema.skillVersionDependencies.dependsOnSlug, input.slug),
        ),
      )
      .limit(1);
    if (referenced.length === 0) throw new Error("skill not found");
  }
  const versions = await listSkillVersions({ ...input, database });
  const row = input.version ? versions.find((v) => v.version === input.version) : versions[0];
  if (!row) throw new Error("version not found");
  const depRows = await database
    .select({ slug: schema.skillVersionDependencies.dependsOnSlug })
    .from(schema.skillVersionDependencies)
    .where(
      and(
        eq(schema.skillVersionDependencies.orgId, input.orgId),
        eq(schema.skillVersionDependencies.skillVersionId, row.id),
      ),
    )
    .orderBy(asc(schema.skillVersionDependencies.dependsOnSlug));
  return {
    storagePath: row.storage_path,
    version: row.version,
    checksum: row.checksum,
    sizeBytes: row.size_bytes,
    visibility: visible.visibility,
    dependencies: depRows.map((d) => d.slug),
  };
}

/* ---- Skill dependencies (un-versioned skill→skill links) + archive --------- */

interface DepGraphSkill {
  id: string;
  slug: string;
  everyone: boolean;
  archivedAt: Date | null;
  currentVersionId: string | null;
  /** Current published version string (null when no version), for org-wide update comparisons. */
  currentVersion: string | null;
  ownerId: string;
  ownerTeamId: string | null;
  /** Teams that can see this skill = its team shares plus its owning team. */
  audienceTeams: Set<string>;
}

interface DepEdge {
  skillId: string;
  dependsOnSlug: string;
  dependsOnSkillId: string | null;
}

interface DepGraph {
  byId: Map<string, DepGraphSkill>;
  bySlug: Map<string, DepGraphSkill>;
  /** Current-version outgoing edges per dependent skill id. */
  requiresBySkill: Map<string, DepEdge[]>;
  /** Current-version incoming edges per target skill id. */
  dependentsByTarget: Map<string, { dependentId: string; edge: DepEdge }[]>;
}

/**
 * Load the org's *current-version* dependency graph once: every skill (live + archived), its
 * audience teams, and the dependency edges declared by each skill's current version. Used to
 * derive live statuses (satisfied / missing / archived / visibility / cycle) and counts.
 */
async function loadDepGraph(database: Db, orgId: string): Promise<DepGraph> {
  const skillRowsRaw = await database
    .select({
      id: schema.skills.id,
      slug: schema.skills.slug,
      everyone: schema.skills.everyone,
      archivedAt: schema.skills.archivedAt,
      currentVersionId: schema.skills.currentVersionId,
      currentVersion: schema.skillVersions.version,
      ownerId: schema.skills.ownerId,
      ownerTeamId: schema.skills.ownerTeamId,
    })
    .from(schema.skills)
    .leftJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skills.currentVersionId))
    .where(eq(schema.skills.orgId, orgId));
  // Defensive: enrichment-only loader — never let a malformed result break list/detail reads.
  const skillRows = Array.isArray(skillRowsRaw) ? skillRowsRaw : [];

  const byId = new Map<string, DepGraphSkill>();
  const bySlug = new Map<string, DepGraphSkill>();
  for (const s of skillRows) {
    const entry: DepGraphSkill = {
      id: s.id,
      slug: s.slug,
      everyone: s.everyone,
      archivedAt: s.archivedAt,
      currentVersionId: s.currentVersionId,
      currentVersion: s.currentVersion ?? null,
      ownerId: s.ownerId,
      ownerTeamId: s.ownerTeamId,
      audienceTeams: new Set(s.ownerTeamId ? [s.ownerTeamId] : []),
    };
    byId.set(s.id, entry);
    bySlug.set(s.slug, entry);
  }

  const shareRowsRaw = await database
    .select({ skillId: schema.skillTeamShares.skillId, teamId: schema.skillTeamShares.teamId })
    .from(schema.skillTeamShares)
    .where(eq(schema.skillTeamShares.orgId, orgId));
  const shareRows = Array.isArray(shareRowsRaw) ? shareRowsRaw : [];
  for (const share of shareRows) byId.get(share.skillId)?.audienceTeams.add(share.teamId);

  const edgeRowsRaw = await database
    .select({
      skillId: schema.skillVersionDependencies.skillId,
      skillVersionId: schema.skillVersionDependencies.skillVersionId,
      dependsOnSlug: schema.skillVersionDependencies.dependsOnSlug,
      dependsOnSkillId: schema.skillVersionDependencies.dependsOnSkillId,
    })
    .from(schema.skillVersionDependencies)
    .where(eq(schema.skillVersionDependencies.orgId, orgId));
  const edgeRows = Array.isArray(edgeRowsRaw) ? edgeRowsRaw : [];

  const requiresBySkill = new Map<string, DepEdge[]>();
  const dependentsByTarget = new Map<string, { dependentId: string; edge: DepEdge }[]>();
  for (const row of edgeRows) {
    // Only the dependent skill's CURRENT version contributes to the live graph.
    const dependent = byId.get(row.skillId);
    if (!dependent || dependent.currentVersionId !== row.skillVersionId) continue;
    // Resolve the target LIVE by its declared slug, not the stored id snapshot — so a dependency
    // recorded as missing (null id) re-satisfies once a skill with that slug is published.
    const resolved = bySlug.get(row.dependsOnSlug);
    const edge: DepEdge = {
      skillId: row.skillId,
      dependsOnSlug: row.dependsOnSlug,
      dependsOnSkillId: resolved ? resolved.id : null,
    };
    const requires = requiresBySkill.get(row.skillId) ?? [];
    requires.push(edge);
    requiresBySkill.set(row.skillId, requires);
    if (resolved) {
      const list = dependentsByTarget.get(resolved.id) ?? [];
      list.push({ dependentId: row.skillId, edge });
      dependentsByTarget.set(resolved.id, list);
    }
  }

  return { byId, bySlug, requiresBySkill, dependentsByTarget };
}


/** Precedence for an edge's status given its computed flags (missing → cycle → archived → visibility). */
export function dependencyStatusFromFlags(flags: {
  resolved: boolean;
  cycle: boolean;
  archived: boolean;
  covered: boolean;
}): SkillDependencyStatus {
  if (!flags.resolved) return "missing";
  if (flags.cycle) return "cycle";
  if (flags.archived) return "archived";
  if (!flags.covered) return "visibility";
  return "satisfied";
}

function audienceCovers(dependent: DepGraphSkill, target: DepGraphSkill): boolean {
  return visibilityCovers(
    { everyone: dependent.everyone, teams: [...dependent.audienceTeams] },
    { everyone: target.everyone, teams: [...target.audienceTeams] },
  );
}

/** Does `fromId` transitively depend on `targetId` over current-version edges? (cycle probe) */
function depReaches(graph: DepGraph, fromId: string, targetId: string, seen: Set<string>): boolean {
  if (fromId === targetId) return true;
  if (seen.has(fromId)) return false;
  seen.add(fromId);
  for (const edge of graph.requiresBySkill.get(fromId) ?? []) {
    // Resolve by slug so an edge declaring a slug that only resolves once a prospective skill is
    // registered (publish-time probe) still participates in cycle detection.
    const next = graph.bySlug.get(edge.dependsOnSlug);
    if (next && depReaches(graph, next.id, targetId, seen)) return true;
  }
  return false;
}

/** Compute the live status of one dependency edge declared by `dependentId`. */
function depEdgeStatus(graph: DepGraph, dependentId: string, edge: DepEdge): SkillDependencyStatus {
  // Resolve by the stable declared slug so a once-missing edge re-satisfies when the target is published.
  const target = graph.bySlug.get(edge.dependsOnSlug);
  const dependent = graph.byId.get(dependentId);
  return dependencyStatusFromFlags({
    resolved: !!target,
    cycle: !!target && !!dependent && depReaches(graph, target.id, dependentId, new Set()),
    archived: !!target?.archivedAt,
    covered: !target || !dependent || audienceCovers(dependent, target),
  });
}

function depNote(status: SkillDependencyStatus, targetSlug: string, dependentSlug: string): string | null {
  switch (status) {
    case "missing":
      return "not published to this workspace";
    case "archived":
      return "publisher archived this skill";
    case "visibility":
      return `not visible to everyone who can install ${dependentSlug}`;
    case "cycle":
      return `${targetSlug} already requires ${dependentSlug}`;
    default:
      return null;
  }
}

/**
 * Resolve the Requires + Used by graph for one skill (optionally a specific version), with each
 * edge's live status. Tenant + visibility scoped: only actor-visible targets/dependents are linkable.
 */
export async function getSkillDependencies(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version?: string | null;
  database?: Db;
}): Promise<SkillDependenciesResponse> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");

  const graph = await loadDepGraph(database, input.orgId);
  const visibleBySlug = new Map(
    (await listSkills({ actor: input.actor, orgId: input.orgId, includeArchived: true, database })).map((s) => [s.slug, s] as const),
  );

  // Requires: edges declared by the selected (or current) version.
  const versions = await listSkillVersions({ actor: input.actor, orgId: input.orgId, slug: input.slug, database });
  const versionRow = input.version
    ? versions.find((v) => v.version === input.version)
    : versions.find((v) => v.version === skill.current_version) ?? versions[0];
  // A typo'd / stale version is an error, mirroring the download + files endpoints.
  if (input.version && !versionRow) throw new Error("version not found");
  const requiresEdgeRows = versionRow
    ? await database
        .select({
          dependsOnSlug: schema.skillVersionDependencies.dependsOnSlug,
          dependsOnSkillId: schema.skillVersionDependencies.dependsOnSkillId,
        })
        .from(schema.skillVersionDependencies)
        .where(
          and(
            eq(schema.skillVersionDependencies.orgId, input.orgId),
            eq(schema.skillVersionDependencies.skillVersionId, versionRow.id),
          ),
        )
        .orderBy(asc(schema.skillVersionDependencies.dependsOnSlug))
    : [];

  const requires: SkillDependencyRow[] = requiresEdgeRows.map((row) => {
    const edge: DepEdge = { skillId: skill.id, dependsOnSlug: row.dependsOnSlug, dependsOnSkillId: row.dependsOnSkillId };
    const targetRow = visibleBySlug.get(row.dependsOnSlug);
    const canOpen = !!targetRow;
    // A target the actor cannot read is reported as "missing" — same no-existence-leak behavior as
    // the publish preflight; the real status is only computed for visible targets.
    const status = canOpen ? depEdgeStatus(graph, skill.id, edge) : "missing";
    return {
      slug: row.dependsOnSlug,
      status,
      visibility: targetRow ? targetRow.visibility : null,
      note: depNote(status, row.dependsOnSlug, skill.slug),
      can_open: canOpen,
    };
  });

  // Used by: other skills whose current version declares this skill as a dependency.
  const usedBy: SkillDependentRow[] = [];
  for (const ref of graph.dependentsByTarget.get(skill.id) ?? []) {
    const dependent = graph.byId.get(ref.dependentId);
    const dependentRow = dependent ? visibleBySlug.get(dependent.slug) : undefined;
    if (!dependent || !dependentRow) continue;
    const status = depEdgeStatus(graph, dependent.id, ref.edge);
    const note = status === "cycle" ? "forms a dependency cycle" : dependent.archivedAt ? "archived dependent" : null;
    usedBy.push({
      slug: dependent.slug,
      status,
      visibility: dependentRow.visibility,
      archived: dependent.archivedAt != null,
      note,
      can_open: true,
    });
  }
  usedBy.sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    slug: skill.slug,
    version: versionRow?.version ?? skill.current_version,
    requires,
    used_by: usedBy,
    requires_n: requires.length,
    used_by_n: usedBy.length,
  };
}

/**
 * Build the dependency preflight for publishing `slug` with `declaredSlugs`: which dependencies are
 * already published, which must be uploaded, which were dropped vs the previous version, which become
 * archival candidates, and which are blocking (missing/cycle/visibility).
 */
export async function buildDependencyPlan(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  declaredSlugs: string[];
  /** Requested visibility (team values are slugs). Used for the publish-time visibility-cover check. */
  visibility?: SkillVisibilityInput;
  /** Owning team slug (its members can see the skill). */
  ownerTeamSlug?: string | null;
  database?: Db;
}): Promise<DependencyPlan> {
  const database = input.database ?? db;
  const graph = await loadDepGraph(database, input.orgId);
  // Resolve declared dependencies against the actor's visibility gate, not the org-wide graph: a
  // skill the actor cannot read must be indistinguishable from one that does not exist (no existence
  // leak) and cannot be bound as a dependency. So "visible & published" → ready; everything else →
  // must-upload / missing.
  const visibleIds = await visibleSkillIds(database, input.actor, input.orgId);
  const isVisible = (s: string) => {
    const t = graph.bySlug.get(s);
    return !!t && visibleIds.has(t.id);
  };
  const declared = [...new Set(input.declaredSlugs)].filter((s) => s !== input.slug);
  const existing = graph.bySlug.get(input.slug);
  const dependentTeamIds = await resolveAudienceTeamIds(database, input.orgId, input.visibility?.teams, input.ownerTeamSlug);

  const ready = declared.filter((s) => isVisible(s) && !graph.bySlug.get(s)!.archivedAt);
  const upload = declared
    .filter((s) => !isVisible(s))
    .map((s) => ({ slug: s, msg: "declared in the new SKILL.md, not in the registry" }));

  // Previous current version's declared dependencies.
  let prevSlugs: string[] = [];
  if (existing?.currentVersionId) {
    const prev = await database
      .select({ slug: schema.skillVersionDependencies.dependsOnSlug })
      .from(schema.skillVersionDependencies)
      .where(
        and(
          eq(schema.skillVersionDependencies.orgId, input.orgId),
          eq(schema.skillVersionDependencies.skillVersionId, existing.currentVersionId),
        ),
      );
    prevSlugs = prev.map((p) => p.slug);
  }
  const removed = prevSlugs.filter((s) => !declared.includes(s));
  const candidateTargets = removed
    .map((s) => graph.bySlug.get(s))
    .filter((t): t is DepGraphSkill => !!t && !t.archivedAt);
  let archive_candidates: DependencyPlan["archive_candidates"] = [];
  if (candidateTargets.length) {
    // Consider ALL published versions' references (not just current-version edges, and org-wide):
    // a dependency still required by any other skill's version — even one the actor cannot see —
    // must NOT be offered for archiving. Excluding this skill's own edges only exposes a boolean
    // ("still used somewhere") about the publisher's own removed dependency, never who uses it.
    const candidateSlugs = candidateTargets.map((t) => t.slug);
    const refRows = await database
      .select({
        slug: schema.skillVersionDependencies.dependsOnSlug,
        skillId: schema.skillVersionDependencies.skillId,
      })
      .from(schema.skillVersionDependencies)
      .where(
        and(
          eq(schema.skillVersionDependencies.orgId, input.orgId),
          inArray(schema.skillVersionDependencies.dependsOnSlug, candidateSlugs),
        ),
      );
    const stillReferenced = new Set(
      (Array.isArray(refRows) ? refRows : []).filter((r) => r.skillId !== existing?.id).map((r) => r.slug),
    );
    archive_candidates = candidateTargets
      .filter((t) => !stillReferenced.has(t.slug))
      .map((t) => ({ slug: t.slug, reason: "no published skill requires it anymore" }));
  }

  // Blocking check: model the publishing skill as a dependent at its requested visibility.
  const dependent = depGraphDependentFor({
    graph,
    slug: input.slug,
    everyone: input.visibility?.everyone,
    audienceTeamIds: dependentTeamIds,
  });
  // Register the prospective skill + its declared edges in the graph so existing edges that declare
  // this slug (including ones currently unresolved/"missing") resolve to it — catching a cycle that
  // publishing this slug would introduce, not just cycles already present.
  graph.bySlug.set(dependent.slug, dependent);
  graph.byId.set(dependent.id, dependent);
  graph.requiresBySkill.set(
    dependent.id,
    declared
      .filter(isVisible)
      .map((s) => ({ skillId: dependent.id, dependsOnSlug: s, dependsOnSkillId: graph.bySlug.get(s)?.id ?? null })),
  );
  const blocked: DependencyPlan["blocked"] = [];
  for (const s of declared) {
    const target = graph.bySlug.get(s);
    // A dependency the actor cannot read is treated as missing — same as a nonexistent slug.
    if (!target || !visibleIds.has(target.id)) {
      blocked.push({ slug: s, status: "missing", msg: "not published to this workspace" });
      continue;
    }
    const edge: DepEdge = { skillId: dependent.id, dependsOnSlug: s, dependsOnSkillId: target.id };
    // Temporarily register the prospective dependent + edge for an accurate cycle probe.
    const status = depEdgeStatusWithDependent(graph, dependent, edge);
    if (status === "cycle") blocked.push({ slug: s, status, msg: `${s} would form a dependency cycle` });
    else if (status === "visibility") blocked.push({ slug: s, status, msg: `${s} is less visible than ${input.slug}` });
    else if (status === "archived") blocked.push({ slug: s, status, msg: `${s} is archived — restore it or drop the dependency` });
  }

  return { declared, ready, upload, removed, archive_candidates, blocked };
}

/** Resolve a visibility's team slugs + owner-team slug to the team ids that form a skill's audience. */
async function resolveAudienceTeamIds(
  database: Db,
  orgId: string,
  teamSlugs: string[] | undefined,
  ownerTeamSlug: string | null | undefined,
): Promise<string[]> {
  const slugs = [...new Set([...(teamSlugs ?? []), ...(ownerTeamSlug ? [ownerTeamSlug] : [])])];
  if (!slugs.length) return [];
  const rows = await database
    .select({ id: schema.teams.id, slug: schema.teams.slug })
    .from(schema.teams)
    .where(and(eq(schema.teams.orgId, orgId), inArray(schema.teams.slug, slugs)));
  return rows.map((r) => r.id);
}

/** A prospective dependent (the skill being published), inserted into the graph for status probes. */
function depGraphDependentFor(input: {
  graph: DepGraph;
  slug: string;
  everyone?: boolean;
  audienceTeamIds?: string[];
}): DepGraphSkill {
  const existing = input.graph.bySlug.get(input.slug);
  const everyone = input.everyone ?? existing?.everyone ?? false;
  // An explicitly-provided audience (even an empty one, i.e. narrowing to private) must be honored;
  // only fall back to the existing audience when no audience was requested at all.
  const teams =
    input.audienceTeamIds !== undefined
      ? new Set(input.audienceTeamIds)
      : new Set<string>(existing?.audienceTeams ?? []);
  // The owning team can always see/install the skill, so it is always part of the audience — even
  // when a re-publish of an existing team-owned skill does not re-send owner_team.
  if (existing?.ownerTeamId) teams.add(existing.ownerTeamId);
  return {
    id: existing?.id ?? `prospective:${input.slug}`,
    slug: input.slug,
    everyone,
    archivedAt: null,
    currentVersionId: existing?.currentVersionId ?? null,
    currentVersion: existing?.currentVersion ?? null,
    ownerId: existing?.ownerId ?? "",
    ownerTeamId: existing?.ownerTeamId ?? null,
    audienceTeams: teams,
  };
}

/** Like depEdgeStatus but for a dependent that may not yet be in the graph (publish-time probe). */
function depEdgeStatusWithDependent(graph: DepGraph, dependent: DepGraphSkill, edge: DepEdge): SkillDependencyStatus {
  const target = graph.bySlug.get(edge.dependsOnSlug);
  return dependencyStatusFromFlags({
    resolved: !!target,
    // Cycle: does the target transitively depend back on this dependent's existing skill id?
    cycle: !!target && graph.byId.has(dependent.id) && depReaches(graph, target.id, dependent.id, new Set()),
    archived: !!target?.archivedAt,
    covered: !target || audienceCovers(dependent, target),
  });
}

/** Carries the dependency plan when a publish is blocked, so the API can surface it to the client. */
export class DependencyPublishError extends Error {
  constructor(public readonly plan: DependencyPlan) {
    super("dependencies must be resolved before publishing");
    this.name = "DependencyPublishError";
  }
}

/** Throw a DependencyPublishError if any declared dependency is missing / cyclic / visibility-mismatched. */
export async function assertDependenciesResolvable(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  dependencies: string[];
  visibility?: SkillVisibilityInput;
  ownerTeamSlug?: string | null;
  database?: Db;
}): Promise<void> {
  if (!input.dependencies.length) return;
  const plan = await buildDependencyPlan({
    actor: input.actor,
    orgId: input.orgId,
    slug: input.slug,
    declaredSlugs: input.dependencies,
    visibility: input.visibility,
    ownerTeamSlug: input.ownerTeamSlug,
    database: input.database,
  });
  if (plan.blocked.length || plan.upload.length) throw new DependencyPublishError(plan);
}

/**
 * Assert that changing `slug`'s visibility to the given audience does not strand any skill that
 * currently depends on it (an Everyone/broader dependent must still be able to see this skill).
 * Shared by publish (which can narrow a dependency target's visibility) and setSkillVisibility.
 */
export async function assertDependentsRemainCovered(input: {
  orgId: string;
  slug: string;
  visibility: SkillVisibilityInput;
  ownerTeamSlug?: string | null;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const graph = await loadDepGraph(database, input.orgId);
  const self = graph.bySlug.get(input.slug);
  if (!self) return;
  const dependents = graph.dependentsByTarget.get(self.id) ?? [];
  if (!dependents.length) return;
  const teamIds = new Set(await resolveAudienceTeamIds(database, input.orgId, input.visibility.teams, input.ownerTeamSlug));
  if (self.ownerTeamId) teamIds.add(self.ownerTeamId); // owner team can always see it
  const newAudience = { everyone: input.visibility.everyone, teams: [...teamIds] };
  for (const ref of dependents) {
    const dependent = graph.byId.get(ref.dependentId);
    if (!dependent) continue;
    if (!visibilityCovers({ everyone: dependent.everyone, teams: [...dependent.audienceTeams] }, newAudience)) {
      throw new Error(`cannot narrow visibility: ${dependent.slug} depends on this skill and would lose access`);
    }
  }
}

export async function archiveSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  reason?: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  await assertCanModifySkillRow({ actor: input.actor, orgId: input.orgId, skill, database });
  await database
    .update(schema.skills)
    .set({ archivedAt: new Date(), archivedBy: input.actor.id, archiveReason: input.reason ?? null, updatedAt: new Date() })
    .where(eq(schema.skills.id, skill.id));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.archive",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: skill.slug, reason: input.reason ?? null },
  });
}

export async function restoreSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  await assertCanModifySkillRow({ actor: input.actor, orgId: input.orgId, skill, database });
  await database
    .update(schema.skills)
    .set({ archivedAt: null, archivedBy: null, archiveReason: null, updatedAt: new Date() })
    .where(eq(schema.skills.id, skill.id));
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.restore",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: skill.slug },
  });
}

/** Shared modify gate (owner / owner-team admin-editor / org admin) for a resolved skill row. */
async function assertCanModifySkillRow(input: {
  actor: ActorContext;
  orgId: string;
  skill: SkillListRow;
  database: Db;
}): Promise<void> {
  const orgRole = await getOrgRole(input.orgId, input.actor.id, input.database);
  if (!orgRole) throw new Error("not a member of this organization");
  const canModifyExisting = await canModifySkill({
    database: input.database,
    orgId: input.orgId,
    actor: input.actor,
    orgRole,
    ownerUserId: input.skill.owner_user_id,
    ownerTeamId: input.skill.owner_team_id,
  });
  if (!canModify({ orgRole }, { isOwner: canModifyExisting })) throw new Error("not allowed to modify this skill");
}

/* ---- Personal access tokens (programmatic publish / install) --------------- */

/** Default lifetime of an issued token (90 days), unless overridden by the caller. */
export const API_TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 90;

function hashApiToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function defaultTokenName(scopes: TokenScope[]): string {
  if (scopes.includes("skills:write")) return "skill publish token";
  if (scopes.includes("skills:read")) return "skill install token";
  return "api token";
}

/**
 * Mint a scoped personal access token. The plaintext `token` is returned exactly once;
 * only its sha256 hash is persisted. Requires the actor to be a member of `orgId`.
 */
export async function issueApiToken(input: {
  actor: ActorContext;
  orgId: string;
  scopes: TokenScope[];
  name?: string;
  ttlMs?: number;
  database?: Db;
}): Promise<{ id: string; token: string; prefix: string; scopes: TokenScope[]; expiresAt: Date }> {
  const database = input.database ?? db;
  if (!input.scopes.length) throw new Error("at least one scope is required");
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  const secret = randomBytes(24).toString("hex");
  const token = `${API_TOKEN_PREFIX}${secret}`;
  const prefix = token.slice(0, API_TOKEN_PREFIX.length + 6);
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? API_TOKEN_TTL_MS));
  const [row] = await database
    .insert(schema.apiTokens)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      name: input.name?.trim() || defaultTokenName(input.scopes),
      tokenPrefix: prefix,
      tokenHash: hashApiToken(token),
      scopes: input.scopes,
      expiresAt,
    })
    .returning({ id: schema.apiTokens.id });
  if (!row) throw new Error("could not issue token");
  return { id: row.id, token, prefix, scopes: input.scopes, expiresAt };
}

/**
 * List a member's personal access tokens for the settings UI. A developer sees only their own tokens
 * (`where userId = actor.id`); an org admin sees every token in the org — this mirrors the `0005` RLS
 * policy. Rows are mapped to the `apiTokenRowSchema` shape (snake_case, ISO timestamps); the secret
 * (`tokenHash`) is never selected or returned.
 */
export async function listApiTokens(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<ApiTokenRow[]> {
  const database = input.database ?? db;
  const role = await getOrgRole(input.orgId, input.actor.id, database);
  if (!role) throw new Error("not a member of this organization");
  // Always scope to the caller's OWN tokens: this backs the personal "Account › API keys" pane,
  // so even an org admin must not see (or be able to revoke from here) other members' keys. The
  // admin's broader revoke capability stays available by token id in `revokeApiToken`.
  // Only active tokens: revoke is a soft delete (revoked_at is set, the row stays), so revoked
  // keys must be filtered out or they reappear in the list masked as if still active.
  const where = and(
    eq(schema.apiTokens.orgId, input.orgId),
    eq(schema.apiTokens.userId, input.actor.id),
    isNull(schema.apiTokens.revokedAt),
  );
  const rows = await database
    .select({
      id: schema.apiTokens.id,
      orgId: schema.apiTokens.orgId,
      userId: schema.apiTokens.userId,
      name: schema.apiTokens.name,
      tokenPrefix: schema.apiTokens.tokenPrefix,
      scopes: schema.apiTokens.scopes,
      expiresAt: schema.apiTokens.expiresAt,
      lastUsedAt: schema.apiTokens.lastUsedAt,
      revokedAt: schema.apiTokens.revokedAt,
      createdAt: schema.apiTokens.createdAt,
    })
    .from(schema.apiTokens)
    .where(where)
    .orderBy(desc(schema.apiTokens.createdAt));
  return rows.map((r) => ({
    id: r.id,
    org_id: r.orgId,
    user_id: r.userId,
    name: r.name,
    prefix: r.tokenPrefix,
    scopes: (r.scopes ?? []) as TokenScope[],
    expires_at: r.expiresAt.toISOString(),
    last_used_at: r.lastUsedAt ? r.lastUsedAt.toISOString() : null,
    revoked_at: r.revokedAt ? r.revokedAt.toISOString() : null,
    created_at: r.createdAt.toISOString(),
  }));
}

/**
 * Resolve a raw `cmp_pat_…` token to an actor + org + scopes, or null if it is unknown,
 * revoked, or expired. Runs on the privileged app connection (the token itself identifies
 * the tenant, so this lookup is intentionally not org-scoped). Best-effort bumps last_used_at.
 */
export async function resolveApiToken(
  rawToken: string,
  database: Db = db,
): Promise<{ actor: ActorContext; orgId: string; scopes: TokenScope[] } | null> {
  if (!rawToken.startsWith(API_TOKEN_PREFIX)) return null;
  const row = await database.query.apiTokens.findFirst({
    where: eq(schema.apiTokens.tokenHash, hashApiToken(rawToken)),
  });
  if (!row || row.revokedAt) return null;
  if (row.expiresAt.getTime() <= Date.now()) return null;
  // The owner must still belong to the token's org — a removed member's token stops working.
  const role = await getOrgRole(row.orgId, row.userId, database);
  if (!role) return null;
  const profile = await database.query.profiles.findFirst({
    where: eq(schema.profiles.id, row.userId),
  });
  await database
    .update(schema.apiTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiTokens.id, row.id))
    .catch(() => {});
  return {
    actor: {
      id: row.userId,
      email: profile?.email ?? "",
      name: profile?.name || profile?.email || row.userId,
    },
    orgId: row.orgId,
    scopes: (row.scopes ?? []) as TokenScope[],
  };
}

/** Revoke a token. The owner can revoke their own; org owners/admins can revoke any. */
export async function revokeApiToken(input: {
  actor: ActorContext;
  orgId: string;
  tokenId: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const row = await database.query.apiTokens.findFirst({
    where: and(eq(schema.apiTokens.id, input.tokenId), eq(schema.apiTokens.orgId, input.orgId)),
  });
  if (!row) throw new Error("token not found");
  if (row.userId !== input.actor.id) {
    const role = await getOrgRole(input.orgId, input.actor.id, database);
    if (!role || !canManageOrg(role)) throw new Error("not allowed to revoke this token");
  }
  await database
    .update(schema.apiTokens)
    .set({ revokedAt: new Date() })
    .where(eq(schema.apiTokens.id, input.tokenId));
}

// --- Local skills (the "Companion skills" section) ------------------------------------------

export interface LocalSkillInstall {
  skillKey: string;
  installedVersion: string;
  agentLabel: string | null;
  installedAt: Date;
  lastReportedAt: Date;
}

/** The caller's install record for a built-in local skill, or null if they never reported one. */
export async function getLocalSkillInstall(input: {
  actor: ActorContext;
  orgId: string;
  skillKey: string;
  database?: Db;
}): Promise<LocalSkillInstall | null> {
  const database = input.database ?? db;
  const row = await database.query.localSkillInstalls.findFirst({
    where: and(
      eq(schema.localSkillInstalls.orgId, input.orgId),
      eq(schema.localSkillInstalls.userId, input.actor.id),
      eq(schema.localSkillInstalls.skillKey, input.skillKey),
    ),
  });
  if (!row) return null;
  return {
    skillKey: row.skillKey,
    installedVersion: row.installedVersion,
    agentLabel: row.agentLabel ?? null,
    installedAt: row.installedAt,
    lastReportedAt: row.lastReportedAt,
  };
}

/**
 * Record (or refresh) the caller's install of a built-in local skill. Idempotent per
 * (org, user, skillKey): the first report sets `installedAt`; later reports update the version,
 * label, and `lastReportedAt`. The local skill calls this at the end of its install flow.
 */
export async function reportLocalSkillInstall(input: {
  actor: ActorContext;
  orgId: string;
  skillKey: string;
  version: string;
  agentLabel?: string | null;
  database?: Db;
}): Promise<LocalSkillInstall> {
  const database = input.database ?? db;
  const now = new Date();
  const agentLabel = input.agentLabel?.trim() ? input.agentLabel.trim() : null;
  const [row] = await database
    .insert(schema.localSkillInstalls)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      skillKey: input.skillKey,
      installedVersion: input.version,
      agentLabel,
      installedAt: now,
      lastReportedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        schema.localSkillInstalls.orgId,
        schema.localSkillInstalls.userId,
        schema.localSkillInstalls.skillKey,
      ],
      set: { installedVersion: input.version, agentLabel, lastReportedAt: now },
    })
    .returning();
  if (!row) throw new Error("could not record install");
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "local_skill.install",
    targetType: "local_skill",
    targetId: input.skillKey,
    metadata: { version: input.version, agent: agentLabel },
  });
  return {
    skillKey: row.skillKey,
    installedVersion: row.installedVersion,
    agentLabel: row.agentLabel ?? null,
    installedAt: row.installedAt,
    lastReportedAt: row.lastReportedAt,
  };
}

/** Derive install status from the reported version (null = never reported) and the available version. */
export function computeLocalSkillStatus(
  installedVersion: string | null,
  availableVersion: string,
): LocalSkillStatus {
  if (!installedVersion) return "none";
  return compareSemver(installedVersion, availableVersion) < 0 ? "update" : "installed";
}

/**
 * Install status for a PUBLISHED skill row from the caller's point of view. Distinct from
 * `computeLocalSkillStatus` because a manual mark can have a null version: a present-but-version-
 * unknown install is "installed", never "update".
 */
export function computeSkillInstallStatus(
  hasInstall: boolean,
  installedVersion: string | null,
  currentVersion: string | null,
): LocalSkillStatus {
  if (!hasInstall) return "none";
  if (!installedVersion || !currentVersion) return "installed";
  return compareSemver(installedVersion, currentVersion) < 0 ? "update" : "installed";
}

/**
 * Does any skill in `rootId`'s transitive dependency closure satisfy `isBehind`? Installing a skill
 * also installs its dependency set, so a stale dependency makes the parent effectively stale — this
 * rolls that up into an "update available" hint on the parent. Cycle-safe via the visited set.
 */
export function depClosureHasUpdate(
  rootId: string,
  requiresBySkill: Map<string, { dependsOnSkillId: string | null }[]>,
  isBehind: (skillId: string) => boolean,
): boolean {
  const seen = new Set<string>([rootId]);
  const walk = (id: string): boolean => {
    for (const edge of requiresBySkill.get(id) ?? []) {
      const targetId = edge.dependsOnSkillId;
      if (!targetId || seen.has(targetId)) continue;
      seen.add(targetId);
      if (isBehind(targetId) || walk(targetId)) return true;
    }
    return false;
  };
  return walk(rootId);
}

/**
 * Record (or refresh) the caller's install of a PUBLISHED skill. Idempotent per (org, user, skill):
 * the first call sets `installedAt`; later calls update the version, label, source, and
 * `lastReportedAt`. The assistant calls this at the end of the normal install flow (source "agent");
 * the UI calls it for a manual mark (source "manual"). Visibility-gated via `getSkillBySlug`.
 */
export async function installSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  version?: string | null;
  agentLabel?: string | null;
  source?: "agent" | "manual";
  database?: Db;
}): Promise<{ status: LocalSkillStatus; installedVersion: string | null; currentVersion: string | null }> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const now = new Date();
  const version = input.version?.trim() ? input.version.trim() : null;
  const agentLabel = input.agentLabel?.trim() ? input.agentLabel.trim() : null;
  const source = input.source ?? "manual";

  // Reject a reported version newer than the current published version (mirrors the local-skill
  // guard): a typo/bogus version must not silently suppress future "update" prompts.
  if (version && skill.current_version && compareSemver(version, skill.current_version) > 0) {
    throw new Error(
      `reported version ${version} is newer than the current published version ${skill.current_version}`,
    );
  }

  await database
    .insert(schema.skillInstalls)
    .values({
      orgId: input.orgId,
      userId: input.actor.id,
      skillId: skill.id,
      installedVersion: version,
      agentLabel,
      source,
      installedAt: now,
      lastReportedAt: now,
    })
    .onConflictDoUpdate({
      target: [schema.skillInstalls.orgId, schema.skillInstalls.userId, schema.skillInstalls.skillId],
      set: { installedVersion: version, agentLabel, source, lastReportedAt: now },
    });

  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.install",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: skill.slug, version, agent: agentLabel, source },
  });

  // Installing a skill also installs its dependency set, so record each resolved (live) dependency in
  // the closure at its current version. This gives dependency-aware update detection a per-dependency
  // baseline to compare against later. Idempotent; cascades on every report so a reinstall refreshes
  // the dependencies too. No audit row per dependency — the parent install is the user-facing action.
  // The dependency graph is current-version-only, so this only matches reality when the reported
  // install IS the current version (or unknown); reporting an older version may declare a different
  // dependency set, so we skip the cascade rather than record dependencies it might not pull.
  const reflectsCurrentVersion = version === null || version === skill.current_version;
  const graph = reflectsCurrentVersion ? await loadDepGraph(database, input.orgId) : null;
  const closure = new Set<string>();
  const collect = (id: string) => {
    for (const edge of graph!.requiresBySkill.get(id) ?? []) {
      const targetId = edge.dependsOnSkillId;
      if (!targetId || closure.has(targetId)) continue;
      const target = graph!.byId.get(targetId);
      if (!target || target.archivedAt || !target.currentVersionId) continue;
      closure.add(targetId);
      collect(targetId);
    }
  };
  if (graph) collect(skill.id);
  if (closure.size) {
    const versionRowsRaw = await database
      .select({ id: schema.skills.id, version: schema.skillVersions.version })
      .from(schema.skills)
      .innerJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skills.currentVersionId))
      .where(and(eq(schema.skills.orgId, input.orgId), inArray(schema.skills.id, [...closure])));
    for (const dep of Array.isArray(versionRowsRaw) ? versionRowsRaw : []) {
      if (!dep.version) continue;
      await database
        .insert(schema.skillInstalls)
        .values({
          orgId: input.orgId,
          userId: input.actor.id,
          skillId: dep.id,
          installedVersion: dep.version,
          agentLabel,
          source,
          installedAt: now,
          lastReportedAt: now,
        })
        .onConflictDoUpdate({
          target: [schema.skillInstalls.orgId, schema.skillInstalls.userId, schema.skillInstalls.skillId],
          set: { installedVersion: dep.version, agentLabel, source, lastReportedAt: now },
        });
    }
  }

  return {
    status: computeSkillInstallStatus(true, version, skill.current_version),
    installedVersion: version,
    currentVersion: skill.current_version,
  };
}

/** Mark a PUBLISHED skill NOT installed for the caller (uninstall / correct a false state). Idempotent. */
export async function uninstallSkill(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  await database
    .delete(schema.skillInstalls)
    .where(
      and(
        eq(schema.skillInstalls.orgId, input.orgId),
        eq(schema.skillInstalls.userId, input.actor.id),
        eq(schema.skillInstalls.skillId, skill.id),
      ),
    );
  await database.insert(schema.auditLog).values({
    orgId: input.orgId,
    actorId: input.actor.id,
    action: "skill.uninstall",
    targetType: "skill",
    targetId: skill.id,
    metadata: { slug: skill.slug },
  });
}
