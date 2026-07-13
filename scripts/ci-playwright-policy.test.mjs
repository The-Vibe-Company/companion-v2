import assert from "node:assert/strict";
import test from "node:test";
import { forbiddenPlaywrightMarkers } from "./ci-playwright-policy.mjs";

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
