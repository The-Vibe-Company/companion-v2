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

  it("bounds and scopes sandbox lifecycle v2", () => {
    const config = runWorkerConfig({
      COMPANION_SANDBOX_LIFECYCLE_V2: "true",
      COMPANION_SANDBOX_LIFECYCLE_V2_ORGS: "org-1, org-2",
      COMPANION_SANDBOX_MAX_SESSION_MS: "600000",
      COMPANION_RUN_RECORDER_UNAVAILABLE_MS: "15000",
    });
    expect(config.sandboxLifecycleV2).toBe(true);
    expect(config.sandboxLifecycleV2OrgIds).toEqual(new Set(["org-1", "org-2"]));
    expect(config.sandboxMaxSessionMs).toBe(600_000);
    expect(config.recorderUnavailableMs).toBe(15_000);
    expect(runWorkerConfig({ COMPANION_SANDBOX_MAX_SESSION_MS: "3600001" }).sandboxMaxSessionMs)
      .toBe(3_600_000);
  });
});
