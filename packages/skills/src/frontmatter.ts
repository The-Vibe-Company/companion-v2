import { parse as parseYaml } from "yaml";
import {
  AGENT_SKILL_FRONTMATTER_KEYS,
  skillFrontmatterSchema,
  type FrontmatterWarning,
  type SkillFrontmatter,
  type SkillLegacyFrontmatter,
} from "@companion/contracts";

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;
const OFFICIAL_KEYS = new Set<string>(AGENT_SKILL_FRONTMATTER_KEYS);

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
  | {
      ok: true;
      data: SkillFrontmatter;
      raw: string;
      body: string;
      warnings: FrontmatterWarning[];
      legacy: SkillLegacyFrontmatter;
    }
  | { ok: false; error: string; raw: string | null; body: string; warnings: FrontmatterWarning[]; legacy: SkillLegacyFrontmatter };

function stringifyScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function normalizeLegacyTools(value: unknown): string[] | undefined {
  if (typeof value === "string") {
    return value.split(/[,\s]+/).map((tool) => tool.trim()).filter(Boolean);
  }
  if (!Array.isArray(value)) return undefined;
  const tools = value.map((tool) => stringifyScalar(tool)).filter((tool): tool is string => !!tool?.trim());
  return tools.length ? tools : undefined;
}

function analyzeLegacyFields(doc: Record<string, unknown>): {
  normalized: Record<string, unknown>;
  warnings: FrontmatterWarning[];
  legacy: SkillLegacyFrontmatter;
} {
  const normalized: Record<string, unknown> = {};
  for (const key of AGENT_SKILL_FRONTMATTER_KEYS) {
    if (doc[key] !== undefined) normalized[key] = doc[key];
  }

  const legacy: SkillLegacyFrontmatter = {
    version: stringifyScalar(doc.version),
    scope: stringifyScalar(doc.scope),
    tools: normalizeLegacyTools(doc.tools),
    unknownFields: Object.keys(doc).filter((key) => !OFFICIAL_KEYS.has(key)),
  };
  const warnings: FrontmatterWarning[] = [];

  if (doc.version !== undefined) {
    warnings.push({
      code: "legacy-version",
      field: "version",
      message: "Top-level version is not part of the Agent Skills spec.",
      suggestion: "Move it to metadata.companion_version or pass the version on publish.",
    });
  }
  if (doc.tools !== undefined) {
    warnings.push({
      code: "legacy-tools",
      field: "tools",
      message: "Top-level tools is a legacy Companion field.",
      suggestion: "Use the Agent Skills allowed-tools string instead.",
    });
    if (normalized["allowed-tools"] === undefined && legacy.tools?.length) {
      normalized["allowed-tools"] = legacy.tools.join(" ");
    }
  }
  if (doc.scope !== undefined) {
    warnings.push({
      code: "legacy-scope",
      field: "scope",
      message: "Top-level scope is not part of the Agent Skills spec.",
      suggestion: "Set visibility on the Companion upload request instead.",
    });
  }

  for (const field of legacy.unknownFields) {
    if (field === "version" || field === "tools" || field === "scope") continue;
    warnings.push({
      code: "unknown-field",
      field,
      message: `Top-level ${field} is not part of the Agent Skills spec.`,
      suggestion: "Move vendor-specific data under metadata.",
    });
  }

  return { normalized, warnings, legacy };
}

/**
 * Parse + validate a SKILL.md's frontmatter. YAML is parsed as plain data (no
 * custom tags, no code execution). Returns a structured result rather than throwing.
 */
export function parseFrontmatter(md: string): ParseFrontmatterResult {
  const { raw, body } = extractFrontmatter(md);
  const emptyLegacy: SkillLegacyFrontmatter = { unknownFields: [] };
  if (raw === null) {
    return { ok: false, error: "SKILL.md is missing a YAML frontmatter block", raw: null, body, warnings: [], legacy: emptyLegacy };
  }
  let doc: unknown;
  try {
    doc = parseYaml(raw, { merge: false });
  } catch (err) {
    return { ok: false, error: `frontmatter is not valid YAML: ${(err as Error).message}`, raw, body, warnings: [], legacy: emptyLegacy };
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    return { ok: false, error: "frontmatter must be a mapping of keys to values", raw, body, warnings: [], legacy: emptyLegacy };
  }
  const { normalized, warnings, legacy } = analyzeLegacyFields(doc as Record<string, unknown>);
  const result = skillFrontmatterSchema.safeParse(normalized);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "frontmatter"}: ${i.message}`)
      .join("; ");
    return { ok: false, error: `frontmatter validation failed: ${issues}`, raw, body, warnings, legacy };
  }
  return { ok: true, data: result.data, raw, body, warnings, legacy };
}
