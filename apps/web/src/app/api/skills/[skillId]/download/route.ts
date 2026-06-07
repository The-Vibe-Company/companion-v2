import { NextResponse } from "next/server";
import { getServerSupabase } from "@/lib/supabase/server";
import { getAdminSupabase } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/** Mint a short-lived signed download URL after the RLS visibility check passes. */
export async function GET(_req: Request, { params }: { params: Promise<{ skillId: string }> }) {
  const { skillId } = await params;
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // RLS decides whether this user can see the skill (and thus its version).
  const { data: skill } = await supabase
    .from("skills")
    .select("current_version_id")
    .eq("id", skillId)
    .maybeSingle();
  const versionId = skill?.current_version_id as string | undefined;
  if (!versionId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { data: ver } = await supabase
    .from("skill_versions")
    .select("storage_path")
    .eq("id", versionId)
    .maybeSingle();
  const path = ver?.storage_path as string | undefined;
  if (!path) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const admin = getAdminSupabase();
  const { data: signed, error } = await admin.storage
    .from("skill-archives")
    .createSignedUrl(path, 60);
  if (error || !signed) {
    return NextResponse.json({ error: "Could not sign download URL" }, { status: 500 });
  }
  return NextResponse.redirect(signed.signedUrl);
}
