import * as Sentry from "@sentry/nextjs";
import { stripSensitiveUrl } from "../../sentry.shared";

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
 * slept mid-request. Callers with a longer legitimate wait pass their own budget; a caller-provided
 * signal still composes with the deadline.
 */
export const API_FETCH_DEFAULT_TIMEOUT_MS = 20_000;

function captureApiFailure(input: {
  path: string;
  method: string;
  status: number;
  kind: "network" | "timeout" | "response";
}): void {
  const route = stripSensitiveUrl(input.path) ?? "unknown";
  Sentry.withScope((scope) => {
    scope.setLevel(input.status >= 500 || input.status === 0 ? "error" : "warning");
    scope.setTag("operation", "api.fetch");
    scope.setTag("http.method", input.method);
    scope.setTag("http.route", route);
    scope.setTag("http.status_code", String(input.status));
    scope.setTag("error.kind", input.kind);
    scope.setFingerprint(["web", "api.fetch", input.kind, route, String(input.status)]);
    Sentry.captureException(new Error(`Companion API ${input.kind} failure (${input.status})`));
  });
}

type ApiFailureCapture = typeof captureApiFailure;
type ApiFetchOptions = { timeoutMs?: number; captureFailure?: ApiFailureCapture };

function deadlineSignal(
  init: RequestInit | undefined,
  options: ApiFetchOptions | undefined,
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
  options?: ApiFetchOptions,
): Promise<T> {
  const reportFailure = options?.captureFailure ?? captureApiFailure;
  let res: Response;
  const requestHeaders: Record<string, string> = {};
  if (!(init?.body instanceof FormData)) requestHeaders["content-type"] = "application/json";
  new Headers(init?.headers).forEach((value, key) => {
    requestHeaders[key] = value;
  });
  try {
    res = await fetch(path, {
      ...init,
      credentials: init?.credentials ?? "same-origin",
      signal: deadlineSignal(init, options),
      headers: requestHeaders,
    });
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === "TimeoutError") {
      reportFailure({ path, method: init?.method ?? "GET", status: 408, kind: "timeout" });
      throw new ApiFetchError("Request timed out. Try connecting again.", 408);
    }
    if (cause instanceof Error && cause.name === "AbortError") {
      reportFailure({ path, method: init?.method ?? "GET", status: 408, kind: "timeout" });
      throw new ApiFetchError("Request timed out. Try connecting again.", 408);
    }
    reportFailure({ path, method: init?.method ?? "GET", status: 0, kind: "network" });
    throw cause;
  }
  // The deadline can also fire mid-body on a degraded network. That abort must stay a timeout —
  // swallowing it here would hand the caller an empty object as a fake success.
  // SAFETY: only the optional API error envelope is read before the generic caller-owned result.
  const json = (await res.json().catch((cause) => {
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      reportFailure({ path, method: init?.method ?? "GET", status: 408, kind: "timeout" });
      throw new ApiFetchError("Request timed out. Try connecting again.", 408);
    }
    return {};
  })) as { error?: string; message?: string };
  if (!res.ok) {
    if (res.status >= 500) {
      reportFailure({ path, method: init?.method ?? "GET", status: res.status, kind: "response" });
    }
    throw new ApiFetchError(json.message ?? json.error ?? `Request failed: ${res.status}`, res.status);
  }
  // SAFETY: apiFetch preserves the established caller-owned response contract; route schemas
  // validate untrusted payloads at their feature boundaries.
  return json as T;
}
