import { NextResponse, type NextRequest } from "next/server";
import { authErrorMessage, forwardAuth } from "@/lib/authProxy";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email : "";
  if (!email) {
    return NextResponse.json({ ok: false, message: "Missing email." }, { status: 400 });
  }

  const { response, json } = await forwardAuth(request, "/auth/email-otp/send-verification-otp", {
    email,
    type: "email-verification",
  });
  if (response.ok) {
    return NextResponse.json({ ok: true });
  }
  if (response.status === 429) {
    return NextResponse.json(
      { ok: false, message: "Please wait a moment before requesting another code." },
      { status: 429 },
    );
  }
  return NextResponse.json({ ok: false, message: authErrorMessage(json, "Could not send the code.") });
}
