import { NextResponse, type NextRequest } from "next/server";
import { apiBaseUrl, responseSetCookies, safeNext, type AuthJson } from "@/lib/authProxy";

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
  const loginErrorUrl = (message: string) => {
    const url = new URL("/login", origin);
    url.searchParams.set("error", message);
    url.searchParams.set("next", next);
    return url;
  };
  const errorRedirect = () => NextResponse.redirect(loginErrorUrl("Google sign-in is unavailable."), 303);
  const callbackURL = new URL(next, origin).toString();

  try {
    const response = await fetch(`${apiBaseUrl()}/auth/sign-in/social`, {
      method: "POST",
      cache: "no-store",
      redirect: "manual",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        provider: "google",
        callbackURL,
        // `/skills` already redirects a not-yet-onboarded user to `/onboarding`. Keeping the same
        // validated target for new users preserves public-install and device-approval return paths.
        newUserCallbackURL: callbackURL,
        errorCallbackURL: loginErrorUrl("Google sign-in failed.").toString(),
      }),
    });
    const json = (await response.json().catch(() => null)) as AuthJson;
    if (response.ok && json?.url) {
      const redirect = NextResponse.redirect(json.url, 303);
      for (const cookie of responseSetCookies(response)) redirect.headers.append("set-cookie", cookie);
      return redirect;
    }
    return errorRedirect();
  } catch {
    return errorRedirect();
  }
}
