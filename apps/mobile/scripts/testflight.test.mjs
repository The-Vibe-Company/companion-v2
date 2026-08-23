import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (name) => JSON.parse(fs.readFileSync(path.join(mobile, name), "utf8"));
const workflow = fs.readFileSync(path.join(mobile, ".eas/workflows/testflight.yml"), "utf8");

function jobs() {
  const body = workflow.slice(workflow.indexOf("\njobs:\n") + 1);
  const blocks = {};
  let current = null;
  for (const line of body.split("\n").slice(1)) {
    const header = line.match(/^ {2}([a-z_]+):\s*$/);
    if (header) {
      current = header[1];
      blocks[current] = [];
    } else if (current && line.trim()) {
      blocks[current].push(line.trim());
    }
  }
  return blocks;
}

describe("TestFlight delivery", () => {
  const app = readJson("app.json").expo;
  const eas = readJson("eas.json");
  const pkg = readJson("package.json");

  it("uses native fingerprints and supports compatible OTA updates", () => {
    assert.deepEqual(app.runtimeVersion, { policy: "fingerprint" });
    assert.ok(pkg.dependencies["expo-updates"]);
  });

  it("keeps production identifiers in app.json and derives the local .dev variant", () => {
    assert.equal(app.ios.bundleIdentifier, "dev.companion.mobile");
    assert.equal(app.android.package, "dev.companion.mobile");
    const config = fs.readFileSync(path.join(mobile, "app.config.ts"), "utf8");
    assert.match(config, /process\.env\.APP_VARIANT/);
    assert.match(config, /development: \{ suffix: "\.dev" \}/);
    assert.match(config, /production: \{ suffix: "" \}/);
  });

  it("has deterministic production build and submit profiles", () => {
    assert.equal(pkg.devDependencies["eas-cli"], "22.2.0");
    assert.equal(eas.cli.version, pkg.devDependencies["eas-cli"]);
    assert.equal(eas.cli.appVersionSource, "remote");
    assert.equal(eas.build.production.autoIncrement, true);
    assert.equal(eas.build.production.channel, "production");
    assert.equal(eas.build.production.distribution, "store");
    assert.equal(eas.build.production.env.APP_VARIANT, "production");
    assert.equal(eas.build.development.developmentClient, true);
    assert.equal(eas.build.development.env.APP_VARIANT, "development");
    assert.match(eas.submit.production.ios.ascAppId, /^\d+$/);
    assert.match(eas.submit.production.ios.appleTeamId, /^[A-Z0-9]{10}$/);
  });

  it("builds only when no compatible iOS build exists", () => {
    const blocks = jobs();
    assert.ok(blocks.fingerprint.includes("type: fingerprint"));
    assert.ok(blocks.get_ios_build.includes("type: get-build"));
    assert.ok(blocks.get_ios_build.some((line) => line.includes("ios_fingerprint_hash")));
    assert.ok(blocks.build_ios.includes("if: ${{ !needs.get_ios_build.outputs.build_id }}"));
    assert.ok(blocks.build_ios.includes("type: build"));
    assert.ok(blocks.testflight.includes("type: testflight"));
    assert.ok(blocks.publish_ios_update.includes("if: ${{ needs.get_ios_build.outputs.build_id }}"));
    assert.ok(blocks.publish_ios_update.includes("type: update"));
    assert.ok(blocks.publish_ios_update.includes("channel: production"));
  });

  it("uses the production variant for fingerprints, builds, and updates", () => {
    const blocks = jobs();
    for (const name of ["fingerprint", "publish_ios_update"]) {
      assert.ok(blocks[name].includes("environment: production"));
      assert.ok(blocks[name].includes(`APP_VARIANT: ${eas.build.production.env.APP_VARIANT}`));
    }
  });

  it("routes manual EAS commands through the production wrapper", () => {
    const wrapper = fs.readFileSync(path.join(mobile, "scripts/eas.sh"), "utf8");
    assert.match(wrapper, /APP_VARIANT=production/);
    assert.match(wrapper, /pnpm exec eas/);
    assert.doesNotMatch(wrapper, /@latest/);
    assert.ok((fs.statSync(path.join(mobile, "scripts/eas.sh")).mode & 0o111) !== 0);
  });

  it("keeps cloud dependency installation inside the standalone mobile app", () => {
    const workspace = fs.readFileSync(path.join(mobile, "pnpm-workspace.yaml"), "utf8");
    assert.match(workspace, /packages:\s*\n\s+- "\."/);
    const rootWorkspace = fs.readFileSync(path.join(mobile, "../../pnpm-workspace.yaml"), "utf8");
    assert.match(rootWorkspace, /!apps\/mobile/);
  });
});
