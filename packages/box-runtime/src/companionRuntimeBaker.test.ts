import { describe, expect, it, vi } from "vitest";

import { BoxRuntimeAdapterError, type BoxRuntimeLifecycleClient } from "./boxMaintenanceClient";
import { createCompanionRuntimeImageBaker } from "./companionRuntimeBaker";
import { companionPiLayoutIdentity } from "./companionRuntimeImage";

const identity = companionPiLayoutIdentity({
  layoutVersion: 14,
  packages: ["npm:pi-mcp-adapter@2.12.1"],
  qmdPackage: "@tobilu/qmd@2.8.3",
  minimumPiVersion: "0.84.2",
});

function snapshot(name: string, createdAt = "2026-08-19T00:00:00.000Z") {
  return {
    name,
    status: "ready" as const,
    sourceBoxId: "bx_23456789",
    createdAt,
  };
}

function lifecycle(overrides: Partial<BoxRuntimeLifecycleClient> = {}): BoxRuntimeLifecycleClient {
  return {
    getNamedSnapshot: vi.fn(async () => null),
    listNamedSnapshots: vi.fn(async () => []),
    createEphemeralBox: vi.fn(async () => ({ boxId: "bx_23456789" })),
    saveNamedSnapshot: vi.fn(async () => snapshot(identity.imageName)),
    deleteNamedSnapshot: vi.fn(async () => undefined),
    deletePermanentlyAndWait: vi.fn(async () => ({ outcome: "already_deleted", boxId: "bx_23456789" })),
    ...overrides,
  } as BoxRuntimeLifecycleClient;
}

describe("companion runtime image baker", () => {
  it("never publishes when archive/resume playbook warmup fails", async () => {
    const controller = new AbortController();
    const saveNamedSnapshot = vi.fn(async () => snapshot(identity.imageName));
    const deletePermanentlyAndWait = vi.fn(async () => ({
      outcome: "already_deleted" as const,
      boxId: "bx_23456789",
    }));
    const warmupFailure = new Error("playbook did not stabilize");
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: lifecycle({ saveNamedSnapshot, deletePermanentlyAndWait }),
      bundledSkill: {
        slug: "companion",
        version: "1.0.0",
        checksum: `sha256:${"1".repeat(64)}`,
        archive: Buffer.from("bundled"),
      },
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
        prepareRuntimeImage: async () => { throw warmupFailure; },
      },
      onAttemptError: () => controller.abort(warmupFailure),
    });

    await expect(baker.ensure(controller.signal)).rejects.toBe(warmupFailure);
    expect(saveNamedSnapshot).not.toHaveBeenCalled();
    expect(deletePermanentlyAndWait).toHaveBeenCalledOnce();
  });

  it("reuses a ready named snapshot without creating a baker Box", async () => {
    const client = lifecycle({
      getNamedSnapshot: vi.fn(async () => snapshot(identity.imageName)),
    });
    const refreshPiLayout = vi.fn();
    const refreshTtl = vi.fn();
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: client,
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout,
        refreshTtl,
      },
    });

    await expect(baker.ensure(new AbortController().signal))
      .resolves.toEqual({ name: identity.imageName, ready: true, baked: false });
    expect(baker.readyName()).toBe(identity.imageName);
    expect(baker.cloneName()).toBe(identity.imageName);
    expect(client.createEphemeralBox).not.toHaveBeenCalled();
    expect(refreshPiLayout).not.toHaveBeenCalled();
    expect(refreshTtl).not.toHaveBeenCalled();
  });

  it("clones the previous companion image, installs the current layout, and prunes older pins", async () => {
    const parent = "companion-l14-bbbbbbbbbbbb";
    const stale = "companion-l14-cccccccccccc";
    const snapshots = [
      snapshot(parent, "2026-08-18T00:00:00.000Z"),
      snapshot(stale, "2026-08-17T00:00:00.000Z"),
    ];
    const refreshTtl = vi.fn(async () => undefined);
    let baker!: ReturnType<typeof createCompanionRuntimeImageBaker>;
    const client = lifecycle({
      listNamedSnapshots: vi.fn(async () => snapshots),
      getNamedSnapshot: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(snapshot(identity.imageName, "2026-08-19T00:00:01.000Z")),
      createEphemeralBox: vi.fn(async () => {
        expect(baker.cloneName()).toBe(parent);
        expect(baker.readyName()).toBeNull();
        return { boxId: "bx_23456789" };
      }),
    });
    baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: client,
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl,
      },
      sleep: async () => undefined,
    });

    await expect(baker.ensure(new AbortController().signal))
      .resolves.toEqual({ name: identity.imageName, ready: true, baked: true });
    expect(baker.cloneName()).toBe(identity.imageName);
    expect(client.createEphemeralBox).toHaveBeenCalledWith(expect.objectContaining({
      from: parent,
      noEnv: true,
      ttlSeconds: 300,
    }));
    expect(refreshTtl).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
      ttlSeconds: 1_800,
    }));
    expect(client.deleteNamedSnapshot).toHaveBeenCalledWith(expect.objectContaining({ name: stale }));
    expect(client.deletePermanentlyAndWait).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_23456789",
    }));
  });

  it("falls back to an empty baker Box when the parent snapshot disappeared", async () => {
    const client = lifecycle({
      listNamedSnapshots: vi.fn(async () => [snapshot("companion-l14-bbbbbbbbbbbb")]),
      createEphemeralBox: vi.fn()
        .mockRejectedValueOnce(new BoxRuntimeAdapterError({
          stableCode: "box_not_found",
          message: "The Box provider resource was not found",
          status: 404,
          providerCode: "unknown_snapshot",
          retryable: false,
          outcomeUnknown: false,
        }))
        .mockResolvedValue({ boxId: "bx_abcdefgh" }),
      getNamedSnapshot: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(snapshot(identity.imageName)),
    });
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: client,
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_abcdefgh", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_abcdefgh", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      sleep: async () => undefined,
    });

    await expect(baker.ensure(new AbortController().signal))
      .resolves.toMatchObject({ ready: true, baked: true });
    expect(client.createEphemeralBox).toHaveBeenNthCalledWith(1, expect.objectContaining({
      from: "companion-l14-bbbbbbbbbbbb",
    }));
    expect(client.createEphemeralBox).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
      from: expect.anything(),
    }));
    expect(client.deletePermanentlyAndWait).toHaveBeenCalledWith(expect.objectContaining({
      boxId: "bx_abcdefgh",
    }));
  });

  it("offers the previous snapshot for clone while a sibling bake is still saving", async () => {
    const parent = "companion-l14-bbbbbbbbbbbb";
    const clones: Array<string | null> = [];
    let baker!: ReturnType<typeof createCompanionRuntimeImageBaker>;
    const saving = {
      ...snapshot(identity.imageName),
      status: "saving" as const,
    };
    baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: lifecycle({
        listNamedSnapshots: vi.fn(async () => [snapshot(parent)]),
        getNamedSnapshot: vi.fn()
          .mockResolvedValueOnce(saving)
          .mockResolvedValueOnce(saving)
          .mockResolvedValue(snapshot(identity.imageName)),
      }),
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      sleep: async () => {
        clones.push(baker.cloneName());
      },
    });

    await expect(baker.ensure(new AbortController().signal))
      .resolves.toEqual({ name: identity.imageName, ready: true, baked: false });
    expect(clones).toEqual([parent]);
    expect(baker.cloneName()).toBe(identity.imageName);
  });

  it("retries after a failed bake until a sibling snapshot is ready", async () => {
    const createEphemeralBox = vi.fn()
      .mockRejectedValueOnce(new BoxRuntimeAdapterError({
        stableCode: "box_provider_unavailable",
        message: "The Box provider is temporarily unavailable",
        status: 503,
        retryable: true,
        outcomeUnknown: false,
      }));
    const getNamedSnapshot = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(snapshot(identity.imageName));
    const sleeps: number[] = [];
    const onAttemptError = vi.fn();
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: lifecycle({ createEphemeralBox, getNamedSnapshot }),
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      onAttemptError,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    await expect(baker.ensure(new AbortController().signal))
      .resolves.toEqual({ name: identity.imageName, ready: true, baked: false });
    expect(createEphemeralBox).toHaveBeenCalledOnce();
    expect(sleeps).toEqual([30_000]);
    expect(onAttemptError).toHaveBeenCalledOnce();
  });

  it("does not treat a named snapshot limit as an in-flight save", async () => {
    const saveNamedSnapshot = vi.fn(async () => {
      throw new BoxRuntimeAdapterError({
        stableCode: "box_conflict",
        message: "The Box request conflicted with current provider state",
        status: 409,
        providerCode: "named_snapshot_limit",
        retryable: false,
        outcomeUnknown: false,
      });
    });
    const getNamedSnapshot = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue(snapshot(identity.imageName));
    const onAttemptError = vi.fn();
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: lifecycle({ saveNamedSnapshot, getNamedSnapshot }),
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      onAttemptError,
      sleep: async () => undefined,
    });

    await expect(baker.ensure(new AbortController().signal))
      .resolves.toEqual({ name: identity.imageName, ready: true, baked: false });
    expect(saveNamedSnapshot).toHaveBeenCalledOnce();
    expect(onAttemptError).toHaveBeenCalledOnce();
  });

  it("settles the initial resolution on the ready fast path", async () => {
    const events: string[] = [];
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: lifecycle({
        getNamedSnapshot: vi.fn(async () => snapshot(identity.imageName)),
      }),
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      onEvent: (event) => events.push(event.kind),
    });

    await baker.ensure(new AbortController().signal);

    await expect(baker.initialResolution()).resolves.toEqual({
      outcome: "ready",
      name: identity.imageName,
    });
    expect(events).toEqual(["resolved"]);
  });

  it("settles the initial resolution on the parent before any bake work", async () => {
    const parent = "companion-l14-bbbbbbbbbbbb";
    const client = lifecycle({
      listNamedSnapshots: vi.fn(async () => [snapshot(parent)]),
      getNamedSnapshot: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(snapshot(identity.imageName)),
    });
    let baker!: ReturnType<typeof createCompanionRuntimeImageBaker>;
    let resolution: unknown = null;
    let resolutionAtCreate: unknown = null;
    baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: {
        ...client,
        createEphemeralBox: vi.fn(async () => {
          resolutionAtCreate = resolution;
          return { boxId: "bx_23456789" };
        }),
      },
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      sleep: async () => undefined,
    });
    void baker.initialResolution().then((value) => {
      resolution = value;
    });

    await baker.ensure(new AbortController().signal);

    expect(resolution).toEqual({ outcome: "parent", name: parent });
    expect(resolutionAtCreate).toEqual({ outcome: "parent", name: parent });
  });

  it("settles the initial resolution to none without waiting when no snapshot exists", async () => {
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: lifecycle({
        getNamedSnapshot: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue(snapshot(identity.imageName)),
      }),
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      sleep: async () => undefined,
    });

    await baker.ensure(new AbortController().signal);

    await expect(baker.initialResolution()).resolves.toEqual({ outcome: "none" });
    expect(baker.cloneName()).toBe(identity.imageName);
  });

  it("keeps a failed first resolution sticky when a later attempt succeeds", async () => {
    const getNamedSnapshot = vi.fn()
      .mockRejectedValueOnce(new BoxRuntimeAdapterError({
        stableCode: "box_network_error",
        message: "The Box provider could not be reached",
        status: 503,
        retryable: true,
        outcomeUnknown: false,
      }))
      .mockResolvedValue(snapshot(identity.imageName));
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: lifecycle({ getNamedSnapshot }),
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      onAttemptError: () => undefined,
      sleep: async () => undefined,
    });

    await baker.ensure(new AbortController().signal);

    await expect(baker.initialResolution()).resolves.toEqual({ outcome: "none" });
    expect(baker.readyName()).toBe(identity.imageName);
  });

  it("reports baker Box cleanup failure without failing the bake", async () => {
    const cleanupFailure = new Error("delete blocked at deadline");
    const onCleanupError = vi.fn();
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: lifecycle({
        getNamedSnapshot: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue(snapshot(identity.imageName)),
        deletePermanentlyAndWait: vi.fn(async () => {
          throw cleanupFailure;
        }),
      }),
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      onCleanupError,
      sleep: async () => undefined,
    });

    await expect(baker.ensure(new AbortController().signal))
      .resolves.toEqual({ name: identity.imageName, ready: true, baked: true });
    expect(onCleanupError).toHaveBeenCalledWith(cleanupFailure, "baker_box_delete");
  });

  it("reports stale snapshot prune failure and still emits prune events", async () => {
    const parent = "companion-l14-bbbbbbbbbbbb";
    const stale = "companion-l14-cccccccccccc";
    const pruneFailure = new Error("snapshot delete failed");
    const onCleanupError = vi.fn();
    const events: string[] = [];
    const baker = createCompanionRuntimeImageBaker({
      identity,
      lifecycle: lifecycle({
        listNamedSnapshots: vi.fn(async () => [
          snapshot(parent, "2026-08-18T00:00:00.000Z"),
          snapshot(stale, "2026-08-17T00:00:00.000Z"),
        ]),
        getNamedSnapshot: vi.fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValue(snapshot(identity.imageName)),
        deleteNamedSnapshot: vi.fn(async () => {
          throw pruneFailure;
        }),
      }),
      runtime: {
        existingBoxStatus: async () => ({ boxId: "bx_23456789", state: "ready" }),
        refreshPiLayout: async () => ({ boxId: "bx_23456789", applied: "base" as const }),
        refreshTtl: async () => undefined,
      },
      onCleanupError,
      onEvent: (event) => events.push(event.kind),
      sleep: async () => undefined,
    });

    await expect(baker.ensure(new AbortController().signal))
      .resolves.toEqual({ name: identity.imageName, ready: true, baked: true });
    expect(onCleanupError).toHaveBeenCalledWith(pruneFailure, "snapshot_prune");
    expect(events).toEqual(["resolved", "bake_started", "bake_completed"]);
  });
});
