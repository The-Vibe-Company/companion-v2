/** Limits and policy for SKILL.md package validation. Shared by web + CLI. */

/** Max total declared (uncompressed) bytes across all entries — zip-bomb guard. */
export const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024; // 25 MB
/** Max declared size of any single entry. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB
/** Max number of entries in a package. */
export const MAX_ENTRY_COUNT = 2000;
/** SKILL.md is the only file we read into memory during validation. */
export const MAX_SKILL_MD_BYTES = 1 * 1024 * 1024; // 1 MB

/** The package manifest filename. */
export const SKILL_FILE = "SKILL.md";

/** Junk excluded from a packed archive (gitignore-ish, matched against the posix relpath). */
export const EXCLUDE_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.git(\/|$)/,
  /(^|\/)\.DS_Store$/,
  /(^|\/)node_modules(\/|$)/,
  /(^|\/)__pycache__(\/|$)/,
  /\.pyc$/,
  /(^|\/)\.companion(\/|$)/,
  /(^|\/)\.companion\.lock$/,
  /(^|\/)companion\.lock$/,
];

/** A declared tool name must be a snake_case identifier. */
export const TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;

/** Tar entry types we accept inside a package (everything else is rejected). */
export const SAFE_ENTRY_TYPES = new Set(["file", "directory"]);

export function isExcluded(relPath: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(relPath));
}
