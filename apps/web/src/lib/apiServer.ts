import "server-only";
import { cookies, headers } from "next/headers";

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

function errorMessage(status: number, fallback: string, body: unknown): string {
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    return body.error;
  }
  return fallback || `Request failed: ${status}`;
}

export async function serverApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  let res: Response;
  try {
    res = await fetch(`${apiBaseUrl()}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
        cookie: cookieHeader,
        // A Server Component cannot forward an API Set-Cookie to the browser. Leave the rolling
        // refresh for SessionKeepAlive's same-origin browser request, which can persist it.
        "x-companion-disable-session-refresh": "1",
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ServerApiError({
      status: 0,
      path,
      message: "Could not reach Companion API.",
    });
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new ServerApiError({
      status: res.status,
      path,
      message: errorMessage(res.status, res.statusText, json),
    });
  }
  if (json === null) {
    throw new ServerApiError({
      status: res.status,
      path,
      message: "Companion API returned an invalid response.",
    });
  }
  return json as T;
}

export async function setCurrentOrgCookie(orgId: string): Promise<void> {
  (await cookies()).set("companion_org", orgId, {
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
