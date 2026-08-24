import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { isAntiSlopCandidatePath, selectAntiSlopTargets } from "./anti-slop-targets.mjs";
import { parseArguments, runIncrementalLint } from "./lint-anti-slop.mjs";

test("recognizes every supported source extension and excludes generated tooling", () => {
  for (const extension of ["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]) {
    assert.equal(isAntiSlopCandidatePath(`apps/api/src/example.${extension}`), true, extension);
  }
  for (const file of [
    "README.md",
    "types.d.ts.map",
    ".agents/skills/example.ts",
    ".claude/hooks/check.js",
    ".context/scratch.ts",
    "tools/oxlint/anti-slop/index.ts",
  ]) {
    assert.equal(isAntiSlopCandidatePath(file), false, file);
  }
});

test("selects existing additions and rename targets while dropping deleted paths", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "companion-anti-slop-targets-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "src/new name.ts"), "export const current = true;\n");
  writeFileSync(join(directory, "src/copied.mjs"), "export const copied = true;\n");

  assert.deepEqual(
    selectAntiSlopTargets(
      ["src/deleted.ts", "src/new name.ts", "src/copied.mjs", "src/new name.ts", "README.md"],
      { cwd: directory },
    ),
    ["src/copied.mjs", "src/new name.ts"],
  );
});

test("parses the public base option and rejects unsafe refs", () => {
  assert.deepEqual(parseArguments([]), { base: "origin/main" });
  assert.deepEqual(parseArguments(["--", "--base", "upstream/trunk"]), { base: "upstream/trunk" });
  assert.throws(() => parseArguments(["--base"]), /requires a git ref/);
  assert.throws(() => parseArguments(["--base", "--upload-pack=bad"]), /invalid base ref/);
  assert.throws(() => parseArguments(["--unknown"]), /unknown argument/);
});

test("skips Oxlint when the change contains no existing source files", () => {
  const messages = [];
  let spawned = false;
  const status = runIncrementalLint("origin/main", {
    collect: () => ["README.md", "src/deleted.ts", ".agents/hook.js"],
    run: () => {
      spawned = true;
      return { status: 0 };
    },
    write: (message) => messages.push(message),
  });
  assert.equal(status, 0);
  assert.equal(spawned, false);
  assert.match(messages[0], /No changed/);
});

test("passes changed paths to Oxlint as an argument array without a shell", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "companion-anti-slop-run-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "src"));
  writeFileSync(join(directory, "src/with space.ts"), "export const value = true;\n");

  const calls = [];
  const status = runIncrementalLint("base-sha", {
    cwd: directory,
    collect(baseRef, options) {
      assert.equal(baseRef, "base-sha");
      assert.deepEqual(options, { cwd: directory, includeCopySources: false });
      return ["src/with space.ts"];
    },
    run(command, args, options) {
      calls.push({ command, args, options });
      return { status: 7 };
    },
    write() {},
  });

  assert.equal(status, 7);
  assert.deepEqual(calls, [
    {
      command: process.execPath,
      args: [
        "--import",
        "tsx",
        "node_modules/oxlint/bin/oxlint",
        "--config",
        "oxlint.config.ts",
        "--",
        "src/with space.ts",
      ],
      options: { cwd: directory, stdio: "inherit", shell: false },
    },
  ]);
});

test("surfaces invalid bases and process startup failures", () => {
  assert.throws(
    () => runIncrementalLint("missing", { collect: () => { throw new Error("base ref 'missing' does not resolve"); } }),
    /does not resolve/,
  );
  assert.throws(
    () => runIncrementalLint("base", {
      collect: () => ["scripts/lint-anti-slop.mjs"],
      run: () => ({ error: new Error("spawn failed") }),
      write() {},
    }),
    /Oxlint could not start: spawn failed/,
  );
});
