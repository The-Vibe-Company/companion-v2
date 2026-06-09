import { NextResponse, type NextRequest } from "next/server";
import { authErrorCode, authErrorMessage, forwardAuth } from "@/lib/authProxy";

export const dynamic = "force-dynamic";

function resetErrorMessage(code: string | null, json: Parameters<typeof authErrorMessage>[0]): string {
  switch (code) {
    case "OTP_EXPIRED":
      return "That code has expired. Request a new one.";
    case "TOO_MANY_ATTEMPTS":
      return "Too many attempts. Request a new code.";
    case "INVALID_OTP":
      return "That code is incorrect. Check the latest email.";
    case "PASSWORD_TOO_SHORT":
      return "Password must be at least 8 characters.";
    default:
      return authErrorMessage(json, "Could not reset your password.");
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as {
    email?: unknown;
    otp?: unknown;
    password?: unknown;
  };
  const email = typeof body.email === "string" ? body.email : "";
  const otp = typeof body.otp === "string" ? body.otp : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || otp.length !== 6) {
    return NextResponse.json({ ok: false, message: "Enter the 6-digit code we emailed you." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ ok: false, message: "Password must be at least 8 characters." }, { status: 400 });
  }

  const { response, json } = await forwardAuth(request, "/auth/email-otp/reset-password", { email, otp, password });
  if (response.ok) {
    // reset-password does not create a session; the user signs in with the new password afterward.
    return NextResponse.json({ ok: true, redirect: "/login?reset=1" });
  }

  const code = authErrorCode(json);
  return NextResponse.json({ ok: false, code, message: resetErrorMessage(code, json) });
}
