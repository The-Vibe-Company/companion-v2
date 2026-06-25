#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const baseRef = process.env.COMPANION_SKILL_VERSION_BASE ?? "origin/main";
const manifestPath = "packages/companion-skill/skill/companion.json";
const skillPathPrefix = "packages/companion-skill/skill/";

function runGit(args, options = {}) {
  return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

const repoRoot = runGit(["rev-parse", "--show-toplevel"]);

function git(args, options = {}) {
  return runGit(args, { cwd: repoRoot, ...options });
}

function fail(message) {
  console.error(`Companion skill version check failed: ${message}`);
  process.exit(1);
}

function parseSemver(version, label) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(version);
  if (!match) fail(`${label} version "${version}" is not valid semver`);
  return {
    raw: version,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Math.sign(Number(a) - Number(b));
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function compareSemver(a, b) {
  for (const key of ["major", "minor", "patch"]) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1;
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const len = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < len; i += 1) {
    if (a.prerelease[i] === undefined) return -1;
    if (b.prerelease[i] === undefined) return 1;
    const compared = compareIdentifiers(a.prerelease[i], b.prerelease[i]);
    if (compared !== 0) return compared;
  }
  return 0;
}

function readManifestFromJson(json, label) {
  let parsed;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    fail(`could not parse ${label} ${manifestPath}: ${error.message}`);
  }
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    fail(`${label} ${manifestPath} is missing a string version`);
  }
  return {
    parsed,
    version: parseSemver(parsed.version, label),
  };
}

let mergeBase;
try {
  mergeBase = git(["merge-base", baseRef, "HEAD"]);
} catch {
  fail(`could not resolve ${baseRef}; ensure the checkout fetched origin/main`);
}

const changedFiles = git(["diff", "--name-only", mergeBase, "--"])
  .split("\n")
  .filter(Boolean)
  .filter((file) => file.startsWith(skillPathPrefix));
const untrackedSkillFiles = git(["ls-files", "--others", "--exclude-standard", "--", skillPathPrefix])
  .split("\n")
  .filter(Boolean);
const watchedFiles = [...new Set([...changedFiles, ...untrackedSkillFiles])];

if (watchedFiles.length === 0) {
  console.log(`No bundled Companion skill changes since ${baseRef}; version bump not required.`);
  process.exit(0);
}

let baseManifestJson;
try {
  baseManifestJson = git(["show", `${mergeBase}:${manifestPath}`]);
} catch {
  fail(`could not read base ${manifestPath} from ${baseRef}`);
}

const baseManifest = readManifestFromJson(baseManifestJson, "base");
const currentManifest = readManifestFromJson(readFileSync(join(repoRoot, manifestPath), "utf8"), "current");
const baseVersion = baseManifest.version;
const currentVersion = currentManifest.version;

if (compareSemver(currentVersion, baseVersion) <= 0) {
  fail(
    `${manifestPath} changed but version did not increase (${baseVersion.raw} -> ${currentVersion.raw}). ` +
      `Bump companion.json.version above ${baseVersion.raw}.`,
  );
}

const changelog = currentManifest.parsed.metadata?.changelog;
const firstEntryVersion = Array.isArray(changelog) ? changelog[0]?.version : undefined;
if (firstEntryVersion !== currentVersion.raw) {
  fail(
    `${manifestPath} version is ${currentVersion.raw}, but metadata.changelog[0].version is ` +
      `${typeof firstEntryVersion === "string" ? firstEntryVersion : "missing"}. ` +
      `Add a top changelog entry for ${currentVersion.raw}.`,
  );
}

console.log(
  `Bundled Companion skill changed (${watchedFiles.length} file${watchedFiles.length === 1 ? "" : "s"}); ` +
    `version ${baseVersion.raw} -> ${currentVersion.raw}.`,
);
