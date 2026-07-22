import type { Dirent, Stats } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  collectSandboxOutputFiles,
  imagePathFromReadInput,
  type SandboxOutputFileSystem,
} from "../src/outputFiles";

type Node = { kind: "file" | "directory" | "symlink" | "socket"; data?: Buffer; real?: string };

function fakeFs(nodes: Record<string, Node>): SandboxOutputFileSystem {
  const missing = () => Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  const stat = (node: Node): Stats => ({
    size: node.data?.length ?? 0,
    isFile: () => node.kind === "file",
    isDirectory: () => node.kind === "directory",
    isSymbolicLink: () => node.kind === "symlink",
  }) as Stats;
  return {
    async readdir(directory) {
      const prefix = `${directory}/`;
      const names = [...new Set(Object.keys(nodes)
        .filter((candidate) => candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes("/"))
        .map((candidate) => candidate.slice(prefix.length)))];
      if (!nodes[directory] || nodes[directory]?.kind !== "directory") throw missing();
      return names.map((name) => ({ name } as Dirent));
    },
    async lstat(file) {
      const node = nodes[file];
      if (!node) throw missing();
      return stat(node);
    },
    async realpath(file) {
      const node = nodes[file];
      if (!node) throw missing();
      return node.real ?? file;
    },
    async readFile(file) {
      const node = nodes[file];
      if (!node?.data) throw missing();
      return node.data;
    },
  };
}

describe("sandbox output collection", () => {
  it("scans only artifacts to depth three and adds explicitly read raster images", async () => {
    const root = "/vercel/sandbox";
    const nodes: Record<string, Node> = {
      [`${root}/artifacts`]: { kind: "directory" },
      [`${root}/artifacts/result.txt`]: { kind: "file", data: Buffer.from("report") },
      [`${root}/artifacts/.secret`]: { kind: "file", data: Buffer.from("hidden") },
      [`${root}/artifacts/link.png`]: { kind: "symlink", real: "/etc/passwd" },
      [`${root}/artifacts/socket`]: { kind: "socket" },
      [`${root}/artifacts/a`]: { kind: "directory" },
      [`${root}/artifacts/a/b`]: { kind: "directory" },
      [`${root}/artifacts/a/b/c`]: { kind: "directory" },
      [`${root}/artifacts/a/b/c/kept.txt`]: { kind: "file", data: Buffer.from("kept") },
      [`${root}/artifacts/a/b/c/d`]: { kind: "directory" },
      [`${root}/artifacts/a/b/c/d/too-deep.txt`]: { kind: "file", data: Buffer.from("deep") },
      [`${root}/plans/images/cat.png`]: { kind: "file", data: Buffer.from("png") },
      [`${root}/unrelated.txt`]: { kind: "file", data: Buffer.from("never scan") },
    };
    const files = await collectSandboxOutputFiles({
      fs: fakeFs(nodes),
      imagePaths: ["plans/images/cat.png", "plans/images/cat.png", "../escape.png"],
      maxFiles: 20,
      maxFileBytes: 1024,
      maxTotalBytes: 4096,
    });
    expect(files.map((file) => file.path)).toEqual([
      "artifacts/a/b/c/kept.txt",
      "artifacts/result.txt",
      "plans/images/cat.png",
    ]);
  });

  it("enforces per-file, count and total byte limits", async () => {
    const root = "/vercel/sandbox";
    const nodes: Record<string, Node> = {
      [`${root}/artifacts`]: { kind: "directory" },
      [`${root}/artifacts/a.txt`]: { kind: "file", data: Buffer.alloc(4) },
      [`${root}/artifacts/b.txt`]: { kind: "file", data: Buffer.alloc(4) },
      [`${root}/artifacts/large.txt`]: { kind: "file", data: Buffer.alloc(9) },
    };
    const files = await collectSandboxOutputFiles({
      fs: fakeFs(nodes), imagePaths: [], maxFiles: 2, maxFileBytes: 8, maxTotalBytes: 7,
    });
    expect(files.map((file) => file.path)).toEqual(["artifacts/a.txt"]);
  });

  it("refuses an over-broad directory before issuing per-entry stat calls", async () => {
    const root = "/vercel/sandbox";
    const nodes: Record<string, Node> = { [`${root}/artifacts`]: { kind: "directory" } };
    for (let index = 0; index < 201; index += 1) {
      nodes[`${root}/artifacts/file-${index}.txt`] = { kind: "file", data: Buffer.from("x") };
    }
    const fs = fakeFs(nodes);
    const lstat = vi.spyOn(fs, "lstat");
    await expect(collectSandboxOutputFiles({
      fs, imagePaths: [], maxFiles: 20, maxFileBytes: 1024, maxTotalBytes: 4096,
    })).rejects.toThrow("safe scan limit");
    expect(lstat).not.toHaveBeenCalled();
  });

  it("fails an incomplete artifact scan instead of publishing omissions as deletions", async () => {
    const root = "/vercel/sandbox";
    const fs = fakeFs({
      [`${root}/artifacts`]: { kind: "directory" },
      [`${root}/artifacts/report.txt`]: { kind: "file", data: Buffer.from("report") },
    });
    fs.lstat = vi.fn(async () => { throw new Error("provider temporarily unavailable"); });

    await expect(collectSandboxOutputFiles({
      fs, imagePaths: [], maxFiles: 20, maxFileBytes: 1024, maxTotalBytes: 4096,
    })).rejects.toThrow("provider temporarily unavailable");
  });
});

describe("read tool image candidates", () => {
  it("accepts raster paths and rejects traversal, hidden and attachment paths", () => {
    expect(imagePathFromReadInput('{"filePath":"plans/images/cat.png"}')).toBe("plans/images/cat.png");
    expect(imagePathFromReadInput('{"path":"/vercel/sandbox/output/photo.webp"}')).toBe("output/photo.webp");
    expect(imagePathFromReadInput('{"path":"../cat.png"}')).toBeNull();
    expect(imagePathFromReadInput('{"path":".claude/skills/x/cat.png"}')).toBeNull();
    expect(imagePathFromReadInput('{"path":"attachments/cat.png"}')).toBeNull();
    expect(imagePathFromReadInput('{"path":"plans/images/cat.svg"}')).toBeNull();
  });
});
