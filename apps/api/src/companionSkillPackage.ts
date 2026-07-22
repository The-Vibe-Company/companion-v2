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

/** Agent-Auth-first assistant prompts. They contain no bearer secret or silent legacy fallback. */
export function buildCompanionSkillPrompts(version: string): LocalSkillPrompts {
  const install = [
    `Install Companion skill ${version} for workspace {workspaceId} from {base}.`,
    "Use delegated Agent Auth; do not create or request a PAT. Pin every bootstrap command to",
    "@auth/agent-cli@0.5.1 and use device_authorization only.",
    "",
    "1. Derive the public instance origin from {base} by removing its trailing /v1, then discover it:",
    '   origin="{base}"; origin="${origin%/v1}"',
    '   npx --yes @auth/agent-cli@0.5.1 --storage-dir "$HOME/.companion/agent-auth" --url="$origin" discover "$origin"',
    "   Set --storage-dir to",
    "   ~/.companion/agent-auth, create it as 0700, and use umask 077.",
    "2. Read the non-secret agentId in schema-v3 ~/.companion/credentials.json. `connection` checks",
    "   only local key state, so run both commands with the pinned CLI:",
    '   npx --yes @auth/agent-cli@0.5.1 --storage-dir "$HOME/.companion/agent-auth" --url="$origin" connection "$agent_id"',
    '   status_response="$(npx --yes @auth/agent-cli@0.5.1 --storage-dir "$HOME/.companion/agent-auth" --url="$origin" status "$agent_id")"',
    "   Parse status_response in memory. Reuse it only when status is exactly active and",
    "   agent_capability_grants contains an active skills:read grant constrained to",
    "   workspaceId={workspaceId}.",
    "3. If the agent is active but that grant is absent or non-active, request it on the same agent:",
    '   npx --yes @auth/agent-cli@0.5.1 --storage-dir "$HOME/.companion/agent-auth" --url="$origin" request "$agent_id" --capabilities skills:read --constraints \'{"skills:read":{"workspaceId":{"eq":"{workspaceId}"}}}\' --preferred-method device_authorization --reason "Read skills in Companion workspace {workspaceId}"',
    "   After approval, run status again and require the active agent and exact active constrained",
    "   grant. Do not trust the cached output from connection or request.",
    '   status_response="$(npx --yes @auth/agent-cli@0.5.1 --storage-dir "$HOME/.companion/agent-auth" --url="$origin" status "$agent_id")"',
    "4. If the connection is absent, status is not active (including revoked, rejected, or expired),",
    "   or the CLI reports agent_not_found, reconnect with:",
    '   npx --yes @auth/agent-cli@0.5.1 --storage-dir "$HOME/.companion/agent-auth" --url="$origin" connect --provider "$origin" --mode delegated --preferred-method device_authorization --capabilities skills:read --constraints \'{"skills:read":{"workspaceId":{"eq":"{workspaceId}"}}}\' --name "Companion" --reason "Read skills in Companion workspace {workspaceId}"',
    "   If status or connect reports host_revoked, do not retry with that host key. Only after that",
    "   explicit server error, remove the revoked ~/.companion/agent-auth/host.json identity. If it",
    "   reports host_not_found, leave the missing identity missing. Rerun the same connect command so",
    "   the CLI generates a fresh host identity, parse its agentId, then revalidate:",
    '   status_response="$(npx --yes @auth/agent-cli@0.5.1 --storage-dir "$HOME/.companion/agent-auth" --url="$origin" status "$agent_id")"',
    "5. Persist only { issuer, agentId } plus apiUrl={base} under this workspace in credentials.json.",
    "   Migrate a schema-v2 token to schema v3 under legacyPat without using it. Write atomically with",
    "   mode 0600; private host/agent keys stay only under ~/.companion/agent-auth.",
    `6. Execute skills:read with {workspaceId, transfer:{action:"download-local",slug:"companion",version:"${version}"}}.`,
    "   Keep the 60-second ticket in memory. Pipe the execution JSON over stdin to a local program",
    "   that sends it only in X-Companion-Transfer-Ticket to {base}/local-skills/companion/package.",
    "   Never put the ticket in a URL, argv, file, log, or chat.",
    "7. Verify the exact checksum and size. Inspect the ZIP without executing scripts; reject",
    "   traversal, absolute paths, duplicate/case-colliding paths, links, and special files, and",
    "   require SKILL.md at the root.",
    "8. Ask global or project and which tool(s): Claude Code, Codex, or OpenCode. Confirm before",
    "   replacement, stage beside the destination, and atomically swap with rollback. Install only",
    "   the root package and report declared prerequisites.",
    "9. Run the bootstrap once from the installed companion folder:",
    "   python3 scripts/bootstrap.py --summary",
    "10. Report installation through scripts/companion-agent-client.mjs over JSON stdin:",
    `   {"action":"api","method":"POST","path":"/local-skills/companion/installed","body":{"version":"${version}","agent":"<your assistant>"}}`,
    "   This first write may request one additional skills:write approval. Tell me when it is ready.",
  ].join("\n");

  const update = [
    `Please update the Companion skill to version ${version}.`,
    "Use its existing Agent Auth connection. If only a legacy PAT exists, do not use it silently;",
    "complete the delegated device connection from the install flow first.",
    "1. From the installed companion folder, run the safe bootstrap update:",
    "   python3 scripts/bootstrap.py --json --auto-update-companion",
    "   It preserves local customizations: if tracked files are modified or missing, it blocks with",
    '   reason "local_customizations" instead of overwriting them.',
    "2. The bundled client obtains a one-use skills:read transfer ticket for the exact local package;",
    "   it never sends a PAT or long-lived JWT to a binary endpoint. Verify integrity, use an atomic",
    "   swap with rollback, and remove transient archives/backups.",
    "3. Report the installed version through the bundled client. Request skills:write progressively",
    "   if absent, then tell me what changed.",
  ].join("\n");

  const use = [
    "Use the Companion skill to manage, validate, and publish my skills.",
    "Use the schema-v3 Agent Auth connection for workspace {workspaceId}; request capabilities only",
    "when first needed. Never fall back to a PAT unless I explicitly select legacy-pat mode.",
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
    prompts: buildCompanionSkillPrompts(pkg.version),
  };
}
