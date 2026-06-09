import { describe, expect, it } from "vitest";
import { extractArchiveFiles } from "../src/index";
import { VALID_SKILL_MD, buildTar } from "./helpers";

describe("extractArchiveFiles — happy path", () => {
  it("returns text content for allowlisted files and excludes directories", async () => {
    const tar = await buildTar([
      { name: "scripts", type: "directory" },
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "scripts/extract.py", content: "print('hi')\n" },
      { name: "data/config.json", content: '{"a":1}\n' },
    ]);
    const res = await extractArchiveFiles(tar);
    expect(res.violations).toEqual([]);
    expect(res.oversize).toBe(false);
    // Directories are excluded; only the 3 files remain.
    expect(res.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "data/config.json",
      "scripts/extract.py",
    ]);
    const py = res.files.find((f) => f.path === "scripts/extract.py");
    expect(py?.binary).toBe(false);
    expect(py?.truncated).toBe(false);
    expect(py?.content).toBe("print('hi')\n");
  });

  it("sorts files deterministically by path ascending", async () => {
    const tar = await buildTar([
      { name: "z.txt", content: "z" },
      { name: "a.txt", content: "a" },
      { name: "m/b.txt", content: "b" },
      { name: "m/a.txt", content: "a" },
      { name: "SKILL.md", content: VALID_SKILL_MD },
    ]);
    const res = await extractArchiveFiles(tar);
    expect(res.files.map((f) => f.path)).toEqual([
      "SKILL.md",
      "a.txt",
      "m/a.txt",
      "m/b.txt",
      "z.txt",
    ]);
  });
});

describe("extractArchiveFiles — adversarial / safety", () => {
  it("rejects a path-traversal entry without including it", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "../evil.sh", content: "rm -rf /\n" },
    ]);
    const res = await extractArchiveFiles(tar);
    expect(res.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(res.violations.some((v) => /path traversal/.test(v))).toBe(true);
  });

  it("rejects an absolute-path entry", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "/etc/cron.d/evil", content: "* * * * * root sh\n" },
    ]);
    const res = await extractArchiveFiles(tar);
    expect(res.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(res.violations.some((v) => /absolute path/.test(v))).toBe(true);
  });

  it("rejects a symlink entry", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "assets/model", type: "symlink", linkname: "/usr/share/tessdata" },
    ]);
    const res = await extractArchiveFiles(tar);
    expect(res.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(res.violations.some((v) => /symlink\/hardlink rejected/.test(v))).toBe(true);
  });

  it("rejects a hardlink entry", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "dup", type: "link", linkname: "SKILL.md" },
    ]);
    const res = await extractArchiveFiles(tar);
    expect(res.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(res.violations.some((v) => /symlink\/hardlink rejected/.test(v))).toBe(true);
  });
});

describe("extractArchiveFiles — binary detection", () => {
  it("treats non-allowlisted extensions as binary (content null, never decoded)", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "logo.png", content: "not-really-a-png-but-bin-ext" },
    ]);
    const res = await extractArchiveFiles(tar);
    const png = res.files.find((f) => f.path === "logo.png");
    expect(png?.binary).toBe(true);
    expect(png?.content).toBeNull();
    expect(png?.truncated).toBe(false);
    expect(png?.size).toBeGreaterThan(0);
  });

  it("downgrades an allowlisted file containing a NUL byte to binary", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "notes.txt", content: "hello\0world" },
    ]);
    const res = await extractArchiveFiles(tar);
    const txt = res.files.find((f) => f.path === "notes.txt");
    expect(txt?.binary).toBe(true);
    expect(txt?.content).toBeNull();
  });
});

describe("extractArchiveFiles — dotfiles & exclusions", () => {
  it("treats leading-dot files like .gitignore / .env as text", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: ".gitignore", content: "uploads/\n" },
      { name: ".env", content: "KEY=value\n" },
    ]);
    const res = await extractArchiveFiles(tar);
    const gi = res.files.find((f) => f.path === ".gitignore");
    expect(gi?.binary).toBe(false);
    expect(gi?.content).toBe("uploads/\n");
    const env = res.files.find((f) => f.path === ".env");
    expect(env?.binary).toBe(false);
    expect(env?.content).toBe("KEY=value\n");
  });

  it("skips packaging junk (.DS_Store, node_modules, __pycache__, *.pyc)", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: ".DS_Store", content: "macjunk" },
      { name: "node_modules/dep/index.js", content: "x" },
      { name: "scripts/__pycache__/m.cpython-311.pyc", content: "y" },
      { name: "scripts/run.py", content: "print(1)\n" },
    ]);
    const res = await extractArchiveFiles(tar);
    expect(res.files.map((f) => f.path)).toEqual(["SKILL.md", "scripts/run.py"]);
  });
});

describe("extractArchiveFiles — size caps", () => {
  it("truncates oversize text content and sets truncated true", async () => {
    const big = "a".repeat(300 * 1024); // > 256 KB display cap, < 10 MB file cap
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "big.txt", content: big },
    ]);
    const res = await extractArchiveFiles(tar);
    const txt = res.files.find((f) => f.path === "big.txt");
    expect(txt?.binary).toBe(false);
    expect(txt?.truncated).toBe(true);
    expect(txt?.content?.length).toBe(256 * 1024);
    expect(txt?.size).toBe(big.length);
    expect(res.oversize).toBe(false); // 300 KB is under the per-file/total caps
  });

  it("respects a smaller maxFileBytes display cap", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "doc.txt", content: "0123456789" },
    ]);
    const res = await extractArchiveFiles(tar, { maxFileBytes: 4 });
    const txt = res.files.find((f) => f.path === "doc.txt");
    expect(txt?.content).toBe("0123");
    expect(txt?.truncated).toBe(true);
  });

  it("flags oversize when an entry exceeds the per-file cap", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "huge.bin", content: " ".repeat(11 * 1024 * 1024) }, // > MAX_FILE_BYTES (10 MB)
    ]);
    const res = await extractArchiveFiles(tar);
    expect(res.oversize).toBe(true);
  });
});
