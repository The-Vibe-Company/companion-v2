import { afterEach, beforeEach, expect, vi } from "vitest";

let implicitFetch: ReturnType<typeof vi.fn>;

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
