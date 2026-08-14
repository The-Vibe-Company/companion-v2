import { describe, expect, it } from "vitest";
import {
  CHAT_VIEWPORT_HEIGHT,
  CHAT_VIEWPORT_SETTLE_MS,
  CHAT_VIEWPORT_TOP,
  chatViewportPin,
  chatViewportVars,
} from "./useVisualViewportPin";

/**
 * Product promise:
 * A phone thread is sized on the box the keyboard leaves visible, so the composer stays above the
 * keyboard instead of behind it — and resizing that box never moves a control out from under a
 * finger that is already on it.
 *
 * Regression caught:
 * THE-345 — reporting a viewport the browser has not measured yet would collapse the thread to a
 * zero-height page, which is worse than the `100dvh` fallback it replaces.
 * THE-346 — a keyboard closing grows the viewport between a tap and its click, and growing the
 * pinned thread there is what swallowed the tap on Send.
 *
 * Why this test is unit-level:
 * The reading is arithmetic. There is no layout in a headless environment, so what can be proven here
 * is exactly which reading becomes a style, which one is refused, and which one has to wait.
 *
 * Failure proof:
 * Returning properties for a zero-height viewport, passing the raw offset through, or reporting a
 * growth that arrived mid-tap each fails a case below.
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

describe("chat visual viewport pin", () => {
  const full = { height: 640, offsetTop: 0 };
  const keyboard = { height: 350, offsetTop: 24 };
  /** Long enough ago that nothing is being touched. */
  const idle = 10_000;

  it("takes the first reading as it comes", () => {
    expect(chatViewportPin(keyboard, null, 0)).toEqual({ reading: keyboard, retryIn: null });
  });

  it("shrinks the moment the keyboard opens, even mid-tap", () => {
    // Opening the keyboard is always the result of tapping the field. Waiting here would leave the
    // composer behind the keyboard for the first frames of typing, which is THE-345 again.
    expect(chatViewportPin(keyboard, full, 0)).toEqual({ reading: keyboard, retryIn: null });
  });

  it("holds a growth that arrives while a tap is still being resolved", () => {
    const pin = chatViewportPin(full, keyboard, 40);

    // The thread stays exactly where the finger found it, and the growth is asked for again once the
    // click it would have stolen has been delivered.
    expect(pin.reading).toBe(keyboard);
    expect(pin.retryIn).toBe(CHAT_VIEWPORT_SETTLE_MS - 40);
  });

  it("grows once the tap has settled", () => {
    expect(chatViewportPin(full, keyboard, CHAT_VIEWPORT_SETTLE_MS)).toEqual({
      reading: full,
      retryIn: null,
    });
    expect(chatViewportPin(full, keyboard, idle)).toEqual({ reading: full, retryIn: null });
  });

  it("keeps refusing a viewport with no size", () => {
    expect(chatViewportPin(null, keyboard, idle)).toEqual({ reading: null, retryIn: null });
  });
});
