"use client";

import { useEffect } from "react";

/**
 * The box a phone keyboard actually leaves on screen.
 *
 * A soft keyboard shrinks the visual viewport and leaves the layout viewport alone, so `100dvh` — the
 * layout box — keeps its full height while a third of it sits behind the keyboard. The composer is at
 * the bottom of that box, so it goes behind the keyboard too, and the browser then pans the thread
 * around trying to keep the focused field in view. Reporting the visual viewport as custom properties
 * lets the thread be sized and placed on what is really visible, which leaves the composer sitting on
 * the keyboard's top edge with nothing left to pan.
 *
 * `interactive-widget` would do this in the viewport meta, but no iOS Safari supports it, and iOS is
 * the browser this is for.
 */

/** The custom properties the Companions thread reads. Cleared together when the thread closes. */
export const CHAT_VIEWPORT_HEIGHT = "--chat-viewport-h";
export const CHAT_VIEWPORT_TOP = "--chat-viewport-top";

/**
 * How long a growing viewport is held back after a tap or a blur. A phone keyboard closes because
 * something was touched, and the growth it reports arrives in the gap between that touch and the
 * `click` the browser is still going to deliver from it. Growing the pinned thread in that gap moves
 * the control out from under the finger, so the tap is lost: THE-346. One settle window is long
 * enough for the click to be delivered and short enough that nobody sees the thread wait for it.
 */
export const CHAT_VIEWPORT_SETTLE_MS = 350;

export interface VisualViewportReading {
  height: number;
  offsetTop: number;
}

/**
 * One reading as the two properties the stylesheet consumes, or `null` when there is nothing worth
 * reporting: a viewport with no size is a browser that has not laid out yet, and answering it with
 * `0px` would collapse the thread to nothing.
 */
export function chatViewportVars(
  viewport: VisualViewportReading | null | undefined,
): Record<string, string> | null {
  if (!viewport) return null;
  const height = Math.round(viewport.height);
  if (!Number.isFinite(height) || height <= 0) return null;
  // A negative offset is the page scrolled above the visual viewport; the thread never scrolls, so
  // the only offset it can see is the keyboard pushing the viewport down.
  const offsetTop = Math.max(0, Math.round(viewport.offsetTop));
  return {
    [CHAT_VIEWPORT_HEIGHT]: `${height}px`,
    [CHAT_VIEWPORT_TOP]: `${offsetTop}px`,
  };
}

export interface ChatViewportPin {
  /** The reading to report now, which may be the one already reported. */
  reading: VisualViewportReading | null;
  /** When to ask again for a reading held back, in milliseconds, or `null` when nothing is held. */
  retryIn: number | null;
}

/**
 * Which reading the thread may be pinned to.
 *
 * A keyboard opening only ever shrinks the box, and that has to land at once or the composer spends
 * the first frames of typing behind the keyboard. A keyboard closing grows it, and that is the one
 * move that can pull a control out from under a finger mid-tap, so it waits for the interaction that
 * caused it to finish. The wait is bounded by the settle window rather than by the blur, because iOS
 * blurs the field *before* it starts closing the keyboard: by the time the growth is reported there
 * is no focus left to wait on, only a click still in flight.
 */
export function chatViewportPin(
  next: VisualViewportReading | null | undefined,
  reported: VisualViewportReading | null,
  sinceInteractionMs: number,
): ChatViewportPin {
  if (!next) return { reading: null, retryIn: null };
  if (!reported || next.height <= reported.height) return { reading: next, retryIn: null };
  const wait = CHAT_VIEWPORT_SETTLE_MS - sinceInteractionMs;
  if (!(wait > 0)) return { reading: next, retryIn: null };
  return { reading: reported, retryIn: wait };
}

/** Focus leaving one of these is a soft keyboard on its way out. */
const KEYBOARD_FIELDS = new Set(["INPUT", "TEXTAREA"]);

function keyboardField(node: EventTarget | null): boolean {
  const element = node as { tagName?: string; isContentEditable?: boolean } | null;
  if (!element?.tagName) return false;
  return KEYBOARD_FIELDS.has(element.tagName) || element.isContentEditable === true;
}

/**
 * Report the visual viewport for as long as a thread is open. A browser without `visualViewport`
 * reports nothing at all, and the stylesheet falls back to `100dvh`.
 */
export function useVisualViewportPin(): void {
  useEffect(() => {
    const viewport = typeof window === "undefined" ? null : window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    /** The reading the stylesheet is currently on, so a growth can be recognised as one. */
    let reported: VisualViewportReading | null = null;
    let interactedAt = Number.NEGATIVE_INFINITY;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      reported = null;
      root.style.removeProperty(CHAT_VIEWPORT_HEIGHT);
      root.style.removeProperty(CHAT_VIEWPORT_TOP);
    };
    const apply = () => {
      if (retry !== undefined) {
        clearTimeout(retry);
        retry = undefined;
      }
      const pin = chatViewportPin(
        { height: viewport.height, offsetTop: viewport.offsetTop },
        reported,
        Date.now() - interactedAt,
      );
      if (pin.retryIn !== null) retry = setTimeout(apply, pin.retryIn);
      const vars = chatViewportVars(pin.reading);
      if (!vars) {
        clear();
        return;
      }
      reported = pin.reading;
      for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    };
    // A touch and the blur it causes are the two things a lost tap is made of; both start the window
    // a growing viewport has to wait out. Capture, because a handler on the way down may stop the
    // event before it reaches the document.
    const noteTouch = () => {
      interactedAt = Date.now();
    };
    const noteBlur = (event: Event) => {
      if (keyboardField(event.target)) interactedAt = Date.now();
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    document.addEventListener("pointerdown", noteTouch, true);
    document.addEventListener("focusout", noteBlur, true);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      document.removeEventListener("pointerdown", noteTouch, true);
      document.removeEventListener("focusout", noteBlur, true);
      if (retry !== undefined) clearTimeout(retry);
      clear();
    };
  }, []);
}
