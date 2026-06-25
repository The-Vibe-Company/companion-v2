import { describe, expect, it } from "vitest";
import { reportSkillInstallInputSchema } from "@companion/contracts";
import { computeSkillInstallStatus, depClosureHasUpdate } from "@companion/core/services";

describe("computeSkillInstallStatus", () => {
  it("returns none when the caller has no install record", () => {
    expect(computeSkillInstallStatus(false, null, "1.0.0")).toBe("none");
    expect(computeSkillInstallStatus(false, "1.0.0", "1.0.0")).toBe("none");
  });

  it("treats a present-but-version-unknown install (manual mark) as installed", () => {
    expect(computeSkillInstallStatus(true, null, "1.0.0")).toBe("installed");
  });

  it("treats an install on a skill with no published version as installed", () => {
    expect(computeSkillInstallStatus(true, "1.0.0", null)).toBe("installed");
  });

  it("returns update when the installed version is behind the current version", () => {
    expect(computeSkillInstallStatus(true, "0.9.0", "1.0.0")).toBe("update");
    expect(computeSkillInstallStatus(true, "1.1.0", "1.2.0")).toBe("update");
  });

  it("returns installed when the installed version is current or ahead", () => {
    expect(computeSkillInstallStatus(true, "1.0.0", "1.0.0")).toBe("installed");
    expect(computeSkillInstallStatus(true, "1.3.0", "1.2.0")).toBe("installed");
  });
});

describe("depClosureHasUpdate", () => {
  // A -> B -> C dependency chain.
  const requires = new Map<string, { targetId: string | null }[]>([
    ["A", [{ targetId: "B" }]],
    ["B", [{ targetId: "C" }]],
  ]);

  it("is false when no dependency is behind", () => {
    expect(depClosureHasUpdate("A", requires, () => false)).toBe(false);
  });

  it("flags a direct dependency that is behind", () => {
    expect(depClosureHasUpdate("A", requires, (id) => id === "B")).toBe(true);
  });

  it("flags a transitive dependency that is behind", () => {
    expect(depClosureHasUpdate("A", requires, (id) => id === "C")).toBe(true);
  });

  it("ignores the root skill's own behind state (only the closure counts)", () => {
    expect(depClosureHasUpdate("A", requires, (id) => id === "A")).toBe(false);
  });

  it("skips unresolved (missing) dependency edges", () => {
    const withMissing = new Map<string, { targetId: string | null }[]>([
      ["A", [{ targetId: null }]],
    ]);
    expect(depClosureHasUpdate("A", withMissing, () => true)).toBe(false);
  });

  it("terminates on a dependency cycle", () => {
    const cyclic = new Map<string, { targetId: string | null }[]>([
      ["A", [{ targetId: "B" }]],
      ["B", [{ targetId: "A" }]],
    ]);
    expect(depClosureHasUpdate("A", cyclic, () => false)).toBe(false);
    expect(depClosureHasUpdate("A", cyclic, (id) => id === "B")).toBe(true);
  });
});

describe("reportSkillInstallInputSchema", () => {
  it("accepts a bare body (manual mark with no version)", () => {
    expect(reportSkillInstallInputSchema.parse({})).toEqual({});
  });

  it("accepts a valid semver with an optional agent label and source", () => {
    expect(
      reportSkillInstallInputSchema.parse({ version: "1.0.0", agent: "Claude Code", source: "agent" }),
    ).toEqual({ version: "1.0.0", agent: "Claude Code", source: "agent" });
  });

  it("rejects a non-semver version", () => {
    expect(() => reportSkillInstallInputSchema.parse({ version: "latest" })).toThrow();
  });

  it("rejects an unknown source", () => {
    expect(() => reportSkillInstallInputSchema.parse({ source: "cli" })).toThrow();
  });
});
