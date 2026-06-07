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
    violations: [],
    oversize: false,
  };
  const skillCandidates: { depth: number; content: string }[] = [];
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
      finding.files.push(norm.path);

      const base = norm.path.split("/").pop();
      if (base === SKILL_FILE && size <= MAX_SKILL_MD_BYTES) {
        const chunks: Buffer[] = [];
        let read = 0;
        stream.on("data", (c: Buffer) => {
          read += c.length;
          if (read <= MAX_SKILL_MD_BYTES) chunks.push(c);
        });
        stream.on("end", () => {
          skillCandidates.push({
            depth: norm.path.split("/").length,
            content: Buffer.concat(chunks).toString("utf8"),
          });
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
  finding.skillMd = skillCandidates[0]?.content ?? null;
  return finding;
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

  return { files, totalBytes, skillMd, violations, oversize };
}
