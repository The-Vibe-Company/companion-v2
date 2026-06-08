import { NextResponse, type NextRequest } from "next/server";

export const dynamic = "force-dynamic";

function apiBaseUrl(): string {
  return process.env.COMPANION_API_URL ?? "http://127.0.0.1:3001";
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

/** Sign out: forward the session to Better Auth (clears the session cookie), drop the org selection. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const clearCookies = ["companion_org=; Path=/; Max-Age=0"];
  try {
    const response = await fetch(`${apiBaseUrl()}/v1/auth/logout`, {
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      // Better Auth's sign-out requires a JSON content-type + body, or it 415s without clearing cookies.
      headers: {
        "content-type": "application/json",
        cookie: request.headers.get("cookie") ?? "",
        origin: request.headers.get("origin") ?? process.env.COMPANION_WEB_URL ?? request.nextUrl.origin,
      },
      body: "{}",
    });
    clearCookies.unshift(...responseSetCookies(response));
  } catch {
    // Even if the API is unreachable, still clear the local org cookie and return to login.
  }
  return redirectWithCookies("/login", clearCookies);
}
