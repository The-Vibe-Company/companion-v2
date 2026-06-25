import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { companionSkillDir } from "@companion/companion-skill";
import { reportLocalSkillInstallInputSchema } from "@companion/contracts";
import { computeLocalSkillStatus } from "@companion/core/services";
import { buildCompanionSkillRow, getCompanionSkillPackage } from "./companionSkillPackage";

const workspaceId = "org-1";

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
    expect(pkg.version).toBe("1.12.1");
    expect(pkg.sizeBytes).toBeGreaterThan(0);
  });

  it("builds a 'none' row with an actionable install prompt for a fresh caller", async () => {
    const pkg = await getCompanionSkillPackage();
    const row = await buildCompanionSkillRow(null, workspaceId);
    expect(row.status).toBe("none");
    expect(row.workspaceId).toBe(workspaceId);
    expect(row.description).toContain("SKILL.md");
    expect(row.description).toContain("self-update");
    expect(row.notes).toContain("companion.json");
    expect(row.notes).toContain("skills.lock.json");
    expect(row.installedVersion).toBeNull();
    expect(row.lastReportedAt).toBeNull();
    expect(row.availableVersion).toBe(pkg.version);
    expect(row.commands.length).toBeGreaterThan(0);
    expect(row.commands).toContainEqual({
      name: "Publish a skill",
      desc: "Validate a skill, ask Personal vs Org and folder placement, then publish it safely.",
    });
    expect(row.commands).toContainEqual({
      name: "Manage skill API calls",
      desc: "Use the supported skills API surface without crossing into workspace admin.",
    });
    expect(row.commands).toContainEqual({
      name: "Sync companion.json",
      desc: "Create or repair manifest v2 with identity, env/secrets, dependency ids, notes, commands, and changelog.",
    });
    const changelog = row.changes.join("\n");
    expect(changelog).toContain("public preview links");
    expect(changelog).toContain("share_token");
    expect(changelog).toContain("preflight guard");
    expect(changelog).toContain("expect_slug");
    // The install prompt drives the report-back call and leaves placeholders for the client.
    expect(row.prompts.install).toContain("/local-skills/companion/package");
    expect(row.prompts.install).toContain("/local-skills/companion/installed");
    expect(row.prompts.install).toContain("{base}");
    expect(row.prompts.install).toContain("{workspaceId}");
    expect(row.prompts.install).toContain("{token}");
    expect(row.prompts.install).toContain(pkg.version);
  });

  it("prompts persist fresh workspace credentials for future skill calls", async () => {
    const row = await buildCompanionSkillRow(null, workspaceId);
    for (const prompt of [row.prompts.install, row.prompts.update, row.prompts.use]) {
      expect(prompt).toContain("$HOME/.companion/credentials.json");
      expect(prompt).toContain("credentials.json");
      expect(prompt).toContain("schemaVersion");
      expect(prompt).toContain("activeWorkspaceId");
      expect(prompt).toContain("{base}");
      expect(prompt).toContain("{workspaceId}");
      expect(prompt).toContain("{token}");
      expect(prompt).toContain("Do not print the token");
    }
    expect(row.prompts.update).toContain("/local-skills/companion/package");
    expect(row.prompts.update).toContain("move it to a backup path");
    expect(row.prompts.update).toContain("Do not delete the existing folder");
    expect(row.prompts.update).not.toContain("Unzip it over");
    expect(row.prompts.install).toContain("/local-skills/companion/installed");
    expect(row.prompts.update).toContain("/local-skills/companion/installed");
  });

  it("bundles mandatory self-update and explicit publish placement instructions", async () => {
    const skillMd = await readFile(join(companionSkillDir(), "SKILL.md"), "utf8");
    const apiRef = await readFile(join(companionSkillDir(), "reference", "api.md"), "utf8");
    const checkScript = await readFile(join(companionSkillDir(), "scripts", "check_updates.py"), "utf8");
    const companionLib = await readFile(join(companionSkillDir(), "scripts", "companion_lib.py"), "utf8");
    const guardScript = await readFile(join(companionSkillDir(), "scripts", "skill_guard.py"), "utf8");
    expect(skillMd).not.toContain("companion_version:");
    expect(skillMd).toContain("companion.json.version");
    expect(skillMd).toContain("https://thecompanion.sh/schemas/companion-manifest.v2.schema.json");
    expect(skillMd).toContain("skills.lock.json");
    expect(skillMd).toContain("GET /skills?installed=true");
    expect(skillMd).toContain("GET /public/skills/{share_token}");
    expect(skillMd).toContain("/s/{share_token}");
    expect(skillMd).toContain("python3 scripts/check_updates.py");
    expect(skillMd).toContain("executes only on the user's machine");
    expect(skillMd).toContain("skills.log.json");
    expect(skillMd).toContain("COMPANION_WORKSPACE_ID");
    expect(skillMd).toContain("Never write the token to this lockfile");
    expect(skillMd).toContain("## Mandatory startup self-update");
    expect(skillMd).toContain("only once per conversation");
    expect(skillMd).toContain("do not repeat it on later Companion turns");
    expect(skillMd).toContain("Do not validate, publish, update, archive, label, install");
    expect(skillMd).toContain("GET /local-skills/companion");
    expect(skillMd).toContain("POST /local-skills/companion/installed");
    expect(skillMd).toContain("GET /v1/schemas/companion-manifest.v2.schema.json");
    expect(skillMd).toContain("POST /skills/{slug}/install");
    expect(skillMd).toContain("After a successful publish from this Companion skill");
    expect(skillMd).toContain("Before any real `POST /skills` upload for a brand-new skill");
    expect(skillMd).toContain("Personal / My Skills");
    expect(skillMd).toContain("Org / everyone");
    expect(skillMd).toContain("Use an existing folder/label");
    expect(skillMd).toContain("Create/use a new folder/label");
    expect(skillMd).toContain("No folder/label");
    expect(skillMd).toContain("Always include `scope=personal` or `scope=org` explicitly");
    expect(skillMd).toContain("re-publish never changes the skill's existing labels");
    expect(skillMd).toContain("If the library is not known from the");
    expect(skillMd).toContain("workspace URL look wrong");
    expect(skillMd).toContain("Dependency preflight follows the workspace access model");
    expect(skillMd).not.toContain("Publishing defaults to `org`");
    expect(skillMd).not.toMatch(/owner_team[\s\S]{0,120}`scope`[\s\S]{0,120}parameters (?:is|are) rejected/);
    expect(apiRef).toContain("`expect_skill_id` / `scope` / `dependency` / `label` fields");
    expect(apiRef).toContain("The Companion skill must send `scope=personal` or `scope=org`");
    expect(apiRef).toContain("POST /skills?scope=org&label=marketing&label=marketing%2Fseo");
    expect(apiRef).toContain("POST /skills?scope=personal");
    expect(apiRef).toContain("GET /v1/schemas/companion-manifest.v2.schema.json");
    expect(apiRef).toContain("GET /skills?lib=mine");
    expect(apiRef).toContain("GET /skills?installed=true");
    expect(apiRef).toContain("GET /public/skills/{share_token}");
    expect(apiRef).toContain("Rows also include `share_token`");
    expect(apiRef).toContain("Local manifest checks");
    expect(apiRef).toContain("never executes the script");
    expect(apiRef).toContain("COMPANION_WORKSPACE_ID");
    expect(apiRef).toContain("skills.log.json");
    expect(apiRef).toContain("response includes `workspaceId`");
    expect(apiRef).toContain("POST /skills/{slug}/install");
    expect(apiRef).toContain("updates preserve the existing scope");
    expect(apiRef).toContain("skill must not declare `scope` or `visibility`");
    expect(apiRef).toContain("Re-publish never moves, adds, or removes folder labels");
    expect(apiRef).toContain("token-supported download endpoint does not expose");
    expect(apiRef).toContain("Personal folder routes use the same request bodies and response shapes");
    expect(apiRef).not.toContain("defaults to `org`");
    expect(apiRef).not.toMatch(/owner_team[\s\S]{0,120}`scope`[\s\S]{0,120}parameters (?:is|are) rejected/);
    expect(companionLib).toContain("def resolve_credentials");
    expect(checkScript).toContain("/skills?installed=true");
    expect(checkScript).toContain("from companion_lib import");
    // The anti-duplication / anti-retargeting guard ships alongside the update check.
    expect(guardScript).toContain("def detect_conflicts");
    expect(guardScript).toContain("def create_preflight");
    expect(guardScript).toContain("def migrate_legacy_log");
  });

  it("reflects an install record as installed/update", async () => {
    const pkg = await getCompanionSkillPackage();
    const base = {
      skillKey: "companion",
      agentLabel: "Claude Code",
      installedAt: new Date("2026-06-15T00:00:00.000Z"),
      lastReportedAt: new Date("2026-06-15T00:00:00.000Z"),
    };
    const current = await buildCompanionSkillRow({ ...base, installedVersion: pkg.version }, workspaceId);
    expect(current.status).toBe("installed");
    expect(current.lastReportedAt).not.toBeNull();

    const behind = await buildCompanionSkillRow({ ...base, installedVersion: "0.0.1" }, workspaceId);
    expect(behind.status).toBe("update");
  });
});
