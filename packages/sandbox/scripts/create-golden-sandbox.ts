/**
 * Create (or refresh) the GOLDEN sandbox snapshot every Companion Agent forks from.
 *
 * One-time / per-OPENCODE_VERSION operation, run manually with real Vercel credentials:
 *
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
 *   OPENCODE_VERSION=1.17.13 pnpm tsx scripts/agents/create-golden-sandbox.ts
 *
 * What it bakes in: Python 3.13, the pinned Python toolbox, Node 24, the exact OpenCode CLI, and
 * common shell utilities. Per-run state is still pushed at provision time, never here.
 */
import { Sandbox } from "@vercel/sandbox";

const OPENCODE_PORT = 4096;
const PIP_VERSION = "25.3";
const GET_PIP_SHA256 = "a341e1a43e38001c551a1508a73ff23636a11970b61d901d9a1cad2a18f57055";
const RIPGREP_VERSION = "14.1.1";
const RIPGREP_SHA256 = "4cf9f2741e6c465ffdb7c26f38056a59e2a2544b51f7cc128ef28337eeae4d8e";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`Missing required env var ${name}`);
    process.exit(1);
  }
  return value;
}

async function run(sandbox: Sandbox, label: string, cmd: string, args: string[], sudo = false): Promise<string> {
  process.stdout.write(`→ ${label}… `);
  const result = await sandbox.runCommand({ cmd, args, sudo });
  const stdout = await result.stdout();
  const stderr = await result.stderr();
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed (exit ${result.exitCode})\n${stdout}\n${stderr}`);
  }
  console.log("ok");
  return stdout.trim();
}

async function main(): Promise<void> {
  const credentials = {
    token: required("VERCEL_TOKEN"),
    teamId: required("VERCEL_TEAM_ID"),
    projectId: required("VERCEL_PROJECT_ID"),
  };
  const opencodeVersion = required("OPENCODE_VERSION");

  console.log(`Creating golden sandbox (opencode-ai@${opencodeVersion}, Python 3.13 + Node 24)…`);
  const sandbox = await Sandbox.create({
    ...credentials,
    runtime: "python3.13",
    ports: [OPENCODE_PORT],
    timeout: 15 * 60 * 1000,
    resources: { vcpus: 2 },
  });
  try {
    console.log(`Sandbox ${sandbox.name} booted.`);

    await run(sandbox, "install Node 24 and shell toolbox", "dnf", [
      "install", "-y", "nodejs24", "nodejs24-npm", "git", "jq", "file", "zip", "unzip",
    ], true);
    await run(sandbox, `install ripgrep ${RIPGREP_VERSION}`, "sh", ["-lc", [
      "set -eu",
      `archive=ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
      "tmp=$(mktemp -d)",
      "trap 'rm -rf \"$tmp\"' EXIT",
      `curl --fail --location --silent --show-error "https://github.com/BurntSushi/ripgrep/releases/download/${RIPGREP_VERSION}/$archive" -o "$tmp/$archive"`,
      `printf '${RIPGREP_SHA256}  %s\\n' "$tmp/$archive" | sha256sum -c -`,
      "tar -xzf \"$tmp/$archive\" -C \"$tmp\"",
      `install -m 0755 "$tmp/ripgrep-${RIPGREP_VERSION}-x86_64-unknown-linux-musl/rg" /usr/local/bin/rg`,
    ].join("\n")], true);
    await run(sandbox, "select Node 24", "alternatives", ["--set", "node", "/usr/bin/node-24"], true);
    await run(sandbox, "configure Python command aliases", "sh", ["-lc", [
      "set -eu",
      "python_bin=$(command -v python3.13)",
      'ln -sf "$python_bin" /usr/local/bin/python3',
      'ln -sf "$python_bin" /usr/local/bin/python',
      "get_pip=$(mktemp)",
      "trap 'rm -f \"$get_pip\"' EXIT",
      'curl --fail --location --silent --show-error "https://bootstrap.pypa.io/get-pip.py" -o "$get_pip"',
      `printf '${GET_PIP_SHA256}  %s\\n' "$get_pip" | sha256sum -c -`,
      `"$python_bin" "$get_pip" "pip==${PIP_VERSION}"`,
    ].join("\n")], true);
    await run(sandbox, "install pinned Python toolbox", "python3", [
      "-m", "pip", "install", "--no-cache-dir", "--break-system-packages",
      "openai==2.45.0", "requests==2.34.2", "PyYAML==6.0.3", "uv==0.11.29",
    ], true);
    await run(sandbox, "configure pip command aliases", "sh", ["-lc", [
      "set -eu",
      "pip_bin=$(command -v pip3.13 || command -v pip3)",
      'ln -sf "$pip_bin" /usr/local/bin/pip3',
      'ln -sf "$pip_bin" /usr/local/bin/pip',
    ].join("\n")], true);
    await run(sandbox, `install opencode-ai@${opencodeVersion} (npm -g)`, "npm", [
      "install",
      "--global",
      `opencode-ai@${opencodeVersion}`,
    ]);
    const reported = await run(sandbox, "verify opencode version", "opencode", ["--version"]);
    if (!reported.includes(opencodeVersion)) {
      throw new Error(`opencode reports "${reported}" but the pin is ${opencodeVersion} — aborting.`);
    }
    const python = await run(sandbox, "verify Python toolbox", "python", [
      "-c",
      "value: str | None = None; import openai, requests, yaml; print(openai.__version__, requests.__version__, yaml.__version__)",
    ]);
    if (python.trim() !== "2.45.0 2.34.2 6.0.3") throw new Error(`unexpected Python package versions: ${python}`);
    const pythonVersion = await run(sandbox, "verify Python 3.13", "python3", ["--version"]);
    if (!pythonVersion.startsWith("Python 3.13.")) throw new Error(`unexpected Python version: ${pythonVersion}`);
    await run(sandbox, "verify pip", "pip", ["--version"]);
    const uvVersion = await run(sandbox, "verify uv", "uv", ["--version"]);
    if (!uvVersion.includes("0.11.29")) throw new Error(`unexpected uv version: ${uvVersion}`);
    const nodeVersion = await run(sandbox, "verify Node 24", "node", ["--version"]);
    if (!nodeVersion.startsWith("v24.")) throw new Error(`unexpected Node version: ${nodeVersion}`);
    await run(sandbox, "verify npm", "npm", ["--version"]);

    console.log("Snapshotting (the sandbox shuts down when the snapshot completes)…");
    const snapshot = await sandbox.snapshot();
    console.log("\nGolden snapshot ready. Export this before starting the worker:\n");
    console.log(`  COMPANION_GOLDEN_SNAPSHOT_ID=${snapshot.snapshotId}`);
    console.log(`  OPENCODE_VERSION=${opencodeVersion}\n`);
    console.log("Note: unused snapshots expire after ~30 days; re-run this script to refresh.");
  } finally {
    // snapshot() normally stops the sandbox. This remains deliberately idempotent so every error
    // path also releases compute instead of waiting for the provider timeout.
    await sandbox.stop().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
