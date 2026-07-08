import { describe, expect, it } from "vitest";
import type { OrgRole } from "@companion/contracts";
import {
  canAccessAgent,
  canAccessSkill,
  canManageAgent,
  canManageOrg,
  canManagePersonalSkill,
  canPerform,
  canTouchOwner,
  isLastOwner,
  isOrgAdmin,
  type Actor,
  type AgentScopeRef,
  type SkillAction,
  type SkillScopeRef,
} from "../src/index";

const actor = (orgRole: OrgRole): Actor => ({ orgRole });

/**
 * Skills are FLAT: there is no owner or visibility axis. The capability gate (`canPerform`) permits
 * EVERY skill action for ANY member, regardless of org role. The "can the actor SEE / TOUCH it?"
 * half is the membership gate (`assertMember` / RLS), exercised in the service-layer suites — a role
 * in org A never authorizes org B because the role passed here is always the actor's role in THAT org.
 * Only org governance (member/role management) keeps a role-sensitive capability gate.
 */

const SKILL_ACTIONS: SkillAction[] = [
  "skill.read",
  "skill.create",
  "skill.update",
  "skill.delete",
  "skill.publish",
];
const ROLES: OrgRole[] = ["owner", "admin", "developer"];

describe("canPerform — flat skill capability gate (every member ⇒ every action)", () => {
  const cases: Array<[OrgRole, SkillAction]> = ROLES.flatMap((role) =>
    SKILL_ACTIONS.map((action) => [role, action] as [OrgRole, SkillAction]),
  );
  it.each(cases)("org=%s action=%s -> allowed", (role, action) => {
    expect(canPerform(actor(role), action)).toBe(true);
  });

  it("the lowest role (developer) may read / create / update / delete / publish any skill", () => {
    for (const action of SKILL_ACTIONS) {
      expect(canPerform(actor("developer"), action)).toBe(true);
    }
  });
});

describe("canAccessSkill — personal-skill privacy (owner-only, NO admin override)", () => {
  const orgSkill: SkillScopeRef = { scope: "org", creatorId: "u-creator" };
  const personalSkill: SkillScopeRef = { scope: "personal", creatorId: "u-owner" };

  it("org skill is visible to any actor (creator or not)", () => {
    expect(canAccessSkill("u-owner", orgSkill)).toBe(true);
    expect(canAccessSkill("u-creator", orgSkill)).toBe(true);
    expect(canAccessSkill("u-stranger", orgSkill)).toBe(true);
  });

  it("personal skill is visible ONLY to its creator", () => {
    expect(canAccessSkill("u-owner", personalSkill)).toBe(true);
    expect(canAccessSkill("u-someone-else", personalSkill)).toBe(false);
  });

  it("an admin/owner who is NOT the creator still cannot see a personal skill", () => {
    // The load-bearing privacy assertion: scope wins, org role is irrelevant. "Only you see this library."
    expect(canAccessSkill("u-admin", personalSkill)).toBe(false);
  });
});

describe("canManagePersonalSkill — owner-only mutate (Share / personal-folder assign)", () => {
  it("only the creator of a personal skill may", () => {
    expect(canManagePersonalSkill("u-owner", { scope: "personal", creatorId: "u-owner" })).toBe(true);
    expect(canManagePersonalSkill("u-other", { scope: "personal", creatorId: "u-owner" })).toBe(false);
  });

  it("org skills are not managed through the personal gate", () => {
    expect(canManagePersonalSkill("u-creator", { scope: "org", creatorId: "u-creator" })).toBe(false);
  });
});

describe("canAccessAgent / canManageAgent — agents mirror the skill scope gates", () => {
  const orgAgent: AgentScopeRef = { scope: "org", creatorId: "u-creator" };
  const personalAgent: AgentScopeRef = { scope: "personal", creatorId: "u-owner" };

  it("org agent is visible to and manageable by any member (flat, like org skills)", () => {
    for (const actorId of ["u-creator", "u-stranger"]) {
      expect(canAccessAgent(actorId, orgAgent)).toBe(true);
      expect(canManageAgent(actorId, orgAgent)).toBe(true);
    }
  });

  it("personal agent is visible/manageable ONLY by its creator", () => {
    expect(canAccessAgent("u-owner", personalAgent)).toBe(true);
    expect(canManageAgent("u-owner", personalAgent)).toBe(true);
    expect(canAccessAgent("u-someone-else", personalAgent)).toBe(false);
    expect(canManageAgent("u-someone-else", personalAgent)).toBe(false);
  });

  it("an admin/owner who is NOT the creator still cannot see a personal agent (no admin override)", () => {
    expect(canAccessAgent("u-admin", personalAgent)).toBe(false);
    expect(canManageAgent("u-admin", personalAgent)).toBe(false);
  });
});

describe("isOrgAdmin / canManageOrg (org governance survives the flattening)", () => {
  const cases: Array<[OrgRole, boolean]> = [
    ["owner", true],
    ["admin", true],
    ["developer", false],
  ];
  it.each(cases)("%s -> %s", (role, expected) => {
    expect(isOrgAdmin(role)).toBe(expected);
    expect(canManageOrg(role)).toBe(expected);
  });

  it("org rename / re-slug (updateOrg) is gated by canManageOrg (admin or owner only)", () => {
    expect(canManageOrg("owner")).toBe(true);
    expect(canManageOrg("admin")).toBe(true);
    expect(canManageOrg("developer")).toBe(false);
  });
});

describe("canTouchOwner (grant / modify / remove the org owner role)", () => {
  it("only an owner may", () => {
    expect(canTouchOwner("owner")).toBe(true);
    expect(canTouchOwner("admin")).toBe(false);
    expect(canTouchOwner("developer")).toBe(false);
  });
});

describe("isLastOwner (an org must always keep at least one owner)", () => {
  it("blocks demoting / removing the sole owner", () => {
    expect(isLastOwner(1, true)).toBe(true);
    expect(isLastOwner(2, true)).toBe(false);
    expect(isLastOwner(1, false)).toBe(false);
  });
});
