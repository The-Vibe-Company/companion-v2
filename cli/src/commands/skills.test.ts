import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { LockedSkill } from "@companion/contracts";
import { packDir } from "@companion/skills";
import { loadLockfile } from "../lib/lockfile";
import type { SkillListRow } from "@companion/contracts";
import {
  assertCanReplaceExistingInstall,
  buildPublishFormData,
  parseVisibilityFilter,
  resolvePushOwner,
  resolvePushVersion,
  verifyDownloadedArchive,
} from "./skills";
import { classify, type RegistryInfo } from "../lib/registry";

/** A minimal published registry row; only owner fields drive `resolvePushOwner`. */
function registryRow(over: Partial<SkillListRow> = {}): SkillListRow {
  return {
    id: "skill-1",
    org_id: "org-1",
    slug: "demo",
    description: "Demo skill",
    display: {},
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
    requirements: [],
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
    ...over,
  };
}

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

describe("skills owner helpers", () => {
  const missing: RegistryInfo = { exists: false, id: null, currentVersion: null, versions: [] };

  it("validates list visibility filters locally", () => {
    expect(parseVisibilityFilter("personal")).toBe("personal");
    expect(parseVisibilityFilter("team")).toBe("team");
    expect(parseVisibilityFilter(undefined)).toBeUndefined();
    expect(() => parseVisibilityFilter("public")).toThrow(/visibility must be one of: personal, team/);
  });

  it("resolves --private to Personal (null)", () => {
    expect(resolvePushOwner(missing, { private: true })).toBeNull();
  });

  it("resolves an explicit --owner-team to that team slug", () => {
    expect(resolvePushOwner(missing, { ownerTeam: "platform" })).toBe("platform");
    // Surrounding whitespace is trimmed.
    expect(resolvePushOwner(missing, { ownerTeam: " platform " })).toBe("platform");
  });

  it("keeps the registry's current owner when no owner flags are given", () => {
    const teamReg: RegistryInfo = {
      exists: true,
      id: "skill-1",
      currentVersion: "1.0.0",
      versions: ["1.0.0"],
      row: registryRow({ owner_kind: "team", owner_handle: "platform", owner_team_id: "team-1" }),
    };
    expect(resolvePushOwner(teamReg, {})).toBe("platform");

    const userReg: RegistryInfo = {
      exists: true,
      id: "skill-1",
      currentVersion: "1.0.0",
      versions: ["1.0.0"],
      row: registryRow({ owner_kind: "user", owner_handle: null }),
    };
    expect(resolvePushOwner(userReg, {})).toBeNull();
  });

  it("defaults new skills to Personal (null) when no owner flags are given", () => {
    expect(resolvePushOwner(missing, {})).toBeNull();
  });

  it("rejects conflicting --private and --owner-team flags", () => {
    expect(() => resolvePushOwner(missing, { private: true, ownerTeam: "platform" })).toThrow(
      /--private cannot be combined with --owner-team/,
    );
  });

  it("rejects an owner change on a re-publish (publish can't change ownership)", () => {
    const teamReg: RegistryInfo = {
      exists: true,
      id: "skill-1",
      currentVersion: "1.0.0",
      versions: ["1.0.0"],
      row: registryRow({ slug: "incident-summary", owner_kind: "team", owner_handle: "platform", owner_team_id: "team-1" }),
    };
    // --private would silently no-op server-side (owner is immutable) and mis-record the lockfile.
    expect(() => resolvePushOwner(teamReg, { private: true })).toThrow(/cannot change ownership on publish/);
    // Re-targeting to a different team is likewise rejected up front (the server would reject it too).
    expect(() => resolvePushOwner(teamReg, { ownerTeam: "data" })).toThrow(/cannot change ownership on publish/);
    // Re-publishing with the SAME team (or no flags) is allowed and keeps the current owner.
    expect(resolvePushOwner(teamReg, { ownerTeam: "platform" })).toBe("platform");
    expect(resolvePushOwner(teamReg, {})).toBe("platform");
  });

  it("builds push form data with the owner team and message", () => {
    const fd = buildPublishFormData({
      archive: Buffer.from("archive"),
      name: "demo",
      version: "1.2.3",
      ownerTeam: "platform",
      message: "release",
    });

    expect(fd.get("action")).toBe("publish");
    expect(fd.get("version")).toBe("1.2.3");
    expect(fd.get("owner_team")).toBe("platform");
    expect(fd.get("message")).toBe("release");
    expect(fd.get("file")).toBeInstanceOf(File);
    // No legacy visibility fields are sent.
    expect(fd.get("everyone")).toBeNull();
    expect(fd.getAll("team")).toEqual([]);
  });

  it("omits owner_team from the form data for a Personal push", () => {
    const fd = buildPublishFormData({
      archive: Buffer.from("archive"),
      name: "demo",
      version: "1.2.3",
      ownerTeam: null,
    });
    expect(fd.get("owner_team")).toBeNull();
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
