import "server-only";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Shared helpers for the web-side auth proxy routes (`apps/web/src/app/v1/auth/*`).
 *
 * These route handlers forward to the API's Better Auth endpoints **server-side** and re-emit the
 * upstream `Set-Cookie` headers onto the web origin, so the session cookie is always stamped same-origin
 * (the codebase deliberately avoids the client-side Better Auth SDK + cross-origin cookies). Mirrors the
 * cookie re-emit pattern in `logout/route.ts`.
 */

export function apiBaseUrl(): string {
  return process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
}

/** Better Auth emits one cookie per header; read them all (a single comma-joined string mis-parses). */
export function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.();
  if (cookies?.length) return cookies;
  const cookie = response.headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

/** Validate a post-auth redirect target: same-origin path only, never an open redirect. */
export function safeNext(value: unknown): string {
  const next = typeof value === "string" ? value : "";
  if (!next.startsWith("/") || next.startsWith("//") || next.includes("\\")) {
    return "/skills";
  }
  try {
    const parsed = new URL(next, "http://companion.local");
    if (parsed.origin !== "http://companion.local") return "/skills";
    const pathname = parsed.pathname.toLowerCase();
    if (pathname.startsWith("/%2f") || pathname.startsWith("/%5c")) return "/skills";
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return "/skills";
  }
}

/** Better Auth error responses are `{ message, code }` at the top level (better-call APIError body). */
export type AuthJson = { message?: string; code?: string; url?: string; error?: { message?: string } } | null;

export interface AuthUpstreamResult {
  response: Response;
  json: AuthJson;
}

/** Server-side POST to an API Better Auth path, forwarding the browser cookie + a trusted origin. */
export async function forwardAuth(request: NextRequest, path: string, body: unknown): Promise<AuthUpstreamResult> {
  const response = await fetch(`${apiBaseUrl()}${path}`, {
    method: "POST",
    cache: "no-store",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      cookie: request.headers.get("cookie") ?? "",
      origin: request.headers.get("origin") ?? process.env.COMPANION_WEB_URL ?? request.nextUrl.origin,
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await response.json().catch(() => null)) as AuthJson;
  return { response, json };
}

/** JSON response that also re-emits the upstream `Set-Cookie` headers on the web origin. */
export function jsonWithCookies(data: unknown, init?: { status?: number; cookies?: string[] }): NextResponse {
  const res = NextResponse.json(data, { status: init?.status ?? 200 });
  for (const cookie of init?.cookies ?? []) res.headers.append("set-cookie", cookie);
  return res;
}

export function authErrorMessage(json: AuthJson, fallback: string): string {
  if (json && typeof json.message === "string" && json.message) return json.message;
  if (json && json.error && typeof json.error.message === "string" && json.error.message) return json.error.message;
  return fallback;
}

export function authErrorCode(json: AuthJson): string | null {
  return json && typeof json.code === "string" ? json.code : null;
}
