import { describe, expect, it } from "vitest";
import type { SkillVM } from "@/lib/types";
import {
  SKILL_ACTIONS,
  resolveSkillActions,
  skillActionPermissions,
  type SkillActionPermissions,
} from "./skillActions";

function skill(overrides: Partial<SkillVM> = {}): SkillVM {
  return {
    uuid: "skill-1",
    id: "demo-skill",
    shareToken: "share-demo-skill",
    version: "1.0.0",
    validation: "valid",
    description: "Demo.",
    icon: null,
    notes: null,
    error: null,
    scope: "org",
    source: null,
    labels: [],
    authorId: "user-1",
    authorName: "Ada",
    authorInitials: "A",
    authorAvatarUrl: null,
    updaterId: "user-1",
    updaterName: "Ada",
    updaterInitials: "A",
    updaterAvatarUrl: null,
    modifiers: [],
    tools: [],
    requirements: [],
    compatibility: null,
    metadata: {},
    size: "1 KB",
    license: null,
    checksum: null,
    created: "Jun 1, 2026",
    updated: "just now",
    installStatus: "none",
    installedVersion: null,
    requiresCount: 0,
    usedByCount: 0,
    depWarn: false,
    archived: false,
    ...overrides,
  };
}

const allowed: SkillActionPermissions = {
  canShare: true,
  canPublishVersion: true,
  canArchive: true,
  canRestore: true,
  canCorrectInstall: true,
};

describe("resolveSkillActions", () => {
  it("keeps explicit action names separate from contextual button labels", () => {
    expect([
      SKILL_ACTIONS.install,
      SKILL_ACTIONS.update,
      SKILL_ACTIONS.archive,
      SKILL_ACTIONS.restore,
    ].map(({ label, contextualLabel }) => [label, contextualLabel])).toEqual([
      ["Install skill", "Install"],
      ["Update skill", "Update"],
      ["Archive skill", "Archive"],
      ["Restore skill", "Restore"],
    ]);
  });

  it.each([
    ["active personal", skill({ scope: "personal", source: "authored" }), "share"],
    ["archived personal", skill({ scope: "personal", source: "authored", archived: true }), "restore"],
    ["organization not installed", skill(), "install"],
    ["organization current", skill({ installStatus: "installed", installedVersion: "1.0.0" }), null],
    ["organization outdated", skill({ installStatus: "update", installedVersion: "0.9.0" }), "update"],
    ["older installed report", skill({ installStatus: "installed", installedVersion: "0.9.0" }), "update"],
    ["installed copy current", skill({ source: "installed", installStatus: "installed" }), null],
    ["installed copy outdated", skill({ source: "installed", installStatus: "update" }), "update"],
    ["no published version", skill({ version: null }), null],
    ["invalid", skill({ validation: "invalid" }), null],
    ["validating", skill({ validation: "validating" }), null],
  ])("resolves %s", (_name, row, expected) => {
    expect(resolveSkillActions(row, allowed).primary?.id ?? null).toBe(expected);
  });

  it("does not expose permission-gated primary actions", () => {
    const denied = { ...allowed, canShare: false, canRestore: false };
    expect(resolveSkillActions(skill({ scope: "personal" }), denied).primary).toBeNull();
    expect(resolveSkillActions(skill({ archived: true }), denied).primary).toBeNull();
  });

  it("keeps download, lifecycle, publish, and manual correction secondary", () => {
    const fresh = resolveSkillActions(skill(), allowed).secondary.map((action) => action.id);
    expect(fresh).toEqual(["download", "publish-version", "archive", "mark-installed"]);

    const current = resolveSkillActions(
      skill({ installStatus: "installed", installedVersion: "1.0.0" }),
      allowed,
    ).secondary.map((action) => action.id);
    expect(current).toEqual(["download", "publish-version", "archive", "mark-not-installed"]);

    const archived = resolveSkillActions(skill({ archived: true, referenced: true }), allowed).secondary.map(
      (action) => action.id,
    );
    expect(archived).toEqual(["download"]);
  });

  it("checks every scope × source × archive × install × version × validation × permission combination", () => {
    const scopes: SkillVM["scope"][] = ["personal", "org"];
    const sources: SkillVM["source"][] = ["authored", "installed", null];
    const archives = [false, true];
    const statuses: SkillVM["installStatus"][] = ["none", "installed", "update"];
    const installedVersions = [null, "0.9.0", "1.0.0"];
    const versions = [null, "1.0.0"];
    const validations: SkillVM["validation"][] = ["valid", "validating", "invalid"];
    const permissionSets = [allowed, {
      canShare: false,
      canPublishVersion: false,
      canArchive: false,
      canRestore: false,
      canCorrectInstall: false,
    }];
    let checked = 0;

    for (const scope of scopes) {
      for (const source of sources) {
        for (const archived of archives) {
          for (const installStatus of statuses) {
            for (const installedVersion of installedVersions) {
              for (const version of versions) {
                for (const validation of validations) {
                  for (const permissions of permissionSets) {
                    const row = skill({ scope, source, archived, installStatus, installedVersion, version, validation });
                    const model = resolveSkillActions(row, permissions);
                    checked += 1;
                    expect(new Set(model.secondary.map((action) => action.id)).size).toBe(model.secondary.length);
                    expect(model.secondary.some((action) => action.id === model.primary?.id)).toBe(false);
                    if (model.primary?.id === "install" || model.primary?.id === "update") {
                      expect(scope).toBe("org");
                      expect(archived).toBe(false);
                      expect(validation).toBe("valid");
                      expect(version).not.toBeNull();
                    }
                    if (archived) expect(model.primary?.id === "restore" || model.primary === null).toBe(true);
                    if (!version || validation !== "valid") {
                      expect(["install", "update"]).not.toContain(model.primary?.id);
                    }
                  }
                }
              }
            }
          }
        }
      }
    }

    expect(checked).toBe(1296);
  });
});

describe("skillActionPermissions", () => {
  it("allows every member to manage org skills and only the creator to manage personal skills", () => {
    expect(skillActionPermissions(skill({ scope: "org" }), "user-2")).toEqual({
      ...allowed,
      canShare: false,
    });
    expect(skillActionPermissions(skill({ scope: "personal" }), "user-1")).toEqual({
      ...allowed,
      canCorrectInstall: false,
    });
    expect(skillActionPermissions(skill({ scope: "personal" }), "user-2")).toEqual({
      canShare: false,
      canPublishVersion: false,
      canArchive: false,
      canRestore: false,
      canCorrectInstall: false,
    });
  });
});
