import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "../src/frontmatter";
import { buildNormalizedSkillMd } from "../src/manifest";
import { prepareSkillDirForPublish, validateSkillDir } from "../src/index";
import { makeSkillDir, skillMd } from "./helpers";

const REQUIREMENTS_FRONTMATTER = `name: vibe-generate-image
description: Generate images with Azure OpenAI.
requirements:
  - key: AZURE_OPENAI_API_KEY
    type: secret
    required: true
    note: >-
      Azure OpenAI key. Ask your org admin to provision an Azure OpenAI
      resource, or create one at https://portal.azure.com.
  - key: AZURE_OPENAI_ENDPOINT
    type: env
    required: false
    note: Defaults to the shared gateway when unset.`;

describe("requirements frontmatter", () => {
  it("parses a requirements list and applies per-entry defaults", () => {
    const parsed = parseFrontmatter(skillMd(REQUIREMENTS_FRONTMATTER));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.requirements).toEqual([
      {
        key: "AZURE_OPENAI_API_KEY",
        type: "secret",
        required: true,
        note: "Azure OpenAI key. Ask your org admin to provision an Azure OpenAI resource, or create one at https://portal.azure.com.",
      },
      {
        key: "AZURE_OPENAI_ENDPOINT",
        type: "env",
        required: false,
        note: "Defaults to the shared gateway when unset.",
      },
    ]);
    expect(parsed.warnings.find((w) => w.field === "requirements")?.code).toBe("legacy-requirements");
  });

  it("applies defaults when only a key is declared", () => {
    const parsed = parseFrontmatter(
      skillMd("name: s\ndescription: A skill.\nrequirements:\n  - key: SOME_TOKEN"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.requirements).toEqual([{ key: "SOME_TOKEN", type: "secret", required: true, note: "" }]);
  });

  it("rejects duplicate requirement keys", () => {
    const parsed = parseFrontmatter(
      skillMd("name: s\ndescription: A skill.\nrequirements:\n  - key: DUP\n  - key: DUP"),
    );
    expect(parsed.ok).toBe(false);
  });

  it("rejects keys that are not environment-variable-like", () => {
    const parsed = parseFrontmatter(
      skillMd('name: s\ndescription: A skill.\nrequirements:\n  - key: "not a var"'),
    );
    expect(parsed.ok).toBe(false);
  });

  it("validates a skill that declares requirements", async () => {
    const dir = await makeSkillDir({ "SKILL.md": skillMd(REQUIREMENTS_FRONTMATTER) });
    const res = await validateSkillDir(dir);
    expect(res.ok).toBe(true);
    expect(res.frontmatter?.requirements).toHaveLength(2);
  });

  it("preserves the requirements block through canonical packaging", async () => {
    const dir = await makeSkillDir({ "SKILL.md": skillMd(REQUIREMENTS_FRONTMATTER) });
    await prepareSkillDirForPublish(dir, { version: "1.0.0" });
    const written = await readFile(join(dir, "SKILL.md"), "utf8");
    const companionJson = JSON.parse(await readFile(join(dir, "companion.json"), "utf8")) as {
      environment: {
        env: Record<string, unknown>;
        secrets: Record<string, unknown>;
      };
    };
    const reparsed = parseFrontmatter(written);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.data.requirements).toEqual([]);
    expect(Object.keys(companionJson.environment.secrets)).toEqual(["AZURE_OPENAI_API_KEY"]);
    expect(Object.keys(companionJson.environment.env)).toEqual(["AZURE_OPENAI_ENDPOINT"]);
  });

  it("omits requirements from the canonical SKILL.md", () => {
    const parsed = parseFrontmatter(
      skillMd("name: s\ndescription: A skill.\nrequirements:\n  - key: ZEBRA_TOKEN\n  - key: ALPHA_TOKEN"),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const md = buildNormalizedSkillMd(parsed.data, "# body\n");
    expect(md).not.toContain("requirements:");
    expect(md).not.toContain("ALPHA_TOKEN");
  });

  it("omits requirements from the canonical SKILL.md when none are declared", () => {
    const parsed = parseFrontmatter(skillMd("name: s\ndescription: A skill."));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const md = buildNormalizedSkillMd(parsed.data, "# body\n");
    expect(md).not.toContain("requirements:");
  });
});
