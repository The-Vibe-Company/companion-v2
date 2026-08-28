import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertResourceName,
  type BoxLabDriver,
  type DriverCommandInput,
  type DriverCommandResult,
  type DriverDoctorCheck,
} from "./driver";
import {
  ProcessExecutionError,
  safeProcessFailure,
  successful,
  type ProcessResult,
  type ProcessRunner,
} from "./process";

const WORKSPACE_LABEL = "dev.companion.box-lab.workspace";
const RESOURCE_KIND_LABEL = "dev.companion.box-lab.kind";
const WRITE_FILE_SCRIPT = `set -euo pipefail
relative="$1"
target="/home/user/$relative"
resolved="$(realpath -m "$target")"
case "$resolved" in /home/user/*) ;; *) exit 64 ;; esac
mkdir -p "$(dirname "$resolved")"
temporary="\${resolved}.box-lab-tmp-$$"
umask 077
cat >"$temporary"
mv -f "$temporary" "$resolved"`;

export interface OciSystemdDriverOptions {
  runner: ProcessRunner;
  engine: "docker" | "podman";
  image: string;
  resourcePrefix: string;
  workspaceScope: string;
}

function uniqueLines(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
}

const CGROUP_ROOT = "/sys/fs/cgroup";
const CGROUP_TYPES = new Set(["domain", "domain threaded", "domain invalid", "threaded"]);

function safeCgroupType(value: string): string {
  return CGROUP_TYPES.has(value) ? value : "unrecognized";
}

export function evaluateCgroupV2Domain(rootType: string, currentType: string): DriverDoctorCheck {
  const normalizedRootType = rootType.trim();
  if (normalizedRootType !== "domain" && normalizedRootType !== "domain threaded") {
    return {
      name: "cgroup-v2-domain",
      ok: false,
      detail: `cgroup v2 root is ${safeCgroupType(normalizedRootType)}; OCI systemd requires a domain hierarchy`,
    };
  }
  const normalizedCurrentType = currentType.trim();
  if (normalizedCurrentType !== "domain") {
    return {
      name: "cgroup-v2-domain",
      ok: false,
      detail: `Current execution cgroup is ${safeCgroupType(normalizedCurrentType)}; OCI systemd requires a domain parent`,
    };
  }
  return {
    name: "cgroup-v2-domain",
    ok: true,
    detail: "cgroup v2 uses a domain hierarchy",
  };
}

async function cgroupV2DoctorCheck(): Promise<DriverDoctorCheck> {
  try {
    const [rootType, membership] = await Promise.all([
      readFile(`${CGROUP_ROOT}/cgroup.type`, "utf8"),
      readFile("/proc/self/cgroup", "utf8"),
    ]);
    const unifiedMembership = membership
      .split(/\r?\n/)
      .find((line) => line.startsWith("0::"));
    if (!unifiedMembership) {
      return {
        name: "cgroup-v2-domain",
        ok: false,
        detail: "Unified cgroup v2 is unavailable",
      };
    }
    const membershipPath = unifiedMembership.slice(3);
    const currentDirectory = resolve(CGROUP_ROOT, `.${membershipPath}`);
    if (currentDirectory !== CGROUP_ROOT && !currentDirectory.startsWith(`${CGROUP_ROOT}/`)) {
      return {
        name: "cgroup-v2-domain",
        ok: false,
        detail: "Current cgroup v2 membership is invalid",
      };
    }
    const currentType = currentDirectory === CGROUP_ROOT
      ? rootType
      : await readFile(`${currentDirectory}/cgroup.type`, "utf8");
    return evaluateCgroupV2Domain(rootType, currentType);
  } catch {
    return {
      name: "cgroup-v2-domain",
      ok: false,
      detail: "cgroup v2 domain support could not be verified",
    };
  }
}

interface ContainerRuntimeState {
  running: boolean;
  exitCode: number;
}

function parseContainerRuntimeState(value: string): ContainerRuntimeState | null {
  const match = /^(true|false)\s+(\d+)$/.exec(value.trim());
  if (!match) return null;
  const exitCode = Number(match[2]);
  if (!Number.isSafeInteger(exitCode)) return null;
  return {
    running: match[1] === "true",
    exitCode,
  };
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isExplicitResourceNotFound(
  engine: "docker" | "podman",
  kind: "container" | "image",
  resourceName: string,
  result: ProcessResult,
): boolean {
  if (result.timedOut || result.exitCode === 0) return false;
  const escapedName = escapeRegularExpression(resourceName);
  const output = `${result.stderr}\n${result.stdout}`;
  if (engine === "docker") {
    const dockerName = kind === "image" ? `${escapedName}(?::latest)?` : escapedName;
    return new RegExp(
      `(?:error(?: response from daemon)?:\\s*)?no such ${kind}:\\s*${dockerName}(?:\\s|$)`,
      "im",
    ).test(output);
  }
  if (kind === "container") {
    return new RegExp(
      `(?:no such container\\s+${escapedName}|no container with name or id ["']?${escapedName}["']? found)`,
      "im",
    ).test(output);
  }
  return new RegExp(
    `(?:no such image\\s+${escapedName}|${escapedName}:\\s*image not known)`,
    "im",
  ).test(output);
}

export class OciSystemdDriver implements BoxLabDriver {
  readonly kind = "oci-systemd" as const;
  readonly #runner: ProcessRunner;
  readonly #engine: "docker" | "podman";
  readonly #image: string;
  readonly #resourcePrefix: string;
  readonly #workspaceScope: string;
  readonly #containerfile = fileURLToPath(new URL("../assets/Containerfile", import.meta.url));
  #prepared = false;

  constructor(options: OciSystemdDriverOptions) {
    this.#runner = options.runner;
    this.#engine = options.engine;
    this.#image = options.image;
    this.#resourcePrefix = options.resourcePrefix;
    this.#workspaceScope = options.workspaceScope;
  }

  async #run(args: readonly string[], timeoutMs = 120_000): Promise<ProcessResult> {
    return await this.#runner.run({
      executable: this.#engine,
      args,
      timeoutMs,
    });
  }

  async doctor(): Promise<DriverDoctorCheck[]> {
    const checks: DriverDoctorCheck[] = [];
    try {
      const result = await this.#run(["version", "--format", "{{.Server.Version}}"], 15_000);
      checks.push({
        name: "oci-engine",
        ok: successful(result),
        detail: successful(result) ? `${this.#engine} ${result.stdout.trim()}` : `${this.#engine} is unavailable`,
      });
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      checks.push({
        name: "oci-engine",
        ok: false,
        detail: missing ? `${this.#engine} is not installed` : `${this.#engine} could not be queried`,
      });
    }
    checks.push({
      name: "host-platform",
      ok: process.platform === "linux",
      detail: process.platform === "linux"
        ? "Linux host supports the contained systemd backend"
        : "oci-systemd requires Linux; use the Lima driver on macOS",
    });
    checks.push({
      name: "architecture",
      ok: process.arch === "x64",
      detail: process.arch === "x64" ? "Host is x86_64" : "OCI systemd requires an x86_64 host",
    });
    if (process.platform === "linux") checks.push(await cgroupV2DoctorCheck());
    return checks;
  }

  async prepare(): Promise<void> {
    if (this.#prepared) return;
    const inspected = await this.#run(["image", "inspect", this.#image], 30_000).catch(() => null);
    if (inspected && successful(inspected)) {
      this.#prepared = true;
      return;
    }
    await access(this.#containerfile);
    const context = fileURLToPath(new URL("../assets", import.meta.url));
    const args = [
      "build", "--platform", "linux/amd64",
      "--label", `${WORKSPACE_LABEL}=${this.#workspaceScope}`,
      "--label", `${RESOURCE_KIND_LABEL}=base-image`,
      "--tag", this.#image, "--file", this.#containerfile, context,
    ];
    const built = await this.#run(args, 20 * 60_000);
    if (!successful(built)) throw safeProcessFailure("Box Lab OCI image build", built);
    this.#prepared = true;
  }

  #resource(name: string): string {
    return assertResourceName(name, this.#resourcePrefix);
  }

  async #containerRuntimeState(resourceName: string): Promise<ContainerRuntimeState> {
    let result: ProcessResult;
    try {
      result = await this.#run([
        "container", "inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", resourceName,
      ], 5_000);
    } catch {
      throw new ProcessExecutionError(
        "process_unavailable",
        "Box Lab container readiness could not query the local virtualization service",
      );
    }
    if (!successful(result)) {
      throw safeProcessFailure("Box Lab container readiness inspection", result);
    }
    const state = parseContainerRuntimeState(result.stdout);
    if (!state) {
      throw new ProcessExecutionError(
        "process_invalid_output",
        "Box Lab container readiness inspection returned an invalid state",
      );
    }
    return state;
  }

  async #waitForSystemd(resourceName: string): Promise<void> {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const result = await this.#run([
        "exec", resourceName, "/bin/sh", "-c",
        "test -S /run/systemd/private && systemctl start user@1000.service && test -S /run/user/1000/bus && test \"$(id -u user)\" = 1000 && test \"$(node -p process.versions.node.split('.')[0])\" = 24",
      ], 5_000).catch(() => null);
      if (result && successful(result)) return;
      const state = await this.#containerRuntimeState(resourceName);
      if (!state.running) {
        throw new ProcessExecutionError(
          "systemd_container_exited",
          `Box Lab systemd container exited before readiness (exit ${state.exitCode})`,
        );
      }
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
    throw new ProcessExecutionError(
      "systemd_readiness_timeout",
      "Box Lab container did not expose systemd, user, and Node 24 before timeout",
    );
  }

  async create(resourceName: string, fromSnapshotResourceName?: string): Promise<void> {
    this.#resource(resourceName);
    if (fromSnapshotResourceName) this.#resource(fromSnapshotResourceName);
    await this.prepare();
    const image = fromSnapshotResourceName || this.#image;
    const result = await this.#run([
      "run", "--detach",
      "--name", resourceName,
      "--hostname", resourceName,
      "--platform", "linux/amd64",
      "--privileged",
      "--cgroupns=host",
      "--tmpfs", "/run:rw,nosuid,nodev,mode=755",
      "--tmpfs", "/run/lock:rw,nosuid,nodev,mode=755",
      "--volume", "/sys/fs/cgroup:/sys/fs/cgroup:rw",
      "--label", `${WORKSPACE_LABEL}=${this.#workspaceScope}`,
      "--label", `${RESOURCE_KIND_LABEL}=box`,
      "--stop-signal", "SIGRTMIN+3",
      image,
    ], 120_000);
    if (!successful(result)) throw safeProcessFailure("Box Lab container create", result);
    await this.#waitForSystemd(resourceName);
  }

  async writeFile(resourceName: string, relativePath: string, content: Uint8Array): Promise<void> {
    this.#resource(resourceName);
    const result = await this.#runner.run({
      executable: this.#engine,
      args: [
        "exec", "--interactive", "--user", "user",
        "--env", "HOME=/home/user", "--env", "USER=user",
        resourceName, "bash", "--noprofile", "--norc", "-c", WRITE_FILE_SCRIPT,
        "box-lab-write", relativePath,
      ],
      input: content,
      timeoutMs: 120_000,
    });
    if (!successful(result)) throw safeProcessFailure("Box Lab file write", result);
  }

  async execute(input: DriverCommandInput): Promise<DriverCommandResult> {
    this.#resource(input.resourceName);
    const guestCommand = `umask 0022\n${input.command}`;
    const result = await this.#runner.run({
      executable: this.#engine,
      args: [
        "exec", "--user", "user",
        "--env", "HOME=/home/user", "--env", "USER=user", "--env", "SHELL=/bin/bash",
        input.resourceName,
        "timeout", "--signal=TERM", "--kill-after=5s", `${input.timeoutSeconds}s`,
        "bash", "--noprofile", "--norc", "-lc", guestCommand,
      ],
      timeoutMs: (input.timeoutSeconds + 10) * 1_000,
    });
    return {
      success: successful(result),
      exitCode: result.timedOut ? null : result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut || result.exitCode === 124,
    };
  }

  async stop(resourceName: string): Promise<void> {
    this.#resource(resourceName);
    const result = await this.#run(["stop", "--time", "30", resourceName], 45_000);
    if (!successful(result)) throw safeProcessFailure("Box Lab container stop", result);
  }

  async start(resourceName: string): Promise<void> {
    this.#resource(resourceName);
    const result = await this.#run(["start", resourceName], 60_000);
    if (!successful(result)) throw safeProcessFailure("Box Lab container start", result);
    await this.#waitForSystemd(resourceName);
  }

  async delete(resourceName: string): Promise<void> {
    this.#resource(resourceName);
    const inspected = await this.#run(["container", "inspect", resourceName], 15_000);
    if (!successful(inspected)) {
      if (isExplicitResourceNotFound(this.#engine, "container", resourceName, inspected)) return;
      throw safeProcessFailure("Box Lab container deletion inventory", inspected);
    }
    const result = await this.#run(["rm", "--force", resourceName], 60_000);
    if (isExplicitResourceNotFound(this.#engine, "container", resourceName, result)) return;
    if (!successful(result)) throw safeProcessFailure("Box Lab container delete", result);
  }

  async saveSnapshot(resourceName: string, snapshotResourceName: string): Promise<void> {
    this.#resource(resourceName);
    this.#resource(snapshotResourceName);
    const result = await this.#run([
      "commit", "--pause=true",
      "--change", `LABEL ${WORKSPACE_LABEL}=${this.#workspaceScope}`,
      "--change", `LABEL ${RESOURCE_KIND_LABEL}=snapshot`,
      resourceName, snapshotResourceName,
    ], 5 * 60_000);
    if (!successful(result)) throw safeProcessFailure("Box Lab snapshot save", result);
  }

  async deleteSnapshot(snapshotResourceName: string): Promise<void> {
    this.#resource(snapshotResourceName);
    const inspected = await this.#run(["image", "inspect", snapshotResourceName], 15_000);
    if (!successful(inspected)) {
      if (isExplicitResourceNotFound(this.#engine, "image", snapshotResourceName, inspected)) return;
      throw safeProcessFailure("Box Lab snapshot deletion inventory", inspected);
    }
    const result = await this.#run(["image", "rm", snapshotResourceName], 60_000);
    if (isExplicitResourceNotFound(this.#engine, "image", snapshotResourceName, result)) return;
    if (!successful(result)) throw safeProcessFailure("Box Lab snapshot delete", result);
  }

  async interactiveShell(resourceName: string): Promise<number> {
    this.#resource(resourceName);
    const result = await this.#runner.run({
      executable: this.#engine,
      args: [
        "exec", "--interactive", "--tty", "--user", "user",
        "--env", "HOME=/home/user", resourceName, "bash", "--login",
      ],
      stdio: "inherit",
    });
    return result.exitCode ?? 1;
  }

  async reset(): Promise<void> {
    const containerList = await this.#run([
      "ps", "--all", "--quiet", "--filter", `label=${WORKSPACE_LABEL}=${this.#workspaceScope}`,
    ], 30_000);
    if (!successful(containerList)) throw safeProcessFailure("Box Lab container inventory", containerList);
    for (const containerId of uniqueLines(containerList.stdout)) {
      const removed = await this.#run(["rm", "--force", containerId], 60_000);
      if (!successful(removed)) throw safeProcessFailure("Box Lab scoped container reset", removed);
    }
    const imageList = await this.#run([
      "images", "--quiet", "--filter", `label=${WORKSPACE_LABEL}=${this.#workspaceScope}`,
    ], 30_000);
    if (!successful(imageList)) throw safeProcessFailure("Box Lab image inventory", imageList);
    for (const imageId of uniqueLines(imageList.stdout)) {
      const removed = await this.#run(["image", "rm", "--force", imageId], 60_000);
      if (!successful(removed)) throw safeProcessFailure("Box Lab scoped image reset", removed);
    }
    this.#prepared = false;
  }
}
