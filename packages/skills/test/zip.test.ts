import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { isZip, zipToTar, unzipToDir, tarGzToZip, validateSkillArchive, packDir } from "../src/index";

const SKILL_MD = `---
name: zip-demo
description: A demo skill packaged as a zip.
metadata:
  companion_version: "1.2.3"
allowed-tools: read_file
---

# What it does

Demonstrates zip ingestion.
`;

function buildZip(files: Record<string, string>): Buffer {
  const entries: Record<string, Uint8Array> = {};
  for (const [k, v] of Object.entries(files)) entries[k] = new TextEncoder().encode(v);
  return Buffer.from(zipSync(entries));
}

describe("zip support", () => {
  it("detects PKZIP magic", () => {
    expect(isZip(buildZip({ "SKILL.md": SKILL_MD }))).toBe(true);
    expect(isZip(Buffer.from(zipSync({})))).toBe(true); // empty-archive EOCD (PK\x05\x06)
    expect(isZip(Buffer.from([0x1f, 0x8b, 0x00, 0x00]))).toBe(false); // gzip
  });

  it("validates a skill delivered as a zip", async () => {
    const zip = buildZip({ "SKILL.md": SKILL_MD, "reference.md": "# ref" });
    const result = await validateSkillArchive(zip);
    expect(result.ok).toBe(true);
    expect(result.frontmatter?.name).toBe("zip-demo");
    expect(result.frontmatter?.metadata.companion_version).toBe("1.2.3");
  });

  it("fails validation when SKILL.md is missing from the zip", async () => {
    const zip = buildZip({ "notes.md": "# nope" });
    const result = await validateSkillArchive(zip);
    expect(result.ok).toBe(false);
  });

  it("converts a zip to a tar that round-trips through validate", async () => {
    const zip = buildZip({ "SKILL.md": SKILL_MD });
    const tar = await zipToTar(zip);
    expect(isZip(tar)).toBe(false);
    const result = await validateSkillArchive(tar);
    expect(result.ok).toBe(true);
  });

  it("unzips to disk and is packable into a canonical archive", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zip-test-"));
    try {
      const zip = buildZip({ "SKILL.md": SKILL_MD });
      const written = await unzipToDir(zip, dir);
      expect(written.length).toBe(1);
      expect(await readFile(join(dir, "SKILL.md"), "utf8")).toContain("zip-demo");
      const packed = await packDir(dir);
      expect(packed.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("repackages a canonical tar.gz into a readable zip", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zip-test-"));
    try {
      const zip = buildZip({ "SKILL.md": SKILL_MD });
      await unzipToDir(zip, dir);
      const packed = await packDir(dir);
      const outZip = await tarGzToZip(packed.archive);
      expect(isZip(outZip)).toBe(true);
      const back = unzipSync(outZip);
      expect(new TextDecoder().decode(back["SKILL.md"])).toContain("zip-demo");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a zip whose entry traverses out of the package root", async () => {
    const zip = buildZip({ "../evil.sh": "rm -rf /" });
    const dir = await mkdtemp(join(tmpdir(), "zip-test-"));
    try {
      await expect(unzipToDir(zip, dir)).rejects.toThrow(/traversal/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("validation flags a zip that smuggles a traversal entry alongside a valid SKILL.md", async () => {
    // The unsafe entry must NOT be silently dropped — validation must report the package as invalid.
    const zip = buildZip({ "SKILL.md": SKILL_MD, "../evil.sh": "rm -rf /" });
    const result = await validateSkillArchive(zip);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.id === "traversal")?.status).toBe("fail");
  });

  it("rejects a zip whose entry exceeds the per-file size cap", async () => {
    const big = new Uint8Array(11 * 1024 * 1024); // > MAX_FILE_BYTES (10 MB)
    const zip = Buffer.from(zipSync({ "SKILL.md": new TextEncoder().encode(SKILL_MD), "big.bin": big }));
    const result = await validateSkillArchive(zip);
    expect(result.ok).toBe(false);
  });

  it("rejects a zip whose entries exceed the total-size cap", async () => {
    const chunk = new Uint8Array(9 * 1024 * 1024); // 3 x 9 MB = 27 MB > MAX_ARCHIVE_BYTES (25 MB)
    const zip = Buffer.from(zipSync({ "a.bin": chunk, "b.bin": chunk, "c.bin": chunk }, { level: 0 }));
    await expect(zipToTar(zip)).rejects.toThrow("archive exceeds size limit");
  });

  it("rejects a zip entry whose name normalizes to an empty path", async () => {
    const zip = buildZip({ "SKILL.md": SKILL_MD, ".": "x" });
    const dir = await mkdtemp(join(tmpdir(), "zip-test-"));
    try {
      await expect(unzipToDir(zip, dir)).rejects.toThrow(/traversal/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects a zip exceeding the entry-count cap", async () => {
    const entries: Record<string, Uint8Array> = {};
    for (let i = 0; i < 2001; i++) entries[`f${i}.txt`] = new Uint8Array(0); // > MAX_ENTRY_COUNT (2000)
    const zip = Buffer.from(zipSync(entries));
    const result = await validateSkillArchive(zip);
    expect(result.ok).toBe(false);
  });
});
