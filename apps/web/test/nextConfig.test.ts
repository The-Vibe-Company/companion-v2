import { describe, expect, it } from "vitest";
import config from "../next.config";

/**
 * THE-341: a send that wakes an asleep Companion persists first and then holds the request open for
 * the wake — ~45–65s, and up to the API's three-minute start budget. Next defaults a rewrite's proxy
 * timeout to 30s, which killed that request mid-wake and surfaced as a 500 over an already-durable
 * turn. The proxy must therefore outlive a normal wake and sit past that start budget, while staying a
 * bounded ceiling rather than an unbounded wait.
 */
const START_BUDGET_MS = 3 * 60_000;

describe("next.config proxy timeout", () => {
  it("lets a proxied API request outlive a wake within the start budget", () => {
    const proxyTimeout = config.experimental?.proxyTimeout;
    expect(typeof proxyTimeout).toBe("number");
    expect(proxyTimeout).toBeGreaterThan(START_BUDGET_MS);
  });

  it("stays a bounded ceiling rather than an unbounded wait", () => {
    const proxyTimeout = config.experimental?.proxyTimeout as number;
    // Just past the budget plus room for the failure path to record its reason; not minutes beyond.
    expect(proxyTimeout).toBeLessThanOrEqual(START_BUDGET_MS + 60_000);
  });
});
