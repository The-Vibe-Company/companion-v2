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
  normalizeLabels,
  resolvePushVersion,
  verifyDownloadedArchive,
} from "./skills";
import { classify, type RegistryInfo } from "../lib/registry";

/** A minimal published registry row (every skill is org-visible; no owner axis). */
function registryRow(over: Partial<SkillListRow> = {}): SkillListRow {
  return {
    id: "skill-1",
    org_id: "org-1",
    slug: "demo",
    share_token: "share-demo",
    description: "Demo skill",
    display: {},
    notes: null,
    validation: "valid",
    validation_error: null,
    scope: "org",
    source: null,
    labels: [],
    creator_id: "user-1",
    creator_name: "User One",
    creator_initials: "UO",
    creator_avatar_url: null,
    updater_id: "user-1",
    updater_name: "User One",
    updater_initials: "UO",
    updater_avatar_url: null,
    modifiers: [],
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

describe("skills push labels", () => {
  it("dedupes, trims, and sorts repeatable --label values", () => {
    expect(normalizeLabels(["marketing/seo", " growth ", "marketing/seo", "growth"])).toEqual([
      "growth",
      "marketing/seo",
    ]);
    expect(normalizeLabels(["", "  "])).toEqual([]);
    expect(normalizeLabels(undefined)).toEqual([]);
  });

  it("builds push form data with one repeatable `label` field per path and a message", () => {
    const fd = buildPublishFormData({
      archive: Buffer.from("archive"),
      name: "demo",
      version: "1.2.3",
      labels: ["growth", "marketing/seo"],
      message: "release",
    });

    expect(fd.get("action")).toBe("publish");
    expect(fd.get("version")).toBe("1.2.3");
    expect(fd.getAll("label")).toEqual(["growth", "marketing/seo"]);
    expect(fd.get("message")).toBe("release");
    expect(fd.get("file")).toBeInstanceOf(File);
    // No legacy owner/visibility fields are sent.
    expect(fd.get("owner_team")).toBeNull();
    expect(fd.get("everyone")).toBeNull();
    expect(fd.getAll("team")).toEqual([]);
  });

  it("sends no `label` fields when the skill has no labels", () => {
    const fd = buildPublishFormData({
      archive: Buffer.from("archive"),
      name: "demo",
      version: "1.2.3",
      labels: [],
    });
    expect(fd.getAll("label")).toEqual([]);
    // The registry row fixture carries no owner axis — only labels organize a skill.
    expect(registryRow().labels).toEqual([]);
  });

  it("omits expect_* on a brand-new skill but binds them on an update", () => {
    const create = buildPublishFormData({ archive: Buffer.from("a"), name: "demo", version: "1.0.0", labels: [] });
    expect(create.get("expect_slug")).toBeNull();
    expect(create.get("expect_skill_id")).toBeNull();

    const update = buildPublishFormData({
      archive: Buffer.from("a"),
      name: "demo",
      version: "1.0.1",
      labels: [],
      expectSlug: "demo",
      expectSkillId: "skill-1",
    });
    expect(update.get("expect_slug")).toBe("demo");
    expect(update.get("expect_skill_id")).toBe("skill-1");
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
        manifestVersion: "3.0.0",
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
        manifestVersion: "3.0.0",
        metadataVersion: "2.0.0",
        legacyVersion: "1.0.0",
        registry: existing,
      }),
    ).toBe("1.3.0");
  });

  it("falls back through metadata, legacy, auto-patch, then new-skill default", () => {
    expect(
      resolvePushVersion({
        manifestVersion: "3.0.0",
        metadataVersion: "2.0.0",
        metadataSkillId: "skill-1",
        legacyVersion: "1.0.0",
        registry: existing,
      }),
    ).toBe("3.0.0");
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
