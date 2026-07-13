import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    browser: false,
    containers: false,
    dependencies: false,
    skill: false,
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
});

test("API changes run database, browser, and container checks", () => {
  const result = classifyFiles(["apps/api/src/index.ts"]);
  assert.equal(result.database, true);
  assert.equal(result.build, true);
  assert.equal(result.browser, true);
  assert.equal(result.containers, true);
});

test("database migrations run every integrated surface", () => {
  const result = classifyFiles(["packages/db/drizzle/0012_tenant_rls.sql"]);
  assert.equal(result.database, true);
  assert.equal(result.browser, true);
  assert.equal(result.containers, true);
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

test("deletion-only diffs retain the deleted runtime path", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "companion-ci-scope-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet"], { cwd: directory });
  execFileSync("git", ["config", "user.email", "ci-scope@example.invalid"], { cwd: directory });
  execFileSync("git", ["config", "user.name", "CI scope test"], { cwd: directory });
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

test("lockfile and workflow changes force the full pipeline", () => {
  for (const file of ["pnpm-lock.yaml", ".github/workflows/ci.yml", ".gitleaksignore", "tsconfig.base.json"]) {
    const result = classifyFiles([file]);
    assert.equal(result.full, true);
    assert.equal(result.database, true);
    assert.equal(result.browser, true);
    assert.equal(result.containers, true);
    assert.equal(result.dependencies, true);
  }
});

test("non-pull-request events force every scope", () => {
  const result = classifyFiles([], { forceFull: true });
  for (const [key, value] of Object.entries(result)) assert.equal(value, true, `${key} should be true`);
});
