import { describe, expect, it } from "vitest";
import type { SkillDependencyStatus, SkillOwnerKind } from "@companion/contracts";
import { dependencyStatusFromFlags, ownerCovers } from "../src/services";

describe("ownerCovers (dependency owner-cover rule)", () => {
  type O = { ownerKind: SkillOwnerKind; ownerUserId: string };
  const team = (u = "u1"): O => ({ ownerKind: "team", ownerUserId: u });
  const mine = (u = "u1"): O => ({ ownerKind: "user", ownerUserId: u });
  const cases: Array<[string, O, O, boolean]> = [
    // [name, dependent, target, covered]
    ["team target covers a personal dependent", mine(), team(), true],
    ["team target covers a team dependent", team(), team(), true],
    ["personal target covers same-owner personal dependent", mine("u1"), mine("u1"), true],
    ["personal target does NOT cover a different owner's personal dependent", mine("u2"), mine("u1"), false],
    ["personal target does NOT cover a team dependent (visible to all)", team(), mine("u1"), false],
  ];
  it.each(cases)("%s", (_name, dependent, target, expected) => {
    expect(ownerCovers(dependent, target)).toBe(expected);
  });
});

describe("dependencyStatusFromFlags (status precedence)", () => {
  const base = { resolved: true, cycle: false, archived: false, covered: true };
  const cases: Array<[string, Partial<typeof base>, SkillDependencyStatus]> = [
    ["unresolved → missing", { resolved: false }, "missing"],
    ["missing wins over other flags", { resolved: false, cycle: true, archived: true, covered: false }, "missing"],
    ["cycle before archived/visibility", { cycle: true, archived: true, covered: false }, "cycle"],
    ["archived before visibility", { archived: true, covered: false }, "archived"],
    ["uncovered → visibility", { covered: false }, "visibility"],
    ["all clear → satisfied", {}, "satisfied"],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(dependencyStatusFromFlags({ ...base, ...overrides })).toBe(expected);
  });
});
