import { NextResponse, type NextRequest } from "next/server";
import { getServerSupabase } from "@/lib/supabase/server";
import { CURRENT_ORG_COOKIE } from "@/lib/currentOrg";

/** Set the active workspace cookie after verifying the caller is a member of that org. */
export async function POST(req: NextRequest) {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let orgId: string | undefined;
  try {
    ({ orgId } = (await req.json()) as { orgId?: string });
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!orgId) return NextResponse.json({ error: "orgId required" }, { status: 400 });

  const { data: mem, error: memErr } = await supabase
    .from("memberships")
    .select("org_id")
    .eq("user_id", user.id)
    .eq("org_id", orgId)
    .maybeSingle();
  if (memErr) return NextResponse.json({ error: "membership check failed" }, { status: 500 });
  if (!mem) return NextResponse.json({ error: "not a member" }, { status: 403 });

  const res = NextResponse.json({ ok: true });
  res.cookies.set(CURRENT_ORG_COOKIE, orgId, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production", // HTTPS-only in prod; allow http for local dev
    path: "/",
    maxAge: 60 * 60 * 24 * 365,
  });
  return res;
}
