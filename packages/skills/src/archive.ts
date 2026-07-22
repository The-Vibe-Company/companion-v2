import { extract as tarExtract } from "tar-stream";
import type { Headers } from "tar-stream";
import type { Readable } from "node:stream";
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

interface SeenPortablePath {
  display: string;
  kind: "directory" | "file";
}

const WIN32_RESERVED_BASENAME = /^(?:con|prn|aux|nul|clock\$|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/i;

function windowsPathSegmentViolation(segment: string): string | null {
  if ([...segment].some((character) => character.codePointAt(0)! <= 31) || /[<>:"|?*]/.test(segment)) {
    return "contains a Windows-reserved character";
  }
  if (/[ .]$/.test(segment)) return "ends with a dot or space";
  const basename = (segment.split(".", 1)[0] ?? "").replace(/[ .]+$/, "");
  if (WIN32_RESERVED_BASENAME.test(basename)) return "uses a Windows-reserved device name";
  return null;
}

function registerPortablePath(
  seen: Map<string, SeenPortablePath>,
  path: string,
  kind: "directory" | "file",
): string | null {
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const display = segments.slice(0, index + 1).join("/");
    const key = display.normalize("NFC").toLocaleLowerCase("en-US");
    const expectedKind = index === segments.length - 1 ? kind : "directory";
    const previous = seen.get(key);
    if (
      previous
      && (
        previous.display !== display
        || previous.kind !== expectedKind
        || (index === segments.length - 1 && expectedKind === "file")
      )
    ) {
      return `duplicate or Windows-colliding path: ${path}`;
    }
    if (!previous) seen.set(key, { display, kind: expectedKind });
  }
  return null;
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
    const windowsViolation = windowsPathSegmentViolation(seg);
    if (windowsViolation) {
      return { path: cleaned, violation: `Windows-unsafe path segment (${windowsViolation}): ${seg}` };
    }
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

interface ArchiveCounters {
  totalBytes: number;
  fileCount: number;
  oversize: boolean;
}

type ArchiveEntryClassification =
  | {
      kind: "file";
      rawName: string;
      type: string;
      path: string;
      size: number;
      mode: number | null;
      countable: true;
    }
  | {
      kind: "skip";
      rawName: string;
      type: string;
      path: string;
      size: number;
      countable: boolean;
      violation: string | null;
    };

function classifyArchiveEntry(header: {
  name?: string;
  type?: string | null;
  size?: number;
  mode?: number | null;
}): ArchiveEntryClassification {
  const rawName = header.name ?? "";
  const type = (header.type ?? "file") as string;
  const size = header.size ?? 0;
  const mode = typeof header.mode === "number" ? header.mode : null;
  const norm = normalizePosix(rawName);

  if (norm.violation) {
    return { kind: "skip", rawName, type, path: norm.path, size, countable: false, violation: `${norm.violation}: ${rawName}` };
  }
  if (type === "directory") {
    return { kind: "skip", rawName, type, path: norm.path, size, countable: false, violation: null };
  }
  if (!norm.path) {
    return { kind: "skip", rawName, type, path: norm.path, size, countable: false, violation: `empty path: ${rawName}` };
  }
  if (type === "symlink" || type === "link") {
    return { kind: "skip", rawName, type, path: norm.path, size, countable: true, violation: `symlink/hardlink rejected: ${rawName}` };
  }
  if (!SAFE_ENTRY_TYPES.has(type)) {
    return { kind: "skip", rawName, type, path: norm.path, size, countable: true, violation: `unsupported entry type '${type}': ${rawName}` };
  }
  if (isExcluded(norm.path)) {
    return { kind: "skip", rawName, type, path: norm.path, size, countable: true, violation: null };
  }
  return { kind: "file", rawName, type, path: norm.path, size, mode, countable: true };
}

function countArchiveEntry(counters: ArchiveCounters, entry: ArchiveEntryClassification): void {
  if (!entry.countable) return;
  counters.fileCount += 1;
  counters.totalBytes += entry.size;
  if (
    entry.size > MAX_FILE_BYTES ||
    counters.totalBytes > MAX_ARCHIVE_BYTES ||
    counters.fileCount > MAX_ENTRY_COUNT
  ) {
    counters.oversize = true;
  }
}

function drainArchiveStream(stream: Readable, next: () => void): void {
  stream.on("end", next);
  stream.resume();
}

async function walkArchive(
  tar: Buffer,
  onFile: (
    entry: Extract<ArchiveEntryClassification, { kind: "file" }>,
    stream: Readable,
    next: () => void,
    reject: (reason?: unknown) => void,
    counters: ArchiveCounters,
  ) => void,
  onViolation?: (violation: string) => void,
): Promise<ArchiveCounters> {
  const counters: ArchiveCounters = { totalBytes: 0, fileCount: 0, oversize: false };
  const seenPortablePaths = new Map<string, SeenPortablePath>();
  const ex = tarExtract();

  await new Promise<void>((resolve, reject) => {
    ex.on("entry", (header: Headers, stream, next) => {
      const entry = classifyArchiveEntry(header);
      const existingViolation = entry.kind === "skip" ? entry.violation : null;
      if (!existingViolation && entry.path) {
        const collision = registerPortablePath(
          seenPortablePaths,
          entry.path,
          entry.type === "directory" ? "directory" : "file",
        );
        if (collision) {
          countArchiveEntry(counters, entry);
          onViolation?.(collision);
          drainArchiveStream(stream, next);
          return;
        }
      }
      countArchiveEntry(counters, entry);
      if (entry.kind === "skip") {
        if (entry.violation) onViolation?.(entry.violation);
        drainArchiveStream(stream, next);
        return;
      }
      onFile(entry, stream, next, reject, counters);
    });
    ex.on("finish", () => resolve());
    ex.on("error", reject);
    ex.end(tar);
  });

  return counters;
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
  const counters = await walkArchive(
    tar,
    (entry, stream, next, reject) => {
      finding.files.push(entry.path);

      const base = entry.path.split("/").pop();
      if (base === "companion.json" && entry.size > MAX_SKILL_MD_BYTES) {
        companionCandidates.push({
          path: entry.path,
          depth: entry.path.split("/").length,
          content: null,
        });
        drainArchiveStream(stream, next);
        return;
      }
      if ((base === SKILL_FILE || base === "companion.json") && entry.size <= MAX_SKILL_MD_BYTES) {
        const chunks: Buffer[] = [];
        let read = 0;
        stream.on("data", (c: Buffer) => {
          read += c.length;
          if (read <= MAX_SKILL_MD_BYTES) chunks.push(c);
        });
        stream.on("end", () => {
          const candidate = {
            path: entry.path,
            depth: entry.path.split("/").length,
            content: Buffer.concat(chunks).toString("utf8"),
          };
          if (base === SKILL_FILE) skillCandidates.push(candidate);
          else companionCandidates.push(candidate);
          next();
        });
        stream.on("error", reject);
        return;
      }

      drainArchiveStream(stream, next);
    },
    (violation) => finding.violations.push(violation),
  );

  finding.totalBytes = counters.totalBytes;
  finding.fileCount = counters.fileCount;
  finding.oversize = counters.oversize;

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

export type ArchiveFilePreviewKind = "text" | "image" | "pdf" | "unsupported";

export interface ArchiveFilePreview {
  preview_kind: ArchiveFilePreviewKind;
  content_type: string | null;
}

function extensionForPath(relPath: string): string {
  const base = (relPath.split("/").pop() ?? "").toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : "";
}

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

export function previewForPath(relPath: string): ArchiveFilePreview {
  const ext = extensionForPath(relPath);
  if (isTextPath(relPath)) {
    if (ext === "json") return { preview_kind: "text", content_type: "application/json; charset=utf-8" };
    if (ext === "md" || ext === "markdown") return { preview_kind: "text", content_type: "text/markdown; charset=utf-8" };
    return { preview_kind: "text", content_type: "text/plain; charset=utf-8" };
  }
  const descriptor = binaryPreviewDescriptor(relPath);
  if (descriptor) return { preview_kind: descriptor.preview_kind, content_type: descriptor.content_type };
  return { preview_kind: "unsupported", content_type: null };
}

function hasBinaryNul(bytes: Buffer): boolean {
  return bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

function looksLikeSvg(bytes: Buffer): boolean {
  if (hasBinaryNul(bytes)) return false;
  const head = bytes.subarray(0, Math.min(bytes.length, 4096)).toString("utf8").trimStart();
  return /^<\?xml[\s\S]*?<svg[\s>]/i.test(head) || /^<svg[\s>]/i.test(head);
}

type PreviewDescriptor = {
  preview_kind: Exclude<ArchiveFilePreviewKind, "text" | "unsupported">;
  content_type: string;
  matches: (bytes: Buffer) => boolean;
};

const BINARY_PREVIEW_DESCRIPTORS: Record<string, PreviewDescriptor> = {
  pdf: {
    preview_kind: "pdf",
    content_type: "application/pdf",
    matches: (bytes) => bytes.length >= 5 && bytes.subarray(0, 5).toString("ascii") === "%PDF-",
  },
  png: {
    preview_kind: "image",
    content_type: "image/png",
    matches: (bytes) => (
      bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
    ),
  },
  jpg: {
    preview_kind: "image",
    content_type: "image/jpeg",
    matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  jpeg: {
    preview_kind: "image",
    content_type: "image/jpeg",
    matches: (bytes) => bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
  },
  gif: {
    preview_kind: "image",
    content_type: "image/gif",
    matches: (bytes) => (
      bytes.length >= 6 &&
      bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
      (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61
    ),
  },
  webp: {
    preview_kind: "image",
    content_type: "image/webp",
    matches: (bytes) => (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ),
  },
  svg: {
    preview_kind: "image",
    content_type: "image/svg+xml",
    matches: looksLikeSvg,
  },
};

function binaryPreviewDescriptor(relPath: string): PreviewDescriptor | null {
  return BINARY_PREVIEW_DESCRIPTORS[extensionForPath(relPath)] ?? null;
}

function matchesPreviewSignature(bytes: Buffer, relPath: string, preview: ArchiveFilePreview): boolean {
  if (preview.preview_kind === "text") return !hasBinaryNul(bytes);
  const descriptor = binaryPreviewDescriptor(relPath);
  return descriptor?.content_type === preview.content_type && descriptor.preview_kind === preview.preview_kind
    ? descriptor.matches(bytes)
    : false;
}

export interface ExtractedFile {
  path: string;
  size: number;
  /** UTF-8 content for text files (capped); null for binary or oversize-skipped files. */
  content: string | null;
  binary: boolean;
  /** True if the displayed content was sliced because the file exceeds the display cap. */
  truncated: boolean;
  preview_kind: ArchiveFilePreviewKind;
  content_type: string | null;
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
  const counters = await walkArchive(
    tar,
    (entry, stream, next, reject) => {
      if (isTextPath(entry.path)) {
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
              ? { path: entry.path, size: entry.size, content: null, binary: true, truncated: false, preview_kind: "unsupported", content_type: null }
              : {
                  path: entry.path,
                  size: entry.size,
                  content: Buffer.concat(chunks).toString("utf8"),
                  binary: false,
                  truncated: read > displayCap,
                  ...previewForPath(entry.path),
                },
          );
          next();
        });
        stream.on("error", reject);
        return;
      }

      // Binary by extension: drain the stream, keep only a small signature window for
      // preview classification, and never decode or buffer the file.
      const preview = previewForPath(entry.path);
      if (preview.preview_kind === "unsupported" || !preview.content_type) {
        files.push({ path: entry.path, size: entry.size, content: null, binary: true, truncated: false, ...preview });
        drainArchiveStream(stream, next);
        return;
      }

      const chunks: Buffer[] = [];
      let sniffed = 0;
      stream.on("data", (c: Buffer) => {
        if (sniffed >= BINARY_SNIFF_BYTES) return;
        const slice = c.subarray(0, BINARY_SNIFF_BYTES - sniffed);
        chunks.push(slice);
        sniffed += slice.length;
      });
      stream.on("end", () => {
        const previewable = matchesPreviewSignature(Buffer.concat(chunks), entry.path, preview);
        files.push({
          path: entry.path,
          size: entry.size,
          content: null,
          binary: true,
          truncated: false,
          ...(previewable ? preview : { preview_kind: "unsupported" as const, content_type: null }),
        });
        next();
      });
      stream.on("error", reject);
    },
    (violation) => violations.push(violation),
  );

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, oversize: counters.oversize, violations };
}

/** Default per-file cap when extracting FULL file bytes (deploy path, not display). */
const MAX_ENTRY_BUFFER_BYTES = 5 * 1024 * 1024; // 5 MB

export interface ArchiveEntryBuffer {
  path: string;
  data: Buffer;
  /** Any execute bit in the tar mode — preserved so bundled scripts stay runnable after push. */
  executable: boolean;
}

export interface ArchiveEntryBuffersResult {
  files: ArchiveEntryBuffer[];
  violations: string[];
  oversize: boolean;
}

/**
 * Extract EVERY safe entry's full bytes (unlike {@link extractArchiveFiles}, which caps text at the
 * display limit and returns no binary content). Used to push a skill folder into a sandbox: the
 * bytes must be exact and executable bits must survive. Same traversal/symlink/special-entry guards
 * as every other reader; a file above the per-file cap flags `oversize` and is skipped — callers
 * must refuse to deploy archives with violations or oversize.
 */
export async function extractArchiveEntryBuffers(
  tar: Buffer,
  opts: { maxFileBytes?: number } = {},
): Promise<ArchiveEntryBuffersResult> {
  const cap = opts.maxFileBytes ?? MAX_ENTRY_BUFFER_BYTES;
  const files: ArchiveEntryBuffer[] = [];
  const violations: string[] = [];
  let anyOversize = false;

  const counters = await walkArchive(
    tar,
    (entry, stream, next, reject) => {
      if (entry.size > cap) {
        anyOversize = true;
        violations.push(`file exceeds deploy cap (${entry.size} bytes): ${entry.path}`);
        drainArchiveStream(stream, next);
        return;
      }
      const chunks: Buffer[] = [];
      let read = 0;
      stream.on("data", (c: Buffer) => {
        read += c.length;
        if (read <= cap) chunks.push(c);
      });
      stream.on("end", () => {
        if (read > cap) {
          anyOversize = true;
          violations.push(`file exceeds deploy cap (${read} bytes): ${entry.path}`);
        } else {
          files.push({
            path: entry.path,
            data: Buffer.concat(chunks),
            executable: entry.mode !== null && (entry.mode & 0o111) !== 0,
          });
        }
        next();
      });
      stream.on("error", reject);
    },
    (violation) => violations.push(violation),
  );

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, violations, oversize: counters.oversize || anyOversize };
}

export type ExtractArchiveFileContentResult =
  | {
      status: "ok";
      path: string;
      size: number;
      bytes: Buffer;
      preview_kind: Exclude<ArchiveFilePreviewKind, "unsupported">;
      content_type: string;
    }
  | { status: "not_found" | "unsupported" | "invalid_path" | "oversize"; message: string };

export async function extractArchiveFileContent(
  tar: Buffer,
  requestedPath: string,
): Promise<ExtractArchiveFileContentResult> {
  const normalizedRequest = requestedPath.replace(/\\/g, "/");
  const wanted = normalizePosix(requestedPath);
  if (wanted.violation || !wanted.path || wanted.path !== normalizedRequest) {
    return { status: "invalid_path", message: "invalid file path" };
  }

  let result: ExtractArchiveFileContentResult | null = null;

  await walkArchive(
    tar,
    (entry, stream, next, reject, counters) => {
      if (counters.oversize && result === null) {
        result = { status: "oversize", message: "archive entry exceeds size limit" };
      }

      if (result !== null || entry.path !== wanted.path) {
        drainArchiveStream(stream, next);
        return;
      }

      const preview = previewForPath(entry.path);
      const previewKind = preview.preview_kind === "unsupported" ? null : preview.preview_kind;
      const contentType = preview.content_type;
      if (!previewKind || !contentType) {
        result = { status: "unsupported", message: "file is not previewable" };
        drainArchiveStream(stream, next);
        return;
      }

      const chunks: Buffer[] = [];
      let read = 0;
      let tooLarge = false;
      stream.on("data", (c: Buffer) => {
        read += c.length;
        if (read > MAX_FILE_BYTES) {
          tooLarge = true;
          return;
        }
        chunks.push(c);
      });
      stream.on("end", () => {
        if (tooLarge) {
          result = { status: "oversize", message: "archive entry exceeds size limit" };
          next();
          return;
        }
        const bytes = Buffer.concat(chunks);
        if (!matchesPreviewSignature(bytes, entry.path, preview)) {
          result = { status: "unsupported", message: "file is not previewable" };
          next();
          return;
        }
        result = {
          status: "ok",
          path: entry.path,
          size: read,
          bytes,
          preview_kind: previewKind,
          content_type: contentType,
        };
        next();
      });
      stream.on("error", reject);
    },
  );

  return result ?? { status: "not_found", message: "file not found" };
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
  const seenPortablePaths = new Map<string, SeenPortablePath>();

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
      const normalized = normalizePosix(childRel);
      if (normalized.violation) {
        violations.push(`${normalized.violation}: ${childRel}`);
        continue;
      }
      if (d.isDirectory() || d.isFile()) {
        const collision = registerPortablePath(
          seenPortablePaths,
          normalized.path,
          d.isDirectory() ? "directory" : "file",
        );
        if (collision) {
          violations.push(collision);
          continue;
        }
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
