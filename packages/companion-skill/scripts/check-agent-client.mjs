#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `skill/scripts/companion-agent-client.mjs` is a committed tsup bundle that inlines
 * `@companion/contracts` and `@auth/agent`. Editing those packages changes the artifact, so a commit
 * that only touches them leaves the committed bundle — and the integrity baseline pinned to its
 * digest — behind. `pnpm build` then regenerates the bundle in CI and the API refuses to serve the
 * bundled skill (THE-363). Rebuild into a temp dir and compare bytes so the drift fails here.
 */

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(scriptDir, "..");
const artifactRelPath = "skill/scripts/companion-agent-client.mjs";
const outName = "companion-agent-client.mjs";

const outDir = mkdtempSync(join(tmpdir(), "companion-agent-client-"));
try {
  execFileSync(join(packageDir, "node_modules/.bin/tsup"), ["--out-dir", outDir], {
    cwd: packageDir,
    stdio: ["ignore", "ignore", "inherit"],
  });
  const rebuilt = readFileSync(join(outDir, outName));
  const committed = readFileSync(join(packageDir, artifactRelPath));
  if (!rebuilt.equals(committed)) {
    console.error(
      `${artifactRelPath} is stale: rebuilding it from client/ produces different bytes ` +
        `(${committed.length} committed vs ${rebuilt.length} rebuilt).\n` +
        "Run: pnpm --filter @companion/companion-skill build && " +
        "pnpm --filter @companion/companion-skill update:integrity\n" +
        "Then bump skill/companion.json version and add a top changelog entry.",
    );
    process.exit(1);
  }
  console.log(`${artifactRelPath} matches a fresh build.`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
