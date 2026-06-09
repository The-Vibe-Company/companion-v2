import { NextResponse, type NextRequest } from "next/server";
import { authErrorMessage, forwardAuth } from "@/lib/authProxy";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email : "";
  if (!/.+@.+\..+/.test(email)) {
    return NextResponse.json({ ok: false, message: "Enter a valid email address." }, { status: 400 });
  }

  const { response, json } = await forwardAuth(request, "/auth/email-otp/request-password-reset", { email });
  // Anti-enumeration: the API no-ops (and returns success) for unknown emails. Always report success,
  // surfacing only the rate limit so the resend countdown reads true.
  if (response.ok) {
    return NextResponse.json({ ok: true });
  }
  if (response.status === 429) {
    return NextResponse.json(
      { ok: false, message: "Please wait a moment before requesting another code." },
      { status: 429 },
    );
  }
  return NextResponse.json({ ok: false, message: authErrorMessage(json, "Could not send the reset code.") });
}
