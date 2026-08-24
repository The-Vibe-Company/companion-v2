import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function read(path) {
  return readFileSync(resolve(ROOT, path), "utf8");
}

test("the native release script signs and uploads an immutable numbered archive", () => {
  const release = read("apps/ios/scripts/release.sh");
  const syntax = spawnSync("bash", ["-n", resolve(ROOT, "apps/ios/scripts/release.sh")], {
    encoding: "utf8",
  });

  assert.equal(syntax.status, 0, syntax.stderr);
  assert.match(release, /ASC_KEY_ID is required/);
  assert.match(release, /ASC_ISSUER_ID is required/);
  assert.match(release, /IOS_PROVISIONING_PROFILE_SPECIFIER is required/);
  assert.match(release, /ASC_KEY_PATH or ASC_KEY_P8 is required/);
  assert.match(release, /date -u \+%Y%m%d%H%M%S/);
  assert.match(release, /xcodebuild archive/);
  assert.match(release, /CURRENT_PROJECT_VERSION="\$BUILD_NUMBER"/);
  assert.match(release, /xcodebuild -exportArchive/);
  assert.match(release, /-authenticationKeyPath/);
  assert.match(release, /-allowProvisioningUpdates/);
  assert.match(release, /CODE_SIGN_STYLE=Manual/);
  assert.match(release, /PROVISIONING_PROFILE_SPECIFIER=\$IOS_PROVISIONING_PROFILE_SPECIFIER/);
  assert.match(release, /tee "\$OUTPUT_DIR\/archive\.log"/);
  assert.match(release, /tee "\$OUTPUT_DIR\/export\.log"/);
  assert.doesNotMatch(release, /7DN3M7V283|c532015e-3315-45c0-9028-3c10a37417e9/);
});

test("the TestFlight workflow is isolated, serialized, and secret-backed", () => {
  const workflow = read(".github/workflows/ios-testflight.yml");

  assert.match(workflow, /^name: iOS TestFlight$/m);
  assert.match(workflow, /^  workflow_dispatch:$/m);
  assert.match(workflow, /^  push:$/m);
  assert.match(workflow, /^      - main$/m);
  assert.match(workflow, /- "apps\/ios\/\*\*"/);
  assert.match(workflow, /^    environment: ios-testflight$/m);
  assert.match(workflow, /^  group: ios-testflight$/m);
  assert.match(workflow, /^  cancel-in-progress: false$/m);
  assert.match(workflow, /ASC_KEY_ID: \$\{\{ secrets\.ASC_KEY_ID \}\}/);
  assert.match(workflow, /ASC_ISSUER_ID: \$\{\{ secrets\.ASC_ISSUER_ID \}\}/);
  assert.match(workflow, /ASC_KEY_P8: \$\{\{ secrets\.ASC_KEY_P8 \}\}/);
  assert.match(workflow, /IOS_DISTRIBUTION_P12: \$\{\{ secrets\.IOS_DISTRIBUTION_P12 \}\}/);
  assert.match(workflow, /IOS_DISTRIBUTION_P12_PASSWORD: \$\{\{ secrets\.IOS_DISTRIBUTION_P12_PASSWORD \}\}/);
  assert.match(workflow, /IOS_PROVISIONING_PROFILE: \$\{\{ secrets\.IOS_PROVISIONING_PROFILE \}\}/);
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
