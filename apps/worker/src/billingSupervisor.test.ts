import type { BillingGateway } from "@companion/billing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBillingSupervisor } from "./billingSupervisor";

/**
 * Product promise:
 * A transient Stripe or database failure cannot leave managed billing reconciliation disabled until redeploy.
 *
 * Regression caught:
 * The worker previously attempted billing startup once, swallowed the error, and permanently returned null.
 *
 * Why this test is unit-level:
 * Retry scheduling and overlap prevention are worker orchestration rules; Stripe and Postgres are separate contracts.
 *
 * Failure proof:
 * Removing the startup retry or periodic error guard makes the recovery scenarios fail.
 */
const stripeConfig = {
  billingMode: "stripe" as const,
  entitlementMode: "observe" as const,
  pilotOrgIds: new Set<string>(),
  proOrgAllowlist: new Set<string>(),
  checkoutEnabled: false,
  webhooksEnabled: false,
};

function gateway(validateConfiguration: () => Promise<void>): BillingGateway {
  return { validateConfiguration } as BillingGateway;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("billing supervisor recovery", () => {
  it("retries a transient startup failure and starts its schedules", async () => {
    vi.useFakeTimers();
    const transient = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const validate = vi.fn().mockRejectedValueOnce(transient).mockResolvedValue(undefined);
    const batch = vi.fn(async () => undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    const supervisor = await startBillingSupervisor({
      config: stripeConfig,
      gateway: gateway(validate),
      runBatch: batch,
      startupRetryMs: 25,
      pendingIntervalMs: 50,
      reconcileIntervalMs: 125,
    });

    expect(supervisor).not.toBeNull();
    expect(validate).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("billing supervisor startup will retry (Error code=ECONNRESET)");

    await vi.advanceTimersByTimeAsync(25);

    expect(validate).toHaveBeenCalledTimes(2);
    expect(batch).toHaveBeenCalledWith(expect.anything(), false);
    expect(info).toHaveBeenCalledWith("billing supervisor started");
    await vi.advanceTimersByTimeAsync(125);
    expect(batch).toHaveBeenCalledTimes(4);
    expect(batch).toHaveBeenNthCalledWith(4, expect.anything(), true);
    await supervisor?.stop();
    await vi.advanceTimersByTimeAsync(500);
    expect(batch).toHaveBeenCalledTimes(4);
  });

  it("recovers when the initial database batch fails", async () => {
    vi.useFakeTimers();
    const validate = vi.fn(async () => undefined);
    const batch = vi
      .fn<(_: BillingGateway, full: boolean) => Promise<void>>()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValue(undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const supervisor = await startBillingSupervisor({
      config: stripeConfig,
      gateway: gateway(validate),
      runBatch: batch,
      pendingIntervalMs: 50,
      reconcileIntervalMs: 10_000,
    });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith("billing pending synchronization will retry (Error)");
    await vi.advanceTimersByTimeAsync(50);
    expect(batch).toHaveBeenCalledTimes(2);
    await supervisor?.stop();
  });

  it("isolates a full reconciliation failure and retries it on the next interval", async () => {
    vi.useFakeTimers();
    const batch = vi
      .fn<(_: BillingGateway, full: boolean) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("stripe unavailable"))
      .mockResolvedValue(undefined);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const supervisor = await startBillingSupervisor({
      config: stripeConfig,
      gateway: gateway(vi.fn(async () => undefined)),
      runBatch: batch,
      pendingIntervalMs: 10_000,
      reconcileIntervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);
    expect(warning).toHaveBeenCalledWith("billing full synchronization will retry (Error)");
    await vi.advanceTimersByTimeAsync(50);
    expect(batch).toHaveBeenCalledTimes(3);
    expect(batch).toHaveBeenNthCalledWith(2, expect.anything(), true);
    expect(batch).toHaveBeenNthCalledWith(3, expect.anything(), true);
    await supervisor?.stop();
  });

  it("cancels a pending startup retry during shutdown", async () => {
    vi.useFakeTimers();
    const validate = vi.fn().mockRejectedValue(new Error("offline"));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const supervisor = await startBillingSupervisor({
      config: stripeConfig,
      gateway: gateway(validate),
      runBatch: vi.fn(async () => undefined),
      startupRetryMs: 25,
    });
    await supervisor?.stop();
    await vi.advanceTimersByTimeAsync(100);

    expect(validate).toHaveBeenCalledTimes(1);
  });

  it("does not overlap pending reconciliation ticks", async () => {
    vi.useFakeTimers();
    let releaseBatch: (() => void) | undefined;
    const batch = vi
      .fn<(_: BillingGateway, full: boolean) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseBatch = resolve; }))
      .mockResolvedValue(undefined);
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const supervisor = await startBillingSupervisor({
      config: stripeConfig,
      gateway: gateway(vi.fn(async () => undefined)),
      runBatch: batch,
      pendingIntervalMs: 25,
      reconcileIntervalMs: 10_000,
    });

    await vi.advanceTimersByTimeAsync(75);
    expect(batch).toHaveBeenCalledTimes(2);
    releaseBatch?.();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);
    expect(batch).toHaveBeenCalledTimes(3);
    await supervisor?.stop();
  });

  it("waits for an in-flight retry activation and cancels future retries when stopped", async () => {
    vi.useFakeTimers();
    let releaseValidation: (() => void) | undefined;
    const validate = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseValidation = resolve; }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const supervisor = await startBillingSupervisor({
      config: stripeConfig,
      gateway: gateway(validate),
      runBatch: vi.fn(async () => undefined),
      startupRetryMs: 25,
    });
    vi.advanceTimersByTime(25);
    await Promise.resolve();
    expect(validate).toHaveBeenCalledTimes(2);

    let stopFinished = false;
    const stop = supervisor?.stop().then(() => { stopFinished = true; });
    await Promise.resolve();
    expect(stopFinished).toBe(false);
    releaseValidation?.();
    await stop;
    expect(stopFinished).toBe(true);
    await vi.advanceTimersByTimeAsync(100);

    expect(validate).toHaveBeenCalledTimes(2);
  });

  it("waits for an in-flight periodic batch during shutdown", async () => {
    vi.useFakeTimers();
    let releaseBatch: (() => void) | undefined;
    const batch = vi
      .fn<(_: BillingGateway, full: boolean) => Promise<void>>()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => { releaseBatch = resolve; }));
    vi.spyOn(console, "info").mockImplementation(() => undefined);

    const supervisor = await startBillingSupervisor({
      config: stripeConfig,
      gateway: gateway(vi.fn(async () => undefined)),
      runBatch: batch,
      pendingIntervalMs: 25,
      reconcileIntervalMs: 10_000,
    });
    vi.advanceTimersByTime(25);
    await Promise.resolve();
    expect(batch).toHaveBeenCalledTimes(2);

    let stopFinished = false;
    const stop = supervisor?.stop().then(() => { stopFinished = true; });
    await Promise.resolve();
    expect(stopFinished).toBe(false);
    releaseBatch?.();
    await stop;
    expect(stopFinished).toBe(true);
  });
});
