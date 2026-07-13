import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { forbiddenPlaywrightMarkers, validatePlaywrightDirectory } from "./ci-playwright-policy.mjs";

test("accepts ordinary Playwright tests", () => {
  assert.deepEqual(forbiddenPlaywrightMarkers('test("critical flow", async ({ page }) => page.goto("/"));'), []);
});

test("rejects exclusive, skipped, and fixme tests", () => {
  const violations = forbiddenPlaywrightMarkers(`
    test.only("focused", async () => {});
    test.skip(condition, "conditional skip");
    describe.fixme("disabled suite", () => {});
  `);
  assert.deepEqual(
    violations.map(({ label }) => label).sort(),
    ["exclusive test", "skipped test", "skipped test"],
  );
});

test("scans every module extension discovered by Playwright", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "companion-playwright-policy-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const extension of ["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"]) {
    writeFileSync(join(directory, `critical.spec.${extension}`), 'test.skip("disabled", async () => {});\n');
  }

  const violations = validatePlaywrightDirectory(directory);
  assert.equal(violations.length, 8);
  for (const extension of ["cjs", "cts", "js", "jsx", "mjs", "mts", "ts", "tsx"]) {
    assert.ok(violations.some((violation) => violation.includes(`critical.spec.${extension}:1`)));
  }
});
