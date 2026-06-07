import { createClient } from "@supabase/supabase-js";
import { SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL } from "./env";

/**
 * Service-role client — SERVER ONLY, never import into a client component. Used for
 * narrow trusted operations such as minting signed download URLs after the request has
 * already passed the RLS visibility check with the user's client.
 */
export function getAdminSupabase() {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
