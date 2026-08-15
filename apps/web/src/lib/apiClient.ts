export class ApiFetchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiFetchError";
    this.status = status;
  }
}

/**
 * Every call gets a deadline. A fetch left without one can hang on a dead proxy or a laptop that
 * slept mid-request, and the thread queue serializes on it — one hung request then silently wedges
 * every poll and queued send behind it. Callers with a longer legitimate wait (a send riding a cold
 * Box wake) pass their own budget; a caller-provided signal still composes with the deadline.
 */
export const API_FETCH_DEFAULT_TIMEOUT_MS = 20_000;

function deadlineSignal(
  init: RequestInit | undefined,
  options: { timeoutMs?: number } | undefined,
): AbortSignal {
  if (options?.timeoutMs !== undefined) {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    return init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  }
  // A caller-provided signal is that caller's own deadline; the default must not shorten it.
  return init?.signal ?? AbortSignal.timeout(API_FETCH_DEFAULT_TIMEOUT_MS);
}

export async function apiFetch<T>(
  path: string,
  init?: RequestInit,
  options?: { timeoutMs?: number },
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: init?.credentials ?? "same-origin",
      signal: deadlineSignal(init, options),
      headers: {
        ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
        ...(init?.headers ?? {}),
      },
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      throw new ApiFetchError("Request timed out. Try connecting again.", 408);
    }
    if (cause instanceof Error && cause.name === "AbortError") {
      throw new ApiFetchError("Request timed out. Try connecting again.", 408);
    }
    throw cause;
  }
  // The deadline can also fire mid-body on a degraded network. That abort must stay a timeout —
  // swallowing it here would hand the caller an empty object as a fake success.
  const json = (await res.json().catch((cause) => {
    if (cause instanceof DOMException && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      throw new ApiFetchError("Request timed out. Try connecting again.", 408);
    }
    return {};
  })) as { error?: string; message?: string };
  if (!res.ok) throw new ApiFetchError(json.message ?? json.error ?? `Request failed: ${res.status}`, res.status);
  return json as T;
}
