export class ApiFetchError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiFetchError";
    this.status = status;
  }
}

export async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      credentials: init?.credentials ?? "same-origin",
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
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiFetchError(json.message ?? json.error ?? `Request failed: ${res.status}`, res.status);
  return json as T;
}
