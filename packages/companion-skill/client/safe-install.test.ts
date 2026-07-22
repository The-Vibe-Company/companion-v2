import { mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inspectPublicSkillZip, installPublicSkillZip } from "./safe-install.js";

const encoder = new TextEncoder();
const SKILL_ID = "84d8bee1-5ad3-4676-8c16-730e2a15ba70";

function skillZip(body = "# Safe\n"): Uint8Array {
  return zipSync({
    "SKILL.md": encoder.encode(body),
    "companion.json": encoder.encode(JSON.stringify({
      dependencies: { required: SKILL_ID },
      environment: {
        env: {
          DEFAULT_REQUIRED_NAME: {},
          OPTIONAL_NAME: { required: false },
          PUBLIC_NAME: { required: true },
        },
        secrets: {
          API_KEY: { required: true },
          DEFAULT_REQUIRED_TOKEN: {},
          OPTIONAL_TOKEN: { required: false },
        },
      },
    })),
    "reference/readme.md": encoder.encode("Reference"),
  });
}

function patchFirstCentralMode(bytes: Uint8Array, mode: number): Uint8Array {
  const patched = Buffer.from(bytes);
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const offset = patched.indexOf(signature);
  if (offset < 0) throw new Error("test ZIP has no central entry");
  patched.writeUInt16LE((3 << 8) | 20, offset + 4);
  patched.writeUInt32LE((mode << 16) >>> 0, offset + 38);
  return patched;
}

describe("safe public skill ZIP inspection", () => {
  it("requires a root SKILL.md and reports declarations without resolving them", () => {
    const result = inspectPublicSkillZip(skillZip());
    expect(result.files.has("SKILL.md")).toBe(true);
    expect(result.prerequisites).toEqual({
      dependencies: ["required"],
      required_env: ["DEFAULT_REQUIRED_NAME", "PUBLIC_NAME"],
      optional_env: ["OPTIONAL_NAME"],
      required_secrets: ["API_KEY", "DEFAULT_REQUIRED_TOKEN"],
      optional_secrets: ["OPTIONAL_TOKEN"],
    });
    expect(() => inspectPublicSkillZip(zipSync({ "wrapped/SKILL.md": encoder.encode("x") }))).toThrow(/root/);
  });

  it("reports legacy manifest dependency and requirement shapes with schema defaults", () => {
    const bytes = zipSync({
      "SKILL.md": encoder.encode(
        "---\nname: legacy-shapes\ndescription: Legacy shapes.\nrequirements:\n  - key: IGNORED_FRONTMATTER\n---\n",
      ),
      "companion.json": encoder.encode(JSON.stringify({
        dependencies: ["alpha", { slug: "beta" }, "alpha"],
        requirements: [
          { key: "DEFAULT_SECRET" },
          { key: "REQUIRED_ENV", type: "env", required: true },
          { key: "OPTIONAL_ENV", type: "env", required: false },
          { key: "OPTIONAL_SECRET", required: false },
        ],
        environment: {
          env: { IGNORED_ENV: { required: true } },
          secrets: { IGNORED_SECRET: { required: true } },
        },
      })),
    });

    expect(inspectPublicSkillZip(bytes).prerequisites).toEqual({
      dependencies: ["alpha", "beta"],
      required_env: ["REQUIRED_ENV"],
      optional_env: ["OPTIONAL_ENV"],
      required_secrets: ["DEFAULT_SECRET"],
      optional_secrets: ["OPTIONAL_SECRET"],
    });
  });

  it("falls back to legacy SKILL.md requirements only when companion.json is absent", () => {
    const bytes = zipSync({
      "SKILL.md": encoder.encode([
        "---",
        "name: frontmatter-fallback",
        "description: Frontmatter fallback.",
        "requirements:",
        "  - key: FALLBACK_SECRET",
        "  - key: FALLBACK_ENV",
        "    type: env",
        "  - key: OPTIONAL_FALLBACK",
        "    required: false",
        "---",
        "# Fallback",
        "",
      ].join("\n")),
    });

    expect(inspectPublicSkillZip(bytes).prerequisites).toEqual({
      dependencies: [],
      required_env: ["FALLBACK_ENV"],
      optional_env: [],
      required_secrets: ["FALLBACK_SECRET"],
      optional_secrets: ["OPTIONAL_FALLBACK"],
    });
  });

  it("rejects malformed supported prerequisite declarations instead of omitting them", () => {
    const invalidManifest = zipSync({
      "SKILL.md": encoder.encode("---\nname: invalid-manifest\ndescription: Invalid.\n---\n"),
      "companion.json": encoder.encode(JSON.stringify({ dependencies: ["Not A Slug"] })),
    });
    const invalidFallback = zipSync({
      "SKILL.md": encoder.encode("---\nname: invalid-fallback\ndescription: Invalid.\nrequirements:\n  - key: invalid-key\n---\n"),
    });

    expect(() => inspectPublicSkillZip(invalidManifest)).toThrow(/companion\.json validation failed/);
    expect(() => inspectPublicSkillZip(invalidFallback)).toThrow(/frontmatter validation failed/);
  });

  it("rejects traversal, case collisions, and Unix symlinks before writing", () => {
    expect(() => inspectPublicSkillZip(zipSync({ "../escape": encoder.encode("x"), "SKILL.md": encoder.encode("x") }))).toThrow(/traversal/);
    expect(() => inspectPublicSkillZip(zipSync({ "SKILL.md": encoder.encode("x"), "skill.md": encoder.encode("y") }))).toThrow(/colliding/);
    expect(() => inspectPublicSkillZip(patchFirstCentralMode(skillZip(), 0o120777))).toThrow(/links and special/);
  });

  it.each([
    "assets/file:payload",
    "assets/NUL.txt",
    "assets/COM1",
    "assets/trailing.",
    "assets/trailing ",
  ])("rejects the Windows-unsafe entry %s before writing", (name) => {
    expect(() => inspectPublicSkillZip(zipSync({
      "SKILL.md": encoder.encode("x"),
      [name]: encoder.encode("unsafe"),
    }))).toThrow(/Windows-unsafe ZIP entry path/);
  });

  it("rejects collisions in case-insensitive Windows directory segments", () => {
    expect(() => inspectPublicSkillZip(zipSync({
      "SKILL.md": encoder.encode("x"),
      "Docs/first.md": encoder.encode("first"),
      "docs/second.md": encoder.encode("second"),
    }))).toThrow(/Windows-colliding ZIP path/);
  });

  it("rejects NFC-equivalent directory segments before writing", () => {
    expect(() => inspectPublicSkillZip(zipSync({
      "SKILL.md": encoder.encode("x"),
      "Caf\u00e9/first.md": encoder.encode("first"),
      "Cafe\u0301/second.md": encoder.encode("second"),
    }))).toThrow(/Windows-colliding ZIP path/);
  });
});

describe("atomic public skill install", () => {
  it("requires explicit replacement consent and swaps only the selected package", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "companion-public-install-"));
    const first = installPublicSkillZip({
      bytes: skillZip("# First\n"),
      slug: "safe-skill",
      tool: "codex",
      scope: "project",
      projectRoot,
      confirmInstall: true,
    });
    expect(readFileSync(join(first.destination, "SKILL.md"), "utf8")).toBe("# First\n");
    expect(first.replaced).toBe(false);

    expect(() => installPublicSkillZip({
      bytes: skillZip("# Second\n"),
      slug: "safe-skill",
      tool: "codex",
      scope: "project",
      projectRoot,
      confirmInstall: true,
    })).toThrow(/replacement confirmation/);
    expect(readFileSync(join(first.destination, "SKILL.md"), "utf8")).toBe("# First\n");

    const second = installPublicSkillZip({
      bytes: skillZip("# Second\n"),
      slug: "safe-skill",
      tool: "codex",
      scope: "project",
      projectRoot,
      confirmInstall: true,
      confirmReplace: true,
    });
    expect(second.replaced).toBe(true);
    expect(readFileSync(join(second.destination, "SKILL.md"), "utf8")).toBe("# Second\n");
    expect(readdirSync(join(projectRoot, ".codex", "skills"))).toEqual(["safe-skill"]);
  });

  it.each(["tool directory", "skills directory"])("rejects a symbolic-link %s before staging", async (kind) => {
    const projectRoot = await mkdtemp(join(tmpdir(), "companion-public-install-root-"));
    const outside = await mkdtemp(join(tmpdir(), "companion-public-install-outside-"));
    if (kind === "tool directory") {
      symlinkSync(outside, join(projectRoot, ".codex"), "dir");
    } else {
      mkdirSync(join(projectRoot, ".codex"));
      symlinkSync(outside, join(projectRoot, ".codex", "skills"), "dir");
    }

    expect(() => installPublicSkillZip({
      bytes: skillZip(),
      slug: "safe-skill",
      tool: "codex",
      scope: "project",
      projectRoot,
      confirmInstall: true,
    })).toThrow(/symbolic-link destination ancestor/);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects a symbolic-link project root and a symbolic-link destination", async () => {
    const container = await mkdtemp(join(tmpdir(), "companion-public-install-container-"));
    const realRoot = join(container, "real-project");
    const linkedRoot = join(container, "linked-project");
    mkdirSync(realRoot);
    symlinkSync(realRoot, linkedRoot, "dir");

    expect(() => installPublicSkillZip({
      bytes: skillZip(),
      slug: "safe-skill",
      tool: "codex",
      scope: "project",
      projectRoot: linkedRoot,
      confirmInstall: true,
    })).toThrow(/symbolic-link install root/);

    const destination = join(realRoot, ".codex", "skills", "safe-skill");
    const outside = join(container, "outside-skill");
    mkdirSync(join(realRoot, ".codex", "skills"), { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, destination, "dir");
    expect(() => installPublicSkillZip({
      bytes: skillZip(),
      slug: "safe-skill",
      tool: "codex",
      scope: "project",
      projectRoot: realRoot,
      confirmInstall: true,
      confirmReplace: true,
    })).toThrow(/symbolic-link destination/);
    expect(readdirSync(outside)).toEqual([]);
  });
});
