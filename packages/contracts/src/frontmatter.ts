import { z } from "zod";

/** Skill id / name: kebab-case (lowercase, digits, single hyphens). */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Strict semantic version (semver.org). */
export const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

/** Official Agent Skills top-level frontmatter fields. Vendor fields belong under `metadata`. */
export const AGENT_SKILL_FRONTMATTER_KEYS = [
  "name",
  "description",
  "license",
  "compatibility",
  "metadata",
  "allowed-tools",
] as const;

export const ALLOWED_TOOL_RE = /^[A-Za-z0-9_.:-]+(?:\([A-Za-z0-9_.*: -]+\))?$/;

export type FrontmatterWarningCode =
  | "legacy-version"
  | "legacy-tools"
  | "legacy-scope"
  | "unknown-field"
  | "reserved-metadata";

export interface FrontmatterWarning {
  code: FrontmatterWarningCode;
  field: string;
  message: string;
  suggestion?: string;
}

export interface SkillLegacyFrontmatter {
  version?: string;
  scope?: string;
  tools?: string[];
  unknownFields: string[];
}

export function parseAllowedTools(value: string | undefined): string[] {
  const input = (value ?? "").trim();
  if (!input) return [];

  const tools: string[] = [];
  let current = "";
  let parenDepth = 0;

  const flush = () => {
    const tool = current.trim();
    if (tool) tools.push(tool);
    current = "";
  };

  for (const char of input) {
    if (char === "(") {
      parenDepth += 1;
      current += char;
      continue;
    }
    if (char === ")" && parenDepth > 0) {
      parenDepth -= 1;
      current += char;
      continue;
    }
    if (parenDepth === 0 && (char === "," || /\s/.test(char))) {
      flush();
      continue;
    }
    current += char;
  }

  flush();
  return tools;
}

export function invalidAllowedTools(value: readonly string[]): string[] {
  return value.filter((tool) => !ALLOWED_TOOL_RE.test(tool));
}

/**
 * Official Agent Skills frontmatter, normalized for Companion consumers.
 * `allowedTools` is derived from the spec's `allowed-tools` space-separated string.
 */
const skillFrontmatterFields = z
  .object({
    name: z
      .string()
      .min(1, "name is required")
      .max(64, "name must be at most 64 characters")
      .regex(SKILL_NAME_RE, "name must be kebab-case (lowercase letters, digits, hyphens)"),
    description: z.string().min(1, "description is required").max(1024, "description must be at most 1024 characters"),
    license: z.string().min(1, "license must not be empty").optional(),
    compatibility: z
      .string()
      .min(1, "compatibility must not be empty")
      .max(500, "compatibility must be at most 500 characters")
      .optional(),
    metadata: z.record(z.string()).default({}),
    "allowed-tools": z.string().optional(),
  })
  .transform((value) => {
    const allowedToolsRaw = value["allowed-tools"];
    return {
      name: value.name,
      description: value.description,
      license: value.license,
      compatibility: value.compatibility,
      metadata: value.metadata,
      allowedToolsRaw,
      allowedTools: parseAllowedTools(allowedToolsRaw),
    };
  });

export const skillFrontmatterSchema = skillFrontmatterFields;
export type SkillFrontmatter = z.infer<typeof skillFrontmatterSchema>;

export interface StoredSkillFrontmatter {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Record<string, string>;
  "allowed-tools"?: string;
}

function sortRecord(value: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
}

export function toStoredSkillFrontmatter(frontmatter: SkillFrontmatter): StoredSkillFrontmatter {
  const stored: StoredSkillFrontmatter = {
    name: frontmatter.name,
    description: frontmatter.description,
    metadata: sortRecord(frontmatter.metadata),
  };
  if (frontmatter.license) stored.license = frontmatter.license;
  if (frontmatter.compatibility) stored.compatibility = frontmatter.compatibility;
  const allowedTools = frontmatter.allowedTools.join(" ");
  if (allowedTools.trim()) stored["allowed-tools"] = allowedTools.trim();
  return stored;
}

export function parseStoredSkillFrontmatter(value: string | null | undefined): StoredSkillFrontmatter | null {
  if (!value) return null;
  try {
    const parsed = skillFrontmatterSchema.safeParse(JSON.parse(value));
    if (!parsed.success) return null;
    return toStoredSkillFrontmatter(parsed.data);
  } catch {
    return null;
  }
}
