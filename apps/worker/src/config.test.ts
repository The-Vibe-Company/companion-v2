import { describe, expect, it } from "vitest";
import { boundedInteger, runWorkerConfig } from "./config";

describe("run worker configuration", () => {
  it("rejects fractional, non-numeric and out-of-range values", () => {
    expect(boundedInteger("4", 2, { min: 1, max: 8 })).toBe(4);
    expect(boundedInteger("1.5", 2, { min: 1, max: 8 })).toBe(2);
    expect(boundedInteger("nope", 2, { min: 1, max: 8 })).toBe(2);
    expect(boundedInteger("99", 2, { min: 1, max: 8 })).toBe(2);
  });

  it("keeps heartbeat shorter than the lease", () => {
    const config = runWorkerConfig({
      COMPANION_RUN_LEASE_SECONDS: "20",
      COMPANION_RUN_HEARTBEAT_MS: "50000",
    });
    expect(config.leaseSeconds).toBe(20);
    expect(config.heartbeatMs).toBeLessThan(20_000);
  });

  it("bounds the terminal sandbox sweep interval", () => {
    expect(runWorkerConfig({ COMPANION_RUN_SWEEP_INTERVAL_MS: "5000" }).cleanupIntervalMs).toBe(5_000);
    expect(runWorkerConfig({ COMPANION_RUN_SWEEP_INTERVAL_MS: "0" }).cleanupIntervalMs).toBe(60_000);
  });
});
