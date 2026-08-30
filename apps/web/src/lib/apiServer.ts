import "server-only";
import * as Sentry from "@sentry/nextjs";
import { cookies, headers } from "next/headers";
import { stripSensitiveUrl } from "../../sentry.shared";

export class ServerApiError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(input: { status: number; path: string; message: string }) {
    super(input.message);
    this.name = "ServerApiError";
    this.status = input.status;
    this.path = input.path;
  }
}

export function apiBaseUrl(): string {
  return process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
}

function captureServerApiFailure(path: string, status: number, kind: "network" | "response" | "invalid-json"): void {
  const route = stripSensitiveUrl(path) ?? "unknown";
  Sentry.withScope((scope) => {
    scope.setLevel("error");
    scope.setTag("operation", "server.api.fetch");
    scope.setTag("http.route", route);
    scope.setTag("http.status_code", String(status));
    scope.setTag("error.kind", kind);
    scope.setFingerprint(["web", "server.api.fetch", kind, route, String(status)]);
    Sentry.captureException(new Error(`Companion API ${kind} failure (${status})`));
  });
}

interface ApiErrorBody {
  error?: string;
}

function errorMessage(status: number, fallback: string, body: ApiErrorBody | null): string {
  if (body?.error) {
    return body.error;
  }
  return fallback || `Request failed: ${status}`;
}

export async function serverApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  const requestHeaders: Record<string, string> = {};
  if (!(init?.body instanceof FormData)) requestHeaders["content-type"] = "application/json";
  requestHeaders.cookie = cookieHeader;
  requestHeaders["x-companion-disable-session-refresh"] = "1";
  new Headers(init?.headers).forEach((value, key) => {
    requestHeaders[key] = value;
  });
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      cache: "no-store",
      // A Server Component cannot forward an API Set-Cookie to the browser. Leave the rolling
      // refresh for SessionKeepAlive's same-origin browser request, which can persist it.
      headers: requestHeaders,
    });
  } catch {
    captureServerApiFailure(path, 0, "network");
    throw new ServerApiError({
      status: 0,
      path,
      message: "Could not reach Companion API.",
    });
  }

  // SAFETY: failure handling reads only the optional API error envelope; successful responses
  // retain their caller-owned generic contract below.
  const json = await res.json().catch(() => null) as ApiErrorBody | null;
  if (!res.ok) {
    if (res.status >= 500) captureServerApiFailure(path, res.status, "response");
    throw new ServerApiError({
      status: res.status,
      path,
      message: errorMessage(res.status, res.statusText, json),
    });
  }
  if (json === null) {
    captureServerApiFailure(path, res.status, "invalid-json");
    throw new ServerApiError({
      status: res.status,
      path,
      message: "Companion API returned an invalid response.",
    });
  }
  // SAFETY: serverApiFetch preserves the established caller-owned response contract; feature
  // schemas validate untrusted payloads where a route requires runtime validation.
  return json as T;
}

export async function setCurrentOrgCookie(orgId: string): Promise<void> {
  (await cookies()).set("companion_org", orgId, {
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
