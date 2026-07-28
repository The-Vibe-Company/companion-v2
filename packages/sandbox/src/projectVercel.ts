import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { APIError, Sandbox, Snapshot } from "@vercel/sandbox";
import {
  OPENCODE_SERVER_USERNAME,
  PROJECT_FILES_DIR,
  PROJECT_WORKDIR,
  RunRuntimeError,
  type ProjectManagedFile,
  type ProjectWorkspaceRef,
  type ProjectWorkspaceRuntime,
  type ServeEnv,
  type SkillBundle,
} from "@companion/core";
import type { VercelRuntimeConfig } from "./vercel";

const OPENCODE_PORT = 4096;
const PROJECT_SKILLS_DIR = `${PROJECT_WORKDIR}/.claude/skills`;
const PROJECT_CONFIG = `${PROJECT_WORKDIR}/opencode.json`;
const NOT_FOUND = new Set([404, 410]);
const INACTIVE_SESSION_STATUSES = new Set([
  "stopped",
  "stopping",
  "snapshotting",
  "failed",
  "aborted",
]);
const RESERVED_PROJECT_FILE_ROOTS = new Set([
  ".claude",
  ".companion",
  ".git",
  ".opencode",
]);

// All writes into the concurrently-mutated user tree use dir-fd traversal and O_NOFOLLOW inside
// one sandbox process. The provider filesystem API exposes path-based writes only, which leaves a
// check/use gap if another OpenCode session swaps an ancestor for a symlink.
export const SAFE_PROJECT_WRITE_SCRIPT = String.raw`
import base64, hashlib, json, os, stat, sys

root, stage, encoded = sys.argv[1], sys.argv[2], sys.argv[3]
items = json.loads(base64.b64decode(encoded).decode("utf-8"))
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)

def open_dir(parent_fd, name):
    return os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)

def stat_identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_nlink)

root_fd = os.open(root, os.O_RDONLY | DIRECTORY | NOFOLLOW)
stage_fd = os.open(stage, os.O_RDONLY | DIRECTORY | NOFOLLOW)
root_identity = stat_identity(os.fstat(root_fd))
try:
    for index, item in enumerate(items):
        parts = item["path"].split("/")
        if not parts or any(not part or part in (".", "..") for part in parts):
            raise RuntimeError("invalid managed path")

        source_parent = os.dup(stage_fd)
        destination_parent = os.dup(root_fd)
        try:
            for segment in parts[:-1]:
                next_source = open_dir(source_parent, segment)
                os.close(source_parent)
                source_parent = next_source
                try:
                    os.mkdir(segment, 0o755, dir_fd=destination_parent)
                except FileExistsError:
                    pass
                next_destination = open_dir(destination_parent, segment)
                os.close(destination_parent)
                destination_parent = next_destination

            leaf = parts[-1]
            source_fd = os.open(leaf, os.O_RDONLY | NOFOLLOW, dir_fd=source_parent)
            try:
                source_stat = os.fstat(source_fd)
                if not stat.S_ISREG(source_stat.st_mode) or source_stat.st_nlink != 1:
                    raise RuntimeError("upload source is not an isolated regular file")
                chunks = []
                hasher = hashlib.sha256()
                while True:
                    chunk = os.read(source_fd, 1024 * 1024)
                    if not chunk:
                        break
                    chunks.append(chunk)
                    hasher.update(chunk)
                if hasher.hexdigest() != item["sha256"]:
                    raise RuntimeError("upload source checksum changed")
            finally:
                os.close(source_fd)

            temporary = ".companion-write-%s-%s" % (index, os.getpid())
            output_fd = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
                item.get("mode", 0o644),
                dir_fd=destination_parent,
            )
            try:
                for chunk in chunks:
                    view = memoryview(chunk)
                    while view:
                        written = os.write(output_fd, view)
                        view = view[written:]
                os.fchmod(output_fd, item.get("mode", 0o644))
                os.fsync(output_fd)
            finally:
                os.close(output_fd)
            os.replace(
                temporary,
                leaf,
                src_dir_fd=destination_parent,
                dst_dir_fd=destination_parent,
            )
            destination_fd = os.open(leaf, os.O_RDONLY | NOFOLLOW, dir_fd=destination_parent)
            try:
                destination_stat = os.fstat(destination_fd)
                if not stat.S_ISREG(destination_stat.st_mode) or destination_stat.st_nlink != 1:
                    raise RuntimeError("managed destination is not an isolated regular file")
                hasher = hashlib.sha256()
                while True:
                    chunk = os.read(destination_fd, 1024 * 1024)
                    if not chunk:
                        break
                    hasher.update(chunk)
                if hasher.hexdigest() != item["sha256"]:
                    raise RuntimeError("managed destination checksum changed")
            finally:
                os.close(destination_fd)

            # Re-resolve from the original managed-root fd. If a concurrent session renamed an
            # ancestor aside, the bytes above are safe but not the visible LWW path, so fail.
            visible_parent = os.dup(root_fd)
            try:
                for segment in parts[:-1]:
                    next_visible = open_dir(visible_parent, segment)
                    os.close(visible_parent)
                    visible_parent = next_visible
                visible_fd = os.open(leaf, os.O_RDONLY | NOFOLLOW, dir_fd=visible_parent)
                try:
                    if stat_identity(os.fstat(visible_fd)) != stat_identity(destination_stat):
                        raise RuntimeError("managed destination moved during upload")
                finally:
                    os.close(visible_fd)
            finally:
                os.close(visible_parent)
        finally:
            os.close(source_parent)
            os.close(destination_parent)

    current_root = os.stat(root, follow_symlinks=False)
    if stat_identity(current_root) != root_identity:
        raise RuntimeError("managed root changed during upload")
finally:
    os.close(stage_fd)
    os.close(root_fd)
`;

// Capture first copies every regular file through stable dir fds into a random isolated tree. The
// worker reads only those copies and verifies the script-produced SHA-256 manifest.
export const SAFE_PROJECT_CAPTURE_SCRIPT = String.raw`
import hashlib, json, os, stat, sys

root, capture = sys.argv[1], sys.argv[2]
max_files, max_file_bytes, max_total_bytes = map(int, sys.argv[3:6])
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
manifest = []
scanned = 0
total = 0
reserved_roots = {".claude", ".companion", ".git", ".opencode"}

def identity(value):
    return (value.st_dev, value.st_ino, value.st_mode, value.st_size, value.st_mtime_ns, value.st_nlink)

def visit(source_fd, destination_fd, prefix, depth):
    global scanned, total
    if depth > 64:
        raise RuntimeError("managed directory nesting is too deep")
    names = sorted(os.listdir(source_fd))
    scanned += len(names)
    if scanned > max(max_files * 20, max_files):
        raise RuntimeError("managed tree exceeds the scan limit")
    for name in names:
        if depth == 0 and name in reserved_roots:
            continue
        relative = name if not prefix else prefix + "/" + name
        if len(relative) > 1024:
            raise RuntimeError("managed path is too long")
        before = os.stat(name, dir_fd=source_fd, follow_symlinks=False)
        if stat.S_ISLNK(before.st_mode):
            continue
        if stat.S_ISDIR(before.st_mode):
            child_source = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=source_fd)
            try:
                if identity(os.fstat(child_source)) != identity(before):
                    raise RuntimeError("managed directory changed during capture")
                os.mkdir(name, 0o700, dir_fd=destination_fd)
                child_destination = os.open(
                    name,
                    os.O_RDONLY | DIRECTORY | NOFOLLOW,
                    dir_fd=destination_fd,
                )
                try:
                    visit(child_source, child_destination, relative, depth + 1)
                finally:
                    os.close(child_destination)
            finally:
                os.close(child_source)
            continue
        if not stat.S_ISREG(before.st_mode):
            continue
        if before.st_nlink != 1:
            raise RuntimeError("managed file has multiple hard links")
        if before.st_size > max_file_bytes:
            raise RuntimeError("managed file exceeds its byte limit")
        if len(manifest) >= max_files:
            raise RuntimeError("managed tree exceeds its file limit")
        total += before.st_size
        if total > max_total_bytes:
            raise RuntimeError("managed tree exceeds its total byte limit")

        source_file = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=source_fd)
        destination_file = os.open(
            name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
            0o600,
            dir_fd=destination_fd,
        )
        hasher = hashlib.sha256()
        copied = 0
        try:
            opened = os.fstat(source_file)
            if identity(opened) != identity(before):
                raise RuntimeError("managed file changed before capture")
            while True:
                chunk = os.read(source_file, 1024 * 1024)
                if not chunk:
                    break
                copied += len(chunk)
                hasher.update(chunk)
                view = memoryview(chunk)
                while view:
                    written = os.write(destination_file, view)
                    view = view[written:]
            after = os.fstat(source_file)
            if identity(after) != identity(opened) or copied != opened.st_size:
                raise RuntimeError("managed file changed during capture")
            os.fsync(destination_file)
        finally:
            os.close(destination_file)
            os.close(source_file)
        manifest.append({
            "path": relative,
            "size": copied,
            "mtimeMs": before.st_mtime_ns // 1000000,
            "sha256": hasher.hexdigest(),
        })

root_fd = os.open(root, os.O_RDONLY | DIRECTORY | NOFOLLOW)
root_identity = identity(os.fstat(root_fd))
os.mkdir(capture, 0o700)
capture_fd = os.open(capture, os.O_RDONLY | DIRECTORY | NOFOLLOW)
try:
    visit(root_fd, capture_fd, "", 0)
    if identity(os.stat(root, follow_symlinks=False)) != root_identity:
        raise RuntimeError("managed root changed during capture")
finally:
    os.close(capture_fd)
    os.close(root_fd)
print(json.dumps(manifest, separators=(",", ":")))
`;

function isMissing(error: unknown): boolean {
  return error instanceof APIError && NOT_FOUND.has(error.response.status);
}

function isInactiveSession(status: string): boolean {
  return INACTIVE_SESSION_STATUSES.has(status);
}

function normalizedRelativePath(value: string, label: string): string {
  if (!value || value.includes("\0") || path.posix.isAbsolute(value)) {
    throw new RunRuntimeError(`${label} contains an invalid path`);
  }
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  if (
    normalized === "."
    || normalized === ".."
    || normalized.startsWith("../")
    || normalized.split("/").includes("..")
  ) {
    throw new RunRuntimeError(`${label} contains an invalid path`);
  }
  return normalized;
}

function normalizedSkillSlug(value: string): string {
  const slug = normalizedRelativePath(value, "skill bundle");
  if (slug.includes("/")) throw new RunRuntimeError("skill bundle contains an invalid slug");
  return slug;
}

function normalizedProjectFilePath(value: string): string {
  const filePath = normalizedRelativePath(value, "Project file");
  if (RESERVED_PROJECT_FILE_ROOTS.has(filePath.split("/")[0]!)) {
    throw new RunRuntimeError("Project file uses a Companion-reserved path");
  }
  return filePath;
}

function projectConfig(): string {
  return `${JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      permission: "allow",
    },
    null,
    2,
  )}\n`;
}

function credentialsWithSignal(
  credentials: { token: string; teamId: string; projectId: string },
  signal?: AbortSignal,
) {
  if (!signal) return credentials;
  return {
    ...credentials,
    signal,
    fetch: (request: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) =>
      globalThis.fetch(request, {
        ...init,
        signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal,
      }),
  };
}

async function writeInChunks(
  sandbox: Sandbox,
  files: Array<{ path: string; content: Uint8Array; mode?: number }>,
  signal?: AbortSignal,
): Promise<void> {
  const chunkSize = 32;
  for (let offset = 0; offset < files.length; offset += chunkSize) {
    await sandbox.writeFiles(files.slice(offset, offset + chunkSize), { signal });
  }
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function removeWithoutFollowing(
  sandbox: Sandbox,
  target: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!(await sandbox.fs.exists(target, { signal }))) return;
  const stat = await sandbox.fs.lstat(target, { signal });
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await sandbox.fs.rm(target, { recursive: true, force: true, signal });
  } else {
    await sandbox.fs.unlink(target, { signal });
  }
}

async function restorePreviousProjection(
  sandbox: Sandbox,
  currentDir: string,
  previousDir: string,
  hadCurrent: boolean,
  label: string,
  signal?: AbortSignal,
): Promise<void> {
  if (!hadCurrent) {
    // The replacement may have been installed before post-swap validation failed. With no prior
    // projection to restore, fail closed by ensuring that replacement is no longer addressable at
    // the canonical path.
    await removeWithoutFollowing(sandbox, currentDir, signal);
    return;
  }

  const previousExists = await sandbox.fs.exists(previousDir, { signal });
  if (!previousExists) {
    // A retry after a successful rollback is a no-op. This also makes provider retries safe when
    // the restore rename completed but its response was lost.
    if (await sandbox.fs.exists(currentDir, { signal })) return;
    throw new RunRuntimeError(`${label} rollback lost both complete projections`);
  }

  // The staging rename can succeed before post-swap validation fails (or before the provider
  // reports an error). Remove that rejected tree first: rename(previous, current) must never be
  // attempted while the failed replacement still occupies the canonical path.
  await removeWithoutFollowing(sandbox, currentDir, signal);
  await sandbox.fs.rename(previousDir, currentDir, { signal });
}

async function rollbackSwapOrThrow(
  sandbox: Sandbox,
  currentDir: string,
  previousDir: string,
  hadCurrent: boolean,
  label: string,
  swapError: unknown,
  signal?: AbortSignal,
): Promise<never> {
  try {
    await restorePreviousProjection(
      sandbox,
      currentDir,
      previousDir,
      hadCurrent,
      label,
      signal,
    );
  } catch (rollbackError) {
    throw new RunRuntimeError(`${label} swap failed and its previous projection could not be restored`, {
      detail: [
        `swap: ${swapError instanceof Error ? swapError.message : String(swapError)}`,
        `rollback: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
      ].join("; "),
    });
  }
  throw swapError;
}

async function assertManagedDirectory(
  sandbox: Sandbox,
  target: string,
  root: string,
  signal?: AbortSignal,
): Promise<void> {
  const stat = await sandbox.fs.lstat(target, { signal });
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RunRuntimeError("Project managed files path is not a real directory");
  }
  const real = await sandbox.fs.realpath(target, { signal });
  if (real !== target || (real !== root && !real.startsWith(`${root}/`))) {
    throw new RunRuntimeError("Project managed file escaped its root");
  }
}

async function assertManagedFile(
  sandbox: Sandbox,
  target: string,
  root: string,
  signal?: AbortSignal,
): Promise<Awaited<ReturnType<Sandbox["fs"]["lstat"]>>> {
  const stat = await sandbox.fs.lstat(target, { signal });
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new RunRuntimeError("Project managed file is not an isolated regular file");
  }
  const real = await sandbox.fs.realpath(target, { signal });
  if (real !== target || !real.startsWith(`${root}/`)) {
    throw new RunRuntimeError("Project managed file escaped its root");
  }
  return stat;
}

async function assertManagedAncestors(
  sandbox: Sandbox,
  root: string,
  relative: string,
  signal?: AbortSignal,
): Promise<void> {
  await assertManagedDirectory(sandbox, root, root, signal);
  const parents = relative.split("/").slice(0, -1);
  let current = root;
  for (const segment of parents) {
    current = `${current}/${segment}`;
    if (!(await sandbox.fs.exists(current, { signal }))) {
      await sandbox.fs.mkdir(current, { signal });
    }
    await assertManagedDirectory(sandbox, current, root, signal);
  }
}

function sameFileIdentity(
  left: Awaited<ReturnType<Sandbox["fs"]["lstat"]>>,
  right: Awaited<ReturnType<Sandbox["fs"]["lstat"]>>,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.nlink === right.nlink;
}

async function firstHealthyResponse(
  domain: string,
  password: string,
  signal?: AbortSignal,
): Promise<void> {
  const auth = Buffer.from(`${OPENCODE_SERVER_USERNAME}:${password}`).toString("base64");
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (signal?.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new Error("Project health check aborted");
    }
    try {
      const timeout = AbortSignal.timeout(10_000);
      const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const response = await fetch(`${domain}/global/health`, {
        headers: { authorization: `Basic ${auth}` },
        redirect: "manual",
        signal: requestSignal,
      });
      if (await isHealthyProjectHealthResponse(response)) {
        return;
      }
      if (response.ok) {
        lastError = new Error("upstream returned an invalid health document");
      } else {
        lastError = new Error(`upstream responded ${response.status}`);
      }
    } catch (error) {
      if (signal?.aborted) {
        throw signal.reason instanceof Error ? signal.reason : new Error("Project health check aborted");
      }
      lastError = error;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(), 500 * Math.min(attempt + 1, 5));
      const onAbort = () => finish(
        signal?.reason instanceof Error ? signal.reason : new Error("Project health check aborted"),
      );
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  throw new RunRuntimeError("Project OpenCode server did not report healthy in time", {
    detail: lastError instanceof Error ? lastError.message : null,
  });
}

export async function isHealthyProjectHealthResponse(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  const payload: unknown = await response.json().catch(() => null);
  return Boolean(
    payload
    && typeof payload === "object"
    && "healthy" in payload
    && payload.healthy === true,
  );
}

/**
 * Persistent Vercel implementation for Cowork Projects.
 *
 * A Project sandbox is named and persistent, keeps three non-expiring snapshots, and hosts one
 * OpenCode server. This adapter is intentionally separate from createVercelRuntime so legacy Skill
 * Runs retain their disposable run-scoped lifecycle.
 */
export function createVercelProjectWorkspaceRuntime(
  config: VercelRuntimeConfig,
): ProjectWorkspaceRuntime {
  const credentials = { token: config.token, teamId: config.teamId, projectId: config.projectId };

  async function getSandbox(
    ref: ProjectWorkspaceRef,
    signal?: AbortSignal,
    resume = true,
  ): Promise<Sandbox> {
    return Sandbox.get({
      ...credentialsWithSignal(credentials, signal),
      name: ref.sandboxName,
      resume,
    });
  }

  async function prepareFilesystem(sandbox: Sandbox, signal?: AbortSignal): Promise<void> {
    const filesDir = `${PROJECT_WORKDIR}/${PROJECT_FILES_DIR}`;
    const previousFilesDir = `${filesDir}.previous`;
    const claudeDir = `${PROJECT_WORKDIR}/.claude`;
    await assertManagedDirectory(sandbox, PROJECT_WORKDIR, PROJECT_WORKDIR, signal);
    if (await sandbox.fs.exists(filesDir, { signal })) {
      const filesStat = await sandbox.fs.lstat(filesDir, { signal });
      if (!filesStat.isDirectory() || filesStat.isSymbolicLink()) {
        await removeWithoutFollowing(sandbox, filesDir, signal);
      }
    }
    // Recover an interrupted durable-files swap before exposing the workspace to another prompt.
    if (
      !(await sandbox.fs.exists(filesDir, { signal }))
      && await sandbox.fs.exists(previousFilesDir, { signal })
    ) {
      const previousStat = await sandbox.fs.lstat(previousFilesDir, { signal });
      const previousReal = previousStat.isDirectory() && !previousStat.isSymbolicLink()
        ? await sandbox.fs.realpath(previousFilesDir, { signal })
        : null;
      if (previousReal === previousFilesDir) {
        await sandbox.fs.rename(previousFilesDir, filesDir, { signal });
      } else {
        await removeWithoutFollowing(sandbox, previousFilesDir, signal);
      }
    }
    await sandbox.fs.mkdir(filesDir, { recursive: true, signal });
    await assertManagedDirectory(sandbox, filesDir, filesDir, signal);
    if (await sandbox.fs.exists(claudeDir, { signal })) {
      const claudeStat = await sandbox.fs.lstat(claudeDir, { signal });
      if (!claudeStat.isDirectory() || claudeStat.isSymbolicLink()) {
        await removeWithoutFollowing(sandbox, claudeDir, signal);
      }
    }
    await sandbox.fs.mkdir(claudeDir, { recursive: true, signal });
    await assertManagedDirectory(sandbox, claudeDir, PROJECT_WORKDIR, signal);
    const previousDir = `${PROJECT_WORKDIR}/.claude/skills.previous`;
    if (await sandbox.fs.exists(PROJECT_SKILLS_DIR, { signal })) {
      const skillsStat = await sandbox.fs.lstat(PROJECT_SKILLS_DIR, { signal });
      if (!skillsStat.isDirectory() || skillsStat.isSymbolicLink()) {
        await removeWithoutFollowing(sandbox, PROJECT_SKILLS_DIR, signal);
      }
    }
    // Recover a process/provider interruption between the two directory renames. Never create an
    // empty projection over the last complete tree.
    if (
      !(await sandbox.fs.exists(PROJECT_SKILLS_DIR, { signal }))
      && await sandbox.fs.exists(previousDir, { signal })
    ) {
      const previousStat = await sandbox.fs.lstat(previousDir, { signal });
      const previousReal = previousStat.isDirectory() && !previousStat.isSymbolicLink()
        ? await sandbox.fs.realpath(previousDir, { signal })
        : null;
      if (previousReal === previousDir) {
        await sandbox.fs.rename(previousDir, PROJECT_SKILLS_DIR, { signal });
      } else {
        await removeWithoutFollowing(sandbox, previousDir, signal);
      }
    }
    await sandbox.fs.mkdir(PROJECT_SKILLS_DIR, { recursive: true, signal });
    await assertManagedDirectory(sandbox, PROJECT_SKILLS_DIR, claudeDir, signal);
    // Model selection is supplied per prompt. The file contains only the Project-wide,
    // non-interactive permission posture and never contains credentials.
    await sandbox.fs.writeFile(PROJECT_CONFIG, projectConfig(), { signal });
  }

  async function stopOpenCode(sandbox: Sandbox, signal?: AbortSignal): Promise<void> {
    await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", "pkill -f '[o]pencode serve' || true"],
      cwd: PROJECT_WORKDIR,
      signal,
      timeoutMs: 10_000,
    });
  }

  return {
    provider: "vercel",

    async activate({ ref, sourceSnapshotId, signal }) {
      try {
        try {
          const observed = await getSandbox(ref, signal, false);
          const wasStopped = isInactiveSession(observed.status);
          const sandbox = wasStopped ? await getSandbox(ref, signal, true) : observed;
          await prepareFilesystem(sandbox, signal);
          await stopOpenCode(sandbox, signal);
          return {
            sandboxId: sandbox.name,
            domain: sandbox.domain(OPENCODE_PORT),
            resumed: wasStopped,
            restoredFromSnapshot: false,
          };
        } catch (error) {
          if (!isMissing(error)) throw error;
        }

        // sourceSnapshotId is either the golden image (first activation) or the last durable
        // Project checkpoint (recovery). A missing/bad checkpoint is propagated; there is no
        // fallback to an empty or golden workspace.
        const sandbox = await Sandbox.getOrCreate({
          ...credentialsWithSignal(credentials, signal),
          name: ref.sandboxName,
          source: { type: "snapshot", snapshotId: sourceSnapshotId },
          persistent: true,
          snapshotExpiration: 0,
          keepLastSnapshots: { count: 3, expiration: 0, deleteEvicted: true },
          ports: [OPENCODE_PORT],
          resources: { vcpus: config.vcpus },
          timeout: ref.timeoutMs,
          resume: true,
        });
        await prepareFilesystem(sandbox, signal);
        await stopOpenCode(sandbox, signal);
        return {
          sandboxId: sandbox.name,
          domain: sandbox.domain(OPENCODE_PORT),
          resumed: false,
          restoredFromSnapshot: true,
        };
      } catch {
        // Provider exceptions may contain control-plane identifiers, response details, or headers.
        // Only a stable user-safe message may cross into the durable Project failure state.
        throw new RunRuntimeError("Project workspace activation failed");
      }
    },

    async syncSkillBundles({ ref, generation, skills, signal }) {
      if (!Number.isSafeInteger(generation) || generation < 0) {
        throw new RunRuntimeError("Project skill generation is invalid");
      }
      const sandbox = await getSandbox(ref, signal);
      // Materialization runs only at a quiescent turn boundary. Stop the same-user agent process
      // before touching the fixed staging/swap paths.
      await stopOpenCode(sandbox, signal);
      const stagingDir = `${PROJECT_WORKDIR}/.claude/skills.staging-${generation}`;
      const previousDir = `${PROJECT_WORKDIR}/.claude/skills.previous`;
      const claudeDir = `${PROJECT_WORKDIR}/.claude`;
      await assertManagedDirectory(sandbox, claudeDir, PROJECT_WORKDIR, signal);
      await removeWithoutFollowing(sandbox, stagingDir, signal);
      await sandbox.fs.mkdir(stagingDir, { recursive: true, signal });
      await assertManagedDirectory(sandbox, stagingDir, claudeDir, signal);

      const seen = new Set<string>();
      const payloads: Array<{ path: string; content: Uint8Array; mode?: number }> = [];
      const manifest: Array<{
        slug: string;
        version: string;
        path: string;
        sha256: string;
        executable: boolean;
      }> = [];
      for (const skill of skills) {
        const slug = normalizedSkillSlug(skill.slug);
        if (seen.has(slug)) throw new RunRuntimeError(`duplicate Project skill bundle: ${slug}`);
        seen.add(slug);
        for (const file of skill.files) {
          const relative = normalizedRelativePath(file.path, `skill ${slug}`);
          const target = `${stagingDir}/${slug}/${relative}`;
          payloads.push({
            path: target,
            content: file.data as Uint8Array,
            ...(file.executable ? { mode: 0o755 } : {}),
          });
          manifest.push({
            slug,
            version: skill.version,
            path: relative,
            sha256: digest(file.data),
            executable: file.executable,
          });
        }
      }
      manifest.sort((a, b) => `${a.slug}/${a.path}`.localeCompare(`${b.slug}/${b.path}`));
      payloads.push({
        path: `${stagingDir}/.companion-generation.json`,
        content: Buffer.from(`${JSON.stringify({ generation, files: manifest }, null, 2)}\n`) as Uint8Array,
      });
      await writeInChunks(sandbox, payloads, signal);

      // Verify every staged byte before the directory swap. If verification fails, the current
      // complete projection stays untouched.
      for (const entry of manifest) {
        const bytes = await sandbox.fs.readFile(`${stagingDir}/${entry.slug}/${entry.path}`, { signal });
        if (digest(bytes) !== entry.sha256) {
          await removeWithoutFollowing(sandbox, stagingDir, signal);
          throw new RunRuntimeError(`Project skill checksum failed for ${entry.slug}/${entry.path}`);
        }
      }

      await removeWithoutFollowing(sandbox, previousDir, signal);
      let hadCurrent = false;
      if (await sandbox.fs.exists(PROJECT_SKILLS_DIR, { signal })) {
        const current = await sandbox.fs.lstat(PROJECT_SKILLS_DIR, { signal });
        if (current.isDirectory() && !current.isSymbolicLink()) {
          await assertManagedDirectory(sandbox, PROJECT_SKILLS_DIR, claudeDir, signal);
          hadCurrent = true;
        } else {
          await removeWithoutFollowing(sandbox, PROJECT_SKILLS_DIR, signal);
        }
      }
      if (hadCurrent) await sandbox.fs.rename(PROJECT_SKILLS_DIR, previousDir, { signal });
      try {
        await sandbox.fs.rename(stagingDir, PROJECT_SKILLS_DIR, { signal });
        await assertManagedDirectory(sandbox, PROJECT_SKILLS_DIR, claudeDir, signal);
      } catch (error) {
        await rollbackSwapOrThrow(
          sandbox,
          PROJECT_SKILLS_DIR,
          previousDir,
          hadCurrent,
          "Project skills",
          error,
          signal,
        );
      }
      await removeWithoutFollowing(sandbox, previousDir, signal);
    },

    async syncFiles({ ref, files, signal }) {
      const sandbox = await getSandbox(ref, signal);
      await stopOpenCode(sandbox, signal);
      const filesDir = `${PROJECT_WORKDIR}/${PROJECT_FILES_DIR}`;
      const stagingDir = `${filesDir}.staging`;
      const previousDir = `${filesDir}.previous`;
      await assertManagedDirectory(sandbox, PROJECT_WORKDIR, PROJECT_WORKDIR, signal);
      await removeWithoutFollowing(sandbox, stagingDir, signal);
      await sandbox.fs.mkdir(stagingDir, { recursive: true, signal });
      await assertManagedDirectory(sandbox, stagingDir, PROJECT_WORKDIR, signal);
      await writeInChunks(
        sandbox,
        files.map((file) => {
          const relative = normalizedProjectFilePath(file.path);
          return {
            path: `${stagingDir}/${relative}`,
            content: file.data as Uint8Array,
            ...(file.executable ? { mode: 0o755 } : {}),
          };
        }),
        signal,
      );

      await removeWithoutFollowing(sandbox, previousDir, signal);
      let hadCurrent = false;
      if (await sandbox.fs.exists(filesDir, { signal })) {
        const current = await sandbox.fs.lstat(filesDir, { signal });
        if (current.isDirectory() && !current.isSymbolicLink()) {
          await assertManagedDirectory(sandbox, filesDir, filesDir, signal);
          hadCurrent = true;
        } else {
          await removeWithoutFollowing(sandbox, filesDir, signal);
        }
      }
      if (hadCurrent) await sandbox.fs.rename(filesDir, previousDir, { signal });
      try {
        await sandbox.fs.rename(stagingDir, filesDir, { signal });
        await assertManagedDirectory(sandbox, filesDir, filesDir, signal);
      } catch (error) {
        await rollbackSwapOrThrow(
          sandbox,
          filesDir,
          previousDir,
          hadCurrent,
          "Project Files",
          error,
          signal,
        );
      }
      await removeWithoutFollowing(sandbox, previousDir, signal);
      await removeWithoutFollowing(sandbox, `${filesDir}/.claude`, signal);
      await sandbox.fs.symlink("../.claude", `${filesDir}/.claude`, { signal });
    },

    async pushFiles({ ref, files, signal }) {
      if (files.length === 0) return;
      const sandbox = await getSandbox(ref, signal);
      const root = `${PROJECT_WORKDIR}/${PROJECT_FILES_DIR}`;
      await assertManagedDirectory(sandbox, root, root, signal);
      const staging = `${PROJECT_WORKDIR}/.companion-upload-${randomUUID()}`;
      const manifest = files.map((file) => {
        const relative = normalizedProjectFilePath(file.path);
        return {
          path: relative,
          sha256: digest(file.data),
          mode: file.executable ? 0o755 : 0o644,
        };
      });
      try {
        await sandbox.fs.mkdir(staging, { signal });
        await writeInChunks(sandbox, files.map((file) => ({
          path: `${staging}/${normalizedProjectFilePath(file.path)}`,
          content: file.data as Uint8Array,
          ...(file.executable ? { mode: 0o755 } : {}),
        })), signal);
        const command = await sandbox.runCommand({
          cmd: "python3",
          args: [
            "-c",
            SAFE_PROJECT_WRITE_SCRIPT,
            root,
            staging,
            Buffer.from(JSON.stringify(manifest)).toString("base64"),
          ],
          cwd: PROJECT_WORKDIR,
          signal,
          timeoutMs: 60_000,
        });
        if (command.exitCode !== 0) {
          throw new RunRuntimeError("Project managed file upload failed its safe write");
        }
      } finally {
        await removeWithoutFollowing(sandbox, staging, signal).catch(() => undefined);
      }
    },

    async listFiles({ ref, maxFiles, maxFileBytes, maxTotalBytes, signal }) {
      const sandbox = await getSandbox(ref, signal);
      const root = `${PROJECT_WORKDIR}/${PROJECT_FILES_DIR}`;
      await assertManagedDirectory(sandbox, root, root, signal);
      const capture = `${PROJECT_WORKDIR}/.companion-capture-${randomUUID()}`;
      try {
        const command = await sandbox.runCommand({
          cmd: "python3",
          args: [
            "-c",
            SAFE_PROJECT_CAPTURE_SCRIPT,
            root,
            capture,
            String(maxFiles),
            String(maxFileBytes),
            String(maxTotalBytes),
          ],
          cwd: PROJECT_WORKDIR,
          signal,
          timeoutMs: 120_000,
        });
        if (command.exitCode !== 0) {
          throw new RunRuntimeError("Project managed file capture failed its safe scan");
        }
        const output = await command.stdout({ signal });
        const parsed: unknown = JSON.parse(output);
        if (!Array.isArray(parsed) || parsed.length > maxFiles) {
          throw new RunRuntimeError("Project managed file capture returned an invalid manifest");
        }
        const captured = [];
        let total = 0;
        for (const raw of parsed) {
          if (!raw || typeof raw !== "object") {
            throw new RunRuntimeError("Project managed file capture returned an invalid entry");
          }
          const entry = raw as Record<string, unknown>;
          if (
            typeof entry.path !== "string"
            || typeof entry.size !== "number"
            || typeof entry.mtimeMs !== "number"
            || typeof entry.sha256 !== "string"
          ) {
            throw new RunRuntimeError("Project managed file capture returned an invalid entry");
          }
          const relative = normalizedProjectFilePath(entry.path);
          const absolute = `${capture}/${relative}`;
          const stat = await assertManagedFile(sandbox, absolute, capture, signal);
          const data = await sandbox.fs.readFile(absolute, { signal });
          const after = await assertManagedFile(sandbox, absolute, capture, signal);
          if (
            !sameFileIdentity(stat, after)
            || data.length !== entry.size
            || digest(data) !== entry.sha256
          ) {
            throw new RunRuntimeError("Project managed file capture changed after isolation");
          }
          total += data.length;
          if (data.length > maxFileBytes || total > maxTotalBytes) {
            throw new RunRuntimeError("Project managed file capture exceeded its byte limit");
          }
          captured.push({
            path: relative,
            byteSize: data.length,
            modifiedAt: new Date(entry.mtimeMs),
            data,
          });
        }
        return captured;
      } catch (error) {
        if (error instanceof RunRuntimeError) throw error;
        throw new RunRuntimeError("Project managed file capture failed");
      } finally {
        await removeWithoutFollowing(sandbox, capture, signal).catch(() => undefined);
      }
    },

    async startServer({ ref, env, signal }) {
      const sandbox = await getSandbox(ref, signal);
      const filesDir = `${PROJECT_WORKDIR}/${PROJECT_FILES_DIR}`;
      await assertManagedDirectory(sandbox, filesDir, filesDir, signal);
      const claudeLink = `${filesDir}/.claude`;
      const linkStat = await sandbox.fs.lstat(claudeLink, { signal });
      if (!linkStat.isSymbolicLink()
        || await sandbox.fs.readlink(claudeLink, { signal }) !== "../.claude"
        || await sandbox.fs.realpath(claudeLink, { signal }) !== `${PROJECT_WORKDIR}/.claude`) {
        throw new RunRuntimeError("Project skill projection link is invalid");
      }
      // Only one OpenCode process serves every native Project session.
      await sandbox.runCommand({
        cmd: "sh",
        args: ["-c", "pkill -f '[o]pencode serve' || true"],
        cwd: PROJECT_WORKDIR,
        signal,
        timeoutMs: 10_000,
      });
      await sandbox.runCommand({
        cmd: "sh",
        args: ["-lc", `exec opencode serve --hostname 0.0.0.0 --port ${OPENCODE_PORT}`],
        cwd: `${PROJECT_WORKDIR}/${PROJECT_FILES_DIR}`,
        env: { ...env, OPENCODE_CONFIG: PROJECT_CONFIG },
        detached: true,
        signal,
      });
    },

    async healthCheck({ domain, password, signal }) {
      const started = Date.now();
      await firstHealthyResponse(domain, password, signal);
      return { ok: true as const, ms: Date.now() - started };
    },

    async scrubAgentState(ref, signal) {
      const sandbox = await getSandbox(ref, signal, false);
      await stopOpenCode(sandbox, signal);
      await sandbox.runCommand({
        cmd: "sh",
        args: [
          "-lc",
          "rm -rf -- \"$HOME/.local/share/opencode\" \"$HOME/.cache/opencode\" /vercel/sandbox/.opencode",
        ],
        cwd: PROJECT_WORKDIR,
        signal,
        timeoutMs: 30_000,
      });
    },

    async checkpointAndStop(ref, signal) {
      try {
        const sandbox = await getSandbox(ref, signal, false);
        if (isInactiveSession(sandbox.status)) {
          if (!sandbox.currentSnapshotId) {
            throw new RunRuntimeError("stopped Project workspace has no restorable checkpoint");
          }
          return { snapshotId: sandbox.currentSnapshotId };
        }
        const snapshot = await sandbox.snapshot({ expiration: 0, signal });
        return { snapshotId: snapshot.snapshotId };
      } catch (error) {
        if (isMissing(error)) {
          throw new RunRuntimeError("Project workspace disappeared before it could be checkpointed");
        }
        throw error;
      }
    },

    async destroy(ref, signal) {
      try {
        const sandbox = await getSandbox(ref, signal, false);
        await sandbox.delete({ signal });
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      // Non-expiring Project checkpoints outlive VM sessions unless removed explicitly.
      const snapshots = await Snapshot.list({
        ...credentialsWithSignal(credentials, signal),
        name: ref.sandboxName,
        limit: 100,
      });
      for await (const metadata of snapshots) {
        if (metadata.status !== "created") continue;
        const snapshot = await Snapshot.get({
          ...credentials,
          snapshotId: metadata.id,
          signal,
        });
        await snapshot.delete({ signal });
      }
    },

    async observe(ref, signal) {
      try {
        const sandbox = await getSandbox(ref, signal, false);
        const stopped = isInactiveSession(sandbox.status);
        return {
          state: stopped ? "stopped" as const : "running" as const,
          startedAt: stopped ? null : sandbox.currentSession().createdAt,
          expiresAt: sandbox.expiresAt ?? null,
          currentSnapshotId: sandbox.currentSnapshotId ?? null,
        };
      } catch (error) {
        if (isMissing(error)) {
          return {
            state: "missing" as const,
            startedAt: null,
            expiresAt: null,
            currentSnapshotId: null,
          };
        }
        throw error;
      }
    },

    async extendTimeout(ref, additionalMs, signal) {
      if (!Number.isSafeInteger(additionalMs) || additionalMs <= 0) {
        throw new RunRuntimeError("Project timeout extension must be a positive integer");
      }
      try {
        const sandbox = await getSandbox(ref, signal, false);
        if (isInactiveSession(sandbox.status)) {
          return {
            state: "stopped" as const,
            startedAt: null,
            expiresAt: sandbox.expiresAt ?? null,
            currentSnapshotId: sandbox.currentSnapshotId ?? null,
          };
        }
        // Calling Sandbox.get with resume:false before currentSession avoids reviving a VM that
        // crossed the stop boundary while the worker was reserving additional usage.
        await sandbox.currentSession().extendTimeout(additionalMs, { signal });
        const observed = await getSandbox(ref, signal, false);
        return {
          state: isInactiveSession(observed.status)
            ? "stopped" as const
            : "running" as const,
          startedAt: isInactiveSession(observed.status)
            ? null
            : observed.currentSession().createdAt,
          expiresAt: observed.expiresAt ?? null,
          currentSnapshotId: observed.currentSnapshotId ?? null,
        };
      } catch (error) {
        if (isMissing(error)) {
          return {
            state: "missing" as const,
            startedAt: null,
            expiresAt: null,
            currentSnapshotId: null,
          };
        }
        throw error;
      }
    },
  };
}
