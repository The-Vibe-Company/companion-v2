import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, exists, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type {
  ApiTokenRow,
  OrgRole,
  OrgSettingsDomainJoin,
  OrgSettingsInvitation,
  OrgSettingsOrg,
  Scope,
  SkillCommentRow,
  SkillFilterPreferences,
  SkillListRow,
  SkillVersionRow,
  TeamRole,
  TokenScope,
} from "@companion/contracts";
import {
  API_TOKEN_PREFIX,
  publishSkillInputSchema,
  skillFilterPreferencesSchema,
  TEAM_BRAND_COLORS,
  type PublishSkillInput,
} from "@companion/contracts";
import { compareSemver } from "@companion/skills";
import { db, schema, type Db } from "@companion/db";
import { initialsFor, slugify } from "@companion/db/ids";
import { classifyEmailDomain } from "./email-domains";
import {
  canActAtScope,
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

function requireVerifiedForDomainJoin(): boolean {
  const flag = process.env.COMPANION_REQUIRE_VERIFIED_DOMAIN_JOIN;
  if (flag === "true") return true;
  if (flag === "false") return false;
  return process.env.NODE_ENV === "production";
}

async function isActorEmailVerified(actorId: string, database: Db): Promise<boolean> {
  const row = await database.query.user.findFirst({
    where: eq(schema.user.id, actorId),
    columns: { emailVerified: true },
  });
  return row?.emailVerified === true;
}

/**
 * Rename and/or re-slug the current organization, and/or toggle domain auto-join. Requires an org
 * admin (`canManageOrg`). Domain auto-join may only be enabled for the actor's own corporate email
 * domain (same rule as onboarding).
 */
export async function updateOrg(input: {
  actor: ActorContext;
  orgId: string;
  name?: string;
  slug?: string;
  domainAutoJoin?: boolean;
  database?: Db;
}): Promise<{ id: string; name: string; slug: string; domain: string | null; domainAutoJoin: boolean }> {
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
    domain?: string | null;
    domainAutoJoin?: boolean;
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
  if (input.domainAutoJoin !== undefined) {
    const { domain: actorDomain, isPersonal } = classifyEmailDomain(input.actor.email);
    if (input.domainAutoJoin) {
      if (orgRow.kind !== "team") {
        throw new Error("domain auto-join is only available for team workspaces");
      }
      const domain = orgRow.domain ?? (actorDomain && !isPersonal ? actorDomain : null);
      if (!domain || isPersonal || domain !== actorDomain) {
        throw new Error("domain auto-join requires a matching corporate email domain on your account");
      }
      if (requireVerifiedForDomainJoin() && !(await isActorEmailVerified(input.actor.id, database))) {
        throw new Error("verify your email to enable domain auto-join");
      }
      patch.domain = domain;
      patch.domainAutoJoin = true;
    } else {
      patch.domainAutoJoin = false;
    }
  }
  if (
    patch.name === undefined &&
    patch.slug === undefined &&
    patch.domain === undefined &&
    patch.domainAutoJoin === undefined
  ) {
    throw new Error("nothing to update");
  }

  const domainToClaim = patch.domain && patch.domain !== orgRow.domain ? patch.domain : null;

  let row;
  try {
    if (domainToClaim) {
      [row] = await database.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`companion:org-domain:${domainToClaim}`}))`);
        return tx
          .update(schema.organizations)
          .set(patch)
          .where(eq(schema.organizations.id, input.orgId))
          .returning({
            id: schema.organizations.id,
            name: schema.organizations.name,
            slug: schema.organizations.slug,
            domain: schema.organizations.domain,
            domainAutoJoin: schema.organizations.domainAutoJoin,
          });
      });
    } else {
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
        });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("organizations_domain_uq")) {
      throw new Error("an organization already exists for this domain");
    }
    if (isUniqueViolation(error)) throw new Error("that workspace URL is already taken");
    throw error;
  }
  if (!row) throw new Error("organization not found");
  return row;
}

export async function listTeamsForUser(input: {
  actor: ActorContext;
  orgId: string;
  database?: Db;
}): Promise<Array<{ id: string; slug: string; name: string }>> {
  const database = input.database ?? db;
  const rows = await database
    .select({ id: schema.teams.id, slug: schema.teams.slug, name: schema.teams.name })
    .from(schema.teams)
    .innerJoin(schema.teamMemberships, eq(schema.teamMemberships.teamId, schema.teams.id))
    .where(and(eq(schema.teams.orgId, input.orgId), eq(schema.teamMemberships.userId, input.actor.id)))
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
 * `skills.team_id` is `onDelete SET NULL`, but a CHECK enforces `(scope = 'team') = (team_id is not
 * null)`, so a raw delete would leave team-scoped skills violating the constraint. Inside one
 * transaction we first re-scope this team's skills to `{ scope: "private", teamId: null }`, then drop
 * the team (its memberships cascade).
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
    // Re-scope this team's skills to private BEFORE deleting so the team_id/scope CHECK stays satisfied.
    await tx
      .update(schema.skills)
      .set({ scope: "private", teamId: null, updatedAt: new Date() })
      .where(and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.teamId, input.teamId)));
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
  if (orgRole && canManageOrg(orgRole)) return eq(schema.skills.orgId, orgId);
  const teamsForActor = database
    .select({ teamId: schema.teamMemberships.teamId })
    .from(schema.teamMemberships)
    .where(and(eq(schema.teamMemberships.orgId, orgId), eq(schema.teamMemberships.userId, actor.id)));
  return and(
    eq(schema.skills.orgId, orgId),
    or(
      eq(schema.skills.scope, "public"),
      eq(schema.skills.ownerId, actor.id),
      and(eq(schema.skills.scope, "team"), inArray(schema.skills.teamId, teamsForActor)),
    ),
  );
}

export async function listSkills(input: {
  actor: ActorContext;
  orgId: string;
  scope?: Scope;
  mine?: boolean;
  database?: Db;
}): Promise<SkillListRow[]> {
  const database = input.database ?? db;
  const baseVisibility = await visibleSkillPredicate(database, input.actor, input.orgId);
  const predicates = [baseVisibility];
  if (input.scope) predicates.push(eq(schema.skills.scope, input.scope));
  if (input.mine) predicates.push(eq(schema.skills.ownerId, input.actor.id));

  const rows = await database
    .select({
      id: schema.skills.id,
      org_id: schema.skills.orgId,
      slug: schema.skills.slug,
      description: schema.skills.description,
      scope: schema.skills.scope,
      team_id: schema.skills.teamId,
      team_name: schema.teams.name,
      team_slug: schema.teams.slug,
      validation: schema.skills.validation,
      validation_error: schema.skills.validationError,
      owner_id: schema.skills.ownerId,
      owner_name: schema.profiles.name,
      owner_handle: schema.profiles.handle,
      owner_initials: schema.profiles.initials,
      current_version: schema.skillVersions.version,
      license: schema.skillVersions.license,
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
      created_at: schema.skills.createdAt,
      updated_at: schema.skills.updatedAt,
    })
    .from(schema.skills)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.skills.ownerId))
    .leftJoin(schema.teams, eq(schema.teams.id, schema.skills.teamId))
    .leftJoin(schema.skillVersions, eq(schema.skillVersions.id, schema.skills.currentVersionId))
    .leftJoin(schema.skillStars, eq(schema.skillStars.skillId, schema.skills.id))
    .where(and(...predicates))
    .groupBy(schema.skills.id, schema.profiles.id, schema.teams.id, schema.skillVersions.id)
    .orderBy(desc(schema.skills.updatedAt));

  return rows.map((r) => ({
    ...r,
    tools: r.tools ?? [],
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  })) as SkillListRow[];
}

const EMPTY_SKILL_FILTER_PREFERENCES: SkillFilterPreferences = {
  active_filters: [],
  custom_views: [],
};

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
  return skillFilterPreferencesSchema.parse({
    active_filters: row.activeFilters,
    custom_views: row.customViews,
  });
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
  const rows = await listSkills({ ...input, database: input.database ?? db });
  return rows.find((r) => r.slug === input.slug) ?? null;
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
  return rows.map((r) => ({
    id: r.id,
    skill_id: r.skillId,
    version: r.version,
    note: r.note,
    frontmatter: r.frontmatter,
    tools: r.tools,
    license: r.license,
    size_bytes: r.sizeBytes,
    checksum: r.checksum,
    storage_path: r.storagePath,
    validation: r.validation,
    validation_error: r.validationError,
    created_by: r.createdBy,
    created_at: r.createdAt.toISOString(),
  }));
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

  // A reply inherits its thread's scope, so any caller-supplied versionId is ignored for replies.
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
  const allowed =
    comment.authorId === input.actor.id ||
    (orgRole ? isOrgAdmin(orgRole) : false) ||
    skill.owner_id === input.actor.id;
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

export async function setSkillScope(input: {
  actor: ActorContext;
  orgId: string;
  slug: string;
  scope: Scope;
  teamSlug?: string | null;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  const team =
    input.scope === "team"
      ? await database.query.teams.findFirst({
          where: and(eq(schema.teams.orgId, input.orgId), eq(schema.teams.slug, input.teamSlug ?? "")),
        })
      : null;
  if (input.scope === "team" && !team) throw new Error("team scope requires a valid team");
  const teamMembership = team
    ? await database.query.teamMemberships.findFirst({
        where: and(eq(schema.teamMemberships.teamId, team.id), eq(schema.teamMemberships.userId, input.actor.id)),
      })
    : null;
  if (
    !canModify({ orgRole, teamRole: teamMembership?.teamRole as TeamRole | null }, { scope: skill.scope, isOwner: skill.owner_id === input.actor.id }) ||
    !canActAtScope({ orgRole, teamRole: teamMembership?.teamRole as TeamRole | null, memberOfResourceTeam: !!teamMembership }, input.scope)
  ) {
    throw new Error("not allowed to change this skill");
  }
  await database
    .update(schema.skills)
    .set({ scope: input.scope, teamId: team?.id ?? null, updatedAt: new Date() })
    .where(eq(schema.skills.id, skill.id));
}

export async function publishSkillVersion(input: {
  actor: ActorContext;
  orgId: string;
  payload: PublishSkillInput;
  archiveKey: string;
  database?: Db;
}): Promise<{ id: string; version: string }> {
  const database = input.database ?? db;
  const payload = publishSkillInputSchema.parse({ ...input.payload, storage_path: input.archiveKey });
  await assertCanPublishSkillVersion({ actor: input.actor, orgId: input.orgId, payload, database });

  return database.transaction(async (tx) => {
    const publishPayload = publishSkillInputSchema.parse({ ...payload, storage_path: input.archiveKey });
    return writeSkillVersion({
      actor: input.actor,
      orgId: input.orgId,
      payload: publishPayload,
      archiveKey: input.archiveKey,
      database: tx as unknown as Db,
    });
  });
}

export async function assertCanPublishSkillVersion(input: {
  actor: ActorContext;
  orgId: string;
  payload: PublishSkillInput;
  database?: Db;
}): Promise<void> {
  const database = input.database ?? db;
  const payload = publishSkillInputSchema.parse(input.payload);
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");
  const team =
    payload.scope === "team"
      ? await database.query.teams.findFirst({
          where: and(eq(schema.teams.orgId, input.orgId), eq(schema.teams.slug, payload.team_slug ?? "")),
        })
      : null;
  if (payload.scope === "team" && !team) throw new Error("team scope requires a valid team");
  const teamMembership = team
    ? await database.query.teamMemberships.findFirst({
        where: and(eq(schema.teamMemberships.teamId, team.id), eq(schema.teamMemberships.userId, input.actor.id)),
      })
    : null;

  const existing = await database.query.skills.findFirst({
      where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, payload.slug)),
    });
  if (existing) {
    if (
      !canModify(
        { orgRole, teamRole: teamMembership?.teamRole as TeamRole | null },
        { scope: existing.scope as Scope, isOwner: existing.ownerId === input.actor.id },
      )
    ) {
      throw new Error("not allowed to publish this skill");
    }
    if (
      !canActAtScope(
        { orgRole, teamRole: teamMembership?.teamRole as TeamRole | null, memberOfResourceTeam: !!teamMembership },
        payload.scope,
      )
    ) {
      throw new Error("not allowed to publish at this scope");
    }
      const versions = await database
        .select({ version: schema.skillVersions.version })
        .from(schema.skillVersions)
        .where(and(eq(schema.skillVersions.orgId, input.orgId), eq(schema.skillVersions.skillId, existing.id)));
    if (versions.some((v) => v.version === payload.version)) throw new Error("version already exists");
    const latest = versions.map((v) => v.version).sort((a, b) => compareSemver(b, a))[0];
    if (latest && compareSemver(payload.version, latest) <= 0) throw new Error("version must increase monotonically");
    return;
  }

  if (
    !canActAtScope(
      { orgRole, teamRole: teamMembership?.teamRole as TeamRole | null, memberOfResourceTeam: !!teamMembership },
      payload.scope,
    )
  ) {
    throw new Error("not allowed to publish at this scope");
  }
}

async function writeSkillVersion(input: {
  actor: ActorContext;
  orgId: string;
  payload: PublishSkillInput;
  archiveKey: string;
  database: Db;
}): Promise<{ id: string; version: string }> {
  const database = input.database;
  const payload = input.payload;
  const team =
    payload.scope === "team"
      ? await database.query.teams.findFirst({
          where: and(eq(schema.teams.orgId, input.orgId), eq(schema.teams.slug, payload.team_slug ?? "")),
        })
      : null;
  const existing = await database.query.skills.findFirst({
    where: and(eq(schema.skills.orgId, input.orgId), eq(schema.skills.slug, payload.slug)),
  });

    const [skill] = existing
      ? await database
          .update(schema.skills)
          .set({
            description: payload.description,
            scope: payload.scope,
            teamId: team?.id ?? null,
            validation: "valid",
            validationError: null,
            updatedAt: new Date(),
          })
          .where(eq(schema.skills.id, existing.id))
          .returning()
      : await database
          .insert(schema.skills)
          .values({
            orgId: input.orgId,
            slug: payload.slug,
            description: payload.description,
            ownerId: input.actor.id,
            creatorId: input.actor.id,
            scope: payload.scope,
            teamId: team?.id ?? null,
            validation: "valid",
          })
          .returning();
    if (!skill) throw new Error("could not write skill");

    const [version] = await database
      .insert(schema.skillVersions)
      .values({
        orgId: input.orgId,
        skillId: skill.id,
        version: payload.version,
        note: payload.note,
        frontmatter: payload.frontmatter,
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
    await database.insert(schema.auditLog).values({
      orgId: input.orgId,
      actorId: input.actor.id,
      action: "skill.publish",
      targetType: "skill",
      targetId: skill.id,
      metadata: { slug: payload.slug, version: payload.version },
    });
    return { id: skill.id, version: version.version };
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
  scope: Scope;
  teamSlug: string | null;
}> {
  const database = input.database ?? db;
  const visible = (await listSkills({ actor: input.actor, orgId: input.orgId, database })).find((s) => s.slug === input.slug);
  if (!visible) throw new Error("skill not found");
  const versions = await listSkillVersions({ ...input, database });
  const row = input.version ? versions.find((v) => v.version === input.version) : versions[0];
  if (!row) throw new Error("version not found");
  return {
    storagePath: row.storage_path,
    version: row.version,
    checksum: row.checksum,
    sizeBytes: row.size_bytes,
    scope: visible.scope,
    teamSlug: visible.team_slug,
  };
}

/* ---- Personal access tokens (programmatic publish / install) --------------- */

/** Default lifetime of an issued token (24h), unless overridden by the caller. */
export const API_TOKEN_TTL_MS = 1000 * 60 * 60 * 24;

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
