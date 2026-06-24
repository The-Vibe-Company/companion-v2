import { type OrgRole, type SkillScope } from "@companion/contracts";

/**
 * The CAPABILITY gate (the "can the actor DO it?" half of authorization). The
 * VISIBILITY gate ("can the actor SEE it?") is enforced separately by Postgres RLS.
 * Both must pass. This module is framework-free and shared by the web routes and CLI.
 *
 * ORG skills are FLAT: every org skill is visible to every member, and any member may do anything to
 * it (read / create / update / delete / publish / label-*). PERSONAL skills are private: only the
 * creator (the owner) can see or modify them — admins included. {@link canAccessSkill} /
 * {@link canManagePersonalSkill} express that per-resource gate; the flat capability gate
 * ({@link canPerform}) still governs the action itself. Org governance (member/role management)
 * mirrors the SQL guards in the SECURITY DEFINER management RPCs — the database is authoritative;
 * these power the route layer + the table-driven tests. Every role passed in is the actor's role IN
 * A SPECIFIC org, so a role in org A never authorizes org B.
 */

export type SkillAction =
  | "skill.read"
  | "skill.create"
  | "skill.update"
  | "skill.delete"
  | "skill.publish";

export interface Actor {
  orgRole: OrgRole;
}

const ORG_ADMINS: ReadonlySet<OrgRole> = new Set<OrgRole>(["owner", "admin"]);

export function isOrgAdmin(role: OrgRole): boolean {
  return ORG_ADMINS.has(role);
}

/* ---- Management capability gates (mirror the SQL RPC guards) ---------------- */

/** Owner or admin may manage org members. */
export function canManageOrg(orgRole: OrgRole): boolean {
  return isOrgAdmin(orgRole);
}

/** Only an owner may grant the owner role or modify/remove another owner. */
export function canTouchOwner(orgRole: OrgRole): boolean {
  return orgRole === "owner";
}

/** Guard: an org must always keep at least one owner. */
export function isLastOwner(ownerCount: number, targetIsOwner: boolean): boolean {
  return targetIsOwner && ownerCount <= 1;
}

/**
 * The single capability decision used by routes and the CLI. Skills are flat: every action is
 * allowed for any member of the org. The visibility gate (RLS / `assertMember`) decides whether
 * the actor is a member at all; this gate then permits the action unconditionally.
 */
export function canPerform(_actor: Actor, _action: SkillAction): boolean {
  return true;
}

/* ---- Per-skill scope gate (personal-skill privacy) -------------------------- */

/** The minimal skill shape the scope gate needs: its library and its owner (creator). */
export interface SkillScopeRef {
  scope: SkillScope;
  creatorId: string;
}

/**
 * Can `actorId` SEE this specific skill? Org skills: yes (flat — every member). Personal skills: only
 * the owner (creator). There is deliberately NO admin override — "only you see this library". Org
 * role is irrelevant here, so this takes the bare actor id rather than an {@link Actor}.
 */
export function canAccessSkill(actorId: string, skill: SkillScopeRef): boolean {
  return skill.scope === "org" || skill.creatorId === actorId;
}

/**
 * Owner-only mutation gate for a personal skill (Share, personal-folder assign). True only when the
 * skill is personal AND `actorId` is its creator. Org skills are not "managed" through this gate —
 * they use the flat capability path.
 */
export function canManagePersonalSkill(actorId: string, skill: SkillScopeRef): boolean {
  return skill.scope === "personal" && skill.creatorId === actorId;
}
