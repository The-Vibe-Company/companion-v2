import type { CookieOptionsWithName } from "@supabase/ssr";
import { SUPABASE_URL } from "./env";

export function authCookieName(supabaseUrl: string) {
  try {
    const url = new URL(supabaseUrl);
    const host = url.hostname.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "");
    const port = url.port ? `-${url.port}` : "";
    const name = `companion-auth-${host}${port}`.toLowerCase().replace(/-+/g, "-");
    return name || "companion-auth-local";
  } catch {
    return "companion-auth-local";
  }
}

export const supabaseCookieOptions: CookieOptionsWithName = {
  name: authCookieName(SUPABASE_URL),
};
