import { NextResponse, type NextRequest } from "next/server";
import { forwardAuth } from "@/lib/authProxy";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; password?: unknown };
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!/.+@.+\..+/.test(email)) {
    return NextResponse.json({ ok: false, message: "Enter a valid email address." }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ ok: false, message: "Password must be at least 8 characters." }, { status: 400 });
  }

  // The Name is collected right after, during onboarding — derive a placeholder from the email local-part
  // (Better Auth's sign-up/email requires a name).
  const name = email.split("@")[0] || email;

  const { response } = await forwardAuth(request, "/auth/sign-up/email", { email, password, name });
  if (response.ok) {
    // requireEmailVerification => no session yet; the OTP was auto-sent. A duplicate email returns a
    // generic success-shaped response (anti-enumeration), so always route to the verify screen and
    // never imply a brand-new account was created.
    return NextResponse.json({ ok: true, needsVerification: true, email });
  }

  // The client already validated email + password length, and a duplicate email returns ok above, so a
  // non-OK here is a transient/server failure. Keep the message generic — never echo the upstream error,
  // so the form can't become an account-enumeration oracle.
  const status = response.status >= 400 && response.status < 500 ? 400 : 502;
  return NextResponse.json(
    { ok: false, message: "Could not create your account. Check your details and try again." },
    { status },
  );
}
