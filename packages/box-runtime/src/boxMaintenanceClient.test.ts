import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AsciiBoxMaintenanceClient,
  type BoxDeletionOperation,
  type BoxDeletionStatus,
} from "./boxMaintenanceClient";
import {
  BoxRuntimeConfigurationError,
  BoxRuntimeProviderError,
} from "./boxCompanionRuntime";

const BOX_ID = "bx_23456789";
const OTHER_BOX_ID = "bx_abcdefgh";
const OPERATION_ID = "bdop_00000000000000000000000000000001";

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function client(): AsciiBoxMaintenanceClient {
  return new AsciiBoxMaintenanceClient({
    COMPANION_BOX_API_KEY: "box_test",
    COMPANION_BOX_API_BASE: "https://box.test/v1/",
  });
}

function operation(
  status: BoxDeletionStatus = "pending",
  overrides: Partial<BoxDeletionOperation> = {},
): BoxDeletionOperation {
  return {
    id: OPERATION_ID,
    targetId: BOX_ID,
    status,
    attemptCount: status === "pending" ? 0 : 1,
    requestedAt: "2026-08-16T00:00:00.001Z",
    completedAt: status === "completed" ? "2026-08-16T00:00:00.003Z" : null,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AsciiBoxMaintenanceClient", () => {
  it("requires the Box service key", () => {
    expect(() => new AsciiBoxMaintenanceClient({}))
      .toThrow(BoxRuntimeConfigurationError);
  });

  it("lists every Box page with the provider maximum and opaque cursor", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [{ id: BOX_ID, name: "Companion one", state: "archived" }],
        pageInfo: { nextCursor: "page-two", hasMore: true },
      }))
      .mockResolvedValueOnce(json({
        ok: true,
        type: "box.list",
        boxes: [{ id: OTHER_BOX_ID }],
        pageInfo: { nextCursor: null, hasMore: false },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().listAllBoxes()).resolves.toEqual([
      { id: BOX_ID, name: "Companion one" },
      { id: OTHER_BOX_ID },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual([
      "https://box.test/v1/boxes?limit=200&sort=desc",
      "https://box.test/v1/boxes?limit=200&sort=desc&cursor=page-two",
    ]);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toMatchObject({
        headers: { Authorization: "Bearer box_test" },
      });
    }
  });

  it("accepts an official short terminal list response without pageInfo", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "box.list",
      boxes: [{ id: BOX_ID, name: "Companion one" }],
    })));

    await expect(client().listAllBoxes()).resolves.toEqual([
      { id: BOX_ID, name: "Companion one" },
    ]);
  });

  it.each([
    ["success discriminator", { ok: false, type: "box.list", boxes: [] }],
    ["envelope type", { ok: true, type: "boxes", boxes: [] }],
    ["Box id", { ok: true, type: "box.list", boxes: [{ id: "bx_invalid" }] }],
    [
      "terminal cursor",
      {
        ok: true,
        type: "box.list",
        boxes: [],
        pageInfo: { nextCursor: "impossible", hasMore: false },
      },
    ],
  ])("fails closed on an invalid Box list %s", async (_name, envelope) => {
    vi.stubGlobal("fetch", vi.fn(async () => json(envelope)));

    await expect(client().listAllBoxes()).rejects.toMatchObject({
      name: "BoxRuntimeProviderError",
      status: 502,
      code: "invalid_provider_response",
    });
  });

  it("fails closed when a full page omits pagination", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "box.list",
      boxes: Array.from({ length: 200 }, () => ({ id: BOX_ID })),
    })));

    await expect(client().listAllBoxes()).rejects.toThrow(/omitted pagination/);
  });

  it("fails closed when pagination repeats a cursor", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => json({
      ok: true,
      type: "box.list",
      boxes: [],
      pageInfo: { nextCursor: "same-page", hasMore: true },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().listAllBoxes()).rejects.toThrow(/invalid Box list pagination/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends the exact irreversible-delete confirmation and retains the operation id", async () => {
    const accepted = operation();
    const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => json({
      ok: true,
      type: "box.deleting",
      operation: accepted,
    }, 202));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID })).resolves.toEqual({
      outcome: "accepted",
      operation: accepted,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(`https://box.test/v1/boxes/${BOX_ID}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "DELETE",
      headers: {
        Authorization: "Bearer box_test",
        "X-Ascii-Confirm-Delete": BOX_ID,
      },
    });
  });

  it("exposes delete 404 as absent without weakening operation polling", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({
        ok: false,
        code: "box_not_found",
        message: "Box not found",
      }, 404))
      .mockResolvedValueOnce(json({
        ok: false,
        code: "deletion_operation_not_found",
        message: "Deletion operation not found",
      }, 404));
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID })).resolves.toEqual({
      outcome: "absent",
      boxId: BOX_ID,
    });
    await expect(client().getDeletionOperation({
      operationId: OPERATION_ID,
      boxId: BOX_ID,
    })).rejects.toMatchObject({
      name: "BoxRuntimeProviderError",
      status: 404,
      code: "deletion_operation_not_found",
    });
  });

  it.each<BoxDeletionStatus>(["pending", "processing", "blocked", "completed"])(
    "accepts and returns the documented %s deletion status",
    async (status) => {
      const current = operation(status);
      const fetchMock = vi.fn<typeof fetch>(async (_input, _init) => json({
        ok: true,
        type: "deletion.operation",
        operation: current,
      }));
      vi.stubGlobal("fetch", fetchMock);

      await expect(client().getDeletionOperation({
        operationId: OPERATION_ID,
        boxId: BOX_ID,
      })).resolves.toEqual(current);
      expect(fetchMock.mock.calls[0]?.[0])
        .toBe(`https://box.test/v1/deletion-operations/${OPERATION_ID}`);
    },
  );

  it.each([
    ["unknown status", operation("pending", { status: "unknown" as BoxDeletionStatus })],
    ["malformed operation id", operation("pending", { id: "operation-1" })],
    ["different target", operation("pending", { targetId: OTHER_BOX_ID })],
    ["premature completion time", operation("pending", { completedAt: "2026-08-16T00:00:00Z" })],
    ["missing completion time", operation("completed", { completedAt: null })],
  ])("fails closed on a deletion response with %s", async (_name, invalidOperation) => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "deletion.operation",
      operation: invalidOperation,
    })));

    await expect(client().getDeletionOperation({
      operationId: OPERATION_ID,
      boxId: BOX_ID,
    })).rejects.toMatchObject({
      name: "BoxRuntimeProviderError",
      status: 502,
      code: "invalid_provider_response",
    });
  });

  it("rejects a poll response carrying a different operation id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "deletion.operation",
      operation: operation("pending", {
        id: "bdop_00000000000000000000000000000002",
      }),
    })));

    await expect(client().getDeletionOperation({
      operationId: OPERATION_ID,
      boxId: BOX_ID,
    })).rejects.toThrow(/different deletion operation/);
  });

  it("requires HTTP 202 and the official accepted-delete envelope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "box.deleting",
      operation: operation(),
    })));

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID }))
      .rejects.toThrow(/unexpected permanent deletion status/);
  });

  it("accepts the documented deletion.operation envelope on DELETE", async () => {
    const accepted = operation();
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: true,
      type: "deletion.operation",
      operation: accepted,
    }, 202)));

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID })).resolves.toEqual({
      outcome: "accepted",
      operation: accepted,
    });
  });

  it("rejects invalid caller ids before contacting Box", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(client().requestPermanentDeletion({ boxId: "../../all" }))
      .rejects.toBeInstanceOf(BoxRuntimeConfigurationError);
    await expect(client().getDeletionOperation({ operationId: "op-1", boxId: BOX_ID }))
      .rejects.toBeInstanceOf(BoxRuntimeConfigurationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps non-404 provider failures without treating them as absence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({
      ok: false,
      code: "delete_blocked",
      message: "Deletion is blocked",
    }, 409)));

    await expect(client().requestPermanentDeletion({ boxId: BOX_ID })).rejects.toEqual(
      expect.objectContaining<Partial<BoxRuntimeProviderError>>({
        name: "BoxRuntimeProviderError",
        status: 409,
        code: "delete_blocked",
      }),
    );
  });

  it("fails closed on invalid JSON in a successful response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("not-json", { status: 200 })));

    await expect(client().listAllBoxes()).rejects.toMatchObject({
      name: "BoxRuntimeProviderError",
      status: 502,
      code: "invalid_provider_response",
    });
  });
});
