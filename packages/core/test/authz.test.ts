import { describe, expect, it } from "vitest";
import type { OrgRole, TeamRole } from "@companion/contracts";
import {
  canActAtVisibility,
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

const actor = (orgRole: OrgRole, teamRole?: TeamRole | null): Actor => ({
  orgRole,
  teamRole,
});

describe("canActAtVisibility (create/publish target visibility)", () => {
  const cases: Array<[OrgRole, boolean, number, boolean | undefined, boolean]> = [
    // role, everyone, teamCount, memberOfAllTargetTeams, expected
    ["owner", true, 2, false, true],
    ["admin", false, 1, false, true],
    ["developer", true, 0, undefined, true],
    ["developer", false, 0, undefined, true],
    ["developer", false, 1, true, true],
    ["developer", true, 2, true, true],
    ["developer", false, 1, false, false],
    ["developer", true, 2, false, false],
  ];
  it.each(cases)(
    "%s everyone=%s teams=%s ownTeams=%s -> %s",
    (role, everyone, teamCount, memberOfAllTargetTeams, expected) => {
      expect(canActAtVisibility(actor(role), { everyone, teamCount, memberOfAllTargetTeams })).toBe(expected);
    },
  );
});

describe("canModify (update/delete existing)", () => {
  it("org admins modify anything; developers modify owned or editable team-shared resources", () => {
    expect(canModify(actor("admin"), { isOwner: false })).toBe(true);
    expect(canModify(actor("owner"), { isOwner: false })).toBe(true);
    expect(canModify(actor("developer"), { isOwner: true })).toBe(true);
    expect(canModify(actor("developer"), { isOwner: false })).toBe(false);
    expect(canModify(actor("developer", "admin"), { isOwner: false })).toBe(true);
    expect(canModify(actor("developer", "editor"), { isOwner: false })).toBe(true);
    expect(canModify(actor("developer", "reader"), { isOwner: false })).toBe(false);
  });
});

describe("canPerform — full surface", () => {
  it("reads are always capability-allowed (RLS gates visibility)", () => {
    expect(canPerform(actor("developer"), "skill.read", { isOwner: false })).toBe(true);
  });
  it("developers may create skills; target visibility is checked separately", () => {
    expect(canPerform(actor("developer"), "skill.create", { isOwner: false })).toBe(true);
  });
  it("owner can publish a new version of any skill", () => {
    expect(canPerform(actor("owner"), "skill.publish", { isOwner: false })).toBe(true);
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
