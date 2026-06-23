import { describe, expect, it } from "vitest";
import type { SkillDependencyStatus } from "@companion/contracts";
import { dependencyStatusFromFlags } from "../src/services";

/**
 * Dependencies are pure skill→skill links in the flat model: every skill is visible to every member,
 * so there is no "owner cover" rule and no "visibility" status. A dependency edge is only
 * `missing` (no published target), `cycle`, `archived`, or `satisfied`.
 */
describe("dependencyStatusFromFlags (status precedence: missing → cycle → archived → satisfied)", () => {
  const base = { resolved: true, cycle: false, archived: false };
  const cases: Array<[string, Partial<typeof base>, SkillDependencyStatus]> = [
    ["unresolved → missing", { resolved: false }, "missing"],
    ["missing wins over every other flag", { resolved: false, cycle: true, archived: true }, "missing"],
    ["cycle before archived", { cycle: true, archived: true }, "cycle"],
    ["archived when resolved + no cycle", { archived: true }, "archived"],
    ["all clear → satisfied", {}, "satisfied"],
  ];
  it.each(cases)("%s", (_name, overrides, expected) => {
    expect(dependencyStatusFromFlags({ ...base, ...overrides })).toBe(expected);
  });
});
