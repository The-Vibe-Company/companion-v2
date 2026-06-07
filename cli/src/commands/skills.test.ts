import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { LockedSkill } from "@companion/contracts";
import { packDir } from "@companion/skills";
import { assertCanReplaceExistingInstall, verifyDownloadedArchive } from "./skills";

async function withSkillDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "companion-cli-test-"));
  try {
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: demo\nversion: 1.0.0\ndescription: Demo skill\n---\n",
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
