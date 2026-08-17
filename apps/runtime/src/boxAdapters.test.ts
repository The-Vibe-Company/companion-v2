import { describe, expect, it, vi } from "vitest";
import type { BoxRuntimeLifecycleClient, CompanionBoxRuntimeV2 } from "@companion/box-runtime";

import { createRuntimeBoxControl, createRuntimePiControl } from "./boxAdapters";

const signal = new AbortController().signal;
const deadlineAt = new Date("2027-01-01T00:00:00.000Z");

function lifecycle(overrides: Partial<BoxRuntimeLifecycleClient> = {}): BoxRuntimeLifecycleClient {
  return {
    listAllBoxes: vi.fn(),
    requestPermanentDeletion: vi.fn(),
    getDeletionOperation: vi.fn(),
    findGenerationBoxes: vi.fn(),
    createOrRecoverGenerationBox: vi.fn(),
    applyGenerationBoxSettings: vi.fn(),
    deletePermanentlyAndWait: vi.fn(),
    ...overrides,
  } as BoxRuntimeLifecycleClient;
}

function boxRuntime(overrides: Partial<CompanionBoxRuntimeV2> = {}): CompanionBoxRuntimeV2 {
  return {
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
    })).resolves.toEqual({ outcome: "accepted", invocationId: "invocation-1" });
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
