import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  COMPANION_SKILL_KEY,
  COMPANION_SKILL_MANIFEST,
  companionSkillChanges,
  companionSkillDir,
} from "@companion/companion-skill";
import { computeLocalSkillStatus, type LocalSkillInstall } from "@companion/core/services";
import type { LocalSkillPrompts, LocalSkillRow } from "@companion/contracts";
import { packDir, parseFrontmatter } from "@companion/skills";

export interface CompanionSkillPackage {
  key: string;
  /** Canonical `.tar.gz` archive. */
  archive: Buffer;
  checksum: string;
  sizeBytes: number;
  /** Authoritative version, read from the bundled SKILL.md `metadata.companion_version`. */
  version: string;
}

let cached: Promise<CompanionSkillPackage> | null = null;

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
  const fm = parseFrontmatter(await readFile(join(dir, "SKILL.md"), "utf8"));
  if (!fm.ok) throw new Error(`bundled companion skill is invalid: ${fm.error ?? "frontmatter"}`);
  const version = fm.data.metadata.companion_version;
  if (!version) throw new Error("bundled companion skill is missing metadata.companion_version");
  return {
    key: COMPANION_SKILL_KEY,
    archive: packed.archive,
    checksum: packed.checksum,
    sizeBytes: packed.sizeBytes,
    version,
  };
}

/**
 * Assistant prompt templates with `{base}` (API base URL) and `{token}` (a freshly minted PAT) left
 * for the web client to fill. The version is already baked in. Each install/update prompt ends with
 * the report-back step so the workspace learns the skill is installed.
 */
function buildPrompts(version: string): LocalSkillPrompts {
  const download =
    'curl -L "{base}/local-skills/companion/package" -H "Authorization: Bearer {token}" -o companion.zip';
  const report =
    `curl -s "{base}/local-skills/companion/installed" -H "Authorization: Bearer {token}" ` +
    `-H "Content-Type: application/json" -d '{"version":"${version}","agent":"<your assistant>"}'`;

  const install = [
    "You are installing the Companion skill for this workspace. It lets you manage, validate,",
    "publish, and update my skills here, and you always confirm a change with me first.",
    "",
    `1. Download version ${version} of the package:`,
    `   ${download}`,
    "2. Unzip companion.zip into wherever you keep skills (for example ~/.claude/skills/companion)",
    "   and confirm SKILL.md sits at the package root. Remove companion.zip when done.",
    "3. Confirm the install so this workspace knows it is ready:",
    `   ${report}`,
    "4. Tell me when it's ready.",
  ].join("\n");

  const update = [
    `Please update the Companion skill to version ${version}.`,
    "",
    "1. Download the latest package:",
    `   ${download}`,
    "2. Unzip it over your existing companion skill folder, keeping SKILL.md at the root.",
    "   Remove companion.zip when done.",
    "3. Confirm the new version with the workspace:",
    `   ${report}`,
    "4. Tell me what changed.",
  ].join("\n");

  // The "use" prompt also carries fresh credentials: the drawer mints a new token on copy/send, and
  // the originally-installed token is short-lived (24h), so handing these over lets the skill keep
  // working without a reinstall.
  const use = [
    "Use the Companion skill to manage, validate, and publish my skills.",
    "If it needs fresh workspace access, set:",
    "  COMPANION_API_URL={base}",
    "  COMPANION_TOKEN={token}",
  ].join("\n");

  return { install, update, use };
}

/** Compose the read row for the Companion skills view from the caller's install record. */
export async function buildCompanionSkillRow(install: LocalSkillInstall | null): Promise<LocalSkillRow> {
  const pkg = await getCompanionSkillPackage();
  const m = COMPANION_SKILL_MANIFEST;
  return {
    key: m.key,
    name: m.name,
    description: m.description,
    status: computeLocalSkillStatus(install?.installedVersion ?? null, pkg.version),
    installedVersion: install?.installedVersion ?? null,
    availableVersion: pkg.version,
    lastReportedAt: install ? install.lastReportedAt.toISOString() : null,
    agentLabel: install?.agentLabel ?? null,
    what: m.what,
    uses: m.uses,
    why: m.why,
    commands: m.commands,
    changes: companionSkillChanges(pkg.version),
    prompts: buildPrompts(pkg.version),
  };
}
