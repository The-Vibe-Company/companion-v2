import path from "node:path";
import type { Stats, Dirent } from "node:fs";
import type { RunOutputFile } from "@companion/core";

const WORKDIR = "/vercel/sandbox";
const ARTIFACTS_DIR = `${WORKDIR}/artifacts`;
const RASTER_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif"]);
const EXCLUDED_SEGMENTS = new Set([".claude", "attachments"]);

export interface SandboxOutputFileSystem {
  readdir(path: string, options: { signal?: AbortSignal; withFileTypes: true }): Promise<Dirent[]>;
  lstat(path: string, options?: { signal?: AbortSignal }): Promise<Stats>;
  realpath(path: string, options?: { signal?: AbortSignal }): Promise<string>;
  readFile(path: string, options?: { signal?: AbortSignal }): Promise<Buffer>;
}

function relativeCandidate(candidate: string): string | null {
  if (!candidate || candidate.includes("\0") || candidate.includes("\\")) return null;
  const raw = candidate.startsWith(`${WORKDIR}/`) ? candidate.slice(WORKDIR.length + 1) : candidate;
  if (raw.startsWith("/") || raw.endsWith("/")) return null;
  const segments = raw.split("/");
  if (
    raw.length > 1_024
    || segments.length === 0
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.startsWith("."))
    || segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))
  ) return null;
  if (segments.at(-1)!.length > 255) return null;
  const normalized = path.posix.normalize(raw);
  return normalized === raw ? normalized : null;
}

export function imagePathFromReadInput(input: string): string | null {
  try {
    const value = JSON.parse(input) as Record<string, unknown>;
    const candidate = [value.filePath, value.file_path, value.path].find((entry) => typeof entry === "string");
    if (typeof candidate !== "string") return null;
    const relative = relativeCandidate(candidate);
    if (!relative || !RASTER_EXTENSIONS.has(path.posix.extname(relative).toLowerCase())) return null;
    return relative;
  } catch {
    return null;
  }
}

function insideWorkspace(realPath: string): boolean {
  return realPath === WORKDIR || realPath.startsWith(`${WORKDIR}/`);
}

async function safeFile(
  fs: SandboxOutputFileSystem,
  relativePath: string,
  maxFileBytes: number,
  signal?: AbortSignal,
): Promise<RunOutputFile | null> {
  const normalized = relativeCandidate(relativePath);
  if (!normalized) return null;
  const absolute = `${WORKDIR}/${normalized}`;
  try {
    const stat = await fs.lstat(absolute, { signal });
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxFileBytes) return null;
    const real = await fs.realpath(absolute, { signal });
    if (!insideWorkspace(real) || real !== absolute) return null;
    const data = await fs.readFile(absolute, { signal });
    if (data.length <= 0 || data.length > maxFileBytes || data.length !== stat.size) return null;
    return { path: normalized, data, byteSize: data.length };
  } catch {
    return null;
  }
}

async function artifactPaths(
  fs: SandboxOutputFileSystem,
  maxFiles: number,
  signal?: AbortSignal,
): Promise<string[]> {
  // Directory reads are not paginated by the provider. Refuse an over-broad directory before
  // sorting or statting its entries, and cap the total entries/candidates considered per scan.
  const maxScannedEntries = Math.max(maxFiles * 10, maxFiles);
  const maxCandidates = Math.max(maxFiles * 4, maxFiles);
  const found: string[] = [];
  let scannedEntries = 0;
  const queue: Array<{ absolute: string; relative: string; depth: number }> = [
    { absolute: ARTIFACTS_DIR, relative: "artifacts", depth: 0 },
  ];
  while (queue.length > 0 && found.length < maxCandidates && scannedEntries < maxScannedEntries) {
    const current = queue.shift()!;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true, signal });
    } catch {
      continue;
    }
    const remainingEntries = maxScannedEntries - scannedEntries;
    if (entries.length > remainingEntries) continue;
    scannedEntries += entries.length;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name || entry.name.startsWith(".") || EXCLUDED_SEGMENTS.has(entry.name)) continue;
      const relative = `${current.relative}/${entry.name}`;
      const absolute = `${current.absolute}/${entry.name}`;
      let stat: Stats;
      try {
        stat = await fs.lstat(absolute, { signal });
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (current.depth < 3) queue.push({ absolute, relative, depth: current.depth + 1 });
      } else if (stat.isFile()) {
        found.push(relative);
        if (found.length >= maxCandidates) break;
      }
    }
  }
  return found;
}

export async function collectSandboxOutputFiles(input: {
  fs: SandboxOutputFileSystem;
  imagePaths: string[];
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  signal?: AbortSignal;
}): Promise<RunOutputFile[]> {
  const artifactCandidates = await artifactPaths(input.fs, input.maxFiles, input.signal);
  const imageCandidates = input.imagePaths.slice(0, input.maxFiles);
  const candidates = [...new Set([...artifactCandidates, ...imageCandidates])].sort();
  const files: RunOutputFile[] = [];
  let totalBytes = 0;
  for (const candidate of candidates) {
    if (files.length >= input.maxFiles) break;
    const file = await safeFile(input.fs, candidate, input.maxFileBytes, input.signal);
    if (!file || totalBytes + file.byteSize > input.maxTotalBytes) continue;
    files.push(file);
    totalBytes += file.byteSize;
  }
  return files;
}
