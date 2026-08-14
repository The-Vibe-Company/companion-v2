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

/**
 * Report the visual viewport for as long as a thread is open. A browser without `visualViewport`
 * reports nothing at all, and the stylesheet falls back to `100dvh`.
 */
export function useVisualViewportPin(): void {
  useEffect(() => {
    const viewport = typeof window === "undefined" ? null : window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const clear = () => {
      root.style.removeProperty(CHAT_VIEWPORT_HEIGHT);
      root.style.removeProperty(CHAT_VIEWPORT_TOP);
    };
    const apply = () => {
      const vars = chatViewportVars(viewport);
      if (!vars) {
        clear();
        return;
      }
      for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      clear();
    };
  }, []);
}
