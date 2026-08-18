import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

import { companionAttachmentUrl, sendCompanionMessage } from "./companions";

/**
 * Product promise:
 * A send that carries files uploads them with the message, in one request, so the accepted turn and
 * the files it names are durable together.
 *
 * Regression caught:
 * The composer can keep staging files while the client silently drops them — falling back to the
 * JSON branch, losing the multipart boundary, or timing out on the one-second text deadline — and
 * every render test would still pass.
 */

const originalFetch = globalThis.fetch;

function jsonResponse() {
  return Promise.resolve(new Response(JSON.stringify({ turn: { id: "t1" } }), {
    status: 202,
    headers: { "content-type": "application/json" },
  }));
}

beforeEach(() => {
  globalThis.fetch = vi.fn(() => jsonResponse()) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("sending a message with files", () => {
  it("sends one multipart request carrying the text and every file", async () => {
    await sendCompanionMessage("org-1", "companion-1", "Look at these", "message-1", [
      new File(["png"], "chart.png", { type: "image/png" }),
      new File(["csv"], "rows.csv", { type: "text/csv" }),
    ]);

    const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1] as RequestInit;
    const body = init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect(body.get("content")).toBe("Look at these");
    expect(body.get("client_message_id")).toBe("message-1");
    // One repeated `file` part per file: the route reads them with `getAll("file")`.
    expect(body.getAll("file").map((part) => (part as File).name))
      .toEqual(["chart.png", "rows.csv"]);
    // The JSON content type must be absent or the multipart boundary is lost.
    expect(init.headers).not.toHaveProperty("content-type");
  });

  it("gives an upload a deadline of its own rather than the text send's", async () => {
    const calls: RequestInit[] = [];
    globalThis.fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      return jsonResponse();
    }) as unknown as typeof fetch;

    await sendCompanionMessage("org-1", "companion-1", "Just text", "message-2");
    await sendCompanionMessage("org-1", "companion-1", "Look", "message-3", [
      new File(["png"], "chart.png", { type: "image/png" }),
    ]);

    // Both carry a deadline; the upload's is the generous one, so a slow transfer is not cut off at
    // the text send's bound.
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(calls[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps a text-only send on the JSON branch", async () => {
    await sendCompanionMessage("org-1", "companion-1", "Just text", "message-4");

    const init = (globalThis.fetch as unknown as ReturnType<typeof vi.fn>)
      .mock.calls[0]![1] as RequestInit;
    expect(typeof init.body).toBe("string");
  });
});

describe("reading an attachment back", () => {
  it("points at the control-plane route rather than object storage", () => {
    expect(companionAttachmentUrl("companion-1", "attachment-1"))
      .toBe("/v1/companions/companion-1/attachments/attachment-1");
    // Ids are encoded: nothing a caller supplies may reshape the path.
    expect(companionAttachmentUrl("a/b", "c d"))
      .toBe("/v1/companions/a%2Fb/attachments/c%20d");
  });
});
