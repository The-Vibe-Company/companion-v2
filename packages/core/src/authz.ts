import { type OrgRole, type Scope, type TeamRole } from "@companion/contracts";

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
  /** The actor's role on the resource's team, if any. */
  teamRole?: TeamRole | null;
  /** Is the actor a member of the resource's team? */
  memberOfResourceTeam?: boolean;
}

export interface ResourceCtx {
  scope: Scope;
  /** Does the actor own this resource (owner_id === actor)? */
  isOwner: boolean;
}

const ORG_ADMINS: ReadonlySet<OrgRole> = new Set<OrgRole>(["owner", "admin"]);

export function isOrgAdmin(role: OrgRole): boolean {
  return ORG_ADMINS.has(role);
}

/**
 * Who may CREATE or PUBLISH a resource at a given visibility scope.
 * - org admins (owner/admin): any scope.
 * - developer: private always; public always (their choice to share broadly); team only
 *   within their own team.
 */
export function canActAtScope(actor: Actor, scope: Scope): boolean {
  if (isOrgAdmin(actor.orgRole)) return true;
  // developer
  if (scope === "private" || scope === "public") return true;
  return actor.memberOfResourceTeam === true; // team scope
}

/** Who may MODIFY (update/delete/publish a new version of) an existing resource. */
export function canModify(actor: Actor, res: ResourceCtx): boolean {
  if (isOrgAdmin(actor.orgRole)) return true;
  return res.isOwner; // developers may modify what they own
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
      return canActAtScope(actor, res.scope);
    case "skill.publish":
      // publishing a new version: modify rights + still allowed at the target scope
      return canModify(actor, res) && canActAtScope(actor, res.scope);
    case "skill.update":
    case "skill.delete":
      return canModify(actor, res);
  }
}
