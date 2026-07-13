#!/usr/bin/env node

import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";

const FORBIDDEN = [
  { label: "exclusive test", pattern: /\b(?:test|describe)\.only\s*\(/g },
  { label: "skipped test", pattern: /\b(?:test|describe)\.(?:skip|fixme)\s*\(/g },
];
const PLAYWRIGHT_SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".ts", ".tsx"]);

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return PLAYWRIGHT_SOURCE_EXTENSIONS.has(extname(path)) ? [path] : [];
  });
}

export function forbiddenPlaywrightMarkers(source) {
  return FORBIDDEN.flatMap(({ label, pattern }) => {
    pattern.lastIndex = 0;
    return [...source.matchAll(pattern)].map((match) => ({ label, index: match.index ?? 0 }));
  });
}

export function validatePlaywrightDirectory(directory) {
  return sourceFiles(directory).flatMap((file) =>
    forbiddenPlaywrightMarkers(readFileSync(file, "utf8")).map(({ label, index }) => {
      const source = readFileSync(file, "utf8");
      const line = source.slice(0, index).split("\n").length;
      return `${relative(process.cwd(), file)}:${line}: ${label} is forbidden in critical flows`;
    }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const violations = validatePlaywrightDirectory(join(process.cwd(), "e2e"));
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exit(1);
  }
  console.log("Critical Playwright flows contain no .only, .skip, or .fixme markers.");
}
