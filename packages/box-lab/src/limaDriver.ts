import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  assertResourceName,
  BoxLabSourceUnavailableError,
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

export const BOX_LAB_LIMA_CONFIG = `arch: x86_64
vmType: qemu
images:
  - location: "https://cloud-images.ubuntu.com/releases/noble/release-20260518/ubuntu-24.04-server-cloudimg-amd64.img"
    arch: x86_64
    digest: "sha256:53fdde898feed8b027d94baa9cfe8229867f330a1d9c49dc7d84465ee7f229f7"
cpus: 4
memory: "6GiB"
disk: "32GiB"
firmware:
  legacyBIOS: true
mounts: []
containerd:
  system: false
  user: false
user:
  name: user
  uid: 1000
  comment: Companion Box Lab
  home: /home/user
  shell: /bin/bash
provision:
  - mode: system
    script: |
      #!/usr/bin/env bash
      set -euo pipefail
      base_marker=/var/lib/companion-box-lab/base-node-24.14.0-v1
      if [ -f "$base_marker" ] && [ "$(node --version 2>/dev/null || true)" = v24.14.0 ]; then
        exit 0
      fi
      rm -f "$base_marker"
      export DEBIAN_FRONTEND=noninteractive
      apt-get update
      apt-get install -y --no-install-recommends ca-certificates curl dbus-user-session jq sudo xz-utils
      if ! command -v node >/dev/null 2>&1 || [ "$(node --version)" != v24.14.0 ]; then
        node_archive=/tmp/node-v24.14.0-linux-x64.tar.xz
        curl --fail --silent --show-error --location \
          https://nodejs.org/dist/v24.14.0/node-v24.14.0-linux-x64.tar.xz \
          -o "$node_archive"
        printf '%s  %s\\n' \
          41cd79bb7877c81605a9e68ec4c91547774f46a40c67a17e34d7179ef11729df \
          "$node_archive" | sha256sum --check
        tar -xJf "$node_archive" --strip-components=1 -C /usr/local
        rm -f "$node_archive"
      fi
      install -d -m 0755 /var/lib/systemd/linger
      touch /var/lib/systemd/linger/user
      systemctl start user@1000.service
      install -d -o user -g user -m 0755 /home/user/.local
      install -o user -g user -m 0644 /dev/null /home/user/.bash_logout
      sudo -u user npm config set prefix /home/user/.local --location=user
      chown -R user:user /home/user
      test "$(node --version)" = v24.14.0
      install -d -m 0755 /var/lib/companion-box-lab
      printf '%s\\n' ready > "$base_marker"
probes:
  - mode: readiness
    description: systemd, user, and Node 24 are ready
    script: |
      #!/usr/bin/env bash
      set -e
      systemctl is-system-running --wait >/dev/null 2>&1 || [ "$(systemctl is-system-running)" = degraded ]
      test "$(id -u user)" = 1000
      test "$(node -p "process.versions.node.split('.')[0]")" = 24
      test -S /run/user/1000/bus
portForwards: []
ssh:
  localPort: 0
`;

export interface LimaDriverOptions {
  runner: ProcessRunner;
  resourcePrefix: string;
  stateDirectory: string;
  hostPlatform?: NodeJS.Platform;
  hostArchitecture?: NodeJS.Architecture;
}

const limaGuestAgentSchema = z.object({
  location: z.string().optional(),
}).passthrough();

const limaInfoSchema = z.object({
  guestAgents: z.record(z.string(), limaGuestAgentSchema).optional(),
}).passthrough();

const limaListEntrySchema = z.object({
  name: z.string(),
}).passthrough();

const limaListSchema = z.union([limaListEntrySchema, z.array(limaListEntrySchema)]);

const MINIMUM_LIMA_VERSION = [2, 2, 0] as const;

function supportedLimaVersion(output: string): string | null {
  const match = /(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/.exec(output);
  if (!match) return null;
  const version = [Number(match[1]), Number(match[2]), Number(match[3])] as const;
  const normalized = `${version[0]}.${version[1]}.${version[2]}`;
  for (let index = 0; index < MINIMUM_LIMA_VERSION.length; index += 1) {
    if (version[index]! > MINIMUM_LIMA_VERSION[index]!) return normalized;
    if (version[index]! < MINIMUM_LIMA_VERSION[index]!) return null;
  }
  return normalized;
}

function hasX8664GuestAgent(output: string): boolean {
  let parsed: ReturnType<typeof limaInfoSchema.safeParse>;
  try {
    parsed = limaInfoSchema.safeParse(JSON.parse(output));
  } catch {
    return false;
  }
  if (!parsed.success || parsed.data.guestAgents === undefined) return false;
  return Object.entries(parsed.data.guestAgents).some(([architecture, value]) => {
    if (architecture === "x86_64" || architecture === "Linux-x86_64") return true;
    return value.location !== undefined && /(?:Linux-)?x86_64(?:\.gz)?$/.test(value.location);
  });
}

function parsedLimaNames(output: string): string[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  try {
    const parsed = limaListSchema.safeParse(JSON.parse(trimmed));
    if (parsed.success) {
      const entries = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
      return entries.map((entry) => entry.name);
    }
  } catch {
    // Fall through to Lima's newline-delimited JSON form.
  }
  const names: string[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ProcessExecutionError(
        "process_invalid_output",
        "Box Lab Lima inventory returned invalid output",
      );
    }
    const parsed = limaListEntrySchema.safeParse(value);
    if (!parsed.success) {
      throw new ProcessExecutionError(
        "process_invalid_output",
        "Box Lab Lima inventory returned invalid output",
      );
    }
    names.push(parsed.data.name);
  }
  return names;
}

function guestAgentInstallHint(platform: NodeJS.Platform, architecture: NodeJS.Architecture): string {
  if (platform === "darwin" && architecture !== "x64") {
    return "Install the foreign-architecture guest agent with: brew install lima-additional-guestagents";
  }
  if (platform === "darwin") {
    return "Reinstall Lima's native x86_64 guest agent with: brew reinstall lima";
  }
  return "Reinstall the native Linux x86_64 guest agent from the same Lima release";
}

function qemuInstallHint(platform: NodeJS.Platform): string {
  if (platform === "darwin") {
    return "QEMU x86_64 is not installed; run: brew install qemu lima-additional-guestagents";
  }
  return "QEMU x86_64 is not installed; install qemu-system-x86_64 with your Linux package manager";
}

function hostPlatformCheck(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): DriverDoctorCheck {
  if (platform === "darwin") {
    const hostArchitecture = architecture === "x64" ? "x86_64" : architecture;
    return {
      name: "host-platform",
      ok: true,
      detail: `macOS ${hostArchitecture} host will run a real x86_64 Linux VM`,
    };
  }
  if (platform === "linux" && architecture === "x64") {
    return {
      name: "host-platform",
      ok: true,
      detail: "Linux x86_64 host will run a same-architecture Linux VM through QEMU",
    };
  }
  if (platform === "linux") {
    return {
      name: "host-platform",
      ok: false,
      detail: `Lima Box Lab requires an x86_64 Linux host; detected Linux ${architecture}`,
    };
  }
  return {
    name: "host-platform",
    ok: false,
    detail: "Lima Box Lab requires macOS or Linux x86_64",
  };
}

export class LimaDriver implements BoxLabDriver {
  readonly kind = "lima" as const;
  readonly #runner: ProcessRunner;
  readonly #resourcePrefix: string;
  readonly #stateDirectory: string;
  readonly #hostPlatform: NodeJS.Platform;
  readonly #hostArchitecture: NodeJS.Architecture;

  constructor(options: LimaDriverOptions) {
    this.#runner = options.runner;
    this.#resourcePrefix = options.resourcePrefix;
    this.#stateDirectory = options.stateDirectory;
    this.#hostPlatform = options.hostPlatform ?? process.platform;
    this.#hostArchitecture = options.hostArchitecture ?? process.arch;
  }

  async #run(args: readonly string[], timeoutMs = 120_000): Promise<ProcessResult> {
    return await this.#runner.run({ executable: "limactl", args, timeoutMs });
  }

  #resource(name: string): string {
    return assertResourceName(name, this.#resourcePrefix);
  }

  async doctor(): Promise<DriverDoctorCheck[]> {
    const checks: DriverDoctorCheck[] = [];
    try {
      const lima = await this.#run(["--version"], 15_000);
      const version = successful(lima) ? supportedLimaVersion(`${lima.stdout}\n${lima.stderr}`) : null;
      checks.push({
        name: "lima",
        ok: version !== null,
        detail: version !== null
          ? `Lima ${version} is available`
          : successful(lima)
            ? "Lima 2.2.0 or newer is required"
            : "Lima is unavailable",
      });
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      checks.push({ name: "lima", ok: false, detail: missing ? "Lima is not installed" : "Lima could not be queried" });
    }
    try {
      const info = await this.#run(["info"], 15_000);
      const available = successful(info) && hasX8664GuestAgent(info.stdout);
      checks.push({
        name: "lima-x86_64-guestagent",
        ok: available,
        detail: available
          ? "Lima's Linux x86_64 guest agent is available"
          : guestAgentInstallHint(this.#hostPlatform, this.#hostArchitecture),
      });
    } catch {
      checks.push({
        name: "lima-x86_64-guestagent",
        ok: false,
        detail: guestAgentInstallHint(this.#hostPlatform, this.#hostArchitecture),
      });
    }
    try {
      const qemu = await this.#runner.run({
        executable: "qemu-system-x86_64",
        args: ["--version"],
        timeoutMs: 15_000,
      });
      checks.push({
        name: "qemu-x86_64",
        ok: successful(qemu),
        detail: successful(qemu) ? qemu.stdout.split(/\r?\n/, 1)[0] || "QEMU is available" : "QEMU x86_64 is unavailable",
      });
    } catch (error) {
      const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
      checks.push({
        name: "qemu-x86_64",
        ok: false,
        detail: missing ? qemuInstallHint(this.#hostPlatform) : "QEMU could not be queried",
      });
    }
    checks.push(hostPlatformCheck(this.#hostPlatform, this.#hostArchitecture));
    return checks;
  }

  async prepare(): Promise<void> {
    await mkdir(resolve(this.#stateDirectory, "instances"), { recursive: true });
  }

  async create(resourceName: string, fromSnapshotResourceName?: string): Promise<void> {
    this.#resource(resourceName);
    await this.prepare();
    if (fromSnapshotResourceName) {
      this.#resource(fromSnapshotResourceName);
      const cloned = await this.#run(["clone", fromSnapshotResourceName, resourceName], 10 * 60_000);
      if (!successful(cloned)) throw safeProcessFailure("Box Lab Lima clone", cloned);
    } else {
      const configuration = resolve(this.#stateDirectory, "instances", `${resourceName}.yaml`);
      await writeFile(configuration, BOX_LAB_LIMA_CONFIG, { encoding: "utf8", mode: 0o600 });
      const created = await this.#run([
        "create", "--name", resourceName, "--tty=false", configuration,
      ], 20 * 60_000);
      if (!successful(created)) throw safeProcessFailure("Box Lab Lima create", created);
    }
    // Foreign-architecture Macs and nested Linux workspaces may run QEMU without acceleration;
    // cloud-init plus the pinned Node provision can legitimately exceed ten minutes there.
    const started = await this.#run(["start", "--tty=false", resourceName], 20 * 60_000);
    if (!successful(started)) throw safeProcessFailure("Box Lab Lima start", started);
  }

  async writeFile(resourceName: string, relativePath: string, content: Uint8Array): Promise<void> {
    this.#resource(resourceName);
    const result = await this.#runner.run({
      executable: "limactl",
      args: [
        "shell", "--workdir", "/home/user", resourceName,
        "bash", "--noprofile", "--norc", "-c", WRITE_FILE_SCRIPT,
        "box-lab-write", relativePath,
      ],
      input: content,
      timeoutMs: 120_000,
    });
    if (!successful(result)) throw safeProcessFailure("Box Lab Lima file write", result);
  }

  async execute(input: DriverCommandInput): Promise<DriverCommandResult> {
    this.#resource(input.resourceName);
    const guestCommand = `umask 0022\n${input.command}`;
    const result = await this.#runner.run({
      executable: "limactl",
      args: [
        "shell", "--workdir", "/home/user", input.resourceName,
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
    const result = await this.#run(["stop", resourceName], 3 * 60_000);
    if (!successful(result)) throw safeProcessFailure("Box Lab Lima stop", result);
  }

  async start(resourceName: string): Promise<void> {
    this.#resource(resourceName);
    const result = await this.#run(["start", "--tty=false", resourceName], 20 * 60_000);
    if (!successful(result)) throw safeProcessFailure("Box Lab Lima resume", result);
  }

  async #exists(resourceName: string): Promise<boolean> {
    const listed = await this.#run(["list", "--json", resourceName], 30_000);
    if (!successful(listed)) throw safeProcessFailure("Box Lab Lima inventory", listed);
    return parsedLimaNames(listed.stdout).includes(resourceName);
  }

  async delete(resourceName: string): Promise<void> {
    this.#resource(resourceName);
    if (!await this.#exists(resourceName)) return;
    const result = await this.#run(["delete", "--force", resourceName], 5 * 60_000);
    if (!successful(result)) throw safeProcessFailure("Box Lab Lima delete", result);
    await rm(resolve(this.#stateDirectory, "instances", `${resourceName}.yaml`), { force: true });
  }

  async saveSnapshot(resourceName: string, snapshotResourceName: string): Promise<void> {
    this.#resource(resourceName);
    this.#resource(snapshotResourceName);
    await this.stop(resourceName);

    let cloneCompleted = false;
    let cloneFailure: unknown;
    try {
      const result = await this.#run(["clone", resourceName, snapshotResourceName], 10 * 60_000);
      if (!successful(result)) throw safeProcessFailure("Box Lab Lima snapshot clone", result);
      cloneCompleted = true;
    } catch (error) {
      cloneFailure = error;
    }

    try {
      await this.start(resourceName);
    } catch {
      throw new BoxLabSourceUnavailableError();
    }

    if (!cloneCompleted) throw cloneFailure;
  }

  async deleteSnapshot(snapshotResourceName: string): Promise<void> {
    await this.delete(snapshotResourceName);
  }

  async interactiveShell(resourceName: string): Promise<number> {
    this.#resource(resourceName);
    const result = await this.#runner.run({
      executable: "limactl",
      args: ["shell", "--workdir", "/home/user", resourceName, "bash", "--login"],
      stdio: "inherit",
    });
    return result.exitCode ?? 1;
  }

  async reset(): Promise<void> {
    const listed = await this.#run(["list", "--json"], 30_000);
    if (!successful(listed)) throw safeProcessFailure("Box Lab Lima inventory", listed);
    const scopedNames = parsedLimaNames(listed.stdout)
      .filter((name) => name.startsWith(`${this.#resourcePrefix}-`))
      .sort((left, right) => left.localeCompare(right));
    for (const name of scopedNames) await this.delete(name);
  }
}
