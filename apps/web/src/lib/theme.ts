"use client";

/**
 * Per-device theme + accent preferences, persisted in localStorage and applied
 * to <html> via data-theme / data-accent attributes (see styles/tokens.css).
 *
 * The light theme + signal-yellow accent are the no-attribute defaults: dark
 * sets data-theme="dark"; every non-yellow accent sets data-accent. A no-FOUC
 * inline script in app/layout.tsx mirrors this logic before first paint.
 *
 * All DOM/localStorage access is SSR-guarded (typeof window/document).
 */

export type Theme = "light" | "dark" | "system";
export type Accent = "yellow" | "cloud" | "evergreen" | "coral";

export interface Prefs {
  theme: Theme;
  accent: Accent;
}

/** localStorage key shared with the no-FOUC inline script in layout.tsx. */
export const PREFS_KEY = "sx_prefs";

/** SSR-safe default: light theme + signal-yellow accent (the no-attribute state). */
export const DEFAULT_PREFS: Prefs = { theme: "light", accent: "yellow" };
const THEMES: readonly Theme[] = ["light", "dark", "system"];
const ACCENTS: readonly Accent[] = ["yellow", "cloud", "evergreen", "coral"];

/** Read persisted prefs, falling back to defaults for SSR or malformed data. */
export function readPrefs(): Prefs {
  if (typeof window === "undefined") return { ...DEFAULT_PREFS };
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<Prefs> | null;
    return {
      theme: parsed && THEMES.includes(parsed.theme as Theme) ? (parsed.theme as Theme) : DEFAULT_PREFS.theme,
      accent: parsed && ACCENTS.includes(parsed.accent as Accent) ? (parsed.accent as Accent) : DEFAULT_PREFS.accent,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

/** Persist prefs (no-op during SSR). */
export function writePrefs(p: Prefs): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage disabled (private mode / quota) — preferences are best-effort */
  }
}

/** Resolve "system" against the OS preference; light/dark pass through. */
function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Apply a theme to <html>: dark sets data-theme; light/resolved-light clears it. */
export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (resolveTheme(theme) === "dark") root.setAttribute("data-theme", "dark");
  else root.removeAttribute("data-theme");
}

/** Apply an accent to <html>: yellow is the default (no attribute). */
export function applyAccent(accent: Accent): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (accent === "yellow") root.removeAttribute("data-accent");
  else root.setAttribute("data-accent", accent);
}

/**
 * Suppress transitions for one frame so background-color doesn't freeze
 * mid-interpolation when theme/accent vars swap (Chromium quirk).
 */
export function freezeAnim(): void {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const root = document.documentElement;
  root.classList.add("no-anim");
  window.requestAnimationFrame(() => window.requestAnimationFrame(() => root.classList.remove("no-anim")));
}

/**
 * Keep <html> in sync with the OS color scheme while theme === "system".
 * Returns an unsubscribe function; a no-op (and no listener) for non-system
 * themes or during SSR. Re-applies on every prefers-color-scheme change.
 */
export function subscribeSystemTheme(theme: Theme): () => void {
  if (theme !== "system" || typeof window === "undefined" || !window.matchMedia) return () => {};
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => applyTheme("system");
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}
