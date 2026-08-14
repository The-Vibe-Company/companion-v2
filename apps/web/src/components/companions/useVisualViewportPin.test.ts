import { describe, expect, it } from "vitest";
import {
  CHAT_VIEWPORT_HEIGHT,
  CHAT_VIEWPORT_TOP,
  chatViewportVars,
} from "./useVisualViewportPin";

/**
 * Product promise:
 * A phone thread is sized on the box the keyboard leaves visible, so the composer stays above the
 * keyboard instead of behind it.
 *
 * Regression caught:
 * THE-345 — reporting a viewport the browser has not measured yet would collapse the thread to a
 * zero-height page, which is worse than the `100dvh` fallback it replaces.
 *
 * Why this test is unit-level:
 * The reading is arithmetic. There is no layout in a headless environment, so what can be proven here
 * is exactly which reading becomes a style and which one is refused.
 *
 * Failure proof:
 * Returning properties for a zero-height viewport, or passing the raw offset through, fails a case
 * below.
 */

describe("chat visual viewport reading", () => {
  it("reports the visible height and the offset the keyboard pushed it down by", () => {
    expect(chatViewportVars({ height: 431.5, offsetTop: 12.4 })).toEqual({
      [CHAT_VIEWPORT_HEIGHT]: "432px",
      [CHAT_VIEWPORT_TOP]: "12px",
    });
  });

  it("refuses a reading with no height so the stylesheet keeps its dvh fallback", () => {
    expect(chatViewportVars({ height: 0, offsetTop: 0 })).toBeNull();
    expect(chatViewportVars({ height: Number.NaN, offsetTop: 0 })).toBeNull();
    expect(chatViewportVars(null)).toBeNull();
    expect(chatViewportVars(undefined)).toBeNull();
  });

  it("never reports a negative offset", () => {
    // The thread does not scroll, so the only offset it can see is the keyboard; anything below zero
    // would lift the shell off the top of the screen.
    expect(chatViewportVars({ height: 640, offsetTop: -8 })?.[CHAT_VIEWPORT_TOP]).toBe("0px");
  });
});
