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
    const concurrency = env.COMPANION_RUNTIME_CONCURRENCY;
  `);
  assert.deepEqual(
    [...names].sort(),
    [
      "COMPANION_BOX_API_KEY",
      "COMPANION_BOX_TTL_SECONDS",
      "COMPANION_PI_MCP_ADAPTER_PACKAGE",
      "COMPANION_RUNTIME_CONCURRENCY",
    ],
  );
});

test("ignores constants and shell markers that only look like Companions variables", () => {
  const names = companionsEnvNamesInSource(`
    export const COMPANION_PI_DISK_LAYOUT_VERSION = 2;
    cat > "$HOME/.companion/bin/pi-daemon" <<'COMPANION_PI_DAEMON'
    const url = env.COMPANION_API_URL;
    const command = process.env.COMPANION_PI_BROKER_COMMAND;
    const run = process.env.COMPANION_PI_ROUTINE_RUN_ID;
  `);
  assert.deepEqual([...names], []);
});

test("reads declared names including documented commented-out defaults", () => {
  const names = documentedEnvNames("COMPANION_BOX_API_KEY=\n# COMPANION_RUNTIME_EXECUTOR_ID=uuid\n");
  assert.ok(names.has("COMPANION_BOX_API_KEY"));
  assert.ok(names.has("COMPANION_RUNTIME_EXECUTOR_ID"));
});

test("every Companions variable the server reads has a documented default", () => {
  assert.deepEqual(undocumentedCompanionsEnv(repoRoot), []);
});

test("the indirect Companions variables stay documented", () => {
  const documented = documentedEnvNames(readFileSync(`${repoRoot}.env.example`, "utf8"));
  for (const name of COMPANIONS_INDIRECT_ENV) assert.ok(documented.has(name), `${name} is undocumented`);
});

test("Companions stays fail closed by default with the flag off and allowlist empty", () => {
  const envExample = readFileSync(`${repoRoot}.env.example`, "utf8");
  assert.match(envExample, /^COMPANION_COMPANIONS_ENABLED=false$/m);
  assert.match(envExample, /^COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=$/m);
});
