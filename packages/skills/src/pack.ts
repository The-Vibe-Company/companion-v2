import { pack as tarPack } from "tar-stream";
import { gzipSync } from "node:zlib";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scanDir } from "./archive";
import { skillChecksum } from "./checksum";
import { SKILL_FILE } from "./constants";

export interface PackResult {
  /** Canonical (uncompressed) tar — the bytes the checksum is computed over. */
  tar: Buffer;
  /** The gzipped archive to upload / store. */
  archive: Buffer;
  /** `sha256:...` over the canonical tar. */
  checksum: string;
  /** Sorted relpaths included. */
  files: string[];
  /** Stored archive size in bytes (the gzipped archive). */
  sizeBytes: number;
}

/**
 * Pack a skill directory into a DETERMINISTIC archive: files sorted bytewise,
 * normalized tar headers (mtime 0, uid/gid 0, fixed modes). Same input bytes →
 * same archive → same checksum, on any machine. Rejects symlinks and missing SKILL.md.
 */
export async function packDir(dir: string): Promise<PackResult> {
  const scan = await scanDir(dir);
  if (scan.violations.length) {
    throw new Error(`cannot pack ${dir}: ${scan.violations[0]}`);
  }
  if (!scan.files.some((f) => f.relPath.split("/").pop() === SKILL_FILE)) {
    throw new Error(`cannot pack ${dir}: ${SKILL_FILE} not found`);
  }

  const pack = tarPack();
  const chunks: Buffer[] = [];
  pack.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<void>((resolve, reject) => {
    pack.on("end", () => resolve());
    pack.on("error", reject);
  });

  for (const f of scan.files) {
    const content = await readFile(join(dir, f.relPath));
    await new Promise<void>((resolve, reject) => {
      pack.entry(
        {
          name: f.relPath,
          size: content.length,
          mode: f.mode,
          mtime: new Date(0),
          type: "file",
          uid: 0,
          gid: 0,
          uname: "",
          gname: "",
        },
        content,
        (err) => (err ? reject(err) : resolve()),
      );
    });
  }
  pack.finalize();
  await done;

  const tar = Buffer.concat(chunks);
  const archive = gzipSync(tar, { level: 9 });
  return {
    tar,
    archive,
    checksum: skillChecksum(tar),
    files: scan.files.map((f) => f.relPath),
    sizeBytes: archive.length,
  };
}
