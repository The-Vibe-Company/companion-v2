import { extract as tarExtract } from "tar-stream";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { toTar } from "./archive";
import { MAX_ARCHIVE_BYTES, MAX_ENTRY_COUNT, MAX_FILE_BYTES, SAFE_ENTRY_TYPES } from "./constants";

/** Resolve a tar entry name under `base`, or null if it would escape. */
function safeJoin(base: string, name: string): string | null {
  const cleaned = name.replace(/\\/g, "/");
  if (cleaned.startsWith("/") || cleaned.includes("\0") || /^[a-zA-Z]:/.test(cleaned)) return null;
  if (cleaned.split("/").some((s) => s === "..")) return null;
  const dest = resolve(base, cleaned);
  if (dest !== base && !dest.startsWith(base + sep)) return null;
  return dest;
}

/**
 * Safely unpack a tar/tar.gz buffer into `targetDir`. Every entry's destination is
 * verified to stay within the target; symlinks/hardlinks/special entries are rejected;
 * size and entry caps are re-enforced while streaming (defense-in-depth on download).
 * Returns the list of absolute file paths written.
 */
export async function unpackTo(input: Buffer, targetDir: string): Promise<string[]> {
  const tar = toTar(input);
  const target = resolve(targetDir);
  const written: string[] = [];
  let total = 0;
  let count = 0;

  await new Promise<void>((resolvePromise, reject) => {
    const ex = tarExtract();
    ex.on("entry", (header, stream, next) => {
      void (async () => {
        const type = (header.type ?? "file") as string;
        if (type === "symlink" || type === "link" || !SAFE_ENTRY_TYPES.has(type)) {
          reject(new Error(`unsafe entry rejected during unpack: ${header.name}`));
          return;
        }
        const dest = safeJoin(target, header.name ?? "");
        if (!dest) {
          reject(new Error(`path traversal rejected during unpack: ${header.name}`));
          return;
        }
        if (type === "directory") {
          await mkdir(dest, { recursive: true });
          stream.on("end", next);
          stream.resume();
          return;
        }
        count += 1;
        if (count > MAX_ENTRY_COUNT) {
          reject(new Error("archive exceeds entry-count limit during unpack"));
          return;
        }
        await mkdir(dirname(dest), { recursive: true });
        const chunks: Buffer[] = [];
        let read = 0;
        stream.on("data", (c: Buffer) => {
          read += c.length;
          total += c.length;
          if (read > MAX_FILE_BYTES || total > MAX_ARCHIVE_BYTES) {
            reject(new Error("archive exceeds size limit during unpack"));
            return;
          }
          chunks.push(c);
        });
        stream.on("end", () => {
          void writeFile(dest, Buffer.concat(chunks), { mode: 0o644 })
            .then(() => {
              written.push(dest);
              next();
            })
            .catch(reject);
        });
        stream.on("error", reject);
      })().catch(reject);
    });
    ex.on("finish", () => resolvePromise());
    ex.on("error", reject);
    ex.end(tar);
  });

  return written;
}
