import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMPANION_SKILL_KEY,
  COMPANION_SKILL_MANIFEST,
  companionSkillChanges,
  companionSkillDir,
} from "@companion/companion-skill";
import { computeLocalSkillStatus, type LocalSkillInstall } from "@companion/core/services";
import { localSkillIntegrityFilesSchema, type LocalSkillPrompts, type LocalSkillRow } from "@companion/contracts";
import { packDir, tarGzToZip } from "@companion/skills";
import { z } from "zod";

export interface CompanionSkillPackage {
  key: string;
  /** Exact `.zip` bytes served by `/local-skills/companion/package`. */
  zip: Buffer;
  /** Canonical package checksum computed from the deterministic package archive. */
  checksum: string;
  sizeBytes: number;
  /** Authoritative version, read from the bundled companion.json `version`. */
  version: string;
  integrity: LocalSkillRow["integrity"];
}

let cached: Promise<CompanionSkillPackage> | null = null;

const companionIntegrityBaselineSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.string(),
  files: localSkillIntegrityFilesSchema.refine((files) => Object.keys(files).length > 0, "integrity baseline must include files"),
});

/**
 * Pack the bundled Companion skill once and cache the result (archive + checksum + version). The
 * source never changes at runtime, so this is computed at most once per process.
 */
export function getCompanionSkillPackage(): Promise<CompanionSkillPackage> {
  if (!cached) {
    cached = buildPackage().catch((error) => {
      cached = null; // allow a retry on the next request
      throw error;
    });
  }
  return cached;
}

async function buildPackage(): Promise<CompanionSkillPackage> {
  const dir = companionSkillDir();
  const packed = await packDir(dir);
  const zip = await tarGzToZip(packed.archive);
  const packageChecksum = packed.checksum;
  const manifest = JSON.parse(await readFile(join(dir, "companion.json"), "utf8")) as { version?: string };
  const version = manifest.version;
  if (!version) throw new Error("bundled companion skill is missing companion.json version");
  const baseline = companionIntegrityBaselineSchema.parse(JSON.parse(await readFile(join(dir, "companion.integrity.json"), "utf8")));
  if (baseline.version !== version) throw new Error("bundled companion integrity baseline version does not match companion.json");
  const files: Record<string, string> = { ...baseline.files };
  for (const relPath of [...Object.keys(baseline.files), "companion.integrity.json"]) {
    const bytes = await readFile(join(dir, relPath));
    const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (relPath !== "companion.integrity.json" && baseline.files[relPath] !== digest) {
      throw new Error(`bundled companion integrity baseline is stale for ${relPath}`);
    }
    files[relPath] = digest;
  }
  return {
    key: COMPANION_SKILL_KEY,
    zip,
    checksum: packageChecksum,
    sizeBytes: zip.length,
    version,
    integrity: {
      packageChecksum,
      files,
    },
  };
}

/**
 * Assistant prompt templates with `{base}` (API base URL), `{workspaceId}` (organizations.id), and
 * `{token}` (a freshly minted PAT) left for the web client to fill. The version is already baked in.
 * Each install/update prompt ends with the report-back step so the workspace learns the skill is
 * installed.
 */
function buildPrompts(version: string): LocalSkillPrompts {
  const download =
    'curl -L "{base}/local-skills/companion/package" -H "Authorization: Bearer {token}" -o companion.zip';
  const report =
    `curl -s "{base}/local-skills/companion/installed" -H "Authorization: Bearer {token}" ` +
    `-H "Content-Type: application/json" -d '{"version":"${version}","agent":"<your assistant>"}'`;
  const credentials = [
    "Save the current Companion credentials before doing anything else. Do not print the token.",
    "",
    "macOS/Linux:",
    "```sh",
    'mkdir -p "$HOME/.companion"',
    "umask 077",
    `node <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");
const file = path.join(os.homedir(), ".companion", "credentials.json");
const workspaceId = "{workspaceId}";
const entry = { apiUrl: "{base}", token: "{token}", updatedAt: new Date().toISOString() };
let current = {};
try { current = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
const workspaces = current && current.schemaVersion === 2 && current.workspaces && typeof current.workspaces === "object"
  ? current.workspaces
  : {};
const next = { schemaVersion: 2, activeWorkspaceId: workspaceId, workspaces: { ...workspaces, [workspaceId]: entry } };
fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\\n", { mode: 0o600 });
NODE`,
    'chmod 600 "$HOME/.companion/credentials.json" 2>/dev/null || true',
    "```",
    "",
    "Windows PowerShell:",
    "```powershell",
    '$dir = Join-Path $HOME ".companion"',
    "New-Item -ItemType Directory -Force -Path $dir | Out-Null",
    '$file = Join-Path $dir "credentials.json"',
    '$workspaceId = "{workspaceId}"',
    '$entry = @{ apiUrl = "{base}"; token = "{token}"; updatedAt = (Get-Date).ToUniversalTime().ToString("o") }',
    '$current = $null',
    'if (Test-Path $file) { try { $current = Get-Content -Raw $file | ConvertFrom-Json } catch {} }',
    '$workspaces = @{}',
    'if ($current -and $current.schemaVersion -eq 2 -and $current.workspaces) { $current.workspaces.PSObject.Properties | ForEach-Object { $workspaces[$_.Name] = $_.Value } }',
    '$workspaces[$workspaceId] = $entry',
    '@{ schemaVersion = 2; activeWorkspaceId = $workspaceId; workspaces = $workspaces } | ConvertTo-Json -Depth 5 | Set-Content -NoNewline -Encoding UTF8 $file',
    "```",
  ].join("\n");

  const install = [
    "You are installing the Companion skill for this workspace. It lets you manage, validate,",
    "publish, and update my skills here, and you always confirm a change with me first.",
    "",
    "1. Run the credential snippet for this user's OS:",
    credentials,
    `2. Download version ${version} of the package:`,
    `   ${download}`,
    "3. Unzip companion.zip into wherever you keep skills (for example ~/.claude/skills/companion,",
    "   ~/.codex/skills/companion, or ~/.agents/skills/companion for OpenCode)",
    "   and confirm SKILL.md sits at the package root. Remove companion.zip when done.",
    "4. Run the bootstrap once from the installed companion folder:",
    "   python3 scripts/bootstrap.py --summary",
    "5. Confirm the install so this workspace knows it is ready:",
    `   ${report}`,
    "6. Tell me when it's ready.",
  ].join("\n");

  const update = [
    `Please update the Companion skill to version ${version}.`,
    "",
    "1. Run the credential snippet for this user's OS so future skill calls use the current workspace:",
    credentials,
    "2. From the installed companion folder, run the safe bootstrap update:",
    "   python3 scripts/bootstrap.py --json --auto-update-companion",
    "   It preserves local customizations: if tracked files are modified or missing, it blocks with",
    '   reason "local_customizations" instead of overwriting them.',
    "3. If bootstrap cannot run because the installed copy is too old, download the latest package:",
    `   ${download}`,
    "4. Unzip companion.zip into a temporary folder and verify SKILL.md is at the package root.",
    `   Verify its companion.json version is ${version}.`,
    "5. Validate the existing companion skill folder, stage the extracted package, then replace the",
    "   existing folder with a transient backup only for the duration of the swap. If the new package",
    "   fails to land, restore the original folder in the same operation. Do not leave backup folders",
    "   containing SKILL.md behind.",
    "   Remove companion.zip, temporary folders, and any transient backup when done.",
    "6. Confirm the new version with the workspace:",
    `   ${report}`,
    "7. Tell me what changed.",
  ].join("\n");

  // The "use" prompt also carries fresh credentials: the drawer mints a new token on copy/send, so
  // handing these over lets the skill keep working without a reinstall.
  const use = [
    "Use the Companion skill to manage, validate, and publish my skills.",
    "First refresh its stored workspace credentials by running the snippet for this user's OS:",
    credentials,
    "Then use the skill. It should read COMPANION_API_URL, COMPANION_WORKSPACE_ID, and",
    "COMPANION_TOKEN from the environment when available; otherwise it should read them from",
    "~/.companion/credentials.json on macOS/Linux or $HOME\\.companion\\credentials.json on Windows.",
    "On the first Companion use in a conversation, run:",
    "python3 scripts/bootstrap.py --json --auto-update-companion",
  ].join("\n");

  return { install, update, use };
}

/** Compose the read row for the Companion skills view from the caller's install record. */
export async function buildCompanionSkillRow(
  install: LocalSkillInstall | null,
  workspaceId: string,
): Promise<LocalSkillRow> {
  const pkg = await getCompanionSkillPackage();
  const m = COMPANION_SKILL_MANIFEST;
  return {
    workspaceId,
    key: m.key,
    name: m.name,
    description: m.description,
    status: computeLocalSkillStatus(install?.installedVersion ?? null, pkg.version),
    installedVersion: install?.installedVersion ?? null,
    availableVersion: pkg.version,
    lastReportedAt: install ? install.lastReportedAt.toISOString() : null,
    agentLabel: install?.agentLabel ?? null,
    notes: m.notes,
    commands: m.commands,
    changes: companionSkillChanges(pkg.version),
    integrity: pkg.integrity,
    prompts: buildPrompts(pkg.version),
  };
}
