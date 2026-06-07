import "server-only";
import { cookies, headers } from "next/headers";

export function apiBaseUrl(): string {
  return process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
}

export async function serverApiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const cookieHeader = (await headers()).get("cookie") ?? "";
  const res = await fetch(`${apiBaseUrl()}${path}`, {
    ...init,
    cache: "no-store",
    headers: {
      ...(init?.body instanceof FormData ? {} : { "content-type": "application/json" }),
      cookie: cookieHeader,
      ...(init?.headers ?? {}),
    },
  });
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(json.error ?? `Request failed: ${res.status}`);
  return json as T;
}

export async function setCurrentOrgCookie(orgId: string): Promise<void> {
  (await cookies()).set("companion_org", orgId, {
    path: "/",
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
