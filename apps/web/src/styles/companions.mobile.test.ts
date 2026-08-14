import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Product promise:
 * A Companion on a phone stays where it is put. Nothing in the Companions stylesheet may be wider
 * than the viewport, no surface may slide in from the side, and the thread keeps the composer on
 * screen instead of letting the page pan under a finger.
 *
 * Regression caught:
 * THE-344/THE-345 — dialogs sized in `100vw` overflowed the visual viewport, a leftover `translateX`
 * enter animation slid the thread in, and the 60px rail squeezed the phone chat header until it
 * overflowed.
 *
 * Why this test is stylesheet-level:
 * The whole failure lives in CSS. There is no runtime behaviour to observe: a jsdom-class environment
 * has no layout, so the only place these promises can be defended is the declarations themselves.
 *
 * Failure proof:
 * Restoring `calc(100vw - 28px)` on any dialog, re-adding the `companions-thread-in` keyframes, or
 * dropping the phone override of the rail margin each fails one case below.
 */

const source = readFileSync(new URL("./companions.css", import.meta.url), "utf8");
/** Comments explain what was removed and why, so the assertions read the rules alone. */
const css = source.replace(/\/\*[\s\S]*?\*\//g, "");

interface CssRule {
  /** The at-rules this rule sits inside, outermost first. */
  at: string[];
  selectors: string[];
  declarations: string;
}

/** A stylesheet as flat rules, so a declaration can be asserted with its media context. */
function parseRules(stripped: string): CssRule[] {
  const rules: CssRule[] = [];
  const at: string[] = [];
  let prelude = "";
  let index = 0;
  while (index < stripped.length) {
    const char = stripped[index];
    if (char === "}") {
      at.pop();
      prelude = "";
      index += 1;
      continue;
    }
    if (char !== "{") {
      prelude += char;
      index += 1;
      continue;
    }
    const head = prelude.trim();
    prelude = "";
    index += 1;
    if (head.startsWith("@")) {
      at.push(head.replace(/\s+/g, " "));
      continue;
    }
    let depth = 1;
    let declarations = "";
    while (index < stripped.length) {
      const inner = stripped[index];
      if (inner === "{") depth += 1;
      if (inner === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
      declarations += inner;
      index += 1;
    }
    index += 1;
    rules.push({
      at: [...at],
      selectors: head.split(",").map((selector) => selector.trim().replace(/\s+/g, " ")),
      declarations,
    });
  }
  return rules;
}

const rules = parseRules(css);

function declarationsFor(selector: string, at: string[] = []): string[] {
  return rules
    .filter((rule) =>
      rule.selectors.includes(selector)
      && rule.at.length === at.length
      && rule.at.every((entry, position) => entry === at[position]))
    .map((rule) => rule.declarations.replace(/\s+/g, " ").trim());
}

const PHONE = ["@media (max-width: 560px)"];

describe("Companions mobile viewport", () => {
  it("sizes every dialog against its scrim instead of the viewport width", () => {
    // `100vw` counts the scrollbar and the overscroll gutter, so a dialog came out wider than what is
    // on screen and the page could be dragged sideways behind it.
    expect(css).not.toContain("100vw");

    for (const dialog of [
      ".companions-new-dialog",
      ".companions-providers-dialog",
      ".companions-plugin-dialog",
      ".companions-delete-dialog",
      ".companions-share-dialog",
    ]) {
      const [declarations] = declarationsFor(dialog);
      expect(declarations, dialog).toMatch(/width: min\(\d+px, 100%\);/);
    }
  });

  it("leaves no slide-in animation on the thread", () => {
    // THE-333 made the chat a full page; these classes are in no TSX file, and the leftover keyframe
    // is the sideways slide the report was about.
    expect(css).not.toContain("companions-thread-in");
    expect(css).not.toContain("companions-scrim-in");
    expect(css).not.toContain("companions-thread-scrim");
    // Nothing in this stylesheet may animate a surface across the screen. A keyframe that only
    // rotates in place — the tool-run spinner — is not that, so the assertion is on what the
    // keyframes do rather than on there being none.
    const keyframes = rules.filter((rule) =>
      rule.at.some((entry) => entry.startsWith("@keyframes")));
    expect(keyframes.length).toBeGreaterThan(0);
    for (const frame of keyframes) {
      expect(frame.declarations).not.toMatch(/translate|left|right|inset|margin/);
    }
    expect(css).not.toContain("translateX(16px)");
  });

  it("keeps the shell on the dynamic viewport and clips the inline axis", () => {
    const [declarations] = declarationsFor(".companions-app");

    expect(declarations).toContain("height: 100dvh;");
    expect(declarations).toContain("overflow-x: clip;");
    expect(declarations).not.toContain("100vh");
  });

  it("stops a flick at the end of a nested scroller instead of bouncing the page", () => {
    // The list scrolls in the main box and the thread scrolls in the log; neither may hand the
    // gesture on to the page underneath it.
    expect(declarationsFor(".companions-main")[0]).toContain("overscroll-behavior: none;");
    expect(declarationsFor(".chat-log")[0]).toContain("overscroll-behavior: none;");
    // The thread's own frame never scrolls: the log owns it.
    expect(declarationsFor(".companions-main--chat")[0]).toContain("overflow: hidden;");
  });

  it("gives the phone thread the whole width and pins it to the visual viewport", () => {
    // The rail is an overlay on a phone, not a column: 60px out of a 320px header is the difference
    // between a header that fits and one that overflows.
    expect(declarationsFor(".companions-app .companions-main--chat", PHONE)[0])
      .toContain("margin-left: 0;");

    const pinned = declarationsFor(".companions-app:has(.companions-main--chat)", PHONE);
    expect(pinned.join(" ")).toContain("height: var(--chat-viewport-h, 100dvh);");
    expect(pinned.join(" ")).toContain("top: var(--chat-viewport-top, 0px);");
    // The shell's own floor is a full `dvh`. Left standing, it holds the box at its pre-keyboard
    // height however short the reported viewport gets, which puts the composer back under the
    // keyboard — the exact failure this rule exists to prevent.
    expect(pinned.join(" ")).toContain("min-height: var(--chat-viewport-h, 100dvh);");
  });

  it("keeps the composer clear of the home indicator", () => {
    // The keyboard covers the home indicator, so the inset is a floor on the existing padding rather
    // than an addition to it.
    expect(declarationsFor(".chat-composer", PHONE)[0])
      .toMatch(/padding: .*max\(12px, env\(safe-area-inset-bottom, 0px\)\);/);
  });

  it("shortens the Box chip on a phone rather than wrapping the header", () => {
    expect(declarationsFor(".chat-box__prefix", PHONE)[0]).toContain("display: none;");
    // The state word stays: status is never left to the colour of the dot alone.
    expect(declarationsFor(".chat-box__state", PHONE)).toHaveLength(0);
    expect(declarationsFor(".chat-head > *")[0]).toContain("flex: none;");
  });

  it("keeps the plugin row's named areas off the registry card", () => {
    // Both surfaces use `.companions-plugin-icon`. Unscoped, `grid-area: icon` placed the card's icon
    // in an implicit track of its own: the card grew two empty columns, the description was squeezed
    // to 32px, and the icon dropped to the bottom-right corner.
    expect(declarationsFor(".companions-plugin-icon", PHONE)).toHaveLength(0);
    expect(declarationsFor(".companions-plugin-row > .companions-plugin-icon", PHONE)[0])
      .toContain("grid-area: icon;");
  });

  it("puts the registry card's action under its text on a phone", () => {
    const card = declarationsFor(".companions-registry-card", PHONE)[0];

    expect(card).toContain("grid-template-columns: 32px minmax(0, 1fr);");
    expect(card).toContain('"action action"');
    expect(declarationsFor(".companions-registry-card > .cds-btn", PHONE)[0])
      .toContain("min-height: 40px;");
  });

  it("holds a tool run's chip and its Box frame inside the thread's width", () => {
    // A grid column left to size itself takes the longest command or the frame's own pixels, so a
    // `max-width: 100%` underneath it resolves against that content rather than the thread and both
    // parts run off a phone. Bounding the column is what makes those percentages mean the thread.
    expect(declarationsFor(".chat-tool")[0]).toContain("grid-template-columns: minmax(0, 1fr);");
    expect(declarationsFor(".chat-tool__head")[0]).toContain("max-width: 100%;");
    expect(declarationsFor(".chat-tool__detail")[0]).toContain("max-width: 100%;");
    expect(declarationsFor(".chat-tool__frame")[0]).toContain("max-width: min(100%, 460px);");
  });

  it("keeps Back, Wake, and Send at a 44px thumb target", () => {
    const coarse = ["@media (pointer: coarse)"];

    expect(declarationsFor(".chat-head .chat-back", coarse)[0]).toContain("min-height: 44px;");
    expect(declarationsFor(".chat-head .cds-btn", coarse)[0]).toContain("min-height: 44px;");
    // THE-346: Send is the control the composer exists for, and 30px is not a thumb target.
    const send = declarationsFor(".chat-send", coarse)[0];
    expect(send).toContain("width: 44px;");
    expect(send).toContain("height: 44px;");
    // A mouse still points at the compact square.
    expect(declarationsFor(".chat-send")[0]).toContain("width: 30px;");
  });
});
