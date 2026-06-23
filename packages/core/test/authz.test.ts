import { describe, expect, it } from "vitest";
import type { OrgRole } from "@companion/contracts";
import {
  canManageOrg,
  canPerform,
  canTouchOwner,
  isLastOwner,
  isOrgAdmin,
  type Actor,
  type SkillAction,
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
