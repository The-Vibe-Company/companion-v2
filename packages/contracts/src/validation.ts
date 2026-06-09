import type { FrontmatterWarning, SkillFrontmatter, SkillLegacyFrontmatter } from "./frontmatter";

/** Checks shown in the upload drawer's validation checklist. */
export type ValidationCheckId = "frontmatter" | "layout" | "metadata" | "traversal" | "size" | "tools" | "legacy";

export interface ValidationCheck {
  id: ValidationCheckId;
  /** Human label, sentence case, no em dashes (DESIGN.md). */
  label: string;
  status: "pass" | "warn" | "fail";
  /** Optional one-line detail; the consequence or the offending value. */
  detail?: string;
  code?: string;
  suggestion?: string;
}

export interface ValidationResult {
  ok: boolean;
  checks: ValidationCheck[];
  /** Parsed frontmatter when the frontmatter check passed. */
  frontmatter?: SkillFrontmatter;
  /** Legacy non-spec fields found at top-level, kept only for migration/version resolution. */
  legacy?: SkillLegacyFrontmatter;
  /** Non-blocking migration or compatibility warnings. */
  warnings?: FrontmatterWarning[];
  /** Human-readable composite error, preserved for the danger block when ok=false. */
  error?: string;
}

export const VALIDATION_CHECK_LABELS: Record<ValidationCheckId, string> = {
  frontmatter: "Agent Skills frontmatter parsed",
  layout: "SKILL.md is at the package root or a matching wrapper folder",
  metadata: "Compatibility and metadata follow the spec",
  traversal: "No path traversal or symlinks escaping the package root",
  size: "Archive under the size limit",
  tools: "allowed-tools parsed",
  legacy: "Legacy Companion fields can be migrated",
};
