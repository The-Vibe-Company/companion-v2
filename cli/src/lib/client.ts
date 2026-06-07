import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getProfileConfig } from "./config";
import { loadSession, saveSession } from "./session";
import { CliError } from "./errors";

export interface AuthedClient {
  supabase: SupabaseClient;
  userId: string;
  email: string;
  url: string;
}

/** A Supabase client bound to the stored user session (refreshing tokens as needed). */
export async function getClient(profile: string): Promise<AuthedClient> {
  const { url, anonKey } = await getProfileConfig(profile);
  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const session = await loadSession(profile);
  if (!session) throw new CliError("not logged in. Run: companion login", 3);

  const { data, error } = await supabase.auth.setSession({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  });
  if (error || !data.session || !data.user) {
    throw new CliError("session expired. Run: companion login", 3);
  }
  await saveSession(profile, {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    expires_at: data.session.expires_at,
    user: { id: data.user.id, email: data.user.email ?? "" },
  });
  return { supabase, userId: data.user.id, email: data.user.email ?? "", url };
}

/** The acting user's organization id (the registry tenant). */
export async function getOrgId(supabase: SupabaseClient): Promise<string> {
  const { data } = await supabase.from("memberships").select("org_id").limit(1).maybeSingle();
  const orgId = (data as { org_id?: string } | null)?.org_id;
  if (!orgId) throw new CliError("no organization membership", 7);
  return orgId;
}
