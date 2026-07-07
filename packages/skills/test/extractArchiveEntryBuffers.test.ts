import { describe, expect, it } from "vitest";
import { extractArchiveEntryBuffers } from "../src/index";
import { VALID_SKILL_MD, buildTar } from "./helpers";

describe("extractArchiveEntryBuffers — deploy-path extraction", () => {
  it("returns full bytes for every file (binary included) with executable bits", async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "scripts/run.py", content: "#!/usr/bin/env python3\nprint('hi')\n", mode: 0o755 },
      { name: "references/logo.png", content: png },
    ]);
    const res = await extractArchiveEntryBuffers(tar);
    expect(res.violations).toEqual([]);
    expect(res.oversize).toBe(false);
    expect(res.files.map((f) => f.path)).toEqual(["SKILL.md", "references/logo.png", "scripts/run.py"]);
    const script = res.files.find((f) => f.path === "scripts/run.py");
    expect(script?.executable).toBe(true);
    expect(script?.data.toString("utf8")).toContain("print('hi')");
    const image = res.files.find((f) => f.path === "references/logo.png");
    expect(image?.executable).toBe(false);
    expect(image?.data.equals(png)).toBe(true);
  });

  it("keeps the traversal/symlink guards and reports violations", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "../evil.sh", content: "boom" },
      { name: "assets/model", type: "symlink", linkname: "/etc/passwd" },
    ]);
    const res = await extractArchiveEntryBuffers(tar);
    expect(res.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(res.violations.some((v) => /path traversal/.test(v))).toBe(true);
    expect(res.violations.some((v) => /symlink\/hardlink rejected/.test(v))).toBe(true);
  });

  it("skips files above the per-file deploy cap and flags oversize", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "big.bin", content: Buffer.alloc(64 * 1024, 1) },
    ]);
    const res = await extractArchiveEntryBuffers(tar, { maxFileBytes: 16 * 1024 });
    expect(res.files.map((f) => f.path)).toEqual(["SKILL.md"]);
    expect(res.oversize).toBe(true);
    expect(res.violations.some((v) => /deploy cap/.test(v))).toBe(true);
  });
});
