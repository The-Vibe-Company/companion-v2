import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { LockedSkill } from "@companion/contracts";
import { packDir } from "@companion/skills";
import { loadLockfile } from "../lib/lockfile";
import {
  assertCanReplaceExistingInstall,
  buildPublishFormData,
  lockfileVisibility,
  parseVisibilityFilter,
  resolvePushVersion,
  resolvePushVisibility,
  splitTeams,
  verifyDownloadedArchive,
} from "./skills";
import { classify, type RegistryInfo } from "../lib/registry";

async function withSkillDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "companion-cli-test-"));
  try {
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: demo\ndescription: Demo skill\nmetadata:\n  companion_version: \"1.0.0\"\n---\n",
    );
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("skills pull safeguards", () => {
  it("fails loudly instead of replacing a malformed existing lockfile", async () => {
    const dir = await mkdtemp(join(tmpdir(), "companion-lock-test-"));
    try {
      await writeFile(join(dir, "companion.lock"), JSON.stringify({ lockfileVersion: 1, skills: { demo: { scope: "public" } } }));
      await expect(loadLockfile(dir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects downloaded archives whose checksum differs from the registry", async () => {
    await withSkillDir(async (dir) => {
      const packed = await packDir(dir);
      expect(() => verifyDownloadedArchive("demo", "1.0.0", packed.archive, "sha256:bad")).toThrow(
        /download checksum mismatch/,
      );
      expect(verifyDownloadedArchive("demo", "1.0.0", packed.archive, packed.checksum)).toBe(packed.checksum);
    });
  });

  it("refuses to replace an untracked existing install without --force", async () => {
    await withSkillDir(async (dir) => {
      await expect(assertCanReplaceExistingInstall(dir, undefined, false)).rejects.toThrow(/refusing to overwrite/);
    });
  });

  it("refuses to replace a locally modified tracked install without --force", async () => {
    await withSkillDir(async (dir) => {
      const locked = { checksum: "sha256:old" } as LockedSkill;
      await expect(assertCanReplaceExistingInstall(dir, locked, false)).rejects.toThrow(/local changes detected/);
      await expect(assertCanReplaceExistingInstall(dir, locked, true)).resolves.toBeUndefined();
    });
  });
});

describe("skills visibility helpers", () => {
  it("parses repeatable and comma-separated team flags", () => {
    expect(splitTeams(["platform,data", "platform", " security "])).toEqual(["platform", "data", "security"]);
  });

  it("validates list visibility filters locally", () => {
    expect(parseVisibilityFilter("everyone")).toBe("everyone");
    expect(parseVisibilityFilter("team")).toBe("team");
    expect(parseVisibilityFilter(undefined)).toBeUndefined();
    expect(() => parseVisibilityFilter("public")).toThrow(/visibility must be one of/);
  });

  it("stores downloaded visibility in lockfile input shape", () => {
    expect(
      lockfileVisibility({
        everyone: true,
        teams: [
          { id: "team-1", slug: "platform", name: "Platform" },
          { id: "team-2", slug: "data", name: "Data" },
        ],
      }),
    ).toEqual({ everyone: true, teams: ["platform", "data"] });
  });

  it("preserves existing registry visibility when update flags are omitted", () => {
    expect(
      resolvePushVisibility(
        {
          exists: true,
          id: "skill-1",
          currentVersion: "1.0.0",
          versions: ["1.0.0"],
          row: {
            id: "skill-1",
            org_id: "org-1",
            slug: "demo",
            description: "Demo skill",
            visibility: { everyone: true, teams: [{ id: "team-1", slug: "platform", name: "Platform" }] },
            validation: "valid",
            validation_error: null,
            owner_kind: "user",
            owner_id: "user-1",
            owner_user_id: "user-1",
            owner_team_id: null,
            owner_name: "User One",
            owner_handle: null,
            owner_initials: "UO",
            current_version: "1.0.0",
            license: null,
            compatibility: null,
            metadata: {},
            checksum: null,
            size_bytes: 10,
            tools: [],
            star_count: 0,
            starred: false,
            installed: false,
            installed_version: null,
            install_status: "none",
            requires_count: 0,
            used_by_count: 0,
            dep_warn: false,
            archived: false,
            referenced: false,
            created_at: "2026-06-09T12:00:00.000Z",
            updated_at: "2026-06-09T12:00:00.000Z",
          },
        },
        {},
      ),
    ).toEqual({ everyone: true, teams: ["platform"] });
  });

  it("can explicitly clear existing registry visibility", () => {
    expect(
      resolvePushVisibility(
        {
          exists: true,
          id: "skill-1",
          currentVersion: "1.0.0",
          versions: ["1.0.0"],
          row: {
            id: "skill-1",
            org_id: "org-1",
            slug: "demo",
            description: "Demo skill",
            visibility: { everyone: true, teams: [{ id: "team-1", slug: "platform", name: "Platform" }] },
            validation: "valid",
            validation_error: null,
            owner_kind: "user",
            owner_id: "user-1",
            owner_user_id: "user-1",
            owner_team_id: null,
            owner_name: "User One",
            owner_handle: null,
            owner_initials: "UO",
            current_version: "1.0.0",
            license: null,
            compatibility: null,
            metadata: {},
            checksum: null,
            size_bytes: 10,
            tools: [],
            star_count: 0,
            starred: false,
            installed: false,
            installed_version: null,
            install_status: "none",
            requires_count: 0,
            used_by_count: 0,
            dep_warn: false,
            archived: false,
            referenced: false,
            created_at: "2026-06-09T12:00:00.000Z",
            updated_at: "2026-06-09T12:00:00.000Z",
          },
        },
        { private: true },
      ),
    ).toEqual({ everyone: false, teams: [] });
  });

  it("rejects conflicting private and shared visibility flags", () => {
    expect(() =>
      resolvePushVisibility({ exists: false, id: null, currentVersion: null, versions: [] }, { private: true, everyone: true }),
    ).toThrow(/--private cannot be combined/);
    expect(() =>
      resolvePushVisibility({ exists: false, id: null, currentVersion: null, versions: [] }, { private: true, team: ["platform"] }),
    ).toThrow(/--private cannot be combined/);
  });

  it("defaults new skills to private when update flags are omitted", () => {
    expect(resolvePushVisibility({ exists: false, id: null, currentVersion: null, versions: [] }, {})).toEqual({
      everyone: false,
      teams: [],
    });
  });

  it("builds push form data with owner, everyone, and repeatable team shares", () => {
    const fd = buildPublishFormData({
      archive: Buffer.from("archive"),
      name: "demo",
      version: "1.2.3",
      ownerTeam: "platform",
      visibility: { everyone: true, teams: splitTeams(["platform,data", "platform"]) },
      message: "release",
    });

    expect(fd.get("action")).toBe("publish");
    expect(fd.get("everyone")).toBe("true");
    expect(fd.get("version")).toBe("1.2.3");
    expect(fd.get("owner_team")).toBe("platform");
    expect(fd.getAll("team")).toEqual(["platform", "data"]);
    expect(fd.get("message")).toBe("release");
    expect(fd.get("file")).toBeInstanceOf(File);
  });
});

describe("skills push version resolution", () => {
  const existing: RegistryInfo = { exists: true, id: "skill-1", currentVersion: "1.2.3", versions: ["1.2.3"] };
  const missing: RegistryInfo = { exists: false, id: null, currentVersion: null, versions: [] };

  it("uses an explicit CLI version before bump, metadata, or legacy values", () => {
    expect(
      resolvePushVersion({
        setVersion: "9.0.0",
        bump: "minor",
        metadataVersion: "2.0.0",
        legacyVersion: "1.0.0",
        registry: existing,
      }),
    ).toBe("9.0.0");
  });

  it("uses an explicit bump before manifest-derived versions", () => {
    expect(
      resolvePushVersion({
        bump: "minor",
        metadataVersion: "2.0.0",
        legacyVersion: "1.0.0",
        registry: existing,
      }),
    ).toBe("1.3.0");
  });

  it("falls back through metadata, legacy, auto-patch, then new-skill default", () => {
    expect(resolvePushVersion({ metadataVersion: "2.0.0", legacyVersion: "1.0.0", registry: existing })).toBe("2.0.0");
    expect(resolvePushVersion({ legacyVersion: "1.0.0", registry: existing })).toBe("1.0.0");
    expect(resolvePushVersion({ registry: existing })).toBe("1.2.4");
    expect(resolvePushVersion({ registry: missing })).toBe("1.0.0");
  });

  it("treats Companion metadata on an existing published package as provenance", () => {
    expect(
      resolvePushVersion({
        metadataVersion: "1.2.3",
        metadataSkillId: "skill-1",
        registry: existing,
      }),
    ).toBe("1.2.4");
  });
});

describe("skills status drift classification", () => {
  it("keeps a freshly pushed package up-to-date after local normalization matches the registry", () => {
    const locked = {
      name: "demo",
      pinned: null,
      resolved: "1.0.0",
      checksum: "sha256:server-normalized",
    } as LockedSkill;
    const registry = {
      exists: true,
      id: "skill-1",
      currentVersion: "1.0.0",
      versions: ["1.0.0"],
      row: { checksum: "sha256:server-normalized" },
    } as RegistryInfo;

    expect(classify(locked, "sha256:server-normalized", registry, "1.0.0")).toBe("up-to-date");
  });
});
