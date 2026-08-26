import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { testflightScope } from "./ios-testflight-scope.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const RELEASE_SCRIPT = resolve(ROOT, "apps/ios/scripts/release.sh");
const BUILD_NUMBER = "20260824220000";
const PRIVATE_KEY_FIXTURE = "fixture-private-key-content";

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function commitFixture(cwd, path, contents, message) {
  const absolutePath = join(cwd, path);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, contents);
  git(cwd, ["add", "--", path]);
  git(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]);
}

function xcodebuildStub() {
  return [
    "#!/usr/bin/env bash",
    "set -euo pipefail",
    "call_kind=\"$1\"",
    "{",
    "  printf '%s' \"$call_kind\"",
    "  for argument in \"$@\"; do printf '\\t%s' \"$argument\"; done",
    "  printf '\\n'",
    "} >> \"$XCODEBUILD_CALLS\"",
    "key_path=''",
    "output_path=''",
    "previous=''",
    "for argument in \"$@\"; do",
    "  if [[ \"$previous\" == '-authenticationKeyPath' ]]; then key_path=\"$argument\"; fi",
    "  if [[ \"$previous\" == '-archivePath' || \"$previous\" == '-exportPath' ]]; then output_path=\"$argument\"; fi",
    "  previous=\"$argument\"",
    "done",
    "[[ -n \"$key_path\" && -r \"$key_path\" ]] || { echo 'missing API key' >&2; exit 70; }",
    "if [[ \"${STUB_XCODEBUILD_FAIL_ON:-}\" == \"$call_kind\" ]]; then",
    "  echo \"stub $call_kind failure\" >&2",
    "  if [[ \"$call_kind\" == 'archive' ]]; then exit 71; else exit 72; fi",
    "fi",
    "mkdir -p \"$output_path\"",
    "echo \"stub $call_kind success\"",
    "",
  ].join("\n");
}

function runRelease(t, { failOn = "", prepare } = {}) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-ios-release-test-"));
  const binDir = join(fixtureRoot, "bin");
  const callsPath = join(fixtureRoot, "xcodebuild-calls.tsv");
  const outputDir = join(fixtureRoot, "release-output");
  mkdirSync(binDir);
  writeFileSync(join(binDir, "xcodebuild"), xcodebuildStub());
  chmodSync(join(binDir, "xcodebuild"), 0o755);
  prepare?.({ outputDir });
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));

  const result = spawnSync("bash", [RELEASE_SCRIPT], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      ASC_ISSUER_ID: "fixture-issuer",
      ASC_KEY_ID: "FIXTUREKEY",
      ASC_KEY_P8: PRIVATE_KEY_FIXTURE,
      BUILD_NUMBER,
      IOS_PROVISIONING_PROFILE_SPECIFIER: "Fixture App Store Profile",
      IOS_NOTIFICATION_EXTENSION_PROVISIONING_PROFILE_SPECIFIER: "Fixture Extension Profile",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      RELEASE_OUTPUT_DIR: outputDir,
      STUB_XCODEBUILD_FAIL_ON: failOn,
      TMPDIR: fixtureRoot,
      XCODEBUILD_CALLS: callsPath,
    },
  });
  const calls = existsSync(callsPath)
    ? readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("\t").slice(1))
    : [];
  const keyDirectories = readdirSync(fixtureRoot).filter((entry) => entry.startsWith("companion-asc-key."));
  return { calls, fixtureRoot, keyDirectories, outputDir, result };
}

test("the native release executes archive then App Store export with an ephemeral key", (t) => {
  const { calls, keyDirectories, outputDir, result } = runRelease(t);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls.map(([command]) => command), ["archive", "-exportArchive"]);
  assert.ok(calls[0].includes(`CURRENT_PROJECT_VERSION=${BUILD_NUMBER}`));
  assert.ok(calls[0].includes("IOS_PROVISIONING_PROFILE_SPECIFIER=Fixture App Store Profile"));
  assert.ok(calls[0].includes(
    "IOS_NOTIFICATION_EXTENSION_PROVISIONING_PROFILE_SPECIFIER=Fixture Extension Profile",
  ));
  assert.ok(calls[1].includes(resolve(ROOT, "apps/ios/Config/ExportOptions.plist")));
  assert.equal(readFileSync(join(outputDir, "archive.log"), "utf8"), "stub archive success\n");
  assert.equal(readFileSync(join(outputDir, "export.log"), "utf8"), "stub -exportArchive success\n");
  assert.deepEqual(keyDirectories, []);
  assert.doesNotMatch(`${result.stdout}${result.stderr}${calls.flat().join(" ")}`, new RegExp(PRIVATE_KEY_FIXTURE));
});

test("the native release stops before export and removes its key after archive failure", (t) => {
  const { calls, keyDirectories, outputDir, result } = runRelease(t, { failOn: "archive" });

  assert.equal(result.status, 71);
  assert.deepEqual(calls.map(([command]) => command), ["archive"]);
  assert.match(readFileSync(join(outputDir, "archive.log"), "utf8"), /stub archive failure/);
  assert.equal(existsSync(join(outputDir, "export.log")), false);
  assert.deepEqual(keyDirectories, []);
  assert.doesNotMatch(result.stdout, /Upload accepted/);
});

test("the native release propagates export failure and removes its key", (t) => {
  const { calls, keyDirectories, outputDir, result } = runRelease(t, { failOn: "-exportArchive" });

  assert.equal(result.status, 72);
  assert.deepEqual(calls.map(([command]) => command), ["archive", "-exportArchive"]);
  assert.match(readFileSync(join(outputDir, "export.log"), "utf8"), /stub -exportArchive failure/);
  assert.deepEqual(keyDirectories, []);
  assert.doesNotMatch(result.stdout, /Upload accepted/);
});

test("the native release refuses to overwrite an existing numbered archive", (t) => {
  const { calls, result } = runRelease(t, {
    prepare: ({ outputDir }) => mkdirSync(join(outputDir, `Companion-${BUILD_NUMBER}.xcarchive`), { recursive: true }),
  });

  assert.equal(result.status, 1);
  assert.deepEqual(calls, []);
  assert.match(result.stderr, /Release output already exists/);
});

test("TestFlight scope includes iOS changes from every commit in the approved push", (t) => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "companion-ios-scope-test-"));
  t.after(() => rmSync(fixtureRoot, { force: true, recursive: true }));
  git(fixtureRoot, ["init", "--quiet"]);
  commitFixture(fixtureRoot, "README.md", "fixture\n", "initial");
  const beforeSha = git(fixtureRoot, ["rev-parse", "HEAD"]);
  const iosSha = commitFixture(fixtureRoot, "apps/ios/Feature.swift", "struct Feature {}\n", "ios change");
  const releaseSha = commitFixture(fixtureRoot, "docs/note.md", "follow-up\n", "non-ios follow-up");

  assert.equal(testflightScope(beforeSha, releaseSha, { cwd: fixtureRoot }).ios, true);
  assert.equal(testflightScope(iosSha, releaseSha, { cwd: fixtureRoot }).ios, false);
});

test("the TestFlight workflow releases only a CI-approved main commit", () => {
  const workflow = read(".github/workflows/ios-testflight.yml");
  const ciWorkflow = read(".github/workflows/ci.yml");
  const releaseScope = workflow.slice(workflow.indexOf("  release-scope:"), workflow.indexOf("  upload:"));

  assert.match(workflow, /^name: "Release: iOS TestFlight"$/m);
  assert.match(workflow, /^  workflow_run:$/m);
  assert.match(workflow, /^    workflows:\n      - CI$/m);
  assert.match(workflow, /^    types:\n      - completed$/m);
  assert.match(workflow, /^      - main$/m);
  assert.doesNotMatch(workflow, /^  workflow_dispatch:$/m);
  assert.doesNotMatch(workflow, /^  push:$/m);
  assert.match(releaseScope, /workflow_run\.conclusion == 'success'/);
  assert.match(releaseScope, /workflow_run\.event == 'push'/);
  assert.match(releaseScope, /workflow_run\.head_repository\.full_name == github\.repository/);
  assert.match(releaseScope, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(releaseScope, /run-id: \$\{\{ github\.event\.workflow_run\.id \}\}/);
  assert.match(releaseScope, /ref: \$\{\{ github\.event\.workflow_run\.head_sha \}\}/);
  assert.match(releaseScope, /fetch-depth: 0/);
  assert.match(releaseScope, /run: node scripts\/ios-testflight-scope\.mjs/);
  assert.doesNotMatch(releaseScope, /secrets\.|environment: ios-testflight/);
  assert.match(ciWorkflow, /BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(ciWorkflow, /name: ios-testflight-scope/);
  assert.match(ciWorkflow, /retention-days: 1/);
  assert.match(workflow, /^    needs: release-scope$/m);
  assert.match(workflow, /^    if: needs\.release-scope\.outputs\.ios == 'true'$/m);
  assert.match(workflow, /^    runs-on: macos-26$/m);
  assert.match(workflow, /ref: \$\{\{ needs\.release-scope\.outputs\.release_sha \}\}/);
  assert.match(workflow, /xcrun --sdk iphoneos --show-sdk-version/);
  assert.match(workflow, /^    environment: ios-testflight$/m);
  assert.match(workflow, /^  group: ios-testflight$/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.match(workflow, /ASC_KEY_ID: \$\{\{ secrets\.ASC_KEY_ID \}\}/);
  assert.match(workflow, /ASC_ISSUER_ID: \$\{\{ secrets\.ASC_ISSUER_ID \}\}/);
  assert.match(workflow, /ASC_KEY_P8: \$\{\{ secrets\.ASC_KEY_P8 \}\}/);
  assert.match(workflow, /IOS_DISTRIBUTION_P12: \$\{\{ secrets\.IOS_DISTRIBUTION_P12 \}\}/);
  assert.match(workflow, /IOS_DISTRIBUTION_P12_PASSWORD: \$\{\{ secrets\.IOS_DISTRIBUTION_P12_PASSWORD \}\}/);
  assert.match(workflow, /IOS_PROVISIONING_PROFILE: \$\{\{ secrets\.IOS_PROVISIONING_PROFILE \}\}/);
  assert.match(
    workflow,
    /IOS_NOTIFICATION_EXTENSION_PROVISIONING_PROFILE: \$\{\{ secrets\.IOS_NOTIFICATION_EXTENSION_PROVISIONING_PROFILE \}\}/,
  );
  assert.match(workflow, /security import/);
  assert.doesNotMatch(workflow, /security import[^\n]* -A(?: |$)/);
  assert.match(workflow, /security import[^\n]*-T \/usr\/bin\/codesign -T \/usr\/bin\/security/);
  assert.match(workflow, /security set-key-partition-list/);
  assert.match(workflow, /bash apps\/ios\/scripts\/release\.sh/);
  assert.match(workflow, /RELEASE_OUTPUT_DIR: \$\{\{ runner\.temp \}\}\/companion-ios-release-/);
  assert.doesNotMatch(workflow, /pull_request:/);
});

test("App Store export pins the distribution profile for the production bundle", () => {
  const exportOptions = read("apps/ios/Config/ExportOptions.plist");

  assert.match(exportOptions, /<key>destination<\/key>\s*<string>upload<\/string>/);
  assert.match(exportOptions, /<key>signingStyle<\/key>\s*<string>manual<\/string>/);
  assert.match(exportOptions, /<key>signingCertificate<\/key>\s*<string>Apple Distribution<\/string>/);
  assert.match(exportOptions, /<key>dev\.companion\.mobile<\/key>/);
  assert.match(exportOptions, /<string>Companion Native App Store 2026-08-24<\/string>/);
  assert.match(exportOptions, /<key>dev\.companion\.mobile\.notifyextension<\/key>/);
  assert.match(
    exportOptions,
    /<string>Companion Notification Service App Store 2026-08-26<\/string>/,
  );
});

test("the iPad declaration includes every multitasking orientation required by App Store Connect", () => {
  const plist = read("apps/ios/Companion/Support/Info.plist");
  const ipadOrientations = plist.slice(plist.indexOf("<key>UISupportedInterfaceOrientations~ipad</key>"));

  for (const orientation of [
    "UIInterfaceOrientationPortrait",
    "UIInterfaceOrientationPortraitUpsideDown",
    "UIInterfaceOrientationLandscapeLeft",
    "UIInterfaceOrientationLandscapeRight",
  ]) {
    assert.match(ipadOrientations, new RegExp(`<string>${orientation}</string>`));
  }
});
