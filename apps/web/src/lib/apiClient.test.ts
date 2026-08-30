import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "./apiClient";

/** A fetch that never answers on its own — it settles only when the request's signal aborts. */
function hangingFetch() {
  return vi.fn((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason));
    }));
}

describe("apiFetch deadlines", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fails a hung request closed as a retryable timeout", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const captureFailure = vi.fn();

    await expect(apiFetch("/v1/companions", undefined, { timeoutMs: 5, captureFailure }))
      .rejects.toMatchObject({ name: "ApiFetchError", status: 408 });
    expect(captureFailure).toHaveBeenCalledOnce();
  });

  it("keeps a deadline that fires mid-body a timeout instead of a fake empty success", async () => {
    // A 200 whose body read is aborted must not resolve to `{}` — callers would dereference a
    // response that never arrived.
    const response = new Response(null, { status: 200 });
    Object.defineProperty(response, "json", {
      value: () => Promise.reject(new DOMException("body aborted", "TimeoutError")),
    });
    vi.stubGlobal("fetch", vi.fn(async () => response));
    const captureFailure = vi.fn();

    await expect(apiFetch("/v1/companions", undefined, { timeoutMs: 5, captureFailure }))
      .rejects.toMatchObject({ name: "ApiFetchError", status: 408 });
    expect(captureFailure).toHaveBeenCalledOnce();
  });

  it("applies a default deadline when the caller brings neither signal nor budget", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    void apiFetch("/v1/companions").catch(() => undefined);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("leaves a caller-provided signal as the only deadline", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    // The OAuth polls carry 35-65 second budgets of their own; wrapping them in the shorter default
    // would abort them mid-flow.
    void apiFetch("/v1/oauth/poll", { signal: controller.signal }).catch(() => undefined);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBe(controller.signal);

    controller.abort(new DOMException("aborted", "AbortError"));
    await expect(apiFetch("/v1/oauth/poll", { signal: controller.signal }))
      .rejects.toMatchObject({ status: 408 });
  });

  it("composes an explicit budget with the caller's signal", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();

    const request = apiFetch(
      "/v1/companions/c1/messages",
      { method: "POST", signal: controller.signal },
      { timeoutMs: 60_000 },
    );
    controller.abort(new DOMException("aborted", "AbortError"));
    await expect(request).rejects.toMatchObject({ status: 408 });
  });
});
