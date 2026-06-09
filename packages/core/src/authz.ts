import { type OrgRole, type TeamRole } from "@companion/contracts";

/**
 * The CAPABILITY gate (the "can the actor DO it?" half of authorization). The
 * VISIBILITY gate ("can the actor SEE it?") is enforced separately by Postgres RLS.
 * Both must pass. This module is framework-free and shared by the web routes and CLI.
 *
 * Roles (design model): org = owner / admin / developer; team = admin / editor / reader.
 * These are pure mirrors of the SQL guards in the SECURITY DEFINER management RPCs —
 * the database is authoritative; these power the route layer + the table-driven tests.
 * Every role passed in is the actor's role IN A SPECIFIC org/team, so a role in org A
 * never authorizes org B (the DB re-derives per org/team; this contract documents it).
 */

export type SkillAction =
  | "skill.read"
  | "skill.create"
  | "skill.update"
  | "skill.delete"
  | "skill.publish";

export interface Actor {
  orgRole: OrgRole;
  teamRole?: TeamRole | null;
}

export interface ResourceCtx {
  /** Does the actor own this resource (owner_id === actor)? */
  isOwner: boolean;
}

export interface VisibilityTarget {
  everyone: boolean;
  teamCount: number;
  /** True when the actor belongs to every targeted team. */
  memberOfAllTargetTeams?: boolean;
}

const ORG_ADMINS: ReadonlySet<OrgRole> = new Set<OrgRole>(["owner", "admin"]);

export function isOrgAdmin(role: OrgRole): boolean {
  return ORG_ADMINS.has(role);
}

/**
 * Who may CREATE or PUBLISH a resource at a given visibility target.
 * - org admins (owner/admin): any visibility.
 * - developers: private always, everyone always, team shares only for teams they belong to.
 */
export function canActAtVisibility(actor: Actor, target: VisibilityTarget): boolean {
  if (isOrgAdmin(actor.orgRole)) return true;
  if (target.teamCount === 0) return true;
  return target.memberOfAllTargetTeams === true;
}

/** Who may MODIFY (update/delete/publish a new version of) an existing resource. */
export function canModify(actor: Actor, res: ResourceCtx): boolean {
  if (isOrgAdmin(actor.orgRole)) return true;
  if (res.isOwner) return true;
  return actor.teamRole === "admin" || actor.teamRole === "editor";
}

/* ---- Management capability gates (mirror the SQL RPC guards) ---------------- */

/** Owner or admin may manage org members & teams. */
export function canManageOrg(orgRole: OrgRole): boolean {
  return isOrgAdmin(orgRole);
}

/** Only an owner may grant the owner role or modify/remove another owner. */
export function canTouchOwner(orgRole: OrgRole): boolean {
  return orgRole === "owner";
}

/**
 * Who may manage a team's members & roles: an org admin, or a team admin (a team admin
 * manages their own team even without org-admin rights).
 */
export function canManageTeam(actor: { orgRole: OrgRole; teamRole?: TeamRole | null }): boolean {
  return isOrgAdmin(actor.orgRole) || actor.teamRole === "admin";
}

/** Guard: an org must always keep at least one owner. */
export function isLastOwner(ownerCount: number, targetIsOwner: boolean): boolean {
  return targetIsOwner && ownerCount <= 1;
}

/** Guard: a team must always keep at least one admin. */
export function isLastTeamAdmin(adminCount: number, targetIsAdmin: boolean): boolean {
  return targetIsAdmin && adminCount <= 1;
}

/** The single capability decision used by routes and the CLI. */
export function canPerform(actor: Actor, action: SkillAction, res: ResourceCtx): boolean {
  switch (action) {
    case "skill.read":
      return true; // visibility gate (RLS) decides what is readable
    case "skill.create":
      return canActAtVisibility(actor, { everyone: false, teamCount: 0 });
    case "skill.publish":
      return canModify(actor, res);
    case "skill.update":
    case "skill.delete":
      return canModify(actor, res);
  }
}
