import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const EXPECTED_RULES = [
  "anti-slop(no-chained-type-assertions)",
  "anti-slop(no-conditional-empty-object-spread)",
  "anti-slop(no-known-value-widening)",
  "anti-slop(no-module-mocking)",
  "anti-slop(no-object-parameters)",
  "anti-slop(no-reflect-apply)",
  "anti-slop(no-reflect-get)",
  "anti-slop(no-runtime-typeof)",
  "anti-slop(no-shape-in-symbol-names)",
  "anti-slop(no-unknown-parameters)",
  "anti-slop(no-unknown-returns)",
  "anti-slop(no-unknown-type-aliases)",
  "anti-slop(no-unsafe-dictionary-type)",
  "anti-slop(no-widen-then-assert)",
  "anti-slop(require-safety-comment-for-type-assertion)",
];

function runOxlint(fixture) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "node_modules/oxlint/bin/oxlint",
      "--config",
      "oxlint.config.ts",
      "--format",
      "json",
      "--",
      fixture,
    ],
    { cwd: process.cwd(), encoding: "utf8", shell: false },
  );
}

test("the vendored plugin accepts a compliant source file", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "companion-anti-slop-compliant-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = join(directory, "compliant.ts");
  writeFileSync(
    fixture,
    `
interface User { readonly id: string }
function displayUser(user: User): string { return user.id; }
const user = { id: "user-1" } satisfies User;
displayUser(user);
`,
  );

  const result = runOxlint(fixture);
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("the vendored plugin reports every configured rule family", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "companion-anti-slop-fixture-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = join(directory, "violations.ts");
  writeFileSync(
    fixture,
    `
import { vi } from "vitest";
declare const condition: boolean;
declare const input: string | number;
declare const operation: (...args: string[]) => void;
declare const owner: object;
declare const args: string[];
declare const value: unknown;
interface User { readonly id: string }
interface UserShape { readonly id: string }
type Hidden = unknown;
type UnsafeDictionary = Record<string, unknown>;
function acceptObject(item: object): void {}
function acceptUnknown(item: unknown): void {}
function returnUnknown(): unknown { return value; }
const chained = value as object as User;
const conditional = { ...(condition ? { enabled: true } : {}) };
const handlers: Record<string, (name: string) => void> = { start: () => {} };
vi.mock("./dependency");
Reflect.get(owner, "id");
Reflect.apply(operation, owner, args);
if (typeof input === "string") input.toUpperCase();
const known = { id: "known" };
const widened: unknown = known;
const narrowed = widened as User;
const assertion = value as User;
void [chained, conditional, handlers, narrowed, assertion];
`,
  );

  const result = runOxlint(fixture);
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(result.stdout);
  const reportedRules = new Set(report.diagnostics.map((diagnostic) => diagnostic.code));
  for (const rule of EXPECTED_RULES) assert.equal(reportedRules.has(rule), true, rule);
});
