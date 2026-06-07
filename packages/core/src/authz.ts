import { type OrgRole, type Scope, type TeamRole } from "@companion/contracts";

/**
 * The CAPABILITY gate (the "can the actor DO it?" half of authorization). The
 * VISIBILITY gate ("can the actor SEE it?") is enforced separately by Postgres RLS.
 * Both must pass. This module is framework-free and shared by the web routes and CLI.
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
 * - org admins: any scope.
 * - member: private always; public always (their choice to share broadly); team only
 *   within their own team.
 * - guest: never.
 */
export function canActAtScope(actor: Actor, scope: Scope): boolean {
  if (isOrgAdmin(actor.orgRole)) return true;
  if (actor.orgRole === "guest") return false;
  // member
  if (scope === "private" || scope === "public") return true;
  return actor.memberOfResourceTeam === true; // team scope
}

/** Who may MODIFY (update/delete/publish a new version of) an existing resource. */
export function canModify(actor: Actor, res: ResourceCtx): boolean {
  if (isOrgAdmin(actor.orgRole)) return true;
  if (actor.orgRole === "guest") return false;
  return res.isOwner; // members may modify what they own
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
