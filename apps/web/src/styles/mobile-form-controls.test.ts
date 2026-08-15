import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Product promise:
 * Focusing a text-entry control on a touch device does not zoom the page or move nearby actions out
 * of view, while controls that do not summon a text keyboard keep their purpose-built sizing.
 *
 * Regression caught:
 * A Companion composer inherited the 14px body size, so iOS Safari zoomed the whole thread on focus
 * and made Send appear to slide beyond the right edge. The same risk existed in compact fields across
 * the app.
 *
 * Why this test is stylesheet-level:
 * Browser focus zoom depends on iOS Safari's visual viewport and cannot be reproduced by jsdom. The
 * app-wide CSS contract is the lowest deterministic boundary that can defend the required computed
 * font-size and its touch-only scope.
 *
 * Failure proof:
 * Removing the coarse-pointer query, lowering the 16px floor, placing the guard before feature
 * imports, or allowing compact local styles to override it fails a case below.
 */

const source = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const normalized = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ");
const guardStart = normalized.indexOf("@media (any-pointer: coarse)");

/** Returns one at-rule's body without accidentally including later top-level rules. */
function atRuleBody(stylesheet: string, prelude: string): string | null {
  const start = stylesheet.indexOf(prelude);
  if (start < 0) return null;
  const open = stylesheet.indexOf("{", start + prelude.length);
  if (open < 0) return null;
  let depth = 1;
  for (let index = open + 1; index < stylesheet.length; index += 1) {
    if (stylesheet[index] === "{") depth += 1;
    if (stylesheet[index] === "}") depth -= 1;
    if (depth === 0) return stylesheet.slice(open + 1, index);
  }
  return null;
}

const guardBody = atRuleBody(normalized, "@media (any-pointer: coarse)");
const guard = guardBody ?? "";
const excludedInputTypes = [
  "button",
  "checkbox",
  "color",
  "date",
  "datetime-local",
  "file",
  "hidden",
  "image",
  "month",
  "radio",
  "range",
  "reset",
  "submit",
  "time",
  "week",
];
const inputExclusions = excludedInputTypes
  .map((type) => `:not([type="${type}"])`)
  .join("");

describe("mobile form-control zoom guard", () => {
  it("loads the touch guard after every stylesheet import", () => {
    expect(guardStart).toBeGreaterThan(-1);
    expect(normalized.lastIndexOf("@import ")).toBeLessThan(guardStart);
    expect(guardBody).not.toBeNull();
  });

  it("keeps text inputs, textareas, and selects at the iOS 16px focus floor", () => {
    expect(guard).toBe(
      ` input${inputExclusions}:not(.otpinput), textarea, select { font-size: max(1rem, 16px) !important; } `,
    );
    expect(normalized.replace(`@media (any-pointer: coarse) {${guard}}`, ""))
      .not.toContain("font-size: max(1rem, 16px) !important;");
  });

  it("leaves non-text controls and the already-large OTP input alone", () => {
    for (const excluded of excludedInputTypes) {
      expect(guard).toContain(`:not([type="${excluded}"])`);
    }
    expect(guard).toContain(":not(.otpinput)");
  });
});
