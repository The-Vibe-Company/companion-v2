#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(scriptDir, "..");
const skillDir = join(packageDir, "skill");
const baselinePath = join(skillDir, "companion.integrity.json");
const manifestPath = join(skillDir, "companion.json");
const checkOnly = process.argv.includes("--check");

function digestFor(relPath) {
  return `sha256:${createHash("sha256").update(readFileSync(join(skillDir, relPath))).digest("hex")}`;
}

function isSafeRelativePath(relPath) {
  return (
    typeof relPath === "string" &&
    relPath.length > 0 &&
    !relPath.startsWith("/") &&
    !relPath.includes("\\") &&
    relPath.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (baseline.schemaVersion !== 1 || typeof baseline.files !== "object" || baseline.files === null) {
  throw new Error("companion.integrity.json has an invalid shape");
}
if (typeof manifest.version !== "string" || !manifest.version) {
  throw new Error("companion.json is missing version");
}
const trackedFiles = manifest.metadata?.integrityFiles;
if (!Array.isArray(trackedFiles) || trackedFiles.length === 0 || !trackedFiles.every(isSafeRelativePath)) {
  throw new Error("companion.json metadata.integrityFiles must be a non-empty list of safe relative paths");
}

const nextFiles = {};
for (const relPath of [...trackedFiles].sort()) {
  nextFiles[relPath] = digestFor(relPath);
}

const next = {
  files: nextFiles,
  schemaVersion: baseline.schemaVersion,
  version: manifest.version,
};

const nextText = `${JSON.stringify(next, null, 2)}\n`;
const currentText = readFileSync(baselinePath, "utf8");

if (checkOnly) {
  if (currentText !== nextText) {
    console.error("companion.integrity.json is stale; run pnpm --filter @companion/companion-skill update:integrity");
    process.exit(1);
  }
  console.log("companion.integrity.json is current.");
} else {
  writeFileSync(baselinePath, nextText);
  console.log("Updated companion.integrity.json.");
}
