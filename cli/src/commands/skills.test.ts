import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { LockedSkill } from "@companion/contracts";
import { packDir } from "@companion/skills";
import { assertCanReplaceExistingInstall, resolvePushVersion, verifyDownloadedArchive } from "./skills";
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
