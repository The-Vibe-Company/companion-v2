import {
  VALIDATION_CHECK_LABELS,
  type ValidationCheck,
  type ValidationResult,
} from "@companion/contracts";
import { parseFrontmatter } from "./frontmatter";
import { isValidSemver } from "./semver";
import { inspectTar, scanDir, toTar, type ArchiveFinding } from "./archive";
import { MAX_ARCHIVE_BYTES, TOOL_NAME_RE } from "./constants";

interface RawFindings {
  skillMd: string | null;
  totalBytes: number;
  fileCount: number;
  violations: string[];
  oversize: boolean;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function buildResult(f: RawFindings): ValidationResult {
  const checks: ValidationCheck[] = [];
  const fm = f.skillMd !== null ? parseFrontmatter(f.skillMd) : null;

  // 1. Frontmatter parsed
  if (f.skillMd === null) {
    checks.push({ id: "frontmatter", label: VALIDATION_CHECK_LABELS.frontmatter, status: "fail", detail: "SKILL.md not found in package" });
  } else if (fm && fm.ok) {
    checks.push({ id: "frontmatter", label: VALIDATION_CHECK_LABELS.frontmatter, status: "pass" });
  } else {
    checks.push({ id: "frontmatter", label: VALIDATION_CHECK_LABELS.frontmatter, status: "fail", detail: fm?.error ?? "frontmatter missing" });
  }

  // 2. Semver well-formed
  const version = fm && fm.ok ? fm.data.version : undefined;
  if (version && isValidSemver(version)) {
    checks.push({ id: "semver", label: VALIDATION_CHECK_LABELS.semver, status: "pass", detail: version });
  } else {
    checks.push({ id: "semver", label: VALIDATION_CHECK_LABELS.semver, status: "fail", detail: version ? `not a valid semver: ${version}` : "version missing from frontmatter" });
  }

  // 3. No path traversal / symlinks
  if (f.violations.length === 0) {
    checks.push({ id: "traversal", label: VALIDATION_CHECK_LABELS.traversal, status: "pass" });
  } else {
    checks.push({ id: "traversal", label: VALIDATION_CHECK_LABELS.traversal, status: "fail", detail: f.violations[0] });
  }

  // 4. Archive under size limit
  if (!f.oversize) {
    checks.push({ id: "size", label: VALIDATION_CHECK_LABELS.size, status: "pass", detail: `${formatBytes(f.totalBytes)} / ${formatBytes(MAX_ARCHIVE_BYTES)}` });
  } else {
    checks.push({ id: "size", label: VALIDATION_CHECK_LABELS.size, status: "fail", detail: `exceeds limit (${formatBytes(f.totalBytes)}, ${f.fileCount} files)` });
  }

  // 5. Declared tools resolved
  const tools = fm && fm.ok ? fm.data.tools : [];
  const badTool = tools.find((t) => !TOOL_NAME_RE.test(t));
  if (fm && fm.ok && !badTool) {
    checks.push({ id: "tools", label: VALIDATION_CHECK_LABELS.tools, status: "pass", detail: tools.length ? tools.join(", ") : "none declared" });
  } else if (fm && fm.ok && badTool) {
    checks.push({ id: "tools", label: VALIDATION_CHECK_LABELS.tools, status: "fail", detail: `invalid tool name: ${badTool}` });
  } else {
    checks.push({ id: "tools", label: VALIDATION_CHECK_LABELS.tools, status: "fail", detail: "cannot resolve tools (frontmatter invalid)" });
  }

  const failed = checks.filter((c) => c.status === "fail");
  return {
    ok: failed.length === 0,
    checks,
    frontmatter: fm && fm.ok ? fm.data : undefined,
    error: failed.length
      ? failed.map((c) => `${c.label}${c.detail ? `: ${c.detail}` : ""}`).join("\n")
      : undefined,
  };
}

/** Validate a packed archive buffer (tar or tar.gz). Metadata-only; never executes scripts. */
export async function validateSkillArchive(input: Buffer): Promise<ValidationResult> {
  let tar: Buffer;
  try {
    tar = toTar(input);
  } catch {
    return buildResult({ skillMd: null, totalBytes: input.length, fileCount: 0, violations: [], oversize: true });
  }
  let finding: ArchiveFinding;
  try {
    finding = await inspectTar(tar);
  } catch (err) {
    const detail = `archive could not be read: ${(err as Error).message}`;
    return {
      ok: false,
      checks: [{ id: "frontmatter", label: VALIDATION_CHECK_LABELS.frontmatter, status: "fail", detail }],
      error: detail,
    };
  }
  return buildResult({
    skillMd: finding.skillMd,
    totalBytes: finding.totalBytes,
    fileCount: finding.fileCount,
    violations: finding.violations,
    oversize: finding.oversize,
  });
}

/** Validate a skill working directory (offline; used by the CLI and push pre-flight). */
export async function validateSkillDir(dir: string): Promise<ValidationResult> {
  const scan = await scanDir(dir);
  return buildResult({
    skillMd: scan.skillMd,
    totalBytes: scan.totalBytes,
    fileCount: scan.files.length,
    violations: scan.violations,
    oversize: scan.oversize,
  });
}
