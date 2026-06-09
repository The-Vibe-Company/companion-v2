import { pack as tarPack } from "tar-stream";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export const VALID_SKILL_MD = `---
name: pdf-extract
version: 2.3.1
description: Extract text, tables, and metadata from PDF documents.
license: MIT
tools:
  - read_file
  - run_python
---

# pdf-extract

Extracts text, tables, and metadata from PDF documents.
`;

/** Build a SKILL.md with overridable frontmatter lines. */
export function skillMd(frontmatter: string, body = "# skill\n"): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

export async function makeSkillDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "companion-skill-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
  return dir;
}

export async function mkTmpDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "companion-out-"));
}

export interface TarEntrySpec {
  name: string;
  type?: "file" | "directory" | "symlink" | "link";
  content?: string;
  linkname?: string;
  /** Override the declared size in the header (for zip-bomb / oversize tests). */
  size?: number;
}

/** Craft an arbitrary tar (including malicious entries) for adversarial tests. */
export function buildTar(entries: TarEntrySpec[]): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const p = tarPack();
    const chunks: Buffer[] = [];
    p.on("data", (c: Buffer) => chunks.push(c));
    p.on("end", () => resolve(Buffer.concat(chunks)));
    p.on("error", reject);
    void (async () => {
      for (const e of entries) {
        const type = e.type ?? "file";
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const header: any = { name: e.name, type, mode: 0o644, mtime: new Date(0) };
        if (type === "symlink" || type === "link") {
          header.linkname = e.linkname ?? "target";
          header.size = 0;
          await new Promise<void>((res, rej) => p.entry(header, (err) => (err ? rej(err) : res())));
        } else {
          const content = e.content !== undefined ? Buffer.from(e.content) : Buffer.alloc(0);
          header.size = e.size ?? content.length;
          await new Promise<void>((res, rej) =>
            p.entry(header, content, (err) => (err ? rej(err) : res())),
          );
        }
      }
      p.finalize();
    })().catch(reject);
  });
}
