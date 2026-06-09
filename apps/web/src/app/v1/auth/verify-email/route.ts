import { NextResponse, type NextRequest } from "next/server";
import { authErrorCode, forwardAuth, jsonWithCookies, responseSetCookies } from "@/lib/authProxy";

export const dynamic = "force-dynamic";

function verifyErrorMessage(code: string | null): string {
  switch (code) {
    case "OTP_EXPIRED":
      return "That code has expired. Request a new one.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many attempts. Request a new code.";
    default:
      return "That code is incorrect. Check the latest email.";
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; otp?: unknown };
  const email = typeof body.email === "string" ? body.email : "";
  const otp = typeof body.otp === "string" ? body.otp : "";
  if (!email || otp.length !== 6) {
    return NextResponse.json({ ok: false, message: "Enter the 6-digit code we emailed you." }, { status: 400 });
  }

  const { response, json } = await forwardAuth(request, "/auth/email-otp/verify-email", { email, otp });
  if (response.ok) {
    // autoSignInAfterVerification: a session cookie is now present — re-emit it on the web origin so the
    // user lands logged in.
    return jsonWithCookies(
      { ok: true, redirect: "/onboarding" },
      { cookies: responseSetCookies(response) },
    );
  }

  const code = authErrorCode(json);
  return NextResponse.json({ ok: false, code, message: verifyErrorMessage(code) });
}
