import {
  companionManifestSchema,
  fallbackCompanionManifest,
  SEMVER_RE,
  VALIDATION_CHECK_LABELS,
  invalidAllowedTools,
  type CompanionManifest,
  type ValidationCheck,
  type ValidationResult,
} from "@companion/contracts";
import { parseFrontmatter } from "./frontmatter";
import { inspectTar, scanDir, toTar, type ArchiveFinding } from "./archive";
import { isZip, zipToTar } from "./zip";
import { MAX_ARCHIVE_BYTES, MAX_SKILL_MD_BYTES } from "./constants";

interface RawFindings {
  files: string[];
  skillMd: string | null;
  skillMdPath: string | null;
  companionJson: string | null;
  companionJsonPath: string | null;
  companionJsonTooLargePath: string | null;
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

function layoutCheck(f: RawFindings, skillName: string | null): ValidationCheck {
  if (!f.skillMdPath) {
    return { id: "layout", label: VALIDATION_CHECK_LABELS.layout, status: "fail", detail: "SKILL.md not found in package" };
  }
  if (f.skillMdPath === "SKILL.md") {
    return { id: "layout", label: VALIDATION_CHECK_LABELS.layout, status: "pass", detail: "SKILL.md" };
  }
  if (skillName) {
    const wrapper = `${skillName}/`;
    if (f.skillMdPath === `${wrapper}SKILL.md` && f.files.length > 0 && f.files.every((path) => path.startsWith(wrapper))) {
      return { id: "layout", label: VALIDATION_CHECK_LABELS.layout, status: "pass", detail: `${skillName}/ wrapper` };
    }
  }
  return {
    id: "layout",
    label: VALIDATION_CHECK_LABELS.layout,
    status: "fail",
    detail: `unexpected SKILL.md location: ${f.skillMdPath}`,
  };
}

function parseCompanionManifest(f: RawFindings, fallback: { summary: string; requirements?: CompanionManifest["requirements"] }): {
  check: ValidationCheck;
  manifest?: CompanionManifest;
  path: string | null;
} {
  if (f.companionJsonTooLargePath) {
    return {
      check: {
        id: "companion",
        label: VALIDATION_CHECK_LABELS.companion,
        status: "fail",
        detail: `${f.companionJsonTooLargePath} exceeds ${formatBytes(MAX_SKILL_MD_BYTES)}`,
      },
      path: f.companionJsonTooLargePath,
    };
  }
  if (f.companionJson === null) {
    return {
      check: {
        id: "companion",
        label: VALIDATION_CHECK_LABELS.companion,
        status: "pass",
        detail: "not present, using SKILL.md fallback",
      },
      manifest: fallbackCompanionManifest(fallback),
      path: null,
    };
  }
  try {
    const result = companionManifestSchema.safeParse(JSON.parse(f.companionJson));
    if (!result.success) {
      return {
        check: {
          id: "companion",
          label: VALIDATION_CHECK_LABELS.companion,
          status: "fail",
          detail: result.error.issues.map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`).join("; "),
        },
        path: f.companionJsonPath,
      };
    }
    const manifest = fallbackCompanionManifest({
      summary: fallback.summary,
      display: result.data.display,
      requirements: result.data.requirements,
      dependencies: result.data.dependencies,
    });
    return {
      check: {
        id: "companion",
        label: VALIDATION_CHECK_LABELS.companion,
        status: "pass",
        detail: f.companionJsonPath ?? "companion.json",
      },
      manifest,
      path: f.companionJsonPath,
    };
  } catch (err) {
    return {
      check: {
        id: "companion",
        label: VALIDATION_CHECK_LABELS.companion,
        status: "fail",
        detail: `companion.json is not valid JSON: ${(err as Error).message}`,
      },
      path: f.companionJsonPath,
    };
  }
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

  // 2. Layout matches Agent Skills package shape.
  checks.push(layoutCheck(f, fm && fm.ok ? fm.data.name : null));

  // 3. Compatibility + metadata follow the official field constraints.
  if (fm && fm.ok) {
    const companionVersion = fm.data.metadata.companion_version;
    if (companionVersion && !SEMVER_RE.test(companionVersion)) {
      checks.push({
        id: "metadata",
        label: VALIDATION_CHECK_LABELS.metadata,
        status: "fail",
        detail: `metadata.companion_version must be valid semver: ${companionVersion}`,
      });
    } else {
      const detail = [
        fm.data.compatibility ? "compatibility declared" : "no compatibility",
        `${Object.keys(fm.data.metadata).length} metadata keys`,
        `${fm.data.requirements.length} requirement${fm.data.requirements.length === 1 ? "" : "s"}`,
      ].join(", ");
      checks.push({ id: "metadata", label: VALIDATION_CHECK_LABELS.metadata, status: "pass", detail });
    }
  } else {
    checks.push({ id: "metadata", label: VALIDATION_CHECK_LABELS.metadata, status: "fail", detail: "cannot inspect metadata (frontmatter invalid)" });
  }

  const companion =
    fm && fm.ok
      ? parseCompanionManifest(f, {
          summary: fm.data.description,
          requirements: f.companionJson !== null ? [] : fm.data.requirements,
        })
      : {
          check: {
            id: "companion" as const,
            label: VALIDATION_CHECK_LABELS.companion,
            status: "fail" as const,
            detail: "cannot inspect companion.json (frontmatter invalid)",
          },
          path: f.companionJsonPath,
        };
  checks.push(companion.check);

  // 4. No path traversal / symlinks
  if (f.violations.length === 0) {
    checks.push({ id: "traversal", label: VALIDATION_CHECK_LABELS.traversal, status: "pass" });
  } else {
    checks.push({ id: "traversal", label: VALIDATION_CHECK_LABELS.traversal, status: "fail", detail: f.violations[0] });
  }

  // 5. Archive under size limit
  if (!f.oversize) {
    checks.push({ id: "size", label: VALIDATION_CHECK_LABELS.size, status: "pass", detail: `${formatBytes(f.totalBytes)} / ${formatBytes(MAX_ARCHIVE_BYTES)}` });
  } else {
    checks.push({ id: "size", label: VALIDATION_CHECK_LABELS.size, status: "fail", detail: `exceeds limit (${formatBytes(f.totalBytes)}, ${f.fileCount} files)` });
  }

  // 6. Official allowed-tools string parsed into Companion's internal list.
  const tools = fm && fm.ok ? fm.data.allowedTools : [];
  if (fm && fm.ok) {
    const invalidTools = invalidAllowedTools(tools);
    if (invalidTools.length > 0) {
      checks.push({
        id: "tools",
        label: VALIDATION_CHECK_LABELS.tools,
        status: "fail",
        detail: `invalid tool token: ${invalidTools[0]}`,
      });
    } else {
      checks.push({ id: "tools", label: VALIDATION_CHECK_LABELS.tools, status: "pass", detail: tools.length ? tools.join(", ") : "none declared" });
    }
  } else {
    checks.push({ id: "tools", label: VALIDATION_CHECK_LABELS.tools, status: "fail", detail: "cannot resolve tools (frontmatter invalid)" });
  }

  // 7. Legacy/non-spec top-level fields are warnings only.
  const warnings = fm?.warnings ?? [];
  if (fm?.ok && f.companionJson !== null && fm.data.requirements.length > 0) {
    warnings.push({
      code: "legacy-requirements",
      field: "requirements",
      message: "SKILL.md requirements are ignored because companion.json declares Companion setup data.",
      suggestion: "Remove requirements from SKILL.md and keep them in companion.json.",
    });
  }
  const legacyVersion = fm?.legacy.version;
  if (fm && legacyVersion && !SEMVER_RE.test(legacyVersion)) {
    checks.push({
      id: "legacy",
      label: VALIDATION_CHECK_LABELS.legacy,
      status: "fail",
      detail: `legacy version must be valid semver: ${legacyVersion}`,
    });
  } else if (fm && warnings.length > 0) {
    checks.push({
      id: "legacy",
      label: VALIDATION_CHECK_LABELS.legacy,
      status: "warn",
      detail: warnings.map((w) => w.field).join(", "),
      code: warnings[0]?.code,
      suggestion: warnings[0]?.suggestion,
    });
  } else if (fm) {
    checks.push({ id: "legacy", label: VALIDATION_CHECK_LABELS.legacy, status: "pass", detail: "none found" });
  } else {
    checks.push({ id: "legacy", label: VALIDATION_CHECK_LABELS.legacy, status: "fail", detail: "cannot inspect legacy fields (frontmatter missing)" });
  }

  const failed = checks.filter((c) => c.status === "fail");
  return {
    ok: failed.length === 0,
    checks,
    frontmatter: fm && fm.ok ? fm.data : undefined,
    body: fm ? fm.body : (f.skillMd ?? ""),
    companion_manifest: companion.manifest,
    companion_manifest_path: companion.path,
    legacy: fm?.legacy,
    warnings,
    error: failed.length
      ? failed.map((c) => `${c.label}${c.detail ? `: ${c.detail}` : ""}`).join("\n")
      : undefined,
  };
}

/** Validate a packed archive buffer (zip, tar, or tar.gz). Metadata-only; never executes scripts. */
export async function validateSkillArchive(input: Buffer): Promise<ValidationResult> {
  let tar: Buffer;
  try {
    tar = isZip(input) ? await zipToTar(input) : toTar(input);
  } catch {
    // Unreadable / over-cap archive (e.g. a zip-bomb tripping the decompression caps):
    // keep the full 5-check result shape so callers (CLI, API) render a consistent checklist.
    return buildResult({
      files: [],
      skillMd: null,
      skillMdPath: null,
      companionJson: null,
      companionJsonPath: null,
      companionJsonTooLargePath: null,
      totalBytes: input.length,
      fileCount: 0,
      violations: [],
      oversize: true,
    });
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
    files: finding.files,
    skillMd: finding.skillMd,
    skillMdPath: finding.skillMdPath,
    companionJson: finding.companionJson,
    companionJsonPath: finding.companionJsonPath,
    companionJsonTooLargePath: finding.companionJsonTooLargePath,
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
    files: scan.files.map((file) => file.relPath),
    skillMd: scan.skillMd,
    skillMdPath: scan.skillMdPath,
    companionJson: scan.companionJson,
    companionJsonPath: scan.companionJsonPath,
    companionJsonTooLargePath: scan.companionJsonTooLargePath,
    totalBytes: scan.totalBytes,
    fileCount: scan.files.length,
    violations: scan.violations,
    oversize: scan.oversize,
  });
}
