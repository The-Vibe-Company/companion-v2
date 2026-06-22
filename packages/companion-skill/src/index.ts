import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `@companion/companion-skill` — the built-in "Companion" management skill.
 *
 * This package ships both the packable skill source (`skill/SKILL.md` + supporting files) and the
 * presentation manifest the "Companion skills" view renders. The authoritative version is the
 * `metadata.companion_version` baked into `skill/SKILL.md`; the API derives `availableVersion` from
 * the packed package, never from a constant here.
 */

export const COMPANION_SKILL_KEY = "companion";

export interface CompanionSkillCommand {
  name: string;
  desc: string;
}

export interface CompanionSkillChangelogEntry {
  version: string;
  changes: string[];
}

export interface CompanionSkillManifest {
  key: string;
  name: string;
  description: string;
  what: string;
  uses: string;
  why: string[];
  commands: CompanionSkillCommand[];
  changelog: CompanionSkillChangelogEntry[];
}

export const COMPANION_SKILL_MANIFEST: CompanionSkillManifest = {
  key: COMPANION_SKILL_KEY,
  name: "Companion",
  description:
    "Manage local SKILL.md packages with Companion: validate, publish, update, resolve skill dependencies, choose owner teams and visibility, install updates, audit skills, check workspace versions, and self-update this Companion skill.",
  what:
    "The Companion skill gives your assistant everything it needs to look after your skills on this machine. It can validate them, publish new ones, push updates, choose owner teams and visibility, and check that everything is current. It always confirms a change with you before anything is published.",
  uses:
    "Your assistant uses it whenever you ask to publish, update, validate, or check your skills, so the steps stay consistent and safe.",
  why: [
    "Reads only the skills you point it at. Nothing else on your machine.",
    "Always validates and confirms with you before it publishes anything.",
    "Keeps ownership and visibility explicit, including team-owned uploads and private or Everyone sharing.",
    "Every publish and update is recorded in the workspace history.",
  ],
  commands: [
    { name: "Publish a skill", desc: "Validate a skill, choose owner/visibility, and publish it safely." },
    { name: "Update a skill", desc: "Push a new version with targeted identity and visibility checks." },
    { name: "Change visibility", desc: "Re-share a published skill; cascade to dependencies or dependents." },
    { name: "Resolve dependencies", desc: "Analyze packages and sync companion.json before upload." },
    { name: "Sync companion.json", desc: "Detect dependencies, setup requirements, and display copy and record them in the skill manifest." },
    { name: "Manage skill API calls", desc: "Use the supported skills API surface without crossing into workspace admin." },
    { name: "Update Companion skill", desc: "Check and install the latest bundled Companion skill safely." },
    { name: "Check for updates", desc: "See whether the skills on this machine are up to date." },
    { name: "Install updates", desc: "Bring outdated skills up to the latest published version." },
    { name: "Validate a skill", desc: "Check a skill is well formed before you share it." },
    { name: "Manage your skills", desc: "List and organize the skills on this machine." },
  ],
  changelog: [
    {
      version: "1.6.0",
      changes: [
        "Documents comment image attachments: POST /skills/{slug}/comments accepts multipart/form-data with up to six image files.",
        "Adds the session-gated GET /skills/{slug}/comments/{commentId}/images/{imageId} endpoint and the images array on comment rows.",
      ],
    },
    {
      version: "1.5.0",
      changes: [
        "Moves Companion-specific package data into companion.json: display copy, dependencies, and setup requirements.",
        "Keeps legacy SKILL.md requirements readable but normalizes them into companion.json on publish.",
        "Uses companion.json dependencies as the upload source of truth, with dependency= kept only as an old-package fallback.",
      ],
    },
    {
      version: "1.4.0",
      changes: [
        "Changes a published skill's visibility with PUT /skills/{slug}/visibility (works with a skills:write token).",
        "Cascade also raises required sub-skills or reduces dependent skills so the cover invariant holds.",
      ],
    },
    {
      version: "1.3.0",
      changes: [
        "Analyzes a skill before upload to detect the secrets and environment variables it needs.",
        "Proposes a `requirements` list (secret/env, required, and a note on how to obtain each) and confirms it with you before writing it into the SKILL.md frontmatter.",
        "Surfaces a skill's declared requirements as setup notes so you know what to configure before running it.",
      ],
    },
    {
      version: "1.2.1",
      changes: [
        "Always analyzes the full skill package for dependencies before validate, publish, or update.",
        "Compares inferred dependencies with companion.json and asks before synchronizing additions or removals.",
        "Uses the confirmed dependency list for validation and upload, then publishes missing local dependencies first.",
      ],
    },
    {
      version: "1.2.0",
      changes: [
        "Reads an optional companion.json to declare required skill→skill dependencies (un-versioned slugs).",
        "Runs a dependency preflight before publishing: surfaces already-published, must-upload-too, removed, and archival-candidate dependencies.",
        "Publishes missing dependencies first in topological order, and blocks publishes with missing, cyclic, or less-visible dependencies.",
        "On update, proposes archiving dependencies that are no longer required by any published skill (never automatically).",
      ],
    },
    {
      version: "1.1.0",
      changes: [
        "Adds explicit owner-team guidance for publishing skills under a team.",
        "Documents Private, Everyone, and team-share visibility separately from ownership.",
        "Lets assistants fetch and propose available teams while preserving current upload defaults.",
        "Clarifies the supported skills API management surface for assistants.",
      ],
    },
    {
      version: "1.0.2",
      changes: [
        "Adds an explicit self-update flow for the bundled Companion skill.",
        "Checks the local skill against the workspace Companion skills catalog before replacing files.",
      ],
    },
    {
      version: "1.0.1",
      changes: [
        "Stores the current workspace API URL and token in a local credentials file during install and use prompts.",
        "Reads credentials from the environment first, then from the local Companion credentials file.",
      ],
    },
    {
      version: "1.0.0",
      changes: [
        "Publish, update, validate, and list skills from your assistant.",
        "Checks every skill on this machine against the workspace and flags what is out of date.",
        "Confirms each change with you and records it in the workspace history.",
      ],
    },
  ],
};

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
