import { describe, expect, it } from "vitest";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPANION_MANIFEST_SCHEMA_URL, type ValidationCheck, type ValidationCheckId } from "@companion/contracts";
import {
  packDir,
  prepareSkillDirForPublish,
  unpackTo,
  validateSkillArchive,
  validateSkillDir,
} from "../src/index";
import { VALID_SKILL_MD, buildTar, makeSkillDir, mkTmpDir, skillMd } from "./helpers";

function check(checks: ValidationCheck[], id: ValidationCheckId) {
  return checks.find((c) => c.id === id);
}

describe("validateSkillDir — golden path", () => {
  it("accepts a well-formed skill", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": VALID_SKILL_MD,
      "scripts/extract.py": "print('hi')\n",
      "references/notes.md": "notes\n",
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(true);
    expect(res.checks.every((c) => c.status === "pass")).toBe(true);
    expect(res.frontmatter?.name).toBe("pdf-extract");
    expect(res.frontmatter?.allowedTools).toEqual(["read_file", "run_python"]);
    expect(res.frontmatter?.compatibility).toBe("claude-code codex");
    expect(res.frontmatter?.metadata.companion_version).toBe("2.3.1");
  });
});

describe("validateSkillDir — allowed-tools", () => {
  it("accepts official `allowed-tools` as a space-separated string", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd(
        'name: vibe-publish\ndescription: A skill.\nallowed-tools: "Bash WebFetch mcp__github__create_pr"',
      ),
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(true);
    expect(check(res.checks, "tools")?.status).toBe("pass");
    expect(res.frontmatter?.allowedTools).toEqual(["Bash", "WebFetch", "mcp__github__create_pr"]);
  });

  it("canonicalizes comma-separated `allowed-tools` strings", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd(
        'name: cmd\ndescription: A skill.\nallowed-tools: "Read, Write, Edit"',
      ),
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(true);
    expect(res.frontmatter?.allowedTools).toEqual(["Read", "Write", "Edit"]);
  });

  it("accepts scoped tool tokens and rejects unsafe tool tokens", async () => {
    const valid = await makeSkillDir({
      "SKILL.md": skillMd(
        'name: scoped-tools\ndescription: A skill.\nallowed-tools: "Bash(git status:*) mcp__github__create_pr Read"',
      ),
    });
    const validRes = await validateSkillDir(valid);
    expect(validRes.ok).toBe(true);
    expect(validRes.frontmatter?.allowedTools).toEqual(["Bash(git status:*)", "mcp__github__create_pr", "Read"]);

    const invalid = await makeSkillDir({
      "SKILL.md": skillMd('name: unsafe-tools\ndescription: A skill.\nallowed-tools: "read_file;rm ../../tool"'),
    });
    const invalidRes = await validateSkillDir(invalid);
    expect(invalidRes.ok).toBe(false);
    expect(check(invalidRes.checks, "tools")?.status).toBe("fail");
  });

  it("fails when `allowed-tools` is not the official string shape", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd(
        "name: cmd\ndescription: A skill.\nallowed-tools:\n  - Read\n  - Write",
      ),
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "frontmatter")?.status).toBe("fail");
  });

  it("warns and migrates legacy `tools` when `allowed-tools` is absent", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd(
        "name: cmd\ndescription: A skill.\ntools:\n  - read_file\n  - run_python",
      ),
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(true);
    expect(check(res.checks, "legacy")?.status).toBe("warn");
    expect(res.frontmatter?.allowedTools).toEqual(["read_file", "run_python"]);
  });
});

describe("validateSkillDir — companion.json", () => {
  it("uses companion.json as the effective manifest", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd(
        "name: manifest-skill\ndescription: Frontmatter fallback.\nrequirements:\n  - key: LEGACY_TOKEN",
      ),
      "companion.json": JSON.stringify({
        display: {
          name: "Manifest skill",
          summary: "Manifest summary.",
          description: "Manifest long description.",
        },
        requirements: [{ key: "MANIFEST_TOKEN", type: "secret", required: true, note: "Ask an admin." }],
        dependencies: ["markdown-report"],
      }),
    });

    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(true);
    expect(check(res.checks, "companion")?.status).toBe("pass");
    expect(res.companion_manifest_path).toBe("companion.json");
    expect(res.companion_manifest?.display.summary).toBe("Manifest summary.");
    expect(res.companion_manifest?.requirements.map((r) => r.key)).toEqual(["MANIFEST_TOKEN"]);
    expect(res.companion_manifest?.dependencies).toEqual({});
    expect(res.companion_manifest?.legacyDependencySlugs).toEqual(["markdown-report"]);
    expect(res.warnings?.some((w) => w.code === "legacy-requirements")).toBe(true);
  });

  it("synthesizes a manifest when companion.json is absent", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: legacy-req\ndescription: Legacy fallback.\nrequirements:\n  - key: LEGACY_TOKEN"),
    });

    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(true);
    expect(res.companion_manifest_path).toBeNull();
    expect(res.companion_manifest?.display.summary).toBe("Legacy fallback.");
    expect(res.companion_manifest?.requirements.map((r) => r.key)).toEqual(["LEGACY_TOKEN"]);
  });

  it("fails validation when companion.json is invalid", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: bad-manifest\ndescription: A skill."),
      "companion.json": JSON.stringify({ dependencies: ["Bad Slug"] }),
    });

    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "companion")?.status).toBe("fail");
  });

  it("fails validation when companion.json is empty", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: empty-manifest\ndescription: A skill."),
      "companion.json": "",
    });

    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "companion")?.status).toBe("fail");
  });

  it("fails validation when companion.json is over the manifest read cap", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: huge-manifest\ndescription: A skill."),
      "companion.json": Buffer.alloc(1024 * 1024 + 1, "{").toString(),
    });

    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "companion")?.status).toBe("fail");
    expect(check(res.checks, "size")?.status).toBe("pass");
  });
});

describe("validateSkillArchive — companion.json", () => {
  it("reads companion.json next to a root SKILL.md", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: skillMd("name: root-manifest\ndescription: Root fallback.") },
      {
        name: "companion.json",
        content: JSON.stringify({ display: { summary: "Root manifest." }, dependencies: ["markdown-report"] }),
      },
    ]);

    const res = await validateSkillArchive(tar);
    expect(res.ok).toBe(true);
    expect(res.companion_manifest_path).toBe("companion.json");
    expect(res.companion_manifest?.display.summary).toBe("Root manifest.");
    expect(res.companion_manifest?.dependencies).toEqual({});
    expect(res.companion_manifest?.legacyDependencySlugs).toEqual(["markdown-report"]);
  });

  it("ignores companion.json files outside the selected package root", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: skillMd("name: root-skill\ndescription: Root fallback.") },
      {
        name: "nested/companion.json",
        content: JSON.stringify({ display: { summary: "Wrong manifest." }, dependencies: ["nested-dep"] }),
      },
    ]);

    const res = await validateSkillArchive(tar);
    expect(res.ok).toBe(true);
    expect(res.companion_manifest_path).toBeNull();
    expect(res.companion_manifest?.display.summary).toBe("Root fallback.");
    expect(res.companion_manifest?.dependencies).toEqual({});
  });

  it("uses the wrapped companion.json when the selected SKILL.md is wrapped", async () => {
    const tar = await buildTar([
      { name: "wrapped-skill/SKILL.md", content: skillMd("name: wrapped-skill\ndescription: Wrapped fallback.") },
      {
        name: "wrapped-skill/companion.json",
        content: JSON.stringify({ display: { summary: "Wrapped manifest." }, dependencies: ["wrapped-dep"] }),
      },
    ]);

    const res = await validateSkillArchive(tar);
    expect(res.ok).toBe(true);
    expect(res.companion_manifest_path).toBe("wrapped-skill/companion.json");
    expect(res.companion_manifest?.display.summary).toBe("Wrapped manifest.");
    expect(res.companion_manifest?.dependencies).toEqual({});
    expect(res.companion_manifest?.legacyDependencySlugs).toEqual(["wrapped-dep"]);
  });

  it("fails validation for an invalid companion.json next to the selected SKILL.md", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: skillMd("name: invalid-manifest\ndescription: Root fallback.") },
      { name: "companion.json", content: JSON.stringify({ dependencies: ["Not A Slug"] }) },
    ]);

    const res = await validateSkillArchive(tar);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "companion")?.status).toBe("fail");
  });

  it("fails validation for an empty companion.json next to the selected SKILL.md", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: skillMd("name: empty-manifest\ndescription: Root fallback.") },
      { name: "companion.json", content: "" },
    ]);

    const res = await validateSkillArchive(tar);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "companion")?.status).toBe("fail");
  });

  it("fails validation for an oversized companion.json next to the selected SKILL.md", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: skillMd("name: huge-manifest\ndescription: Root fallback.") },
      { name: "companion.json", content: Buffer.alloc(1024 * 1024 + 1, "{") },
    ]);

    const res = await validateSkillArchive(tar);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "companion")?.status).toBe("fail");
    expect(check(res.checks, "size")?.status).toBe("pass");
  });
});

describe("packDir — determinism & integrity", () => {
  it("produces a stable checksum across repeated packs", async () => {
    const dir = await makeSkillDir({ "SKILL.md": VALID_SKILL_MD, "scripts/x.py": "x\n" });
    const a = await packDir(dir);
    const b = await packDir(dir);
    expect(a.checksum).toBe(b.checksum);
    expect(a.checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.tar.equals(b.tar)).toBe(true);
  });

  it("round-trips through unpackTo", async () => {
    const dir = await makeSkillDir({ "SKILL.md": VALID_SKILL_MD, "scripts/x.py": "print(1)\n" });
    const packed = await packDir(dir);
    const out = await mkTmpDir();
    await unpackTo(packed.archive, out);
    const restored = await readFile(join(out, "SKILL.md"), "utf8");
    expect(restored).toBe(VALID_SKILL_MD);
  });

  it("validates a packed archive (tar.gz) the same as the dir", async () => {
    const dir = await makeSkillDir({ "SKILL.md": VALID_SKILL_MD });
    const packed = await packDir(dir);
    const res = await validateSkillArchive(packed.archive);
    expect(res.ok).toBe(true);
  });

  it("refuses to pack a directory without SKILL.md", async () => {
    const dir = await makeSkillDir({ "README.md": "no manifest\n" });
    await expect(packDir(dir)).rejects.toThrow(/SKILL.md not found/);
  });
});

describe("prepareSkillDirForPublish", () => {
  it("rewrites SKILL.md without Companion metadata and writes companion.json identity", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd(
        "name: legacy-publish\ndescription: Legacy package.\nversion: 1.2.3\ntools:\n  - read_file",
        "# Body\n",
      ),
    });
    const prepared = await prepareSkillDirForPublish(dir, {
      skillId: "84d8bee1-5ad3-4676-8c16-730e2a15ba70",
      version: "2.0.0",
    });
    const rewritten = await readFile(join(prepared.rootDir, "SKILL.md"), "utf8");
    const companionJson = JSON.parse(await readFile(join(prepared.rootDir, "companion.json"), "utf8")) as {
      version: string;
      metadata: { companionSkillId?: string };
    };
    expect(rewritten).not.toContain("companion_skill_id");
    expect(rewritten).not.toContain("companion_version");
    expect(companionJson.version).toBe("2.0.0");
    expect(companionJson.metadata.companionSkillId).toBe("84d8bee1-5ad3-4676-8c16-730e2a15ba70");
    expect(rewritten).toContain("allowed-tools: read_file");
    expect(rewritten).not.toMatch(/^version:/m);
    expect(rewritten).not.toMatch(/^scope:/m);
    expect(rewritten).not.toMatch(/^tools:/m);
    expect(prepared.warnings.map((w) => w.field).sort()).toEqual(["tools", "version"]);
  });

  it("preserves complete manifest v2 fields through canonical packaging", async () => {
    const uploadedChangelog = [{ version: "1.1.0", date: "2026-06-20", changes: ["Add manifest v2 metadata."] }];
    const commands = [{ name: "Review package", desc: "Inspect and publish the package safely." }];
    const checks = { updates: { runtime: "python" as const, script: "scripts/check_updates.py", timeoutSeconds: 30 } };
    const environment = {
      env: { OPENAI_BASE_URL: { required: false, description: "Optional gateway." } },
      secrets: { OPENAI_API_KEY: { required: true, description: "Ask an admin." } },
    };
    const dependencies = { "markdown-report": "3e16ce8a-0d5f-4b2e-9db3-ae30d05e4bf8" };
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: manifest-v2\ndescription: Frontmatter fallback.", "# Body\n"),
      "scripts/check_updates.py": "print('ok')\n",
      "companion.json": JSON.stringify({
        $schema: COMPANION_MANIFEST_SCHEMA_URL,
        name: "manifest-v2",
        version: "1.1.0",
        title: "Manifest v2",
        description: "Uploaded manifest description.",
        notes: "## Notes\n\nKeep this package complete.",
        metadata: {
          companionSkillId: "3e16ce8a-0d5f-4b2e-9db3-ae30d05e4bf8",
          changelog: uploadedChangelog,
        },
        environment,
        dependencies,
        commands,
        checks,
      }),
    });

    const prepared = await prepareSkillDirForPublish(dir, {
      skillId: "84d8bee1-5ad3-4676-8c16-730e2a15ba70",
      version: "1.2.0",
    });
    const companionJson = JSON.parse(await readFile(join(prepared.rootDir, "companion.json"), "utf8")) as Record<
      string,
      unknown
    > & {
      metadata: { companionSkillId?: string; changelog: Array<{ version: string; changes: string[] }> };
      environment: typeof environment;
      dependencies: typeof dependencies;
      commands: typeof commands;
      checks: typeof checks;
    };

    expect(companionJson).toMatchObject({
      $schema: COMPANION_MANIFEST_SCHEMA_URL,
      name: "manifest-v2",
      version: "1.2.0",
      title: "Manifest v2",
      description: "Uploaded manifest description.",
      notes: "## Notes\n\nKeep this package complete.",
      environment,
      dependencies,
      commands,
      checks,
    });
    expect(companionJson.metadata.companionSkillId).toBe("84d8bee1-5ad3-4676-8c16-730e2a15ba70");
    expect(companionJson.metadata.changelog).toContainEqual(uploadedChangelog[0]);
    expect(companionJson.metadata.changelog).toContainEqual({
      version: "1.2.0",
      date: expect.any(String),
      changes: ["Publish version 1.2.0."],
    });
    expect(companionJson).not.toHaveProperty("display");
    expect(companionJson).not.toHaveProperty("requirements");
  });

  it("rejects a manifest update check whose script is not packaged", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: missing-check\ndescription: Missing check script."),
      "companion.json": JSON.stringify({
        $schema: COMPANION_MANIFEST_SCHEMA_URL,
        name: "missing-check",
        version: "1.0.0",
        description: "Missing check script.",
        metadata: { changelog: [{ version: "1.0.0", changes: ["Add check."] }] },
        environment: { env: {}, secrets: {} },
        dependencies: {},
        commands: [],
        checks: { updates: { runtime: "python", script: "scripts/check_updates.py", timeoutSeconds: 30 } },
      }),
    });

    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "companion")?.status).toBe("fail");
    expect(check(res.checks, "companion")?.detail).toContain("checks.updates.script not found");
  });

  it("rejects legacy top-level visibility fields on publish", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: scoped-publish\ndescription: Scoped package.\nscope: team", "# Body\n"),
    });

    await expect(
      prepareSkillDirForPublish(dir, {
        skillId: "skill-123",
        version: "2.0.0",
      }),
    ).rejects.toThrow(/must not declare visibility/);
  });

  it("accepts a single wrapper folder matching the skill name and packs from inside it", async () => {
    const dir = await makeSkillDir({
      "wrapped-skill/SKILL.md": skillMd("name: wrapped-skill\ndescription: Wrapped package."),
      "wrapped-skill/references/notes.md": "notes\n",
    });
    const prepared = await prepareSkillDirForPublish(dir, {
      skillId: "84d8bee1-5ad3-4676-8c16-730e2a15ba70",
      version: "1.0.0",
    });
    expect(prepared.rootDir.endsWith("wrapped-skill")).toBe(true);
    const packed = await packDir(prepared.rootDir);
    const out = await mkTmpDir();
    await unpackTo(packed.archive, out);
    expect(await readFile(join(out, "SKILL.md"), "utf8")).toContain("name: wrapped-skill");
    expect(await readFile(join(out, "references/notes.md"), "utf8")).toBe("notes\n");
  });

  it("ignores packaging junk outside a matching wrapper folder", async () => {
    const tar = await buildTar([
      { name: "wrapped-skill/SKILL.md", content: skillMd("name: wrapped-skill\ndescription: Wrapped package.") },
      { name: "__MACOSX/._SKILL.md", content: "junk\n" },
      { name: ".DS_Store", content: "junk\n" },
    ]);
    const res = await validateSkillArchive(tar);
    expect(res.ok).toBe(true);
    expect(check(res.checks, "layout")?.status).toBe("pass");
  });
});

describe("validateSkillArchive — adversarial", () => {
  it("rejects a path-traversal entry", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "../evil.sh", content: "rm -rf /\n" },
    ]);
    const res = await validateSkillArchive(gzipSync(tar));
    expect(res.ok).toBe(false);
    expect(check(res.checks, "traversal")?.status).toBe("fail");
  });

  it("rejects an absolute-path entry", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "/etc/cron.d/evil", content: "* * * * * root sh\n" },
    ]);
    const res = await validateSkillArchive(tar);
    expect(check(res.checks, "traversal")?.status).toBe("fail");
  });

  it("rejects non-directory entries whose normalized path is empty", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: ".", content: "root-as-file\n" },
    ]);
    const res = await validateSkillArchive(tar);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "traversal")?.status).toBe("fail");
  });

  it("rejects a symlink entry escaping the root", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "assets/model", type: "symlink", linkname: "/usr/share/tessdata" },
    ]);
    const res = await validateSkillArchive(tar);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "traversal")?.status).toBe("fail");
  });

  it("flags a zip-bomb / oversize entry", async () => {
    // 11 MB of zeros — over the 10 MB per-file cap. Gzips to a few KB.
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "big.bin", content: Buffer.alloc(11 * 1024 * 1024) },
    ]);
    const res = await validateSkillArchive(gzipSync(tar));
    expect(check(res.checks, "size")?.status).toBe("fail");
  });

  it("counts excluded packaging junk toward archive size caps", async () => {
    const tar = await buildTar([
      { name: "SKILL.md", content: VALID_SKILL_MD },
      { name: "__MACOSX/big.bin", content: Buffer.alloc(11 * 1024 * 1024) },
    ]);
    const res = await validateSkillArchive(gzipSync(tar));
    expect(check(res.checks, "size")?.status).toBe("fail");
  });
});

describe("validateSkillDir — frontmatter failures and warnings", () => {
  it("accepts a skill without a manifest version", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd(
        "name: image-ocr\ndescription: OCR scanned images to text.\nlicense: unknown",
      ),
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(true);
    expect(check(res.checks, "frontmatter")?.status).toBe("pass");
  });

  it("warns on legacy top-level version and unknown fields", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: legacy\ndescription: old\nversion: 1.2.3\nargument-hint: foo"),
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(true);
    expect(check(res.checks, "legacy")?.status).toBe("warn");
    expect(res.legacy?.version).toBe("1.2.3");
    expect(res.warnings?.map((w) => w.field).sort()).toEqual(["argument-hint", "version"]);
  });

  it("rejects legacy top-level scope or visibility", async () => {
    const scoped = await makeSkillDir({
      "SKILL.md": skillMd("name: legacy-scope\ndescription: old\nscope: team"),
    });
    const scopedRes = await validateSkillDir(scoped);
    expect(scopedRes.ok).toBe(false);
    expect(check(scopedRes.checks, "frontmatter")?.status).toBe("fail");

    const visible = await makeSkillDir({
      "SKILL.md": skillMd("name: legacy-visibility\ndescription: old\nvisibility: public"),
    });
    const visibleRes = await validateSkillDir(visible);
    expect(visibleRes.ok).toBe(false);
    expect(check(visibleRes.checks, "frontmatter")?.status).toBe("fail");
  });

  it("fails when metadata values are not strings", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: bad-meta\ndescription: bad\nmetadata:\n  count: 2"),
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "metadata")?.status).toBe("fail");
  });

  it("fails when reserved Companion version metadata is not semver", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: bad-meta-version\ndescription: bad\nmetadata:\n  companion_version: next"),
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "metadata")?.status).toBe("fail");
  });

  it("fails when legacy top-level version is not semver", async () => {
    const dir = await makeSkillDir({
      "SKILL.md": skillMd("name: bad-legacy-version\ndescription: bad\nversion: 1.2"),
    });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "legacy")?.status).toBe("fail");
  });

  it("fails when SKILL.md has no frontmatter block", async () => {
    const dir = await makeSkillDir({ "SKILL.md": "# just markdown, no frontmatter\n" });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(false);
    expect(check(res.checks, "frontmatter")?.status).toBe("fail");
  });
});
