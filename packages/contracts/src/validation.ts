import type { SkillFrontmatter } from "./frontmatter";

/** The five checks shown 1:1 in the upload drawer's validation checklist. */
export type ValidationCheckId = "frontmatter" | "semver" | "traversal" | "size" | "tools";

export interface ValidationCheck {
  id: ValidationCheckId;
  /** Human label, sentence case, no em dashes (DESIGN.md). */
  label: string;
  status: "pass" | "fail";
  /** Optional one-line detail; the consequence or the offending value. */
  detail?: string;
}

export interface ValidationResult {
  ok: boolean;
  checks: ValidationCheck[];
  /** Parsed frontmatter when the frontmatter check passed. */
  frontmatter?: SkillFrontmatter;
  /** Human-readable composite error, preserved for the danger block when ok=false. */
  error?: string;
}

export const VALIDATION_CHECK_LABELS: Record<ValidationCheckId, string> = {
  frontmatter: "Frontmatter parsed: name, version, description present",
  semver: "Semantic version is well-formed",
  traversal: "No path traversal or symlinks escaping the package root",
  size: "Archive under the size limit",
  tools: "Declared tools resolved against the runtime",
};
