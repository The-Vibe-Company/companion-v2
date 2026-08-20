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
const absent = {
  name: created.name,
  canonical: null,
  duplicates: [],
};
const discovery = {
  companionId: create.companionId,
  generation: create.generation,
  deadlineAt: create.deadlineAt,
};

describe("runtime-change Box creation", () => {
  it("uses the configured runtime snapshot when it is available", async () => {
    const findGenerationBoxes = vi.fn(async () => absent);
    const createGenerationBoxAfterObservedAbsence = vi.fn(async () => created);

    await expect(createRuntimeChangeGenerationBox({
      lifecycle: { findGenerationBoxes, createGenerationBoxAfterObservedAbsence },
      create,
      image: "companion-l14-aaaaaaaaaaaa",
    })).resolves.toEqual({ box: created, source: "named_snapshot" });

    expect(findGenerationBoxes).toHaveBeenCalledWith(discovery);
    expect(createGenerationBoxAfterObservedAbsence).toHaveBeenCalledWith({
      ...create,
      from: "companion-l14-aaaaaaaaaaaa",
    });
  });

  it.each(["unknown_snapshot", "box_not_found"])(
    "falls back exactly once to a base Box for provider code %s",
    async (providerCode) => {
      const findGenerationBoxes = vi.fn(async () => absent);
      const missingSnapshot = new BoxRuntimeAdapterError({
        stableCode: "box_not_found",
        message: "The named Box snapshot was not found",
        status: 404,
        providerCode,
        retryable: false,
        outcomeUnknown: false,
      });
      const createGenerationBoxAfterObservedAbsence = vi.fn()
        .mockRejectedValueOnce(missingSnapshot)
        .mockResolvedValueOnce(created);

      await expect(createRuntimeChangeGenerationBox({
        lifecycle: { findGenerationBoxes, createGenerationBoxAfterObservedAbsence },
        create,
        image: "companion-l14-aaaaaaaaaaaa",
      })).resolves.toEqual({ box: created, source: "base_fallback" });

      expect(findGenerationBoxes).toHaveBeenCalledOnce();
      expect(createGenerationBoxAfterObservedAbsence).toHaveBeenCalledTimes(2);
      expect(createGenerationBoxAfterObservedAbsence).toHaveBeenNthCalledWith(1, {
        ...create,
        from: "companion-l14-aaaaaaaaaaaa",
      });
      expect(createGenerationBoxAfterObservedAbsence).toHaveBeenNthCalledWith(2, create);
    },
  );

  it("recovers an existing exact-generation Box without issuing a create", async () => {
    const canonical = { id: created.boxId, state: "ready" as const };
    const findGenerationBoxes = vi.fn(async () => ({ ...absent, canonical }));
    const createGenerationBoxAfterObservedAbsence = vi.fn(async () => created);

    await expect(createRuntimeChangeGenerationBox({
      lifecycle: { findGenerationBoxes, createGenerationBoxAfterObservedAbsence },
      create,
      image: "companion-l14-aaaaaaaaaaaa",
    })).resolves.toEqual({
      box: { ...absent, canonical, outcome: "recovered", boxId: created.boxId },
      source: "named_snapshot",
    });

    expect(createGenerationBoxAfterObservedAbsence).not.toHaveBeenCalled();
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
  ])("does not replay an ambiguous, timed-out, or 5xx create failure", async (failure) => {
    const findGenerationBoxes = vi.fn(async () => absent);
    const createGenerationBoxAfterObservedAbsence = vi.fn(async () => {
      throw failure;
    });

    await expect(createRuntimeChangeGenerationBox({
      lifecycle: { findGenerationBoxes, createGenerationBoxAfterObservedAbsence },
      create,
      image: "companion-l14-aaaaaaaaaaaa",
    })).rejects.toBe(failure);
    expect(createGenerationBoxAfterObservedAbsence).toHaveBeenCalledOnce();
  });

  it("propagates a discovery 404 without issuing any create", async () => {
    const failure = new BoxRuntimeAdapterError({
      stableCode: "box_not_found",
      message: "An unrelated Box provider resource was not found",
      status: 404,
      providerCode: "box_not_found",
      retryable: false,
      outcomeUnknown: false,
    });
    const findGenerationBoxes = vi.fn(async () => {
      throw failure;
    });
    const createGenerationBoxAfterObservedAbsence = vi.fn(async () => created);

    await expect(createRuntimeChangeGenerationBox({
      lifecycle: { findGenerationBoxes, createGenerationBoxAfterObservedAbsence },
      create,
      image: "companion-l14-aaaaaaaaaaaa",
    })).rejects.toBe(failure);
    expect(createGenerationBoxAfterObservedAbsence).not.toHaveBeenCalled();
  });
});
