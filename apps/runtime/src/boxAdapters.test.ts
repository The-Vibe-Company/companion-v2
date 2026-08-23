/* oxlint-disable anti-slop/require-safety-comment-for-type-assertion, anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, anti-slop/no-known-value-widening -- Lifecycle fixtures are hand-written fakes matching the used client surface exactly. */
import { describe, expect, it, vi } from "vitest";
import { BoxRuntimeAdapterError, type BoxRuntimeLifecycleClient, type CompanionBoxRuntimeV2 } from "@companion/box-runtime";
import type { RuntimeProcessLog } from "@companion/companion-runtime";

import {
  createRuntimeBoxControl,
  createRuntimePiControl,
  RUNTIME_IMAGE_WAIT_MS,
  type RuntimeImageSource,
} from "./boxAdapters";

const signal = new AbortController().signal;
const deadlineAt = new Date("2027-01-01T00:00:00.000Z");

function runtimeImage(overrides: Partial<RuntimeImageSource> = {}): RuntimeImageSource {
  return {
    expectedName: () => "companion-l14-aaaaaaaaaaaa",
    cloneName: () => null,
    waitForResolution: async () => "failed",
    ...overrides,
  };
}

function capturingLog(): { log: RuntimeProcessLog; records: Record<string, unknown>[] } {
  const records: Record<string, unknown>[] = [];
  return {
    records,
    log: {
      error(record) { records.push({ level: "error", ...record }); },
      warn(record) { records.push({ level: "warn", ...record }); },
      info(record) { records.push({ level: "info", ...record }); },
    },
  };
}

function lifecycle(overrides: Partial<BoxRuntimeLifecycleClient> = {}): BoxRuntimeLifecycleClient {
  const createAfterAbsence = overrides.createGenerationBoxAfterObservedAbsence
    ?? overrides.createOrRecoverGenerationBox
    ?? vi.fn();
  return {
    listAllBoxes: vi.fn(),
    requestPermanentDeletion: vi.fn(),
    getDeletionOperation: vi.fn(),
    findGenerationBoxes: vi.fn(),
    createOrRecoverGenerationBox: createAfterAbsence,
    createGenerationBoxAfterObservedAbsence: createAfterAbsence,
    applyGenerationBoxSettings: vi.fn(),
    deletePermanentlyAndWait: vi.fn(),
    ...overrides,
  } as BoxRuntimeLifecycleClient;
}

function boxRuntime(overrides: Partial<CompanionBoxRuntimeV2> = {}): CompanionBoxRuntimeV2 {
  return {
    layoutIdentity: () => ({ fullMarker: "layout-current" }),
    ...overrides,
  } as CompanionBoxRuntimeV2;
}

describe("runtime Box/Pi port adapters", () => {
  it("uses only generation-qualified lifecycle create and exact provider status", async () => {
    const findGenerationBoxes = vi.fn(async () => ({
      name: "Companion 11111111-1111-4111-8111-111111111111 g4",
      canonical: { id: "bx_23456789", name: "canonical" },
      duplicates: [],
    }));
    const createOrRecoverGenerationBox = vi.fn(async () => ({
      outcome: "created" as const,
      boxId: "bx_23456789",
      name: "canonical",
    }));
    const existingBoxStatus = vi.fn(async () => ({
      boxId: "bx_23456789",
      state: "archiving" as const,
    }));
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ findGenerationBoxes, createOrRecoverGenerationBox }),
      runtime: () => boxRuntime({ existingBoxStatus }),
      now: () => deadlineAt.getTime() - 10_000,
    });

    await control.findGenerationBoxes({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      deadlineAt,
      signal,
    });
    await expect(control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    })).resolves.toMatchObject({ outcome: "created", boxId: "bx_23456789" });
    await expect(control.getStatus({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({ state: "archiving" });

    expect(findGenerationBoxes).toHaveBeenCalledWith(expect.objectContaining({
      generation: 4,
      deadlineAt,
      signal,
    }));
    expect(createOrRecoverGenerationBox).toHaveBeenCalledWith(expect.objectContaining({
      generation: 4,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    }));
    expect(existingBoxStatus).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      signal,
    });
  });

  it("proves the durable Box identity with the direct status GET", async () => {
    const existingBoxStatus = vi.fn(async () => ({
      boxId: "bx_23456789",
      state: "archived" as const,
    }));
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({ existingBoxStatus }),
    });

    await expect(control.getStatus({
      boxId: "bx_23456789",
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      signal,
    })).resolves.toEqual({ state: "archived" });
    expect(existingBoxStatus).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      companionId: "11111111-1111-4111-8111-111111111111",
      runtimeGeneration: 4,
      signal,
    });
  });

  it("clones the golden runtime image and falls back when that snapshot is gone", async () => {
    const createOrRecoverGenerationBox = vi.fn()
      .mockRejectedValueOnce(new BoxRuntimeAdapterError({
        stableCode: "box_not_found",
        message: "The Box provider resource was not found",
        status: 404,
        providerCode: "unknown_snapshot",
        retryable: false,
        outcomeUnknown: false,
      }))
      .mockResolvedValue({
        outcome: "created" as const,
        boxId: "bx_23456789",
        name: "canonical",
      });
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ createOrRecoverGenerationBox }),
      runtime: () => boxRuntime(),
      runtimeImage: runtimeImage({ cloneName: () => "companion-l14-aaaaaaaaaaaa" }),

      now: () => deadlineAt.getTime() - 10_000,
    });

    await expect(control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    })).resolves.toMatchObject({ outcome: "created", boxId: "bx_23456789" });

    expect(createOrRecoverGenerationBox).toHaveBeenNthCalledWith(1, expect.objectContaining({
      from: "companion-l14-aaaaaaaaaaaa",
    }));
    expect(createOrRecoverGenerationBox).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
      from: expect.anything(),
    }));
  });

  it("waits on the published build past the bound, then creates without from", async () => {
    vi.useFakeTimers();
    try {
      const createOrRecoverGenerationBox = vi.fn(async () => ({
        outcome: "created" as const,
        boxId: "bx_23456789",
        name: "canonical",
      }));
      const captured = capturingLog();
      const control = createRuntimeBoxControl({
        lifecycle: lifecycle({ createOrRecoverGenerationBox }),
        runtime: () => boxRuntime(),
        runtimeImage: runtimeImage({
          waitForResolution: (boundMs) =>
            new Promise((resolve) => {
              setTimeout(() => resolve("pending" as const), boundMs);
            }),
        }),
        log: captured.log,
        now: () => Date.now(),
      });

      const pending = control.createGenerationBox({
        companionId: "11111111-1111-4111-8111-111111111111",
        generation: 4n,
        ttlSeconds: 21_600,
        deadlineAt,
        signal,
      });
      await vi.advanceTimersByTimeAsync(RUNTIME_IMAGE_WAIT_MS);
      await expect(pending).resolves.toMatchObject({ outcome: "created", boxId: "bx_23456789" });

      expect(createOrRecoverGenerationBox).toHaveBeenCalledTimes(1);
      expect(createOrRecoverGenerationBox).toHaveBeenCalledWith(expect.not.objectContaining({
        from: expect.anything(),
      }));
      expect(captured.records).toEqual([expect.objectContaining({
        level: "info",
        event: "runtime.box.create",
        companionId: "11111111-1111-4111-8111-111111111111",
        generation: 4,
        expectedImage: "companion-l14-aaaaaaaaaaaa",
        fromImage: null,
        fallbackReason: "image_build_pending",
        imageWaitMs: RUNTIME_IMAGE_WAIT_MS,
        outcome: "created",
      })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the wait entirely when the registry already reports a failed build", async () => {
    const createOrRecoverGenerationBox = vi.fn(async () => ({
      outcome: "created" as const,
      boxId: "bx_23456789",
      name: "canonical",
    }));
    const captured = capturingLog();
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ createOrRecoverGenerationBox }),
      runtime: () => boxRuntime(),
      runtimeImage: runtimeImage(),
      log: captured.log,
      now: () => 1_000_000,
    });

    await expect(control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    })).resolves.toMatchObject({ outcome: "created", boxId: "bx_23456789" });

    expect(createOrRecoverGenerationBox).toHaveBeenCalledTimes(1);
    expect(createOrRecoverGenerationBox).toHaveBeenCalledWith(expect.not.objectContaining({
      from: expect.anything(),
    }));
    expect(captured.records).toEqual([expect.objectContaining({
      event: "runtime.box.create",
      fromImage: null,
      fallbackReason: "image_build_failed",
      imageWaitMs: 0,
    })]);
  });

  it("clones the expected image once the registry publishes readiness", async () => {
    const createOrRecoverGenerationBox = vi.fn(async () => ({
      outcome: "created" as const,
      boxId: "bx_23456789",
      name: "canonical",
    }));
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ createOrRecoverGenerationBox }),
      runtime: () => boxRuntime(),
      runtimeImage: runtimeImage({
        cloneName: () => null,
        waitForResolution: async () => "ready",
      }),
      now: () => deadlineAt.getTime() - 10_000,
    });

    await expect(control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      deadlineAt,
      signal,
    })).resolves.toMatchObject({ outcome: "created", boxId: "bx_23456789" });

    expect(createOrRecoverGenerationBox).toHaveBeenCalledWith(expect.objectContaining({
      from: "companion-l14-aaaaaaaaaaaa",
    }));
  });

  it("propagates abort while waiting on the published build state", async () => {
    const controller = new AbortController();
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime(),
      runtimeImage: runtimeImage({
        waitForResolution: (_boundMs, waitSignal) =>
          new Promise((_resolve, reject) => {
            waitSignal.addEventListener("abort", () => {
              reject(waitSignal.reason instanceof Error ? waitSignal.reason : new Error("aborted"));
            });
          }),
      }),
      now: () => deadlineAt.getTime() - 10_000,
    });

    const pending = control.createGenerationBox({
      companionId: "11111111-1111-4111-8111-111111111111",
      generation: 4n,
      ttlSeconds: 21_600,
      deadlineAt,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow();
  });

  it("keeps provisioned and cloning in the provisioning bucket until the Box is ready", async () => {
    const existingBoxStatus = vi.fn()
      .mockResolvedValueOnce({ boxId: "bx_23456789", state: "provisioned" as const })
      .mockResolvedValueOnce({ boxId: "bx_23456789", state: "cloning" as const })
      .mockResolvedValueOnce({ boxId: "bx_23456789", state: "idle" as const });
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({ existingBoxStatus }),
    });

    await expect(control.getStatus({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({ state: "provisioning" });
    await expect(control.getStatus({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({ state: "provisioning" });
    await expect(control.getStatus({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({ state: "idle" });
  });

  it("forwards a present but invalid Companion identity instead of dropping its ownership proof", async () => {
    const existingBoxStatus = vi.fn(async () => {
      throw new Error("invalid Companion identity");
    });
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({ existingBoxStatus }),
    });

    await expect(control.getStatus({
      boxId: "bx_23456789",
      companionId: "",
      generation: 4n,
      signal,
    })).rejects.toThrow("invalid Companion identity");
    expect(existingBoxStatus).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      companionId: "",
      runtimeGeneration: 4,
      signal,
    });
  });

  it("adds an explicit provider deadline to delete work without a turn deadline", async () => {
    const requestPermanentDeletion = vi.fn(async () => ({
      outcome: "accepted" as const,
      operation: {
        id: "bdop_11111111111111111111111111111111",
        targetId: "bx_23456789",
        status: "pending" as const,
        attemptCount: 0,
        requestedAt: "2027-01-01T00:00:00.000Z",
        completedAt: null,
      },
    }));
    const getDeletionOperation = vi.fn(async () => ({
      id: "bdop_11111111111111111111111111111111",
      targetId: "bx_23456789",
      status: "completed" as const,
      attemptCount: 1,
      requestedAt: "2027-01-01T00:00:00.000Z",
      completedAt: "2027-01-01T00:00:01.000Z",
    }));
    const control = createRuntimeBoxControl({
      lifecycle: lifecycle({ requestPermanentDeletion, getDeletionOperation }),
      runtime: () => boxRuntime(),
      providerDeadlineMs: 12_000,
      now: () => 1_000,
    });

    await expect(control.requestPermanentDeletion({ boxId: "bx_23456789", signal }))
      .resolves.toEqual({
        outcome: "accepted",
        operationId: "bdop_11111111111111111111111111111111",
      });
    await expect(control.pollPermanentDeletion({
      boxId: "bx_23456789",
      operationId: "bdop_11111111111111111111111111111111",
      signal,
    })).resolves.toEqual({ status: "completed" });
    expect(requestPermanentDeletion).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAt: new Date(13_000),
      signal,
    }));
    expect(getDeletionOperation).toHaveBeenCalledWith(expect.objectContaining({
      deadlineAt: new Date(13_000),
      signal,
    }));
  });

  it("maps the broker's positive ACK directly without a second post-effect probe", async () => {
    const dispatchPrompt = vi.fn(async () => ({
      outcome: "accepted" as const,
      attemptId: "attempt-1",
      invocationId: "invocation-1",
      initialCursor: 7,
    }));
    const brokerState = vi.fn();
    const factory = vi.fn(() => boxRuntime({ dispatchPrompt, brokerState }));
    const pi = createRuntimePiControl({ lifecycle: lifecycle(), runtime: factory });

    await expect(pi.prompt({
      boxId: "bx_23456789",
      commandId: "command-1",
      attemptId: "attempt-1",
      message: "hello",
      signal,
    })).resolves.toEqual({
      outcome: "accepted",
      invocationId: "invocation-1",
      initialCursor: 7n,
    });
    expect(factory).toHaveBeenCalledOnce();
    expect(dispatchPrompt).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      requestId: "command-1",
      attemptId: "attempt-1",
      message: "hello",
      signal,
    });
    expect(brokerState).not.toHaveBeenCalled();
  });

  it("maps a Pi abort ACK without probing broker state afterwards", async () => {
    const dispatchAbort = vi.fn(async () => ({
      outcome: "accepted" as const,
      attemptId: "attempt-1",
      invocationId: "invocation-1",
    }));
    const brokerState = vi.fn();
    const factory = vi.fn(() => boxRuntime({ dispatchAbort, brokerState }));
    const pi = createRuntimePiControl({ lifecycle: lifecycle(), runtime: factory });

    await expect(pi.abort({
      boxId: "bx_23456789",
      commandId: "command-abort",
      attemptId: "attempt-1",
      signal,
    })).resolves.toEqual({ outcome: "accepted", invocationId: "invocation-1" });
    expect(dispatchAbort).toHaveBeenCalledWith({
      boxId: "bx_23456789",
      requestId: "command-abort",
      attemptId: "attempt-1",
      signal,
    });
    expect(brokerState).not.toHaveBeenCalled();
  });

  it("preserves refusal/ambiguity and converts broker cursors without precision loss", async () => {
    const dispatchPrompt = vi.fn()
      .mockResolvedValueOnce({ outcome: "refused", code: "pi_busy", message: "ignored" })
      .mockResolvedValueOnce({ outcome: "ambiguous", code: "pi_ack_ambiguous", message: "ignored" });
    const ackEvents = vi.fn(async () => ({ acknowledgedCursor: 42 }));
    const readEvents = vi.fn(async () => ({
      events: [], nextCursor: 42, acknowledgedCursor: 42, hasMore: false,
    }));
    const pi = createRuntimePiControl({
      lifecycle: lifecycle(),
      runtime: () => boxRuntime({
        dispatchPrompt,
        ackEvents,
        readEvents: readEvents as unknown as CompanionBoxRuntimeV2["readEvents"],
      }),
    });
    const request = {
      boxId: "bx_23456789",
      commandId: "command-1",
      attemptId: "attempt-1",
      message: "hello",
      signal,
    };
    await expect(pi.prompt(request)).resolves.toEqual({ outcome: "rejected", code: "pi_busy" });
    await expect(pi.prompt(request)).resolves.toEqual({
      outcome: "ambiguous",
      code: "pi_ack_ambiguous",
    });
    await expect(pi.readBrokerEvents({ boxId: "bx_23456789", after: 41n, signal }))
      .resolves.toMatchObject({ nextCursor: 42 });
    await expect(pi.ackBrokerEvents({ boxId: "bx_23456789", through: 42n, signal }))
      .resolves.toBe(42n);
    expect(readEvents).toHaveBeenCalledWith({ boxId: "bx_23456789", after: 41, signal });
    expect(ackEvents).toHaveBeenCalledWith({ boxId: "bx_23456789", through: 42, signal });
    await expect(pi.readBrokerEvents({
      boxId: "bx_23456789",
      after: BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      signal,
    })).rejects.toThrow(/safe integer range/);
  });
});
