import { describe, expect, it } from "vitest";
import { extractArchiveFileContent, extractArchiveFiles } from "../src/index";
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
    expect(png?.preview_kind).toBe("unsupported");
    expect(png?.content_type).toBeNull();
  });

  it("marks browser-native binary files previewable only when their signature matches", async () => {
    const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "valid.png", content: validPng },
      { name: "fake.pdf", content: "not a pdf" },
    ]);
    const res = await extractArchiveFiles(tar);
    expect(res.files.find((f) => f.path === "valid.png")).toMatchObject({
      binary: true,
      content: null,
      preview_kind: "image",
      content_type: "image/png",
    });
    expect(res.files.find((f) => f.path === "fake.pdf")).toMatchObject({
      binary: true,
      content: null,
      preview_kind: "unsupported",
      content_type: null,
    });
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

describe("extractArchiveFileContent", () => {
  it("extracts browser-native image, PDF, SVG, and JSON files by path", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "assets/logo.png", content: png },
      { name: "reference/demo.pdf", content: Buffer.from("%PDF-1.4\n") },
      { name: "assets/icon.svg", content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' },
      { name: "companion.json", content: '{"name":"demo"}\n' },
    ]);

    const image = await extractArchiveFileContent(tar, "assets/logo.png");
    expect(image).toMatchObject({ status: "ok", preview_kind: "image", content_type: "image/png" });
    if (image.status === "ok") expect(image.bytes.equals(png)).toBe(true);

    await expect(extractArchiveFileContent(tar, "reference/demo.pdf")).resolves.toMatchObject({
      status: "ok",
      preview_kind: "pdf",
      content_type: "application/pdf",
    });
    await expect(extractArchiveFileContent(tar, "assets/icon.svg")).resolves.toMatchObject({
      status: "ok",
      preview_kind: "image",
      content_type: "image/svg+xml",
    });
    await expect(extractArchiveFileContent(tar, "companion.json")).resolves.toMatchObject({
      status: "ok",
      preview_kind: "text",
      content_type: "application/json; charset=utf-8",
    });
  });

  it("rejects traversal, symlink targets, missing files, unsupported types, and oversized entries", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "assets/link.png", type: "symlink", linkname: "real.png" },
      { name: "archive.bin", content: Buffer.from([1, 2, 3]) },
    ]);
    const hugeTar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "huge.pdf", content: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(11 * 1024 * 1024)]) },
    ]);

    await expect(extractArchiveFileContent(tar, "../evil.pdf")).resolves.toMatchObject({ status: "invalid_path" });
    await expect(extractArchiveFileContent(tar, "assets/link.png")).resolves.toMatchObject({ status: "not_found" });
    await expect(extractArchiveFileContent(tar, "missing.pdf")).resolves.toMatchObject({ status: "not_found" });
    await expect(extractArchiveFileContent(tar, "archive.bin")).resolves.toMatchObject({ status: "unsupported" });
    await expect(extractArchiveFileContent(hugeTar, "huge.pdf")).resolves.toMatchObject({ status: "oversize" });
  });

  it("rejects files whose bytes do not match their previewable extension", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "fake.png", content: "not a png" },
      { name: "fake.pdf", content: "not a pdf" },
    ]);

    await expect(extractArchiveFileContent(tar, "fake.png")).resolves.toMatchObject({ status: "unsupported" });
    await expect(extractArchiveFileContent(tar, "fake.pdf")).resolves.toMatchObject({ status: "unsupported" });
  });
});
