/**
 * The org/team/membership management RPCs are SECURITY DEFINER and enforce the real
 * capability gates + guards (last-owner, only-owner-touches-owner, invite email-match).
 * The only honest test is against a live Supabase with the seed: sign in as the seeded
 * users and assert each guard. Skips automatically if a local Supabase is not reachable.
 *
 *   supabase start && supabase db reset    # then: pnpm --filter @companion/web test
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

function loadEnv(): { url?: string; anon?: string } {
  let url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  let anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    try {
      const p = fileURLToPath(new URL("../.env.local", import.meta.url));
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_]+)=(.*)$/);
        if (!m) continue;
        if (m[1] === "NEXT_PUBLIC_SUPABASE_URL") url = url || m[2];
        if (m[1] === "NEXT_PUBLIC_SUPABASE_ANON_KEY") anon = anon || m[2];
      }
    } catch {
      // no .env.local
    }
  }
  return { url, anon };
}

const { url, anon } = loadEnv();
let reachable = false;
if (url && anon) {
  try {
    const r = await fetch(`${url}/auth/v1/health`, { headers: { apikey: anon } });
    reachable = r.ok;
  } catch {
    reachable = false;
  }
}

async function signIn(email: string, password: string): Promise<SupabaseClient> {
  const sb = createClient(url as string, anon as string, { auth: { persistSession: false } });
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`sign-in failed for ${email}: ${error.message}`);
  return sb;
}

// Seeded ids (supabase/seed.sql).
const ACME = "11111111-1111-1111-1111-111111111111";
const ADMIN_ID = "333333aa-3333-3333-3333-3333333333a0"; // org owner
const SEED_INVITE_TOKEN = "seedtoken00000000000000000000000000000000000000000000000000acme"; // newhire@acme.test

describe.skipIf(!reachable)("org management RPC guards (live supabase)", () => {
  it("a developer cannot invite members", async () => {
    const sb = await signIn("alice@acme.test", "password");
    const { error } = await sb.rpc("invite_member", {
      p_org: ACME,
      p_email: "nope@acme.test",
      p_role: "developer",
    });
    expect(error?.message ?? "").toMatch(/insufficient role/i);
  });

  it("a developer cannot change member roles", async () => {
    const sb = await signIn("alice@acme.test", "password");
    const { error } = await sb.rpc("set_member_role", {
      p_org: ACME,
      p_user: ADMIN_ID,
      p_role: "developer",
    });
    expect(error?.message ?? "").toMatch(/insufficient role/i);
  });

  it("a developer cannot create a team", async () => {
    const sb = await signIn("alice@acme.test", "password");
    const { error } = await sb.rpc("create_team", { p_org: ACME, p_name: "Should Fail" });
    expect(error?.message ?? "").toMatch(/insufficient role/i);
  });

  it("the last owner cannot be demoted", async () => {
    const sb = await signIn("admin@tvc.dev", "adminadmin");
    const { error } = await sb.rpc("set_member_role", {
      p_org: ACME,
      p_user: ADMIN_ID,
      p_role: "developer",
    });
    expect(error?.message ?? "").toMatch(/last owner/i);
  });

  it("an invite cannot be accepted by a different email", async () => {
    // The seeded invite is for newhire@acme.test; alice redeeming it must be rejected.
    const sb = await signIn("alice@acme.test", "password");
    const { error } = await sb.rpc("accept_invite", { p_token: SEED_INVITE_TOKEN });
    expect(error?.message ?? "").toMatch(/different email/i);
  });

  it("an owner can create a team and becomes its admin", async () => {
    const sb = await signIn("admin@tvc.dev", "adminadmin");
    const { data, error } = await sb.rpc("create_team", { p_org: ACME, p_name: "RLS Probe Team" });
    expect(error).toBeFalsy();
    const team = data as { id?: string; slug?: string } | null;
    expect(team?.slug).toBeTruthy();
    // Cleanup so repeated local runs stay clean (no skills attached → delete is allowed).
    if (team?.id) await sb.rpc("delete_team", { p_team: team.id });
  });
});

describe.skipIf(reachable)("org management RPC guards (skipped — no local supabase)", () => {
  it("start supabase + db reset to run the live management-RPC tests", () => {
    expect(reachable).toBe(false);
  });
});
