import { describe, expect, it } from "vitest";
import type { OrgRole, TeamRole } from "@companion/contracts";
import {
  canEditSkill,
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

describe("canEditSkill — the single owner gate", () => {
  // role, ownerKind, isOwnerUser, ownerTeamRole, expected
  const cases: Array<[OrgRole, "user" | "team", boolean, TeamRole | null, boolean]> = [
    // Org admins edit anything.
    ["owner", "user", false, null, true],
    ["admin", "team", false, "reader", true],
    ["admin", "user", false, null, true],
    // Personal skills: only the owning user.
    ["developer", "user", true, null, true],
    ["developer", "user", false, null, false],
    // Team-owned skills: that team's admins & editors only.
    ["developer", "team", false, "admin", true],
    ["developer", "team", false, "editor", true],
    ["developer", "team", false, "reader", false],
    ["developer", "team", false, null, false], // not a member of the owning team
    // Being the personal owner doesn't help on a team-owned skill if you're not admin/editor.
    ["developer", "team", true, "reader", false],
  ];
  it.each(cases)(
    "org=%s ownerKind=%s isOwnerUser=%s ownerTeamRole=%s -> %s",
    (orgRole, ownerKind, isOwnerUser, ownerTeamRole, expected) => {
      expect(canEditSkill(actor(orgRole), { ownerKind, isOwnerUser, ownerTeamRole })).toBe(expected);
    },
  );
});

describe("canModify (update/delete existing)", () => {
  it("org admins modify anything; developers modify only owned resources", () => {
    expect(canModify(actor("admin"), { isOwner: false })).toBe(true);
    expect(canModify(actor("owner"), { isOwner: false })).toBe(true);
    expect(canModify(actor("developer"), { isOwner: true })).toBe(true);
    expect(canModify(actor("developer"), { isOwner: false })).toBe(false);
    expect(canModify(actor("developer", "admin"), { isOwner: false })).toBe(false);
    expect(canModify(actor("developer", "editor"), { isOwner: false })).toBe(false);
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
