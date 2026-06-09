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

/**
 * A declared tool name is an identifier (a letter then letters/digits/underscores). This admits
 * both Companion's snake_case (`read_file`) and the Claude tool names skills declare via
 * `allowed-tools` — built-ins (`Bash`, `WebFetch`, `Agent`) and MCP tools (`mcp__server__tool`).
 */
export const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Tar entry types we accept inside a package (everything else is rejected). */
export const SAFE_ENTRY_TYPES = new Set(["file", "directory"]);

export function isExcluded(relPath: string): boolean {
  return EXCLUDE_PATTERNS.some((re) => re.test(relPath));
}
