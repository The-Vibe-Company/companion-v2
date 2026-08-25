import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Companions shipped across THE-317, THE-318, THE-324, and THE-325. Every environment variable those
 * changes read has to keep a documented default in .env.example, otherwise a Railway deploy inherits
 * an undeclared variable and the operator has no way to discover it. This guard scans the server
 * sources for Companions env reads and fails when one is missing from .env.example.
 */
const COMPANIONS_ENV_PREFIXES = [
  "COMPANION_BOX_",
  "COMPANION_PI_",
  "COMPANION_RUNTIME_",
  "COMPANION_COMPANIONS_",
];

// These variables exist only inside the generated, per-Box broker command.
// They are created by apps/runtime for one correlated invocation and are not
// deployment inputs, so advertising them in .env.example would be unsafe.
const BOX_BROKER_INTERNAL_ENV = new Set([
  "COMPANION_PI_BROKER_COMMAND",
  "COMPANION_PI_BROKER_SOCKET",
  "COMPANION_PI_BROKER_TIMEOUT_MS",
  "COMPANION_PI_INVOCATION_ID",
]);

/**
 * Companions variables that are read through a constant rather than a literal member access, so the
 * source scan below cannot see them. The secrets master key is shared with Skills but becomes
 * load-bearing for Companions provider subscriptions (THE-324).
 */
export const COMPANIONS_INDIRECT_ENV = [
  "COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS",
  "COMPANION_COMPANIONS_ENABLED",
  "COMPANION_SECRETS_MASTER_KEY",
  "COMPANION_API_URL",
  "COMPANION_DIRECT_TRANSPORT",
  "DATABASE_COMPANION_RUNTIME_URL",
];

/** Deployed server sources. The agent-side skill scripts are deliberately excluded: their
 *  COMPANION_* variables are supplied by the delegated client, not by a Railway service. */
const SOURCE_ROOTS = [
  "apps/api/src",
  "apps/runtime/src",
  "apps/web/src",
  "apps/worker/src",
  "packages/core/src",
  "packages/db/src",
  "packages/box-runtime/src",
  "packages/companion-runtime/src",
];

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs"];

function isScannableFile(name) {
  if (/\.(test|spec)\./.test(name)) return false;
  return SOURCE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function walk(directory, files = []) {
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return files;
  }
  for (const entry of entries) {
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (isScannableFile(entry)) files.push(full);
  }
  return files;
}

/**
 * Collect Companions environment variables read as `env.NAME` or `process.env.NAME`. Matching only
 * member access keeps plain constants such as COMPANION_PI_DISK_LAYOUT_VERSION and the shell heredoc
 * markers in the Box setup script out of the results.
 */
export function companionsEnvNamesInSource(text) {
  const names = new Set();
  for (const match of text.matchAll(/(?:process\.)?env\.(COMPANION_[A-Z0-9_]+)/g)) {
    const name = match[1];
    if (
      COMPANIONS_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))
      && !BOX_BROKER_INTERNAL_ENV.has(name)
    ) names.add(name);
  }
  return names;
}

/** Variable names declared in a .env file, including entries commented out as documentation. */
export function documentedEnvNames(text) {
  const names = new Set();
  for (const match of text.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm)) names.add(match[1]);
  return names;
}

/** Companions variables the server reads that .env.example does not declare. */
export function undocumentedCompanionsEnv(rootDir) {
  const required = new Set(COMPANIONS_INDIRECT_ENV);
  for (const root of SOURCE_ROOTS) {
    for (const file of walk(join(rootDir, root))) {
      for (const name of companionsEnvNamesInSource(readFileSync(file, "utf8"))) required.add(name);
    }
  }
  const documented = documentedEnvNames(readFileSync(join(rootDir, ".env.example"), "utf8"));
  return [...required].filter((name) => !documented.has(name)).sort();
}
