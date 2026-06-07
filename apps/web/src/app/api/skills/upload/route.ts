import { NextResponse } from "next/server";
import {
  extractFrontmatter,
  inspectTar,
  skillChecksum,
  toTar,
  validateSkillArchive,
} from "@companion/skills";
import { getServerSupabase } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * POST /api/skills/upload — the write path (the "service layer").
 *  action=validate  -> run the metadata-only validator, return the checklist.
 *  action=publish   -> validate, upload the archive to Storage, call the atomic
 *                      publish_skill_version RPC (immutable, monotonic).
 * The control plane never executes any script in the archive.
 */
export async function POST(req: Request) {
  const supabase = await getServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  const form = await req.formData();
  const action = String(form.get("action") ?? "validate");
  const file = form.get("file");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());

  const result = await validateSkillArchive(buffer);

  if (action === "validate") {
    return NextResponse.json({ result });
  }

  // --- publish ---
  if (!result.ok || !result.frontmatter) {
    return NextResponse.json(
      { error: result.error ?? "Package failed validation", result },
      { status: 400 },
    );
  }
  const fm = result.frontmatter;
  const scope = String(form.get("scope") ?? fm.scope ?? "private");
  const teamSlug = scope === "team" ? String(form.get("team") ?? "").trim() : null;
  if (scope === "team" && !teamSlug) {
    return NextResponse.json({ error: "team scope requires a team slug" }, { status: 400 });
  }

  // Derive the tenant for the storage path.
  const { data: mem } = await supabase.from("memberships").select("org_id").limit(1).maybeSingle();
  const orgId = mem?.org_id as string | undefined;
  if (!orgId) return NextResponse.json({ error: "No organization membership" }, { status: 403 });

  // Canonical checksum + the raw frontmatter to freeze on the version.
  let tar: Buffer;
  try {
    tar = toTar(buffer);
  } catch {
    return NextResponse.json({ error: "Archive could not be read" }, { status: 400 });
  }
  const checksum = skillChecksum(tar);
  const finding = await inspectTar(tar);
  const rawFrontmatter = finding.skillMd ? (extractFrontmatter(finding.skillMd).raw ?? "") : "";
  const storagePath = `${orgId}/${fm.name}/${fm.version}.tar.gz`;

  const upload = await supabase.storage
    .from("skill-archives")
    .upload(storagePath, buffer, { contentType: "application/gzip", upsert: false });
  if (upload.error && !/exists|duplicate/i.test(upload.error.message)) {
    return NextResponse.json({ error: `Storage upload failed: ${upload.error.message}` }, { status: 400 });
  }

  const { data: version, error: rpcError } = await supabase.rpc("publish_skill_version", {
    p_slug: fm.name,
    p_scope: scope,
    p_team_slug: teamSlug,
    p_version: fm.version,
    p_description: fm.description,
    p_checksum: checksum,
    p_storage_path: storagePath,
    p_size: buffer.length,
    p_frontmatter: rawFrontmatter,
    p_tools: fm.tools,
    p_license: fm.license ?? null,
    p_note: "Uploaded via web",
  });
  if (rpcError) {
    return NextResponse.json({ error: rpcError.message }, { status: 400 });
  }

  return NextResponse.json({ ok: true, version });
}
