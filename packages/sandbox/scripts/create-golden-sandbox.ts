/**
 * Create (or refresh) the GOLDEN sandbox snapshot every Companion Agent forks from.
 *
 * One-time / per-OPENCODE_VERSION operation, run manually with real Vercel credentials:
 *
 *   VERCEL_TOKEN=… VERCEL_TEAM_ID=… VERCEL_PROJECT_ID=… \
 *   OPENCODE_VERSION=1.17.13 pnpm tsx scripts/agents/create-golden-sandbox.ts
 *
 * What it bakes in: the pinned OpenCode CLI (npm global install, exact version) and python3 (skills
 * bundle Python scripts). Per-agent state (agent markdown, opencode.json, skills, env) is pushed at
 * provision time, never here. Prints the snapshot id to export as COMPANION_GOLDEN_SNAPSHOT_ID.
 */
import { Sandbox } from "@vercel/sandbox";

const OPENCODE_PORT = 4096;

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
    console.error(`FAILED (exit ${result.exitCode})\n${stdout}\n${stderr}`);
    await sandbox.stop().catch(() => {});
    process.exit(1);
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

  console.log(`Creating golden sandbox (opencode-ai@${opencodeVersion}, node24 + python3)…`);
  const sandbox = await Sandbox.create({
    ...credentials,
    runtime: "node24",
    ports: [OPENCODE_PORT],
    timeout: 15 * 60 * 1000,
    resources: { vcpus: 2 },
  });
  console.log(`Sandbox ${sandbox.name} booted.`);

  await run(sandbox, "install python3 (dnf)", "dnf", ["install", "-y", "python3"], true);
  await run(sandbox, `install opencode-ai@${opencodeVersion} (npm -g)`, "npm", [
    "install",
    "--global",
    `opencode-ai@${opencodeVersion}`,
  ]);
  const reported = await run(sandbox, "verify opencode version", "opencode", ["--version"]);
  if (!reported.includes(opencodeVersion)) {
    console.error(`opencode reports "${reported}" but the pin is ${opencodeVersion} — aborting.`);
    await sandbox.stop().catch(() => {});
    process.exit(1);
  }
  await run(sandbox, "verify python3", "python3", ["--version"]);

  console.log("Snapshotting (the sandbox shuts down when the snapshot completes)…");
  const snapshot = await sandbox.snapshot();
  console.log("\nGolden snapshot ready. Export this before starting the API:\n");
  console.log(`  COMPANION_GOLDEN_SNAPSHOT_ID=${snapshot.snapshotId}`);
  console.log(`  OPENCODE_VERSION=${opencodeVersion}\n`);
  console.log("Note: unused snapshots expire after ~30 days; re-run this script to refresh.");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
