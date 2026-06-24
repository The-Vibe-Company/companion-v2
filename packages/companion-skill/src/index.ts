import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `@companion/companion-skill` — the built-in "Companion" management skill.
 *
 * The packable skill source lives in `skill/`. Its `companion.json` is the source of truth for
 * version, user-facing copy, commands, changelog, and setup declarations.
 */

export const COMPANION_SKILL_KEY = "companion";

export interface CompanionSkillCommand {
  name: string;
  desc: string;
}

export interface CompanionSkillChangelogEntry {
  version: string;
  date?: string;
  changes: string[];
}

export interface CompanionSkillManifest {
  key: string;
  name: string;
  version: string;
  description: string;
  notes: string;
  commands: CompanionSkillCommand[];
  changelog: CompanionSkillChangelogEntry[];
}

interface RawCompanionJson {
  name?: string;
  version?: string;
  title?: string;
  description?: string;
  notes?: string;
  metadata?: {
    changelog?: CompanionSkillChangelogEntry[];
  };
  commands?: CompanionSkillCommand[];
}

function loadCompanionSkillManifest(): CompanionSkillManifest {
  const raw = JSON.parse(readFileSync(join(companionSkillDir(), "companion.json"), "utf8")) as RawCompanionJson;
  const key = raw.name ?? COMPANION_SKILL_KEY;
  const version = raw.version;
  if (!version) throw new Error("bundled companion skill is missing companion.json version");
  return {
    key,
    name: raw.title ?? "Companion",
    version,
    description: raw.description ?? "Manage local SKILL.md packages with Companion.",
    notes: raw.notes ?? "",
    commands: raw.commands ?? [],
    changelog: raw.metadata?.changelog ?? [],
  };
}

export const COMPANION_SKILL_MANIFEST: CompanionSkillManifest = loadCompanionSkillManifest();

/** Free-form changelog lookup; empty array when the version is unknown. */
export function companionSkillChanges(version: string): string[] {
  return COMPANION_SKILL_MANIFEST.changelog.find((entry) => entry.version === version)?.changes ?? [];
}

/**
 * Absolute path to the packable `skill/` directory. Resolves for `tsx` dev runs and tests (via the
 * package source), for bundled production builds (the dir is copied next to the bundle as
 * `companion-skill/`), and for a repo-root cwd. Override with `COMPANION_SKILL_DIR`.
 */
export function companionSkillDir(): string {
  const candidates = [
    process.env.COMPANION_SKILL_DIR,
    fileURLToPath(new URL("../skill", import.meta.url)),
    fileURLToPath(new URL("./companion-skill", import.meta.url)),
    resolve(process.cwd(), "packages/companion-skill/skill"),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}
