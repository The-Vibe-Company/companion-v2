import { NextResponse, type NextRequest } from "next/server";
import { apiBaseUrl, safeNext, type AuthJson } from "@/lib/authProxy";

export const dynamic = "force-dynamic";

function webOrigin(request: NextRequest): string {
  return process.env.COMPANION_WEB_URL ?? request.nextUrl.origin;
}

/**
 * Begins the Google OAuth dance. The browser navigates here (top-level GET); we ask Better Auth for the
 * Google consent URL and 303 the browser to it. Google then returns to `${BETTER_AUTH_URL}/auth/callback/google`,
 * which creates the session and redirects to `callbackURL` (existing user) or `newUserCallbackURL` (new user).
 *
 * Google is conditional: when GOOGLE_CLIENT_ID/SECRET are unset the social provider isn't wired, so the
 * API responds without a `url` and we bounce back to /login with a friendly error.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = webOrigin(request);
  const next = safeNext(request.nextUrl.searchParams.get("next"));
  const errorRedirect = () =>
    NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent("Google sign-in is unavailable.")}`, origin),
      303,
    );

  try {
    const response = await fetch(`${apiBaseUrl()}/auth/sign-in/social`, {
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        provider: "google",
        callbackURL: new URL(next, origin).toString(),
        newUserCallbackURL: new URL("/onboarding", origin).toString(),
        errorCallbackURL: new URL(`/login?error=${encodeURIComponent("Google sign-in failed.")}`, origin).toString(),
      }),
    });
    const json = (await response.json().catch(() => null)) as AuthJson;
    if (response.ok && json?.url) {
      return NextResponse.redirect(json.url, 303);
    }
    return errorRedirect();
  } catch {
    return errorRedirect();
  }
}
