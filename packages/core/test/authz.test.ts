import { describe, expect, it } from "vitest";
import type { OrgRole, Scope } from "@companion/contracts";
import { canActAtScope, canModify, canPerform, isOrgAdmin, type Actor } from "../src/index";

const actor = (orgRole: OrgRole, memberOfResourceTeam = false): Actor => ({
  orgRole,
  memberOfResourceTeam,
});

describe("canActAtScope (create/publish target scope)", () => {
  const cases: Array<[OrgRole, Scope, boolean, boolean]> = [
    // role, scope, memberOfTeam, expected
    ["owner", "public", false, true],
    ["admin", "team", false, true],
    ["member", "public", false, true], // members may publish public (their choice)
    ["member", "private", false, true],
    ["member", "team", true, true], // ...team only within their own team
    ["member", "team", false, false], // ...not another team
    ["guest", "private", false, false],
    ["guest", "public", false, false],
  ];
  it.each(cases)("%s @ %s (team=%s) -> %s", (role, scope, team, expected) => {
    expect(canActAtScope(actor(role, team), scope)).toBe(expected);
  });
});

describe("canModify (update/delete existing)", () => {
  it("org admins modify anything; members only what they own; guests never", () => {
    expect(canModify(actor("admin"), { scope: "team", isOwner: false })).toBe(true);
    expect(canModify(actor("owner"), { scope: "public", isOwner: false })).toBe(true);
    expect(canModify(actor("member"), { scope: "private", isOwner: true })).toBe(true);
    expect(canModify(actor("member"), { scope: "private", isOwner: false })).toBe(false);
    expect(canModify(actor("guest"), { scope: "team", isOwner: true })).toBe(false);
  });
});

describe("canPerform — full surface", () => {
  it("reads are always capability-allowed (RLS gates visibility)", () => {
    expect(canPerform(actor("guest"), "skill.read", { scope: "team", isOwner: false })).toBe(true);
  });
  it("members cannot create team skills for a team they are not on", () => {
    expect(canPerform(actor("member", false), "skill.create", { scope: "team", isOwner: false })).toBe(false);
  });
  it("members can create team skills for their own team", () => {
    expect(canPerform(actor("member", true), "skill.create", { scope: "team", isOwner: false })).toBe(true);
  });
  it("owner can publish a new version of any skill", () => {
    expect(canPerform(actor("owner"), "skill.publish", { scope: "team", isOwner: false })).toBe(true);
  });
});

describe("isOrgAdmin", () => {
  it("recognizes owner and admin", () => {
    expect(isOrgAdmin("owner")).toBe(true);
    expect(isOrgAdmin("admin")).toBe(true);
    expect(isOrgAdmin("member")).toBe(false);
    expect(isOrgAdmin("guest")).toBe(false);
  });
});
