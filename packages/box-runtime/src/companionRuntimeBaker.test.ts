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
});
