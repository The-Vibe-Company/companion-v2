import { describe, expect, it, vi } from "vitest";
import type {
  BoxRuntimeLifecycleClient,
  CompanionBoxRuntimeV2,
} from "@companion/box-runtime";
import type {
  CreateRuntimeKernelInput,
  RuntimeSchedulerSnapshot,
  RuntimeStore,
} from "@companion/companion-runtime";

import type { RuntimeDatabase } from "./database";
import {
  buildProductionRuntimeService,
  type RuntimeArchiveStorage,
  type RuntimeProductionFactories,
} from "./production";
import type { RuntimeKernelScheduler } from "./schedulerAdapter";

const databaseUrl = "postgres://companion_runtime:secret@127.0.0.1:5432/companion";

function scheduler(): RuntimeKernelScheduler {
  const snapshot: RuntimeSchedulerSnapshot = {
    claimLoopAlive: false,
    acceptingClaims: false,
    claimsEnabled: false,
    gateEnabled: null,
    lastSweepStartedAt: null,
    lastSweepCompletedAt: null,
    claimLoopErrorAt: null,
    activeCount: 0,
    concurrency: 8,
    sweepIntervalMs: 2_000,
  };
  return {
    start: vi.fn(),
    stopClaims: vi.fn(),
    shutdown: vi.fn(async () => undefined),
    snapshot: () => snapshot,
  };
}

function database(): RuntimeDatabase {
  return {
    sql: { unsafe: vi.fn() } as unknown as RuntimeDatabase["sql"],
    verifyRole: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

describe("production runtime composition", () => {
  it("verifies the runtime role but constructs no external client on the kill-switch path", async () => {
    const db = database();
    const store = {} as RuntimeStore;
    let kernelInput: CreateRuntimeKernelInput | undefined;
    const createLifecycle = vi.fn(() => ({} as BoxRuntimeLifecycleClient));
    const createBoxRuntime = vi.fn(() => ({} as CompanionBoxRuntimeV2));
    const createArchiveStorage = vi.fn(() => ({
      load: vi.fn(),
      close: vi.fn(),
    } as RuntimeArchiveStorage));
    const loadBundledSkill = vi.fn();
    const factories = {
      createDatabase: () => db,
      createStore: () => store,
      createLifecycle,
      createBoxRuntime,
      createArchiveStorage,
      loadBundledSkill,
      createKernel: (input) => {
        kernelInput = input;
        return { scheduler: scheduler() };
      },
    } satisfies RuntimeProductionFactories;

    const service = await buildProductionRuntimeService({
      env: {
        DATABASE_COMPANION_RUNTIME_URL: databaseUrl,
        COMPANION_COMPANIONS_ENABLED: "false",
      },
      factories,
    });

    expect(db.verifyRole).toHaveBeenCalledOnce();
    expect(kernelInput).toMatchObject({ claimsEnabled: false, store });
    expect(createLifecycle).not.toHaveBeenCalled();
    expect(createBoxRuntime).not.toHaveBeenCalled();
    expect(createArchiveStorage).not.toHaveBeenCalled();
    expect(loadBundledSkill).not.toHaveBeenCalled();
    await service.application.stop();
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("wires isolated Box calls, storage, bundled skill, and clears key bytes after drain", async () => {
    const masterKey = Buffer.alloc(32, 17);
    const hmacKey = Buffer.alloc(32, 23);
    const db = database();
    const store = {} as RuntimeStore;
    let kernelInput: CreateRuntimeKernelInput | undefined;
    let configuredMasterKey: Buffer | undefined;
    let configuredHmacKey: Buffer | undefined;
    let boxEnv: NodeJS.ProcessEnv | undefined;
    const existingBoxStatus = vi.fn(async (input: { boxId: string }) => ({
      boxId: input.boxId,
      state: "ready" as const,
    }));
    const createBoxRuntime = vi.fn(() => ({
      existingBoxStatus,
    } as unknown as CompanionBoxRuntimeV2));
    const storageClose = vi.fn();
    const factories = {
      createDatabase: (config) => {
        configuredMasterKey = config.masterKey ?? undefined;
        configuredHmacKey = config.desktopHmacSecret ?? undefined;
        return db;
      },
      createStore: () => store,
      createLifecycle: (env) => {
        boxEnv = env;
        return {} as BoxRuntimeLifecycleClient;
      },
      createBoxRuntime,
      createArchiveStorage: () => ({
        load: vi.fn(async () => Buffer.from("archive")),
        close: storageClose,
      }),
      loadBundledSkill: vi.fn(async () => ({
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      })),
      createKernel: (input) => {
        kernelInput = input;
        return { scheduler: scheduler() };
      },
    } satisfies RuntimeProductionFactories;

    const service = await buildProductionRuntimeService({
      env: {
        DATABASE_COMPANION_RUNTIME_URL: databaseUrl,
        COMPANION_COMPANIONS_ENABLED: "true",
        COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS: "example.test",
        COMPANION_BOX_API_KEY: "box-secret",
        COMPANION_BOX_API_BASE: "http://127.0.0.1:13400",
        COMPANION_SECRETS_MASTER_KEY: masterKey.toString("base64"),
        COMPANION_RUNTIME_DESKTOP_HMAC_SECRET: hmacKey.toString("base64"),
        COMPANION_API_URL: "http://127.0.0.1:3001",
        UNRELATED_DATABASE_SECRET: "must-not-be-forwarded",
      },
      factories,
    });

    expect(db.verifyRole).toHaveBeenCalledOnce();
    expect(kernelInput).toMatchObject({
      claimsEnabled: true,
      concurrency: 8,
      sweepIntervalMs: 2_000,
      materialProvider: expect.any(Object),
      projectionRedactorFactory: expect.any(Object),
      resourceStager: expect.any(Object),
    });
    expect(boxEnv).toEqual({
      COMPANION_BOX_API_KEY: "box-secret",
      COMPANION_BOX_API_BASE: "http://127.0.0.1:13400",
      COMPANION_BOX_TTL_SECONDS: "21600",
    });
    const control = (kernelInput as CreateRuntimeKernelInput).box;
    await control.getStatus({ boxId: "bx_23456789", signal: new AbortController().signal });
    await control.getStatus({ boxId: "bx_23456789", signal: new AbortController().signal });
    expect(createBoxRuntime).toHaveBeenCalledTimes(2);

    await service.application.stop();
    expect(storageClose).toHaveBeenCalledOnce();
    expect(db.close).toHaveBeenCalledOnce();
    expect(configuredMasterKey).toEqual(Buffer.alloc(32));
    expect(configuredHmacKey).toEqual(Buffer.alloc(32));
  });
});
