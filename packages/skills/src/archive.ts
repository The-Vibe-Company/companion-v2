import { extract as tarExtract } from "tar-stream";
import { gunzipSync } from "node:zlib";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  MAX_ARCHIVE_BYTES,
  MAX_ENTRY_COUNT,
  MAX_FILE_BYTES,
  MAX_SKILL_MD_BYTES,
  SAFE_ENTRY_TYPES,
  SKILL_FILE,
  isExcluded,
} from "./constants";

export function isGzip(buf: Buffer): boolean {
  return buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b;
}

/** Decompress a gzip buffer (bounded against zip bombs) or pass a raw tar through. */
export function toTar(input: Buffer): Buffer {
  if (!isGzip(input)) return input;
  return gunzipSync(input, { maxOutputLength: MAX_ARCHIVE_BYTES * 2 });
}

export interface PathCheck {
  path: string;
  violation?: string;
}

/** Normalize a tar entry name to a safe posix relpath, flagging traversal/abs/special. */
export function normalizePosix(name: string): PathCheck {
  const cleaned = name.replace(/\\/g, "/");
  if (cleaned.includes("\0")) return { path: cleaned, violation: "null byte in path" };
  if (cleaned.startsWith("/")) return { path: cleaned, violation: "absolute path" };
  if (/^[a-zA-Z]:/.test(cleaned)) return { path: cleaned, violation: "drive-letter path" };
  const parts: string[] = [];
  for (const seg of cleaned.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") return { path: cleaned, violation: "path traversal" };
    parts.push(seg);
  }
  return { path: parts.join("/") };
}

export interface ArchiveFinding {
  files: string[];
  totalBytes: number;
  fileCount: number;
  /** Content of the shallowest SKILL.md, or null. */
  skillMd: string | null;
  /** Path of the selected SKILL.md inside the archive, or null when absent. */
  skillMdPath: string | null;
  /** Content of companion.json next to the selected SKILL.md package root, or null. */
  companionJson: string | null;
  /** Path of the selected companion.json inside the archive, or null when absent. */
  companionJsonPath: string | null;
  /** Path of an oversized selected companion.json that was not buffered. */
  companionJsonTooLargePath: string | null;
  /** Traversal / symlink / special-entry messages. */
  violations: string[];
  /** Exceeded a size or entry-count cap. */
  oversize: boolean;
}

/**
 * Inspect a tar buffer entry-by-entry WITHOUT extracting to disk. Only SKILL.md is
 * read into memory (capped); all other file streams are drained. Rejects symlinks,
 * hardlinks, special entries, absolute/traversal paths; sums declared sizes.
 */
export async function inspectTar(tar: Buffer): Promise<ArchiveFinding> {
  const finding: ArchiveFinding = {
    files: [],
    totalBytes: 0,
    fileCount: 0,
    skillMd: null,
    skillMdPath: null,
    companionJson: null,
    companionJsonPath: null,
    companionJsonTooLargePath: null,
    violations: [],
    oversize: false,
  };
  const skillCandidates: { path: string; depth: number; content: string }[] = [];
  const companionCandidates: { path: string; depth: number; content: string | null }[] = [];
  const ex = tarExtract();

  await new Promise<void>((resolve, reject) => {
    ex.on("entry", (header, stream, next) => {
      const rawName = header.name ?? "";
      const type = (header.type ?? "file") as string;

      if (type === "symlink" || type === "link") {
        finding.violations.push(`symlink/hardlink rejected: ${rawName}`);
        stream.on("end", next);
        stream.resume();
        return;
      }
      if (!SAFE_ENTRY_TYPES.has(type)) {
        finding.violations.push(`unsupported entry type '${type}': ${rawName}`);
        stream.on("end", next);
        stream.resume();
        return;
      }

      const norm = normalizePosix(rawName);
      if (norm.violation) {
        finding.violations.push(`${norm.violation}: ${rawName}`);
        stream.on("end", next);
        stream.resume();
        return;
      }

      if (type === "directory") {
        stream.on("end", next);
        stream.resume();
        return;
      }
      if (!norm.path) {
        finding.violations.push(`empty path: ${rawName}`);
        stream.on("end", next);
        stream.resume();
        return;
      }
      finding.fileCount += 1;
      const size = header.size ?? 0;
      finding.totalBytes += size;
      if (
        size > MAX_FILE_BYTES ||
        finding.totalBytes > MAX_ARCHIVE_BYTES ||
        finding.fileCount > MAX_ENTRY_COUNT
      ) {
        finding.oversize = true;
      }
      if (isExcluded(norm.path)) {
        stream.on("end", next);
        stream.resume();
        return;
      }
      finding.files.push(norm.path);

      const base = norm.path.split("/").pop();
      if (base === "companion.json" && size > MAX_SKILL_MD_BYTES) {
        companionCandidates.push({
          path: norm.path,
          depth: norm.path.split("/").length,
          content: null,
        });
        stream.on("end", next);
        stream.resume();
        return;
      }
      if ((base === SKILL_FILE || base === "companion.json") && size <= MAX_SKILL_MD_BYTES) {
        const chunks: Buffer[] = [];
        let read = 0;
        stream.on("data", (c: Buffer) => {
          read += c.length;
          if (read <= MAX_SKILL_MD_BYTES) chunks.push(c);
        });
        stream.on("end", () => {
          const candidate = {
            path: norm.path,
            depth: norm.path.split("/").length,
            content: Buffer.concat(chunks).toString("utf8"),
          };
          if (base === SKILL_FILE) skillCandidates.push(candidate);
          else companionCandidates.push(candidate);
          next();
        });
        stream.on("error", reject);
        return;
      }

      stream.on("end", next);
      stream.resume();
    });
    ex.on("finish", () => resolve());
    ex.on("error", reject);
    ex.end(tar);
  });

  skillCandidates.sort((a, b) => a.depth - b.depth);
  const skillCandidate = skillCandidates[0];
  finding.skillMd = skillCandidate?.content ?? null;
  finding.skillMdPath = skillCandidate?.path ?? null;
  const packageRoot = skillCandidate?.path.includes("/") ? skillCandidate.path.slice(0, skillCandidate.path.lastIndexOf("/")) : "";
  const expectedCompanionPath = packageRoot ? `${packageRoot}/companion.json` : "companion.json";
  const companionCandidate = companionCandidates.find((candidate) => candidate.path === expectedCompanionPath);
  finding.companionJson = companionCandidate?.content ?? null;
  finding.companionJsonPath = companionCandidate?.path ?? null;
  finding.companionJsonTooLargePath = companionCandidate?.content === null ? companionCandidate.path : null;
  return finding;
}

/** Max bytes of any single text file we buffer into memory for display. */
const MAX_DISPLAY_BYTES = 256 * 1024; // 256 KB
/** Bytes sniffed for a NUL byte to decide binary-ness. */
const BINARY_SNIFF_BYTES = 8 * 1024; // 8 KB

/**
 * Extensions whose contents we are willing to UTF-8 decode for display. Anything
 * outside this list is treated as binary (content: null). Matched case-insensitively.
 */
const TEXT_EXTENSIONS = new Set([
  "md", "json", "py", "txt", "js", "jsx", "ts", "tsx", "sh", "bash", "yaml", "yml",
  "toml", "cfg", "ini", "env", "csv", "xml", "html", "css", "sql", "rb", "go", "rs",
  "java", "c", "h", "cpp", "gitignore", "dockerfile",
]);

/** Extensionless basenames we still treat as text. Matched case-insensitively. */
const TEXT_BASENAMES = new Set(["license", "readme", "dockerfile", "makefile"]);

/** Decide whether a posix relpath's basename is a text file by extension/name. */
function isTextPath(relPath: string): boolean {
  const base = (relPath.split("/").pop() ?? "").toLowerCase();
  // lastIndexOf so "foo.tar.gz" keys on "gz"; >= 0 so leading-dot files like ".gitignore"
  // (lastIndexOf === 0 -> ext "gitignore") and ".env" still resolve against the allowlist.
  const dot = base.lastIndexOf(".");
  if (dot >= 0) {
    const ext = base.slice(dot + 1);
    if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  }
  // Extensionless names (LICENSE, README, Dockerfile, Makefile).
  return TEXT_BASENAMES.has(base);
}

export interface ExtractedFile {
  path: string;
  size: number;
  /** UTF-8 content for text files (capped); null for binary or oversize-skipped files. */
  content: string | null;
  binary: boolean;
  /** True if the displayed content was sliced because the file exceeds the display cap. */
  truncated: boolean;
}

export interface ExtractResult {
  files: ExtractedFile[];
  /** Exceeded a size or entry-count cap. */
  oversize: boolean;
  /** Traversal / symlink / special-entry messages. */
  violations: string[];
}

/**
 * Extract every (non-directory) file from a tar buffer into memory for browsing,
 * WITHOUT writing to disk. Text files (by extension allowlist) are UTF-8 decoded up
 * to a 256 KB display cap — content is sliced mid-stream rather than accumulated past
 * the cap. Binary files (NUL byte in the first ~8 KB, or a non-allowlisted extension)
 * are drained and counted but never decoded (content: null, binary: true).
 *
 * Rejects symlinks, hardlinks, special entries, absolute/traversal paths (recorded in
 * `violations`). Re-enforces the per-file / total-size / entry-count caps (`oversize`).
 * Results are sorted by path for deterministic tree rendering.
 */
export async function extractArchiveFiles(
  tar: Buffer,
  opts: { maxFileBytes?: number } = {},
): Promise<ExtractResult> {
  const displayCap = opts.maxFileBytes ?? MAX_DISPLAY_BYTES;
  const files: ExtractedFile[] = [];
  const violations: string[] = [];
  let totalBytes = 0;
  let fileCount = 0;
  let oversize = false;
  const ex = tarExtract();

  await new Promise<void>((resolve, reject) => {
    ex.on("entry", (header, stream, next) => {
      const rawName = header.name ?? "";
      const type = (header.type ?? "file") as string;

      if (type === "symlink" || type === "link") {
        violations.push(`symlink/hardlink rejected: ${rawName}`);
        stream.on("end", next);
        stream.resume();
        return;
      }
      if (!SAFE_ENTRY_TYPES.has(type)) {
        violations.push(`unsupported entry type '${type}': ${rawName}`);
        stream.on("end", next);
        stream.resume();
        return;
      }

      const norm = normalizePosix(rawName);
      if (norm.violation) {
        violations.push(`${norm.violation}: ${rawName}`);
        stream.on("end", next);
        stream.resume();
        return;
      }

      if (type === "directory") {
        stream.on("end", next);
        stream.resume();
        return;
      }
      if (!norm.path) {
        violations.push(`empty path: ${rawName}`);
        stream.on("end", next);
        stream.resume();
        return;
      }

      fileCount += 1;
      const size = header.size ?? 0;
      totalBytes += size;
      if (
        size > MAX_FILE_BYTES ||
        totalBytes > MAX_ARCHIVE_BYTES ||
        fileCount > MAX_ENTRY_COUNT
      ) {
        oversize = true;
      }

      // Skip packaging junk (.git, .DS_Store, node_modules, __pycache__, *.pyc, …) the same
      // way the packer excludes it — an uploaded macOS/IDE archive shouldn't clutter the explorer.
      // Security size limits above still count excluded bytes and entries.
      if (isExcluded(norm.path)) {
        stream.on("end", next);
        stream.resume();
        return;
      }

      if (isTextPath(norm.path)) {
        const chunks: Buffer[] = [];
        let read = 0;
        let sniffedBinary = false;
        let sniffed = 0;
        stream.on("data", (c: Buffer) => {
          // NUL-byte sniff over the first ~8 KB; a hit downgrades the file to binary.
          if (!sniffedBinary && sniffed < BINARY_SNIFF_BYTES) {
            const window = c.subarray(0, BINARY_SNIFF_BYTES - sniffed);
            if (window.includes(0)) sniffedBinary = true;
            sniffed += c.length;
          }
          read += c.length;
          // Slice mid-stream exactly like the SKILL.md guard — never buffer past the cap.
          if (read <= displayCap) chunks.push(c);
          else if (read - c.length < displayCap) chunks.push(c.subarray(0, displayCap - (read - c.length)));
        });
        stream.on("end", () => {
          files.push(
            sniffedBinary
              ? { path: norm.path, size, content: null, binary: true, truncated: false }
              : {
                  path: norm.path,
                  size,
                  content: Buffer.concat(chunks).toString("utf8"),
                  binary: false,
                  truncated: read > displayCap,
                },
          );
          next();
        });
        stream.on("error", reject);
        return;
      }

      // Binary by extension: drain the stream, count its size, never decode.
      files.push({ path: norm.path, size, content: null, binary: true, truncated: false });
      stream.on("end", next);
      stream.resume();
    });
    ex.on("finish", () => resolve());
    ex.on("error", reject);
    ex.end(tar);
  });

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, oversize, violations };
}

export interface DirFile {
  relPath: string;
  size: number;
  mode: number;
}

export interface DirScan {
  files: DirFile[];
  totalBytes: number;
  skillMd: string | null;
  skillMdPath: string | null;
  companionJson: string | null;
  companionJsonPath: string | null;
  companionJsonTooLargePath: string | null;
  violations: string[];
  oversize: boolean;
}

function modeFor(relPath: string): number {
  return relPath === "scripts" || relPath.startsWith("scripts/") || relPath.includes("/scripts/")
    ? 0o755
    : 0o644;
}

/** Scan a skill directory deterministically (sorted), rejecting symlinks. */
export async function scanDir(dir: string): Promise<DirScan> {
  const files: DirFile[] = [];
  const violations: string[] = [];
  let totalBytes = 0;
  let oversize = false;

  async function walk(abs: string, rel: string): Promise<void> {
    const dirents = await readdir(abs, { withFileTypes: true });
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      if (isExcluded(childRel)) continue;
      if (d.isSymbolicLink()) {
        violations.push(`symlink rejected: ${childRel}`);
        continue;
      }
      const childAbs = join(abs, d.name);
      if (d.isDirectory()) {
        await walk(childAbs, childRel);
        continue;
      }
      if (!d.isFile()) {
        violations.push(`unsupported file type: ${childRel}`);
        continue;
      }
      const st = await stat(childAbs);
      totalBytes += st.size;
      if (st.size > MAX_FILE_BYTES || totalBytes > MAX_ARCHIVE_BYTES || files.length + 1 > MAX_ENTRY_COUNT) {
        oversize = true;
      }
      files.push({ relPath: childRel, size: st.size, mode: modeFor(childRel) });
    }
  }

  await walk(dir, "");
  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const skillEntry = files
    .filter((f) => f.relPath.split("/").pop() === SKILL_FILE)
    .sort((a, b) => a.relPath.split("/").length - b.relPath.split("/").length)[0];
  const skillMd = skillEntry ? await readFile(join(dir, skillEntry.relPath), "utf8") : null;
  const packageRoot = skillEntry?.relPath.includes("/") ? skillEntry.relPath.slice(0, skillEntry.relPath.lastIndexOf("/")) : "";
  const expectedCompanionPath = packageRoot ? `${packageRoot}/companion.json` : "companion.json";
  const companionEntry = files.find((f) => f.relPath === expectedCompanionPath);
  const companionJsonTooLargePath =
    companionEntry && companionEntry.size > MAX_SKILL_MD_BYTES ? companionEntry.relPath : null;
  const companionJson =
    companionEntry && !companionJsonTooLargePath ? await readFile(join(dir, companionEntry.relPath), "utf8") : null;

  return {
    files,
    totalBytes,
    skillMd,
    skillMdPath: skillEntry?.relPath ?? null,
    companionJson,
    companionJsonPath: companionEntry?.relPath ?? null,
    companionJsonTooLargePath,
    violations,
    oversize,
  };
}
