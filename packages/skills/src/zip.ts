import { unzipSync, zipSync, type UnzipFileInfo } from "fflate";
import { extract as tarExtract, pack as tarPack } from "tar-stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { normalizePosix, toTar } from "./archive";
import { unpackTo } from "./unpack";
import { MAX_ARCHIVE_BYTES, MAX_ENTRY_COUNT, MAX_FILE_BYTES } from "./constants";

interface SeenPortableZipPath {
  display: string;
  kind: "directory" | "file";
}

function registerPortableZipPath(seen: Map<string, SeenPortableZipPath>, path: string): string | null {
  const segments = path.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const display = segments.slice(0, index + 1).join("/");
    const key = display.normalize("NFC").toLocaleLowerCase("en-US");
    const kind = index === segments.length - 1 ? "file" : "directory";
    const previous = seen.get(key);
    if (
      previous
      && (
        previous.display !== display
        || previous.kind !== kind
        || (index === segments.length - 1 && kind === "file")
      )
    ) {
      return `duplicate or Windows-colliding archive path: ${path}`;
    }
    if (!previous) seen.set(key, { display, kind });
  }
  return null;
}

/** PKZIP local-file-header (`PK\x03\x04`) or empty-archive EOCD (`PK\x05\x06`) magic. */
export function isZip(buf: Buffer): boolean {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    ((buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06))
  );
}

/**
 * Decompress a zip into an in-memory `{ relpath: bytes }` map. Directory entries are
 * dropped. Caps are enforced from the central-directory `originalSize` BEFORE inflating
 * each entry (the `filter` runs pre-decompression), so a zip bomb is rejected without
 * being expanded — memory stays bounded by MAX_ARCHIVE_BYTES.
 */
function readZipEntries(input: Buffer): Record<string, Uint8Array> {
  let total = 0;
  let count = 0;
  const raw = unzipSync(input, {
    filter(file: UnzipFileInfo): boolean {
      if (file.name.endsWith("/")) return false; // directory entry
      if (file.originalSize > MAX_FILE_BYTES) {
        throw new Error(`archive entry exceeds size limit: ${file.name}`);
      }
      count += 1;
      if (count > MAX_ENTRY_COUNT) throw new Error("archive exceeds entry-count limit");
      total += file.originalSize;
      if (total > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds size limit");
      return true;
    },
  });
  // Defense-in-depth: re-check the ACTUAL decompressed sizes, not just the header-declared
  // `originalSize`, in case an archive understates its sizes.
  let actual = 0;
  for (const name of Object.keys(raw)) {
    const len = raw[name]!.length;
    if (len > MAX_FILE_BYTES) throw new Error(`archive entry exceeds size limit: ${name}`);
    actual += len;
    if (actual > MAX_ARCHIVE_BYTES) throw new Error("archive exceeds size limit");
  }
  return raw;
}

/**
 * Convert a zip buffer into an uncompressed tar buffer, so the existing tar-based
 * inspection/validation pipeline can read it. Entry paths are normalized; anything that
 * traverses out of the package root is dropped (and surfaces as a missing/invalid skill).
 */
export async function zipToTar(input: Buffer): Promise<Buffer> {
  const entries = readZipEntries(input);
  const pack = tarPack();
  const chunks: Buffer[] = [];
  pack.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolvePromise, reject) => {
    pack.on("end", () => resolvePromise());
    pack.on("error", reject);
  });
  for (const name of Object.keys(entries).sort()) {
    // Preserve the raw entry name (don't silently drop unsafe entries) so the downstream
    // tar inspector flags traversal/unsafe paths and validation fails instead of passing.
    pack.entry({ name, mode: 0o644, mtime: new Date(0) }, Buffer.from(entries[name]!));
  }
  pack.finalize();
  await done;
  return Buffer.concat(chunks);
}

/** Resolve a zip entry name under `base`, or null if it escapes or names the root itself. */
function safeJoin(base: string, name: string): string | null {
  const norm = normalizePosix(name);
  if (norm.violation || !norm.path) return null; // empty path would write to `base` itself
  const dest = resolve(base, norm.path);
  if (dest !== base && !dest.startsWith(base + sep)) return null;
  return dest;
}

/**
 * Safely unpack a zip buffer into `targetDir`. Every entry stays within the target;
 * traversal is rejected; size/entry caps are re-enforced. Returns absolute paths written.
 */
export async function unzipToDir(input: Buffer, targetDir: string): Promise<string[]> {
  const entries = readZipEntries(input);
  const target = resolve(targetDir);
  const written: string[] = [];
  for (const name of Object.keys(entries).sort()) {
    const dest = safeJoin(target, name);
    if (!dest) throw new Error(`path traversal rejected during unpack: ${name}`);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, Buffer.from(entries[name]!), { mode: 0o644 });
    written.push(dest);
  }
  return written;
}

/** Unpack any supported package buffer (zip or tar/tar.gz) into `targetDir`. */
export async function unpackAnyTo(input: Buffer, targetDir: string): Promise<string[]> {
  return isZip(input) ? unzipToDir(input, targetDir) : unpackTo(input, targetDir);
}

/**
 * Repackage a stored canonical tar.gz archive into a zip buffer for human/agent download
 * (the registry serves `.zip` so the mock's `unzip <id>.zip` works). Only regular files
 * are carried over; tar headers are dropped.
 */
export async function tarGzToZip(archive: Buffer): Promise<Buffer> {
  const tar = toTar(archive);
  const entries: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  const seenPortablePaths = new Map<string, SeenPortableZipPath>();
  let total = 0;
  let count = 0;
  await new Promise<void>((resolvePromise, reject) => {
    let failed = false;
    const ex = tarExtract();
    ex.on("entry", (header, stream, next) => {
      const type = (header.type ?? "file") as string;
      if (failed) {
        stream.on("end", next);
        stream.resume();
        return;
      }
      if (type === "directory") {
        stream.on("end", next);
        stream.resume();
        return;
      }
      if (type !== "file") {
        failed = true;
        reject(new Error(`unsafe archive entry type '${type}': ${header.name ?? ""}`));
        stream.on("end", next);
        stream.resume();
        return;
      }
      const norm = normalizePosix(header.name ?? "");
      const collision = !norm.violation && norm.path
        ? registerPortableZipPath(seenPortablePaths, norm.path)
        : null;
      if (norm.violation || !norm.path || collision) {
        failed = true;
        reject(new Error(norm.violation ?? collision ?? "empty archive path"));
        stream.on("end", next);
        stream.resume();
        return;
      }
      count += 1;
      if (count > MAX_ENTRY_COUNT) {
        failed = true;
        reject(new Error("archive exceeds entry-count limit"));
        stream.on("end", next);
        stream.resume();
        return;
      }
      const chunks: Buffer[] = [];
      let read = 0;
      stream.on("data", (c: Buffer) => {
        if (failed) return;
        read += c.length;
        total += c.length;
        // Guardrail even though the stored archive was size-validated on upload.
        if (read > MAX_FILE_BYTES || total > MAX_ARCHIVE_BYTES) {
          failed = true;
          reject(new Error("archive exceeds size limit"));
          return;
        }
        chunks.push(c);
      });
      stream.on("end", () => {
        if (!failed) entries[norm.path] = Buffer.concat(chunks);
        next();
      });
      stream.on("error", reject);
    });
    ex.on("finish", () => resolvePromise());
    ex.on("error", reject);
    ex.end(tar);
  });
  // fflate otherwise stamps each entry with the current wall clock, making the transport checksum
  // change every time the same immutable version is promoted or downloaded. The ZIP epoch is the
  // earliest DOS timestamp supported by the format; constructing it in local time keeps the encoded
  // calendar fields stable across server time zones.
  return Buffer.from(zipSync(entries, { level: 6, mtime: new Date(1980, 0, 1, 0, 0, 0) }));
}
