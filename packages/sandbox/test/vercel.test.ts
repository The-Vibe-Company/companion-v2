import { describe, expect, it } from "vitest";
import { shouldReplaceRunningSandboxForBudget } from "../src/vercel";

describe("managed Vercel sandbox runtime budget", () => {
  const nowMs = Date.parse("2026-07-15T10:00:00.000Z");

  it("replaces only running sessions whose provider lease exceeds the admitted timeout", () => {
    expect(shouldReplaceRunningSandboxForBudget({
      status: "running",
      expiresAt: new Date(nowMs + 60_000),
      nowMs,
      requestedTimeoutMs: 10_000,
    })).toBe(true);
    expect(shouldReplaceRunningSandboxForBudget({
      status: "running",
      expiresAt: new Date(nowMs + 10_500),
      nowMs,
      requestedTimeoutMs: 10_000,
    })).toBe(false);
    expect(shouldReplaceRunningSandboxForBudget({
      status: "stopped",
      expiresAt: new Date(nowMs + 60_000),
      nowMs,
      requestedTimeoutMs: 10_000,
    })).toBe(false);
  });
});
