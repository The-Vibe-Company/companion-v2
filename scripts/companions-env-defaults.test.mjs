import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  COMPANIONS_INDIRECT_ENV,
  companionsEnvNamesInSource,
  documentedEnvNames,
  undocumentedCompanionsEnv,
} from "./companions-env-defaults.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

test("collects Companions environment reads from member access", () => {
  const names = companionsEnvNamesInSource(`
    const key = env.COMPANION_BOX_API_KEY?.trim();
    const ttl = process.env.COMPANION_BOX_TTL_SECONDS;
    const adapter = env.COMPANION_PI_MCP_ADAPTER_PACKAGE;
  `);
  assert.deepEqual(
    [...names].sort(),
    ["COMPANION_BOX_API_KEY", "COMPANION_BOX_TTL_SECONDS", "COMPANION_PI_MCP_ADAPTER_PACKAGE"],
  );
});

test("ignores constants and shell markers that only look like Companions variables", () => {
  const names = companionsEnvNamesInSource(`
    export const COMPANION_PI_DISK_LAYOUT_VERSION = 2;
    cat > "$HOME/.companion/bin/pi-daemon" <<'COMPANION_PI_DAEMON'
    const url = env.COMPANION_API_URL;
  `);
  assert.deepEqual([...names], []);
});

test("reads declared names including documented commented-out defaults", () => {
  const names = documentedEnvNames("COMPANION_BOX_API_KEY=\n# DATABASE_RUNTIME_ROLE=companion\n");
  assert.ok(names.has("COMPANION_BOX_API_KEY"));
  assert.ok(names.has("DATABASE_RUNTIME_ROLE"));
});

test("every Companions variable the server reads has a documented default", () => {
  assert.deepEqual(undocumentedCompanionsEnv(repoRoot), []);
});

test("the indirect Companions variables stay documented", () => {
  const documented = documentedEnvNames(readFileSync(`${repoRoot}.env.example`, "utf8"));
  for (const name of COMPANIONS_INDIRECT_ENV) assert.ok(documented.has(name), `${name} is undocumented`);
});

test("Companions stays off by default so a deploy boots without Box or provider secrets", () => {
  const envExample = readFileSync(`${repoRoot}.env.example`, "utf8");
  assert.match(envExample, /^COMPANION_COMPANIONS_ENABLED=false$/m);
  assert.match(envExample, /^COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=$/m);
});
