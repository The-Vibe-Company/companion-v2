import { isCancel, password as passwordPrompt, text } from "@clack/prompts";
import { createClient } from "@supabase/supabase-js";
import { getProfileConfig, saveProfileConfig } from "../lib/config";
import { clearSession, saveSession } from "../lib/session";
import { getClient } from "../lib/client";
import { CliError } from "../lib/errors";
import { emitJson, out, type GlobalOpts } from "../lib/output";

async function promptText(message: string): Promise<string> {
  const v = await text({ message });
  if (isCancel(v) || !v) throw new CliError("cancelled", 2);
  return String(v);
}
async function promptPassword(message: string): Promise<string> {
  const v = await passwordPrompt({ message });
  if (isCancel(v) || !v) throw new CliError("cancelled", 2);
  return String(v);
}

export interface LoginOpts {
  url?: string;
  anonKey?: string;
  email?: string;
  password?: string;
}

export async function login(opts: LoginOpts, g: GlobalOpts): Promise<void> {
  let url = opts.url ?? process.env.COMPANION_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  let anonKey =
    opts.anonKey ??
    process.env.COMPANION_SUPABASE_ANON_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    try {
      const existing = await getProfileConfig(g.profile);
      url = url ?? existing.url;
      anonKey = anonKey ?? existing.anonKey;
    } catch {
      // no existing config
    }
  }
  if (!url || !anonKey) {
    throw new CliError("provide --url and --anon-key (from `supabase start`) on first login", 2);
  }
  await saveProfileConfig(g.profile, { url, anonKey });

  const email = opts.email ?? (await promptText("Email"));
  const pw = opts.password ?? (await promptPassword("Password"));

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await supabase.auth.signInWithPassword({ email, password: pw });
  if (error || !data.session || !data.user) {
    throw new CliError(`login failed: ${error?.message ?? "unknown error"}`, 3);
  }
  await saveSession(g.profile, {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email ?? email },
  });

  if (g.json) emitJson({ ok: true, user: { id: data.user.id, email: data.user.email } });
  else out(`logged in as ${data.user.email}`);
}

export async function logout(g: GlobalOpts): Promise<void> {
  await clearSession(g.profile);
  if (g.json) emitJson({ ok: true });
  else out("logged out");
}

export async function whoami(g: GlobalOpts): Promise<void> {
  const { supabase, email, userId } = await getClient(g.profile);
  const { data: mem } = await supabase
    .from("memberships")
    .select("org_role, organizations(name, slug)")
    .limit(1)
    .maybeSingle();
  const org = (mem?.organizations ?? null) as { name?: string; slug?: string } | null;
  const role = (mem as { org_role?: string } | null)?.org_role ?? null;
  if (g.json) {
    emitJson({ userId, email, org, role });
  } else {
    out(`user   ${email}`);
    out(`id     ${userId}`);
    out(`org    ${org?.slug ?? "-"} (${org?.name ?? "-"})`);
    out(`role   ${role ?? "-"}`);
  }
}
