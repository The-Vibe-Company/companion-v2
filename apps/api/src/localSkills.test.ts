import { describe, expect, it } from "vitest";
import { reportLocalSkillInstallInputSchema } from "@companion/contracts";
import { computeLocalSkillStatus } from "@companion/core/services";
import { buildCompanionSkillRow, getCompanionSkillPackage } from "./companionSkillPackage";

describe("computeLocalSkillStatus", () => {
  it("returns none when the member has never reported an install", () => {
    expect(computeLocalSkillStatus(null, "1.2.0")).toBe("none");
  });

  it("returns update when the installed version is behind the available version", () => {
    expect(computeLocalSkillStatus("1.1.0", "1.2.0")).toBe("update");
    expect(computeLocalSkillStatus("0.9.0", "1.0.0")).toBe("update");
  });

  it("returns installed when the installed version is current or ahead", () => {
    expect(computeLocalSkillStatus("1.2.0", "1.2.0")).toBe("installed");
    expect(computeLocalSkillStatus("1.3.0", "1.2.0")).toBe("installed");
  });
});

describe("reportLocalSkillInstallInputSchema", () => {
  it("accepts a valid semver with an optional agent label", () => {
    expect(reportLocalSkillInstallInputSchema.parse({ version: "1.0.0", agent: "Claude Code" })).toEqual({
      version: "1.0.0",
      agent: "Claude Code",
    });
    expect(reportLocalSkillInstallInputSchema.parse({ version: "2.3.4" })).toEqual({ version: "2.3.4" });
  });

  it("rejects a non-semver version", () => {
    expect(() => reportLocalSkillInstallInputSchema.parse({ version: "latest" })).toThrow();
  });
});

describe("companion skill package + row", () => {
  it("packs the bundled skill deterministically and reads its version", async () => {
    const pkg = await getCompanionSkillPackage();
    expect(pkg.key).toBe("companion");
    expect(pkg.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(pkg.sizeBytes).toBeGreaterThan(0);
  });

  it("builds a 'none' row with an actionable install prompt for a fresh caller", async () => {
    const pkg = await getCompanionSkillPackage();
    const row = await buildCompanionSkillRow(null);
    expect(row.status).toBe("none");
    expect(row.installedVersion).toBeNull();
    expect(row.lastReportedAt).toBeNull();
    expect(row.availableVersion).toBe(pkg.version);
    expect(row.commands.length).toBeGreaterThan(0);
    // The install prompt drives the report-back call and leaves placeholders for the client.
    expect(row.prompts.install).toContain("/local-skills/companion/installed");
    expect(row.prompts.install).toContain("{base}");
    expect(row.prompts.install).toContain("{token}");
    expect(row.prompts.install).toContain(pkg.version);
  });

  it("reflects an install record as installed/update", async () => {
    const pkg = await getCompanionSkillPackage();
    const base = {
      skillKey: "companion",
      agentLabel: "Claude Code",
      installedAt: new Date("2026-06-15T00:00:00.000Z"),
      lastReportedAt: new Date("2026-06-15T00:00:00.000Z"),
    };
    const current = await buildCompanionSkillRow({ ...base, installedVersion: pkg.version });
    expect(current.status).toBe("installed");
    expect(current.lastReportedAt).not.toBeNull();

    const behind = await buildCompanionSkillRow({ ...base, installedVersion: "0.0.1" });
    expect(behind.status).toBe("update");
  });
});
