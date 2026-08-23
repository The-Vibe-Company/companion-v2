import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function tomlSection(source, name) {
  const marker = `[${name}]`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `missing TOML section ${marker}`);
  const next = source.indexOf("\n[", start + marker.length);
  return source.slice(start, next === -1 ? source.length : next);
}

test("Conductor keeps the root stack default and exposes native mobile runs only locally", () => {
  const settings = read(".conductor/settings.toml");
  assert.match(tomlSection(settings, "scripts.run.dev"), /^default = true$/m);

  for (const name of ["mobile-ios", "mobile-android", "mobile-metro"]) {
    const section = tomlSection(settings, `scripts.run.${name}`);
    assert.match(section, /^available_in = \["local"\]$/m);
    assert.doesNotMatch(section, /^default\s*=/m);
  }
});

test("root setup leaves the standalone mobile toolchain opt-in", () => {
  const setup = read("scripts/setup-conductor.sh");
  const mobileLauncher = read("apps/mobile/scripts/dev-conductor.sh");
  assert.doesNotMatch(setup, /apps\/mobile|xcodebuildmcp/i);
  assert.match(read("pnpm-workspace.yaml"), /^\s*- "!apps\/mobile"$/m);
  assert.match(mobileLauncher, /CI=1 pnpm --dir "\$MOBILE_DIR" --ignore-workspace install --frozen-lockfile/);

  const packageJson = JSON.parse(read("package.json"));
  assert.equal(
    packageJson.scripts["mobile:setup"],
    "pnpm --dir apps/mobile --ignore-workspace run dev:setup",
  );
  assert.match(packageJson.scripts["mobile:mcp:setup"], /^pnpm --dir apps\/mobile --ignore-workspace /);
});

test("mobile ports stay within Conductor's reserved block without colliding with the runtime", () => {
  assert.match(read("apps/mobile/scripts/dev-conductor.sh"), /expo start --lan --port "\$METRO_PORT"/);
  const output = execFileSync("bash", ["apps/mobile/scripts/dev-conductor.sh", "ports"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, CONDUCTOR_PORT: "4100" },
  });
  assert.equal(output, "api=4101\nmetro=4109\n");
});

test("XcodeBuildMCP bootstrap is explicit and fails before installation away from macOS", () => {
  const launcher = read("apps/mobile/scripts/dev-conductor.sh");
  const setup = read("apps/mobile/scripts/setup-xcodebuildmcp.sh");
  assert.doesNotMatch(launcher, /setup-xcodebuildmcp|brew install/);
  assert.match(setup, /codex mcp add XcodeBuildMCP -- xcodebuildmcp mcp/);
  assert.match(setup, /claude mcp add --scope user XcodeBuildMCP -- xcodebuildmcp mcp/);

  if (process.platform !== "darwin") {
    const result = spawnSync("bash", ["apps/mobile/scripts/setup-xcodebuildmcp.sh"], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /requires macOS and Xcode/);
  }
});

test("XcodeBuildMCP bootstrap registers the stdio server with available agent clients", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-mobile-mcp-"));
  const bin = join(directory, "bin");
  const calls = join(directory, "calls");
  mkdirSync(bin);

  const executable = (name, source) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`);
    chmodSync(path, 0o755);
  };

  executable("uname", "printf 'Darwin\\n'");
  executable("xcodebuild", "printf 'Xcode 26.0\\nBuild version 17A000\\n'");
  executable("xcrun", "[ \"$1 $2\" = \"simctl help\" ]");
  executable("xcodebuildmcp", "printf '2.7.0\\n'");
  executable(
    "codex",
    'printf "codex %s\\n" "$*" >>"$MOBILE_MCP_TEST_CALLS"\n[ "$1 $2" != "mcp get" ]',
  );
  executable(
    "claude",
    'printf "claude %s\\n" "$*" >>"$MOBILE_MCP_TEST_CALLS"\n[ "$1 $2" != "mcp get" ]',
  );

  try {
    const result = spawnSync("bash", ["apps/mobile/scripts/setup-xcodebuildmcp.sh"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        MOBILE_MCP_TEST_CALLS: calls,
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(calls, "utf8"),
      [
        "codex mcp get XcodeBuildMCP",
        "codex mcp add XcodeBuildMCP -- xcodebuildmcp mcp",
        "claude mcp get XcodeBuildMCP",
        "claude mcp add --scope user XcodeBuildMCP -- xcodebuildmcp mcp",
        "",
      ].join("\n"),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("XcodeBuildMCP bootstrap rejects an existing non-stdio Codex configuration", () => {
  const directory = mkdtempSync(join(tmpdir(), "companion-mobile-mcp-divergent-"));
  const bin = join(directory, "bin");
  mkdirSync(bin);

  const executable = (name, source) => {
    const path = join(bin, name);
    writeFileSync(path, `#!/usr/bin/env bash\nset -euo pipefail\n${source}\n`);
    chmodSync(path, 0o755);
  };

  executable("uname", "printf 'Darwin\\n'");
  executable("xcodebuild", "printf 'Xcode 26.0\\nBuild version 17A000\\n'");
  executable("xcrun", "[ \"$1 $2\" = \"simctl help\" ]");
  executable("xcodebuildmcp", "printf '2.7.0\\n'");
  executable(
    "codex",
    'if [ "${4:-}" = "--json" ]; then printf \'%s\\n\' \'{"transport":{"type":"streamable_http","url":"https://xcodebuildmcp.example/mcp"}}\'; else exit 0; fi',
  );
  executable(
    "claude",
    "printf 'XcodeBuildMCP:\\n  Type: stdio\\n  Command: xcodebuildmcp\\n  Args: mcp\\n'",
  );

  try {
    const result = spawnSync("bash", ["apps/mobile/scripts/setup-xcodebuildmcp.sh"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /different XcodeBuildMCP configuration/);
    assert.match(result.stderr, /Resolve the divergent MCP configuration manually/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
