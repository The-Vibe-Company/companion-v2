import { createHash, randomBytes } from "node:crypto";
import { and, asc, count, desc, eq, exists, gt, inArray, isNull, or, sql } from "drizzle-orm";
import type {
  OrgRole,
  Scope,
  SkillCommentRow,
  SkillListRow,
  SkillVersionRow,
  TeamRole,
  TokenScope,
} from "@companion/contracts";
import { API_TOKEN_PREFIX, publishSkillInputSchema, type PublishSkillInput } from "@companion/contracts";
import { compareSemver } from "@companion/skills";
import { db, schema, type Db } from "@companion/db";
import { initialsFor, slugify } from "@companion/db/ids";
import {
  canActAtScope,
  canManageOrg,
  canManageTeam,
  canModify,
  canTouchOwner,
  isLastOwner,
  isLastTeamAdmin,
} from "./authz";

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
  members: Array<{
    userId: string;
    role: TeamRole;
    name: string;
    email: string;
    initials: string;
  }>;
}

function uniqueSlug(base: string, suffix: string): string {
  return `${slugify(base)}-${suffix.slice(0, 8).toLowerCase()}`;
}

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

  await database.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('companion:first-owner-bootstrap'))`);

    const userMembership = await tx.query.memberships.findFirst({
      where: eq(schema.memberships.userId, actor.id),
    });
    if (userMembership) return;

    const [membershipCountRow] = await tx.select({ value: count() }).from(schema.memberships);
    const membershipCount = membershipCountRow?.value ?? 0;
    if (membershipCount > 0) return;

    const existingOrg = await tx.query.organizations.findFirst({
      orderBy: asc(schema.organizations.createdAt),
    });
    const [org] = existingOrg
      ? [existingOrg]
      : await tx
          .insert(schema.organizations)
          .values({
            name: "Acme",
            slug: "acme",
            kind: "team",
            plan: "free",
          })
          .returning();
    if (!org) throw new Error("could not create bootstrap organization");

    await tx
      .insert(schema.memberships)
      .values({ orgId: org.id, userId: actor.id, orgRole: "owner" })
      .onConflictDoNothing();
  });
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
}): Promise<{ members: OrgSettingsMember[]; teams: OrgSettingsTeam[] }> {
  const database = input.database ?? db;
  const orgRole = await getOrgRole(input.orgId, input.actor.id, database);
  if (!orgRole) throw new Error("not a member of this organization");

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

  if (canManageOrg(orgRole)) {
    const inviteRows = await database
      .select({
        id: schema.invitations.id,
        email: schema.invitations.email,
        role: schema.invitations.orgRole,
        token: schema.invitations.token,
        createdAt: schema.invitations.createdAt,
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
    }
  }

  const teamRows = await database
    .select({ id: schema.teams.id, slug: schema.teams.slug, name: schema.teams.name })
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
      members: teamMembers.map((m) => ({
        userId: m.userId,
        role: m.role as TeamRole,
        name: m.name,
        email: m.email,
        initials: m.initials,
      })),
    });
  }

  return { members, teams };
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
    })
    .from(schema.skillComments)
    .innerJoin(schema.profiles, eq(schema.profiles.id, schema.skillComments.authorId))
    .where(and(eq(schema.skillComments.orgId, input.orgId), eq(schema.skillComments.skillId, skill.id)))
    .orderBy(asc(schema.skillComments.createdAt));
  return rows.map((r) => ({ ...r, created_at: r.created_at.toISOString() }));
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
  database?: Db;
}): Promise<SkillCommentRow> {
  const database = input.database ?? db;
  const skill = await getSkillBySlug(input);
  if (!skill) throw new Error("skill not found");
  const [row] = await database
    .insert(schema.skillComments)
    .values({ orgId: input.orgId, skillId: skill.id, authorId: input.actor.id, body: input.body })
    .returning();
  if (!row) throw new Error("could not add comment");
  return {
    id: row.id,
    skill_id: row.skillId,
    author_id: row.authorId,
    body: row.body,
    created_at: row.createdAt.toISOString(),
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
