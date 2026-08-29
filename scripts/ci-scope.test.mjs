import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { changedFiles, classifyFiles } from "./ci-scope.mjs";

test("documentation-only changes avoid application jobs", () => {
  assert.deepEqual(classifyFiles(["docs/testing.md", "README.md", "packages/core/README.md"]), {
    docs: true,
    design: false,
    quality: false,
    build: false,
    database: false,
    runtime: false,
    browser: false,
    containers: false,
    dependencies: false,
    skill: false,
    ios: false,
    macos: false,
    full: false,
  });
});

test("a DESIGN.md change requests only its dedicated validation", () => {
  const result = classifyFiles(["DESIGN.md"]);
  assert.equal(result.docs, true);
  assert.equal(result.design, true);
  assert.equal(result.quality, false);
});

test("web runtime changes exercise quality, browser, and containers", () => {
  const result = classifyFiles(["apps/web/src/app/page.tsx"]);
  assert.equal(result.quality, true);
  assert.equal(result.build, true);
  assert.equal(result.browser, true);
  assert.equal(result.containers, true);
  assert.equal(result.database, false);
});

test("unit-test-only changes stay in the quality lane", () => {
  const result = classifyFiles(["apps/web/src/components/SkillsApp.test.ts", "packages/core/test/authz.test.ts"]);
  assert.equal(result.quality, true);
  assert.equal(result.build, false);
  assert.equal(result.database, false);
  assert.equal(result.browser, false);
  assert.equal(result.containers, false);
  assert.equal(result.runtime, false);
});

test("API and runtime integration fixtures retain the runtime lane", () => {
  for (const file of [
    "apps/api/test/integration/runtimeRoleGrants.integration.test.ts",
    "apps/runtime/test/integration/runtimeFullStack.integration.test.ts",
  ]) {
    assert.equal(classifyFiles([file]).runtime, true, file);
  }
});

test("API changes run database, browser, and container checks", () => {
  const result = classifyFiles(["apps/api/src/index.ts"]);
  assert.equal(result.database, true);
  assert.equal(result.build, true);
  assert.equal(result.browser, true);
  assert.equal(result.containers, true);
  assert.equal(result.runtime, true);
  assert.equal(result.ios, true);
});

test("iOS app changes request only the iOS native lane", () => {
  const result = classifyFiles(["apps/ios/Companion/Screens/LoginView.swift"]);
  assert.equal(result.ios, true);
  assert.equal(result.macos, false);
  assert.equal(result.quality, true);
});

test("CompanionKit changes exercise both native clients", () => {
  const result = classifyFiles(["apps/ios/CompanionKit/Sources/CompanionKit/Models.swift"]);
  assert.equal(result.ios, true);
  assert.equal(result.macos, true);
});

test("macOS app changes request the native Mac lane without an iOS build", () => {
  const result = classifyFiles(["apps/macos/CompanionMac/MacChatView.swift"]);
  assert.equal(result.macos, true);
  assert.equal(result.ios, false);
  assert.equal(result.quality, true);
});

test("runtime and simulator changes run PostgreSQL, runtime, and container checks", () => {
  for (const file of [
    "apps/runtime/src/index.ts",
    "packages/companion-runtime/src/engine.ts",
    "packages/box-runtime/src/boxCompanionRuntime.ts",
    "packages/box-sim/src/server.ts",
  ]) {
    const result = classifyFiles([file]);
    assert.equal(result.database, true, `${file} must exercise PostgreSQL`);
    assert.equal(result.runtime, true, `${file} must exercise Runtime v2`);
    assert.equal(result.containers, true, `${file} must exercise the runtime image`);
  }
});

test("skill database worker changes run database and container checks", () => {
  const result = classifyFiles(["apps/worker/src/skillDatabaseCleanup.ts"]);
  assert.equal(result.quality, true);
  assert.equal(result.build, true);
  assert.equal(result.database, true);
  assert.equal(result.containers, true);
});

test("database migrations run every integrated surface", () => {
  const result = classifyFiles(["packages/db/drizzle/0012_tenant_rls.sql"]);
  assert.equal(result.database, true);
  assert.equal(result.browser, true);
  assert.equal(result.containers, true);
});

test("Oxlint configuration changes force every CI lane", () => {
  const result = classifyFiles(["oxlint.config.ts"]);
  assert.equal(result.full, true);
  assert.equal(result.quality, true);
  assert.equal(result.dependencies, true);
});

test("Railway changes only request container validation in addition to quality", () => {
  const result = classifyFiles(["deploy/railway/Dockerfile.web"]);
  assert.equal(result.quality, true);
  assert.equal(result.build, false);
  assert.equal(result.containers, true);
  assert.equal(result.database, false);
  assert.equal(result.browser, false);
});

test("the Railway smoke script triggers its own container lane", () => {
  const result = classifyFiles(["scripts/ci-container-smoke.sh"]);
  assert.equal(result.quality, true);
  assert.equal(result.build, false);
  assert.equal(result.containers, true);
});

test("the bundled Companion runtime triggers its direct browser smoke", () => {
  const result = classifyFiles(["packages/companion-skill/src/index.ts"]);
  assert.equal(result.build, true);
  assert.equal(result.browser, true);
  assert.equal(result.containers, true);
});

test("bundled skill files always request the skill checks, documentation included", () => {
  assert.equal(classifyFiles(["packages/companion-skill/skill/SKILL.md"]).skill, true);
  assert.equal(classifyFiles(["packages/companion-skill/skill/scripts/bootstrap.py"]).skill, true);
});

test("sources inlined into the committed agent-client bundle request the skill checks", () => {
  assert.equal(classifyFiles(["packages/contracts/src/companions.ts"]).skill, true);
  assert.equal(classifyFiles(["packages/companion-skill/client/operations.ts"]).skill, true);
  assert.equal(classifyFiles(["packages/companion-skill/tsup.config.ts"]).skill, true);
});

test("changes that cannot alter the bundled skill stay out of the skill lane", () => {
  assert.equal(classifyFiles(["packages/contracts/test/companions.test.ts"]).skill, false);
  assert.equal(classifyFiles(["packages/contracts/README.md"]).skill, false);
  assert.equal(classifyFiles(["packages/core/src/companions.ts"]).skill, false);
});

test("agent-browser smoke runtime changes trigger the browser lane", () => {
  for (const file of ["scripts/agent-browser-smoke.sh", "scripts/agent-browser-box-center.mjs"]) {
    const result = classifyFiles([file]);
    assert.equal(result.quality, true);
    assert.equal(result.browser, true);
  }
});

test("deletion-only diffs retain the deleted runtime path", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "companion-ci-scope-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "ci-scope@example.invalid"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "CI scope test"], { cwd: directory });
  execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: directory });
  const relativePath = "apps/api/src/deleted.ts";
  mkdirSync(join(directory, "apps/api/src"), { recursive: true });
  writeFileSync(join(directory, relativePath), "export const deleted = true;\n");
  execFileSync("git", ["add", relativePath], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture: add runtime file"], { cwd: directory });
  const base = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();
  rmSync(join(directory, relativePath));
  execFileSync("git", ["add", "--update"], { cwd: directory });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture: delete runtime file"], { cwd: directory });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" }).trim();

  assert.deepEqual(changedFiles(base, head, { cwd: directory }), [relativePath]);
  const result = classifyFiles(changedFiles(base, head, { cwd: directory }));
  assert.equal(result.build, true);
  assert.equal(result.database, true);
  assert.equal(result.browser, true);
  assert.equal(result.containers, true);
});

test("lockfile, workflow, and CI gate changes force the full pipeline", () => {
  for (const file of [
    "pnpm-lock.yaml",
    ".github/workflows/ci.yml",
    ".gitleaksignore",
    "tsconfig.base.json",
    "scripts/ci-gate.mjs",
    "scripts/verify-change.mjs",
  ]) {
    const result = classifyFiles([file]);
    assert.equal(result.full, true);
    assert.equal(result.database, true);
    assert.equal(result.browser, true);
    assert.equal(result.containers, true);
    assert.equal(result.runtime, true);
    assert.equal(result.dependencies, true);
  }
});

test("non-pull-request events force every scope", () => {
  const result = classifyFiles([], { forceFull: true });
  for (const [key, value] of Object.entries(result)) assert.equal(value, true, `${key} should be true`);
});

test("code pull requests run the same full Node quality suite as main", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /- name: Run full quality checks\n\s+run: pnpm ci:quality --output-logs=errors-only/);
  assert.doesNotMatch(workflow, /Run affected quality checks|turbo run lint typecheck test --affected/);
});
