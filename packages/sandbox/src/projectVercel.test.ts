import { beforeEach, describe, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const { get, getOrCreate } = vi.hoisted(() => ({
  get: vi.fn(),
  getOrCreate: vi.fn(),
}));

vi.mock("@vercel/sandbox", () => ({
  Sandbox: { get, getOrCreate },
  APIError: class APIError extends Error {
    constructor(readonly response: Response) {
      super(`provider returned ${response.status}`);
    }
  },
}));

import {
  createVercelProjectWorkspaceRuntime,
  isHealthyProjectHealthResponse,
  SAFE_PROJECT_CAPTURE_SCRIPT,
} from "./projectVercel";

const execFileAsync = promisify(execFile);

const ref = {
  sandboxName: "project-org00000-proj0000",
  sandboxId: null,
  region: "iad1",
  timeoutMs: 3_600_000,
};

function fakeSandbox() {
  const extendTimeout = vi.fn(async () => undefined);
  const stat = (kind: "directory" | "file" | "symlink", size = 0) => ({
    dev: 1,
    ino: kind === "directory" ? 1 : 2,
    size,
    mtime: new Date("2026-07-23T20:00:00.000Z"),
    mtimeMs: new Date("2026-07-23T20:00:00.000Z").getTime(),
    nlink: 1,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  });
  return {
    name: ref.sandboxName,
    status: "running",
    expiresAt: new Date("2026-07-23T21:00:00.000Z"),
    currentSnapshotId: "snapshot-current",
    domain: vi.fn(() => "https://project.invalid"),
    currentSession: vi.fn(() => ({ extendTimeout })),
    runCommand: vi.fn(async () => undefined),
    writeFiles: vi.fn(async () => undefined),
    fs: {
      mkdir: vi.fn(async () => undefined),
      rm: vi.fn(async () => undefined),
      unlink: vi.fn(async () => undefined),
      exists: vi.fn(async () => true),
      rename: vi.fn(async () => undefined),
      symlink: vi.fn(async () => undefined),
      readlink: vi.fn(async () => "../.claude"),
      lstat: vi.fn(async (filePath: string) =>
        filePath === "/vercel/sandbox/files/.claude"
          ? stat("symlink")
          : stat("directory")),
      realpath: vi.fn(async (filePath: string) =>
        filePath === "/vercel/sandbox/files/.claude"
          ? "/vercel/sandbox/.claude"
          : filePath),
      readdir: vi.fn(async () => []),
      readFile: vi.fn(async () => Buffer.alloc(0)),
      writeFile: vi.fn(async () => undefined),
    },
  };
}

describe("persistent Vercel Project workspace", () => {
  beforeEach(() => {
    get.mockReset();
    getOrCreate.mockReset();
  });

  it("creates a missing deterministic sandbox with durable snapshot retention", async () => {
    const { APIError } = await import("@vercel/sandbox");
    const sandbox = fakeSandbox();
    get.mockRejectedValueOnce(new APIError(new Response(null, { status: 404 })));
    getOrCreate.mockResolvedValueOnce(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.activate({
      ref,
      sourceSnapshotId: "golden-or-checkpoint",
    })).resolves.toEqual({
      sandboxId: ref.sandboxName,
      domain: "https://project.invalid",
      resumed: false,
      restoredFromSnapshot: true,
    });

    expect(getOrCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: ref.sandboxName,
      source: { type: "snapshot", snapshotId: "golden-or-checkpoint" },
      persistent: true,
      snapshotExpiration: 0,
      keepLastSnapshots: { count: 3, expiration: 0, deleteEvicted: true },
      ports: [4096],
      timeout: ref.timeoutMs,
    }));
    expect(sandbox.fs.writeFile).toHaveBeenCalledWith(
      "/vercel/sandbox/opencode.json",
      expect.stringContaining('"permission"'),
      { signal: undefined },
    );
  });

  it("resumes a stopped named Project instead of creating a second sandbox", async () => {
    const stopped = { ...fakeSandbox(), status: "stopped" };
    const resumed = fakeSandbox();
    get.mockResolvedValueOnce(stopped).mockResolvedValueOnce(resumed);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.activate({ ref, sourceSnapshotId: "checkpoint" })).resolves.toEqual({
      sandboxId: ref.sandboxName,
      domain: "https://project.invalid",
      resumed: true,
      restoredFromSnapshot: false,
    });
    expect(get).toHaveBeenNthCalledWith(1, expect.objectContaining({ resume: false }));
    expect(get).toHaveBeenNthCalledWith(2, expect.objectContaining({ resume: true }));
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("waits for a snapshotting named Project to resume instead of treating its VM as running", async () => {
    const snapshotting = { ...fakeSandbox(), status: "snapshotting" };
    const resumed = fakeSandbox();
    get.mockResolvedValueOnce(snapshotting).mockResolvedValueOnce(resumed);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.activate({ ref, sourceSnapshotId: "checkpoint" })).resolves.toEqual({
      sandboxId: ref.sandboxName,
      domain: "https://project.invalid",
      resumed: true,
      restoredFromSnapshot: false,
    });
    expect(get).toHaveBeenNthCalledWith(1, expect.objectContaining({ resume: false }));
    expect(get).toHaveBeenNthCalledWith(2, expect.objectContaining({ resume: true }));
    expect(getOrCreate).not.toHaveBeenCalled();
  });

  it("does not expose provider exception details through activation errors", async () => {
    const sentinel = "provider-token-and-topology-must-not-leak";
    get.mockRejectedValueOnce(new Error(`request failed with ${sentinel}`));
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    const failure = await runtime.activate({
      ref,
      sourceSnapshotId: "golden-or-checkpoint",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Project workspace activation failed");
    expect(JSON.stringify(failure)).not.toContain(sentinel);
    expect((failure as Error).stack).not.toContain(sentinel);
  });

  it("checkpoints with no expiration before idle suspension", async () => {
    const snapshot = vi.fn(async () => ({ snapshotId: "checkpoint-2" }));
    get.mockResolvedValueOnce({ ...fakeSandbox(), snapshot });
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.checkpointAndStop(ref)).resolves.toEqual({
      snapshotId: "checkpoint-2",
    });
    expect(snapshot).toHaveBeenCalledWith({ expiration: 0, signal: undefined });
  });

  it("observes a snapshotting Project as stopped without reading a live session", async () => {
    const sandbox = {
      ...fakeSandbox(),
      status: "snapshotting",
      currentSession: vi.fn(() => {
        throw new Error("snapshotting Projects have no live session to inspect");
      }),
    };
    get.mockResolvedValueOnce(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.observe(ref)).resolves.toEqual({
      state: "stopped",
      startedAt: null,
      expiresAt: sandbox.expiresAt,
      currentSnapshotId: "snapshot-current",
    });
    expect(sandbox.currentSession).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledWith(expect.objectContaining({ resume: false }));
  });

  it("extends only the current running session and re-observes provider truth", async () => {
    const initial = fakeSandbox();
    const extended = {
      ...fakeSandbox(),
      expiresAt: new Date("2026-07-23T22:00:00.000Z"),
    };
    get.mockResolvedValueOnce(initial).mockResolvedValueOnce(extended);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.extendTimeout(ref, 600_000)).resolves.toEqual({
      state: "running",
      expiresAt: extended.expiresAt,
      currentSnapshotId: "snapshot-current",
    });
    expect(initial.currentSession().extendTimeout).toHaveBeenCalledWith(600_000, {
      signal: undefined,
    });
    expect(get).toHaveBeenNthCalledWith(1, expect.objectContaining({ resume: false }));
    expect(get).toHaveBeenNthCalledWith(2, expect.objectContaining({ resume: false }));
  });

  it("runs OpenCode from the managed Files surface while keeping config outside it", async () => {
    const sandbox = fakeSandbox();
    get.mockResolvedValueOnce(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await runtime.startServer({
      ref,
      env: { OPENAI_API_KEY: "injected" },
    });

    expect(sandbox.runCommand).toHaveBeenLastCalledWith(expect.objectContaining({
      cwd: "/vercel/sandbox/files",
      env: {
        OPENAI_API_KEY: "injected",
        OPENCODE_CONFIG: "/vercel/sandbox/opencode.json",
      },
      detached: true,
    }));
  });

  it("restores the complete previous skill projection when the atomic swap fails", async () => {
    const sandbox = fakeSandbox();
    const written = new Map<string, Uint8Array>();
    const rename = vi.fn(async (source: string, destination: string) => {
      if (source.includes("skills.staging-2") && destination.endsWith("/skills")) {
        throw new Error("provider rename failed");
      }
    });
    Object.assign(sandbox.fs, {
      rm: vi.fn(async () => undefined),
      readFile: vi.fn(async (filePath: string) => written.get(filePath) ?? Buffer.alloc(0)),
      exists: vi.fn(async () => true),
      rename,
    });
    Object.assign(sandbox, {
      writeFiles: vi.fn(async (
        files: Array<{ path: string; content: Uint8Array }>,
      ) => {
        for (const file of files) written.set(file.path, file.content);
      }),
    });
    get.mockResolvedValueOnce(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.syncSkillBundles({
      ref,
      generation: 2,
      skills: [{
        slug: "research",
        version: "1.0.0",
        files: [{
          path: "SKILL.md",
          data: Buffer.from("# Research"),
          executable: false,
        }],
      }],
    })).rejects.toThrow("provider rename failed");

    expect(sandbox.runCommand).toHaveBeenCalledWith(expect.objectContaining({
      args: ["-c", "pkill -f '[o]pencode serve' || true"],
    }));
    expect(sandbox.writeFiles).toHaveBeenCalledOnce();
    expect(rename).toHaveBeenNthCalledWith(
      1,
      "/vercel/sandbox/.claude/skills",
      "/vercel/sandbox/.claude/skills.previous",
      { signal: undefined },
    );
    expect(rename).toHaveBeenNthCalledWith(
      3,
      "/vercel/sandbox/.claude/skills.previous",
      "/vercel/sandbox/.claude/skills",
      { signal: undefined },
    );
  });

  it("removes a post-swap-invalid skill tree before restoring the complete previous projection", async () => {
    const sandbox = fakeSandbox();
    const currentDir = "/vercel/sandbox/.claude/skills";
    const previousDir = "/vercel/sandbox/.claude/skills.previous";
    const stagingDir = "/vercel/sandbox/.claude/skills.staging-3";
    const written = new Map<string, Uint8Array>();
    let current: "old" | "new" | null = "old";
    let previous: "old" | null = null;
    let staging = false;
    const rename = vi.fn(async (source: string, destination: string) => {
      if (source === currentDir && destination === previousDir) {
        expect(current).toBe("old");
        current = null;
        previous = "old";
        return;
      }
      if (source === stagingDir && destination === currentDir) {
        expect(staging).toBe(true);
        expect(current).toBeNull();
        staging = false;
        current = "new";
        return;
      }
      if (source === previousDir && destination === currentDir) {
        // This assertion is the regression: the rejected replacement must not still occupy current.
        expect(current).toBeNull();
        expect(previous).toBe("old");
        previous = null;
        current = "old";
      }
    });
    const rm = vi.fn(async (target: string) => {
      if (target === currentDir) current = null;
      if (target === previousDir) previous = null;
      if (target === stagingDir) staging = false;
    });
    Object.assign(sandbox.fs, {
      exists: vi.fn(async (target: string) => {
        if (target === currentDir) return current !== null;
        if (target === previousDir) return previous !== null;
        if (target === stagingDir) return staging;
        return true;
      }),
      mkdir: vi.fn(async (target: string) => {
        if (target === stagingDir) staging = true;
      }),
      rm,
      rename,
      realpath: vi.fn(async (target: string) =>
        target === currentDir && current === "new"
          ? "/vercel/sandbox/.claude/escaped"
          : target),
      readFile: vi.fn(async (filePath: string) => written.get(filePath) ?? Buffer.alloc(0)),
    });
    Object.assign(sandbox, {
      writeFiles: vi.fn(async (
        files: Array<{ path: string; content: Uint8Array }>,
      ) => {
        for (const file of files) written.set(file.path, file.content);
      }),
    });
    get.mockResolvedValueOnce(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.syncSkillBundles({
      ref,
      generation: 3,
      skills: [{
        slug: "research",
        version: "1.0.0",
        files: [{
          path: "SKILL.md",
          data: Buffer.from("# Research"),
          executable: false,
        }],
      }],
    })).rejects.toThrow("escaped its root");

    expect(rename).toHaveBeenCalledTimes(3);
    expect(rename).toHaveBeenNthCalledWith(2, stagingDir, currentDir, { signal: undefined });
    expect(rm).toHaveBeenCalledWith(currentDir, {
      recursive: true,
      force: true,
      signal: undefined,
    });
    expect(rename).toHaveBeenNthCalledWith(3, previousDir, currentDir, { signal: undefined });
    expect(current).toBe("old");
    expect(previous).toBeNull();
  });

  it("restores the previous managed files projection when its exact swap fails", async () => {
    const sandbox = fakeSandbox();
    const rename = vi.fn(async (source: string, destination: string) => {
      if (source.endsWith("/files.staging") && destination.endsWith("/files")) {
        throw new Error("provider files rename failed");
      }
    });
    Object.assign(sandbox.fs, {
      rm: vi.fn(async () => undefined),
      exists: vi.fn(async () => true),
      rename,
    });
    Object.assign(sandbox, {
      writeFiles: vi.fn(async () => undefined),
    });
    get.mockResolvedValueOnce(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.syncFiles({
      ref,
      files: [],
    })).rejects.toThrow("provider files rename failed");

    expect(rename).toHaveBeenNthCalledWith(
      1,
      "/vercel/sandbox/files",
      "/vercel/sandbox/files.previous",
      { signal: undefined },
    );
    expect(rename).toHaveBeenNthCalledWith(
      3,
      "/vercel/sandbox/files.previous",
      "/vercel/sandbox/files",
      { signal: undefined },
    );
  });

  it("removes a post-swap-invalid Files tree before restoring the complete previous projection", async () => {
    const sandbox = fakeSandbox();
    const currentDir = "/vercel/sandbox/files";
    const previousDir = "/vercel/sandbox/files.previous";
    const stagingDir = "/vercel/sandbox/files.staging";
    let current: "old" | "new" | null = "old";
    let previous: "old" | null = null;
    let staging = false;
    const rename = vi.fn(async (source: string, destination: string) => {
      if (source === currentDir && destination === previousDir) {
        expect(current).toBe("old");
        current = null;
        previous = "old";
        return;
      }
      if (source === stagingDir && destination === currentDir) {
        expect(staging).toBe(true);
        expect(current).toBeNull();
        staging = false;
        current = "new";
        return;
      }
      if (source === previousDir && destination === currentDir) {
        // A directory rename cannot replace the rejected non-empty projection in place.
        expect(current).toBeNull();
        expect(previous).toBe("old");
        previous = null;
        current = "old";
      }
    });
    const rm = vi.fn(async (target: string) => {
      if (target === currentDir) current = null;
      if (target === previousDir) previous = null;
      if (target === stagingDir) staging = false;
    });
    Object.assign(sandbox.fs, {
      exists: vi.fn(async (target: string) => {
        if (target === currentDir) return current !== null;
        if (target === previousDir) return previous !== null;
        if (target === stagingDir) return staging;
        return true;
      }),
      mkdir: vi.fn(async (target: string) => {
        if (target === stagingDir) staging = true;
      }),
      rm,
      rename,
      realpath: vi.fn(async (target: string) =>
        target === currentDir && current === "new"
          ? "/vercel/sandbox/escaped"
          : target),
    });
    Object.assign(sandbox, {
      writeFiles: vi.fn(async () => undefined),
    });
    get.mockResolvedValueOnce(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.syncFiles({
      ref,
      files: [],
    })).rejects.toThrow("escaped its root");

    expect(rename).toHaveBeenCalledTimes(3);
    expect(rename).toHaveBeenNthCalledWith(2, stagingDir, currentDir, { signal: undefined });
    expect(rm).toHaveBeenCalledWith(currentDir, {
      recursive: true,
      force: true,
      signal: undefined,
    });
    expect(rename).toHaveBeenNthCalledWith(3, previousDir, currentDir, { signal: undefined });
    expect(current).toBe("old");
    expect(previous).toBeNull();
  });

  it("fails closed when the managed Files root is a symlink", async () => {
    const sandbox = fakeSandbox();
    vi.mocked(sandbox.fs.lstat).mockImplementation(async (filePath: string) => ({
      dev: 1,
      ino: 9,
      size: 0,
      mtime: new Date(),
      mtimeMs: Date.now(),
      nlink: 1,
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => filePath === "/vercel/sandbox/files",
    }) as never);
    get.mockResolvedValueOnce(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.pushFiles({
      ref,
      files: [{ path: "report.txt", data: Buffer.from("safe") }],
    })).rejects.toThrow("not a real directory");
  });

  it("rejects a hard-linked file returned by the isolated capture manifest", async () => {
    const sandbox = fakeSandbox();
    const bytes = Buffer.from("data");
    const sha256 = await import("node:crypto")
      .then(({ createHash }) => createHash("sha256").update(bytes).digest("hex"));
    vi.mocked(sandbox.runCommand).mockResolvedValue({
      exitCode: 0,
      stdout: vi.fn(async () => JSON.stringify([{
        path: "report.txt",
        size: bytes.length,
        mtimeMs: 1,
        sha256,
      }])),
    } as never);
    vi.mocked(sandbox.fs.lstat).mockImplementation(async (filePath: string) => {
      const file = filePath.endsWith("/report.txt");
      return {
        dev: 1,
        ino: file ? 9 : 1,
        size: file ? bytes.length : 0,
        mtime: new Date(1),
        mtimeMs: 1,
        nlink: file ? 2 : 1,
        isDirectory: () => !file,
        isFile: () => file,
        isSymbolicLink: () => false,
      } as never;
    });
    get.mockResolvedValueOnce(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    await expect(runtime.listFiles({
      ref,
      maxFiles: 10,
      maxFileBytes: 1_024,
      maxTotalBytes: 10_240,
    })).rejects.toThrow("isolated regular file");
  });

  it("rejects every control-plane-reserved root from the Files projection", async () => {
    const sandbox = fakeSandbox();
    Object.assign(sandbox, { writeFiles: vi.fn(async () => undefined) });
    get.mockResolvedValue(sandbox);
    const runtime = createVercelProjectWorkspaceRuntime({
      token: "token",
      teamId: "team",
      projectId: "provider-project",
      vcpus: 2,
    });

    for (const reserved of [".claude", ".companion", ".git", ".opencode"]) {
      await expect(runtime.syncFiles({
        ref,
        files: [{ path: `${reserved}/hidden`, data: Buffer.from("no") }],
      })).rejects.toThrow("Companion-reserved path");
    }
  });

  it("isolated capture omits every hidden system root", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "companion-project-capture-"));
    const root = path.join(directory, "files");
    const capture = path.join(directory, "capture");
    try {
      await mkdir(root);
      await writeFile(path.join(root, "visible.txt"), "visible");
      for (const reserved of [".claude", ".companion", ".git", ".opencode"]) {
        await mkdir(path.join(root, reserved));
        await writeFile(path.join(root, reserved, "hidden"), "hidden");
      }
      const { stdout } = await execFileAsync("python3", [
        "-c",
        SAFE_PROJECT_CAPTURE_SCRIPT,
        root,
        capture,
        "10",
        "1024",
        "10240",
      ]);
      expect(JSON.parse(stdout)).toEqual([
        expect.objectContaining({ path: "visible.txt", size: 7 }),
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("isolated capture rejects persistent hard links", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "companion-project-hardlink-"));
    const root = path.join(directory, "files");
    const capture = path.join(directory, "capture");
    try {
      await mkdir(root);
      await writeFile(path.join(root, "first.txt"), "same inode");
      await link(path.join(root, "first.txt"), path.join(root, "second.txt"));
      await expect(execFileAsync("python3", [
        "-c",
        SAFE_PROJECT_CAPTURE_SCRIPT,
        root,
        capture,
        "10",
        "1024",
        "10240",
      ])).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("accepts only the authenticated v2 health document", async () => {
    for (const status of [401, 404, 500]) {
      await expect(isHealthyProjectHealthResponse(
        new Response(JSON.stringify({ healthy: true }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      )).resolves.toBe(false);
    }
    await expect(isHealthyProjectHealthResponse(
      new Response(JSON.stringify({ healthy: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )).resolves.toBe(false);
    await expect(isHealthyProjectHealthResponse(
      new Response(JSON.stringify({ healthy: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    )).resolves.toBe(true);
  });
});
