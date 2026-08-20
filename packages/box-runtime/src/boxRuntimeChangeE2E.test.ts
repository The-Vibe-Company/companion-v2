import { describe, expect, it, vi } from "vitest";

import { createRuntimeChangeGenerationBox } from "../../../scripts/box-runtime-change-e2e";
import { BoxRuntimeAdapterError } from "./boxMaintenanceClient";

const create = {
  companionId: "11111111-1111-4111-8111-111111111111",
  generation: 14,
  ttlSeconds: 300,
  deadlineAt: Date.now() + 30_000,
};
const created = {
  outcome: "created" as const,
  boxId: "bx_23456789",
  name: "Companion 11111111-1111-4111-8111-111111111111 g14",
};

describe("runtime-change Box creation", () => {
  it("uses the configured runtime snapshot when it is available", async () => {
    const createOrRecoverGenerationBox = vi.fn(async () => created);
    const createGenerationBoxAfterObservedAbsence = vi.fn(async () => created);
    const listNamedSnapshots = vi.fn(async () => []);

    await expect(createRuntimeChangeGenerationBox({
      lifecycle: {
        createOrRecoverGenerationBox,
        createGenerationBoxAfterObservedAbsence,
        listNamedSnapshots,
      },
      create,
      image: "companion-l14-aaaaaaaaaaaa",
    })).resolves.toEqual({ box: created, source: "named_snapshot" });

    expect(createOrRecoverGenerationBox).toHaveBeenCalledWith({
      ...create,
      from: "companion-l14-aaaaaaaaaaaa",
    });
    expect(createGenerationBoxAfterObservedAbsence).not.toHaveBeenCalled();
  });

  it.each([
    "unknown_snapshot",
    "box_not_found",
  ] as const)("falls back exactly once to a base Box when the configured snapshot is a confirmed 404 (%s)", async (providerCode) => {
    const createOrRecoverGenerationBox = vi.fn(async () => {
      throw new BoxRuntimeAdapterError({
        stableCode: "box_not_found",
        message: "The Box provider resource was not found",
        status: 404,
        providerCode,
        retryable: false,
        outcomeUnknown: false,
      });
    });
    const createGenerationBoxAfterObservedAbsence = vi.fn(async () => created);
    const listNamedSnapshots = vi.fn(async () => []);

    await expect(createRuntimeChangeGenerationBox({
      lifecycle: {
        createOrRecoverGenerationBox,
        createGenerationBoxAfterObservedAbsence,
        listNamedSnapshots,
      },
      create,
      image: "companion-l14-aaaaaaaaaaaa",
    })).resolves.toEqual({ box: created, source: "base_fallback" });

    expect(createOrRecoverGenerationBox).toHaveBeenCalledOnce();
    expect(listNamedSnapshots).toHaveBeenCalledOnce();
    expect(createGenerationBoxAfterObservedAbsence).toHaveBeenCalledOnce();
    expect(createGenerationBoxAfterObservedAbsence).toHaveBeenCalledWith(create);
  });

  it("uses the newest ready runtime snapshot when the configured one was pruned", async () => {
    const createOrRecoverGenerationBox = vi.fn(async () => {
      throw new BoxRuntimeAdapterError({
        stableCode: "box_not_found",
        message: "The Box provider resource was not found",
        status: 404,
        providerCode: "unknown_snapshot",
        retryable: false,
        outcomeUnknown: false,
      });
    });
    const createGenerationBoxAfterObservedAbsence = vi.fn(async () => created);
    const listNamedSnapshots = vi.fn(async () => [
      {
        name: "companion-l14-aaaaaaaaaaaa",
        status: "ready" as const,
        sourceBoxId: "bx_3456789a",
        createdAt: "2026-08-19T10:00:00.000Z",
      },
      {
        name: "companion-l14-bbbbbbbbbbbb",
        status: "ready" as const,
        sourceBoxId: "bx_456789ab",
        createdAt: "2026-08-20T10:00:00.000Z",
      },
      {
        name: "companion-l14-cccccccccccc",
        status: "failed" as const,
        sourceBoxId: "bx_56789abc",
        createdAt: "2026-08-21T10:00:00.000Z",
      },
    ]);

    await expect(createRuntimeChangeGenerationBox({
      lifecycle: {
        createOrRecoverGenerationBox,
        createGenerationBoxAfterObservedAbsence,
        listNamedSnapshots,
      },
      create,
      image: "companion-l14-dddddddddddd",
    })).resolves.toEqual({ box: created, source: "replacement_snapshot" });

    expect(createGenerationBoxAfterObservedAbsence).toHaveBeenCalledWith({
      ...create,
      from: "companion-l14-bbbbbbbbbbbb",
    });
  });

  it.each([
    new BoxRuntimeAdapterError({
      stableCode: "box_request_deadline_exceeded",
      message: "The Box request deadline elapsed",
      status: 504,
      retryable: true,
      outcomeUnknown: true,
    }),
    new BoxRuntimeAdapterError({
      stableCode: "box_not_found",
      message: "The Box provider resource was not found",
      status: 404,
      providerCode: "unknown_snapshot",
      retryable: false,
      outcomeUnknown: true,
    }),
    new BoxRuntimeAdapterError({
      stableCode: "box_not_found",
      message: "The Box provider returned a server error",
      status: 503,
      providerCode: "unknown_snapshot",
      retryable: true,
      outcomeUnknown: false,
    }),
  ])("does not replay an ambiguous, timed-out, or 5xx failure", async (failure) => {
    const createOrRecoverGenerationBox = vi.fn(async () => {
      throw failure;
    });
    const createGenerationBoxAfterObservedAbsence = vi.fn(async () => created);
    const listNamedSnapshots = vi.fn(async () => []);

    await expect(createRuntimeChangeGenerationBox({
      lifecycle: {
        createOrRecoverGenerationBox,
        createGenerationBoxAfterObservedAbsence,
        listNamedSnapshots,
      },
      create,
      image: "companion-l14-aaaaaaaaaaaa",
    })).rejects.toBe(failure);
    expect(createGenerationBoxAfterObservedAbsence).not.toHaveBeenCalled();
  });
});
