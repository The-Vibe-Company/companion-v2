import { NextResponse, type NextRequest } from "next/server";
import {
  authErrorCode,
  authErrorMessage,
  forwardAuth,
  jsonWithCookies,
  responseSetCookies,
  safeNext,
} from "@/lib/authProxy";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as {
    email?: unknown;
    password?: unknown;
    next?: unknown;
  };
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) {
    return NextResponse.json({ ok: false, message: "Enter your email and password to continue." }, { status: 400 });
  }

  const { response, json } = await forwardAuth(request, "/auth/sign-in/email", { email, password });
  if (response.ok) {
    return jsonWithCookies({ ok: true, redirect: safeNext(body.next) }, { cookies: responseSetCookies(response) });
  }

  // requireEmailVerification + sendOnSignIn: an unverified sign-in re-mails a fresh OTP, so route the
  // client straight to the verify screen instead of showing a credentials error.
  if (authErrorCode(json) === "EMAIL_NOT_VERIFIED") {
    const resend = await forwardAuth(request, "/auth/email-otp/send-verification-otp", {
      email,
      type: "email-verification",
    });
    if (!resend.response.ok && resend.response.status !== 429) {
      return NextResponse.json(
        { ok: false, message: authErrorMessage(resend.json, "Could not send the verification code.") },
        { status: resend.response.status >= 500 ? 502 : resend.response.status },
      );
    }
    return NextResponse.json({ ok: false, needsVerification: true, email });
  }

  return NextResponse.json({ ok: false, message: authErrorMessage(json, "Invalid email or password.") });
}
