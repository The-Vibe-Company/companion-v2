/**
 * Team visibility is enforced by Postgres RLS, so the only honest test is against a live
 * Supabase: sign in as the seeded users and assert what each can see. Skips automatically
 * if a local Supabase (with the seed) is not reachable.
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

async function teamScopedSkills(sb: SupabaseClient): Promise<string[]> {
  const { data, error } = await sb.from("skill_list_v").select("slug").eq("scope", "team");
  if (error) throw new Error(error.message);
  return (data ?? []).map((r: { slug: string }) => r.slug).sort();
}

async function allSlugs(sb: SupabaseClient): Promise<string[]> {
  const { data } = await sb.from("skill_list_v").select("slug");
  return (data ?? []).map((r: { slug: string }) => r.slug).sort();
}

const PLATFORM_TEAM_SKILLS = [
  "granite-recall",
  "jira-triage",
  "k8s-logs",
  "markdown-lint",
  "openapi-client",
  "repo-review",
];

describe.skipIf(!reachable)("team RLS visibility (live supabase)", () => {
  it("alice (Platform) sees only platform team-scoped skills", async () => {
    const sb = await signIn("alice@acme.test", "password");
    expect(await teamScopedSkills(sb)).toEqual(PLATFORM_TEAM_SKILLS);
  });

  it("priya (Data) sees only data team-scoped skills", async () => {
    const sb = await signIn("priya@acme.test", "password");
    expect(await teamScopedSkills(sb)).toEqual(["sql-query"]);
  });

  it("sara (Support) sees only support team-scoped skills", async () => {
    const sb = await signIn("sara@acme.test", "password");
    expect(await teamScopedSkills(sb)).toEqual(["email-draft", "slack-digest"]);
  });

  it("a member sees public + their teams + their own, but NOT other teams' or the whole org", async () => {
    const sb = await signIn("alice@acme.test", "password");
    const visible = await allSlugs(sb);
    expect(visible).not.toContain("sql-query"); // data team skill
    expect(visible).not.toContain("email-draft"); // support team skill
    expect(visible).not.toContain("csv-profile"); // priya's private skill
    expect(visible).toContain("jira-triage"); // her own team
    expect(visible).toContain("pdf-extract"); // public
    expect(visible).toContain("web-fetch"); // public
  });

  it("the org owner respects the team boundary (sees only their own team's skills)", async () => {
    // admin@tvc.dev is on Platform only — even as org owner there is no override.
    const sb = await signIn("admin@tvc.dev", "adminadmin");
    expect(await teamScopedSkills(sb)).toEqual(PLATFORM_TEAM_SKILLS);
  });
});

describe.skipIf(reachable)("team RLS visibility (skipped — no local supabase)", () => {
  it("start supabase + db reset to run the live RLS tests", () => {
    expect(reachable).toBe(false);
  });
});
