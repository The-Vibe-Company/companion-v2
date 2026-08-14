import { afterEach, beforeEach, expect, vi } from "vitest";

let implicitFetch: ReturnType<typeof vi.fn>;

/**
 * The refusal happy-dom reports for every framed document once `disableIframePageLoading` is on. That
 * setting is deliberate — a unit test has no business asking a real Box for a desktop stream — so its
 * refusal is expected output rather than a diagnostic, and it is dropped so a real console error in a
 * test that renders a frame is still the only thing on stderr.
 */
const EXPECTED_IFRAME_REFUSAL = "Iframe page loading is disabled";

const consoleError = console.error.bind(console);
console.error = (...args: unknown[]) => {
  const first = args[0];
  const message = first instanceof Error ? first.message : typeof first === "string" ? first : "";
  if (message.includes(EXPECTED_IFRAME_REFUSAL)) return;
  consoleError(...args);
};

beforeEach(() => {
  implicitFetch = vi.fn(async (input: RequestInfo | URL) => {
    throw new Error(
      `Unexpected network request in a web unit test: ${String(input)}. Mock the client boundary explicitly.`,
    );
  });
  vi.stubGlobal("fetch", implicitFetch);
});

afterEach(() => {
  // A rejected fetch is often caught by production fallback code. Checking the spy as well makes
  // accidental I/O fail the test even when that fallback would otherwise hide the regression.
  expect(implicitFetch, "web unit tests must not perform implicit network requests").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
