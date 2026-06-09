import { describe, expect, it } from "vitest";
import type { OrgRole, Scope, TeamRole } from "@companion/contracts";
import {
  canActAtScope,
  canManageOrg,
  canManageTeam,
  canModify,
  canPerform,
  canTouchOwner,
  isLastOwner,
  isLastTeamAdmin,
  isOrgAdmin,
  type Actor,
} from "../src/index";

const actor = (orgRole: OrgRole, memberOfResourceTeam = false): Actor => ({
  orgRole,
  memberOfResourceTeam,
});

describe("canActAtScope (create/publish target scope)", () => {
  const cases: Array<[OrgRole, Scope, boolean, boolean]> = [
    // role, scope, memberOfTeam, expected
    ["owner", "public", false, true],
    ["admin", "team", false, true],
    ["developer", "public", false, true], // developers may publish public (their choice)
    ["developer", "private", false, true],
    ["developer", "team", true, true], // ...team only within their own team
    ["developer", "team", false, false], // ...not another team
  ];
  it.each(cases)("%s @ %s (team=%s) -> %s", (role, scope, team, expected) => {
    expect(canActAtScope(actor(role, team), scope)).toBe(expected);
  });
});

describe("canModify (update/delete existing)", () => {
  it("org admins modify anything; developers only what they own", () => {
    expect(canModify(actor("admin"), { scope: "team", isOwner: false })).toBe(true);
    expect(canModify(actor("owner"), { scope: "public", isOwner: false })).toBe(true);
    expect(canModify(actor("developer"), { scope: "private", isOwner: true })).toBe(true);
    expect(canModify(actor("developer"), { scope: "private", isOwner: false })).toBe(false);
  });
});

describe("canPerform — full surface", () => {
  it("reads are always capability-allowed (RLS gates visibility)", () => {
    expect(canPerform(actor("developer"), "skill.read", { scope: "team", isOwner: false })).toBe(true);
  });
  it("developers cannot create team skills for a team they are not on", () => {
    expect(canPerform(actor("developer", false), "skill.create", { scope: "team", isOwner: false })).toBe(false);
  });
  it("developers can create team skills for their own team", () => {
    expect(canPerform(actor("developer", true), "skill.create", { scope: "team", isOwner: false })).toBe(true);
  });
  it("owner can publish a new version of any skill", () => {
    expect(canPerform(actor("owner"), "skill.publish", { scope: "team", isOwner: false })).toBe(true);
  });
});

describe("isOrgAdmin / canManageOrg", () => {
  const cases: Array<[OrgRole, boolean]> = [
    ["owner", true],
    ["admin", true],
    ["developer", false],
  ];
  it.each(cases)("%s -> %s", (role, expected) => {
    expect(isOrgAdmin(role)).toBe(expected);
    expect(canManageOrg(role)).toBe(expected);
  });
});

describe("settings services rely on these capability decisions", () => {
  // Documentary: the workspace/team settings services gate on these exact predicates. updateOrg and
  // deleteTeam require an org admin (`canManageOrg`); a developer is denied at both.
  it("org rename/re-slug (updateOrg) is gated by canManageOrg", () => {
    expect(canManageOrg("owner")).toBe(true);
    expect(canManageOrg("admin")).toBe(true);
    expect(canManageOrg("developer")).toBe(false);
  });
  it("team delete (deleteTeam) is gated by canManageOrg (org admin, not merely team admin)", () => {
    expect(canManageOrg("owner")).toBe(true);
    expect(canManageOrg("admin")).toBe(true);
    expect(canManageOrg("developer")).toBe(false);
  });
});

describe("canTouchOwner (grant/modify/remove the owner role)", () => {
  it("only an owner may", () => {
    expect(canTouchOwner("owner")).toBe(true);
    expect(canTouchOwner("admin")).toBe(false);
    expect(canTouchOwner("developer")).toBe(false);
  });
});

describe("canManageTeam (org admin OR team admin)", () => {
  const cases: Array<[OrgRole, TeamRole | null, boolean]> = [
    ["admin", null, true], // org admin, not on the team
    ["owner", "reader", true], // org admin trumps team role
    ["developer", "admin", true], // team admin manages own team
    ["developer", "editor", false],
    ["developer", "reader", false],
    ["developer", null, false], // not on the team
  ];
  it.each(cases)("org=%s team=%s -> %s", (orgRole, teamRole, expected) => {
    expect(canManageTeam({ orgRole, teamRole })).toBe(expected);
  });
});

describe("last-owner / last-admin guards", () => {
  it("isLastOwner", () => {
    expect(isLastOwner(1, true)).toBe(true); // demoting/removing the sole owner is blocked
    expect(isLastOwner(2, true)).toBe(false);
    expect(isLastOwner(1, false)).toBe(false);
  });
  it("isLastTeamAdmin", () => {
    expect(isLastTeamAdmin(1, true)).toBe(true);
    expect(isLastTeamAdmin(2, true)).toBe(false);
    expect(isLastTeamAdmin(1, false)).toBe(false);
  });
});
