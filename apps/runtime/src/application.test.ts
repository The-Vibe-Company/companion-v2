import { describe, expect, it, vi } from "vitest";

import type { RuntimeServiceConfig } from "./config";
import {
  createRuntimeApplication,
  durablyDisableRuntime,
  type RuntimeApplicationScheduler,
  type RuntimeApplicationStore,
} from "./application";
import type { RuntimeHttpServer } from "./server";

const enabledConfig = {
  executorId: "11111111-1111-4111-8111-111111111111",
  companionsEnabled: true,
  shutdownDrainMs: 25,
  apiUrl: "http://127.0.0.1:3001",
} as RuntimeServiceConfig;

function harness(config: RuntimeServiceConfig = enabledConfig) {
  const calls: string[] = [];
  const store: RuntimeApplicationStore = {
    ping: vi.fn(async () => { calls.push("ping"); }),
    gateStatus: vi.fn(async () => {
      calls.push("gate:read");
      return { enabled: true, gateEpoch: 8n, updatedAt: new Date(0) };
    }),
    disable: vi.fn(async () => {
      calls.push("gate:disable");
      return { enabled: false, gateEpoch: 9n, updatedAt: new Date(1) };
    }),
  };
  const scheduler: RuntimeApplicationScheduler = {
    start: vi.fn(async () => { calls.push("scheduler:start"); }),
    stopClaims: vi.fn(async () => { calls.push("scheduler:stop-claims"); }),
    shutdown: vi.fn(async () => { calls.push("scheduler:shutdown"); }),
    snapshot: () => ({
      claimLoopAlive: true,
      fatal: false,
      lastSweepStartedAt: new Date(),
      lastSweepCompletedAt: new Date(),
      claimLoopErrorAt: null,
      activeCount: 0,
    }),
  };
  const server = {
    listen: vi.fn(async () => { calls.push("server:listen"); }),
    close: vi.fn(async () => { calls.push("server:close"); }),
  } as unknown as RuntimeHttpServer;
  const closeResources = vi.fn(async () => { calls.push("resources:close"); });
  const application = createRuntimeApplication({
    config,
    store,
    scheduler,
    server,
    closeResources,
  });
  return { application, calls, store, scheduler, server, closeResources };
}

describe("runtime application lifecycle", () => {
  it("starts an enabled runtime without ever calling the database enable path", async () => {
    const value = harness();
    await value.application.start();

    expect(value.calls).toEqual(["ping", "scheduler:start", "server:listen"]);
    expect(value.store.gateStatus).not.toHaveBeenCalled();
    expect(value.store.disable).not.toHaveBeenCalled();
    expect("enable" in value.store).toBe(false);
    await value.application.stop();
  });

  it("durably disables the current epoch before a locally disabled scheduler starts", async () => {
    const value = harness({
      ...enabledConfig,
      companionsEnabled: false,
      boxApiKey: null,
      masterKey: null,
      desktopHmacSecret: null,
      apiUrl: null,
    });
    await value.application.start();

    expect(value.store.gateStatus).toHaveBeenCalledOnce();
    expect(value.store.disable).toHaveBeenCalledWith(
      8n,
      enabledConfig.executorId,
    );
    expect(value.scheduler.start).toHaveBeenCalledOnce();
    expect(value.calls).toEqual([
      "ping",
      "gate:read",
      "gate:disable",
      "scheduler:start",
      "server:listen",
    ]);
    await value.application.stop();
  });

  it("re-reads the gate only for a fenced serialization conflict", async () => {
    const store: RuntimeApplicationStore = {
      ping: async () => undefined,
      gateStatus: vi.fn()
        .mockResolvedValueOnce({ enabled: true, gateEpoch: 2n, updatedAt: new Date(0) })
        .mockResolvedValueOnce({ enabled: false, gateEpoch: 3n, updatedAt: new Date(1) }),
      disable: vi.fn()
        .mockRejectedValueOnce(Object.assign(new Error("stale"), {
          name: "RuntimeStoreSerializationError",
        }))
        .mockResolvedValueOnce({ enabled: false, gateEpoch: 3n, updatedAt: new Date(1) }),
    };

    await expect(durablyDisableRuntime(store, enabledConfig.executorId)).resolves.toMatchObject({
      enabled: false,
      gateEpoch: 3n,
    });
    expect(store.disable).toHaveBeenNthCalledWith(1, 2n, enabledConfig.executorId);
    expect(store.disable).toHaveBeenNthCalledWith(2, 3n, enabledConfig.executorId);

    const contractFailure = new Error("contract failure");
    await expect(durablyDisableRuntime({
      ...store,
      gateStatus: async () => ({ enabled: true, gateEpoch: 4n, updatedAt: new Date() }),
      disable: async () => { throw contractFailure; },
    }, enabledConfig.executorId)).rejects.toBe(contractFailure);
  });

  it("stops claims before ingress, then drains and closes dependencies", async () => {
    const value = harness();
    await value.application.start();
    await Promise.all([value.application.stop(), value.application.stop()]);

    expect(value.calls.slice(3)).toEqual([
      "scheduler:stop-claims",
      "server:close",
      "scheduler:shutdown",
      "resources:close",
    ]);
    expect(value.closeResources).toHaveBeenCalledOnce();
  });

  it("passes the configured bound to the scheduler drain before closing resources", async () => {
    const value = harness({ ...enabledConfig, shutdownDrainMs: 5 });
    await value.application.start();
    await value.application.stop();

    expect(value.scheduler.shutdown).toHaveBeenCalledWith({ drainTimeoutMs: 5 });
    expect(value.closeResources).toHaveBeenCalledOnce();
  });

  it("continues partial-start cleanup when stopClaims throws synchronously", async () => {
    const value = harness();
    const startupFailure = new Error("listen failed");
    vi.mocked(value.server.listen).mockRejectedValueOnce(startupFailure);
    vi.mocked(value.scheduler.stopClaims).mockImplementationOnce(() => {
      throw new Error("stop claims failed");
    });

    await expect(value.application.start()).rejects.toBe(startupFailure);

    expect(value.server.close).toHaveBeenCalledOnce();
    expect(value.scheduler.shutdown).toHaveBeenCalledOnce();
    expect(value.closeResources).toHaveBeenCalledOnce();
  });
});
