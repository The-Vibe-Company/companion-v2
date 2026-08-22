import { existsSync } from "node:fs";
import { resolve } from "node:path";

const LINTABLE_EXTENSION = /\.(?:[cm]?js|jsx|[cm]?ts|tsx)$/;
const IGNORED_PREFIXES = [
  ".agent/",
  ".agents/",
  ".claude/",
  ".codex/",
  ".context/",
  ".continue/",
  ".cursor/",
  ".gemini/",
  ".opencode/",
  ".pi/",
  ".roo/",
  ".windsurf/",
  "tools/oxlint/anti-slop/",
  // The bundled Agent Auth client is a tsup build artifact committed for distribution; the
  // hand-written-code rules do not apply to minified generated output.
  "packages/companion-skill/skill/scripts/companion-agent-client.mjs",
];

export function isAntiSlopCandidatePath(file) {
  return LINTABLE_EXTENSION.test(file) && !IGNORED_PREFIXES.some((prefix) => file.startsWith(prefix));
}

export function selectAntiSlopTargets(files, { cwd = process.cwd(), exists = existsSync } = {}) {
  return [...new Set(files)]
    .filter(isAntiSlopCandidatePath)
    .filter((file) => exists(resolve(cwd, file)))
    .sort();
}
