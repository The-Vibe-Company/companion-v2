import { describe, expect, it } from "vitest";
import type { SkillDependencyStatus } from "@companion/contracts";
import { dependencyStatusFromFlags, visibilityCovers } from "../src/services";

describe("visibilityCovers (dependency visibility-cover rule)", () => {
  type V = { everyone: boolean; teams: string[] };
  const cases: Array<[string, V, V, boolean]> = [
    // [name, dependent, target, covered]
    ["everyone target covers everything", { everyone: false, teams: ["a"] }, { everyone: true, teams: [] }, true],
    ["everyone dependent needs everyone target", { everyone: true, teams: [] }, { everyone: false, teams: ["a"] }, false],
    ["everyone → everyone", { everyone: true, teams: [] }, { everyone: true, teams: [] }, true],
    ["private dependent is owner-managed", { everyone: false, teams: [] }, { everyone: false, teams: ["a"] }, true],
    ["same team is covered", { everyone: false, teams: ["a"] }, { everyone: false, teams: ["a"] }, true],
    ["disjoint team is a mismatch", { everyone: false, teams: ["a"] }, { everyone: false, teams: ["b"] }, false],
    ["target must be a superset", { everyone: false, teams: ["a", "b"] }, { everyone: false, teams: ["a"] }, false],
    ["subset dependent is covered", { everyone: false, teams: ["a"] }, { everyone: false, teams: ["a", "b"] }, true],
  ];
  it.each(cases)("%s", (_name, dependent, target, expected) => {
    expect(visibilityCovers(dependent, target)).toBe(expected);
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
