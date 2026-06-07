import { parse as parseYaml } from "yaml";
import { skillFrontmatterSchema, type SkillFrontmatter } from "@companion/contracts";

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

export interface ExtractedFrontmatter {
  /** The raw YAML between the `---` fences (no fences), or null if absent. */
  raw: string | null;
  body: string;
}

/** Split a `SKILL.md` into its YAML frontmatter block and the markdown body. */
export function extractFrontmatter(md: string): ExtractedFrontmatter {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) return { raw: null, body: md };
  return { raw: m[1] ?? "", body: m[2] ?? "" };
}

export type ParseFrontmatterResult =
  | { ok: true; data: SkillFrontmatter; raw: string }
  | { ok: false; error: string; raw: string | null };

/**
 * Parse + validate a SKILL.md's frontmatter. YAML is parsed as plain data (no
 * custom tags, no code execution). Returns a structured result rather than throwing.
 */
export function parseFrontmatter(md: string): ParseFrontmatterResult {
  const { raw } = extractFrontmatter(md);
  if (raw === null) {
    return { ok: false, error: "SKILL.md is missing a YAML frontmatter block", raw: null };
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw, { merge: false });
  } catch (err) {
    return { ok: false, error: `frontmatter is not valid YAML: ${(err as Error).message}`, raw };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "frontmatter must be a mapping of keys to values", raw };
  }
  const result = skillFrontmatterSchema.safeParse(doc);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `frontmatter validation failed: ${issues}`, raw };
  }
  return { ok: true, data: result.data, raw };
}
