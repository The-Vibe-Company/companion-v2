import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function apiBaseUrl(): string {
  return process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
}

function safeNext(value: unknown): string {
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

function loginPath(next: string, mode: string, error: string): string {
  return `/login?${new URLSearchParams({ next, mode, error }).toString()}`;
}

function responseSetCookies(response: Response): string[] {
  const headers = response.headers as Headers & { getSetCookie?: () => string[] };
  const cookies = headers.getSetCookie?.();
  if (cookies?.length) return cookies;
  const cookie = response.headers.get("set-cookie");
  return cookie ? [cookie] : [];
}

function redirectWithCookies(path: string, cookies: string[] = []): NextResponse {
  const redirect = new NextResponse(null, {
    status: 303,
    headers: { location: path },
  });
  for (const cookie of cookies) {
    redirect.headers.append("set-cookie", cookie);
  }
  return redirect;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const mode = form.get("mode") === "signup" ? "signup" : "signin";
  const next = safeNext(form.get("next"));
  const email = String(form.get("email") ?? "");
  const password = String(form.get("password") ?? "");
  const name = String(form.get("name") || email.split("@")[0] || email);
  const endpoint = mode === "signup" ? "/auth/sign-up/email" : "/auth/sign-in/email";

  const response = await fetch(`${apiBaseUrl()}${endpoint}`, {
    method: "POST",
    cache: "no-store",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      origin: request.headers.get("origin") ?? process.env.COMPANION_WEB_URL ?? request.nextUrl.origin,
    },
    body: JSON.stringify({ email, password, name }),
  });

  if (!response.ok) {
    const json = (await response.json().catch(() => ({}))) as { message?: string; error?: { message?: string } };
    return redirectWithCookies(loginPath(next, mode, json.error?.message ?? json.message ?? "Authentication failed"));
  }

  // New accounts go through onboarding (create or join an org) before landing in the app.
  const destination = mode === "signup" ? "/onboarding" : next;
  return redirectWithCookies(destination, responseSetCookies(response));
}
