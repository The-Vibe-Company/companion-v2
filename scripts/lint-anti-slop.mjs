#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { selectAntiSlopTargets } from "./anti-slop-targets.mjs";
import { collectChangedFiles } from "./verify-change.mjs";

export function parseArguments(argv) {
  const options = { base: "origin/main" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--base") {
      const value = argv[index + 1];
      if (!value) throw new Error("--base requires a git ref");
      if (value.startsWith("-")) throw new Error(`invalid base ref: ${value}`);
      options.base = value;
      index += 1;
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }
  return options;
}

export function runIncrementalLint(
  baseRef,
  {
    cwd = process.cwd(),
    collect = collectChangedFiles,
    run = spawnSync,
    write = console.log,
  } = {},
) {
  const changedFiles = collect(baseRef, { cwd, includeCopySources: false });
  const targets = selectAntiSlopTargets(changedFiles, { cwd });
  if (targets.length === 0) {
    write("[anti-slop] No changed JavaScript or TypeScript files to lint.");
    return 0;
  }

  write(`[anti-slop] Linting ${targets.length} changed JavaScript/TypeScript file(s).`);
  const result = run(
    process.execPath,
    ["--import", "tsx", "node_modules/oxlint/bin/oxlint", "--config", "oxlint.config.ts", "--", ...targets],
    { cwd, stdio: "inherit", shell: false },
  );
  if (result.error) throw new Error(`Oxlint could not start: ${result.error.message}`);
  return result.status ?? 1;
}

export function main(argv = process.argv.slice(2), { cwd = process.cwd() } = {}) {
  try {
    const options = parseArguments(argv);
    return runIncrementalLint(options.base, { cwd });
  } catch (error) {
    console.error(`[anti-slop] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}
