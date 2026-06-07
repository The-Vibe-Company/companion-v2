import "server-only";
import { cookies } from "next/headers";
import type { OrgSummary } from "@companion/contracts";
import type { getServerSupabase } from "./supabase/server";
import type { OrgVM } from "./types";

/** Cookie holding the active workspace id. Read by server components, set by /api/org. */
export const CURRENT_ORG_COOKIE = "companion_org";

type ServerSupabase = Awaited<ReturnType<typeof getServerSupabase>>;

function toOrgVM(s: OrgSummary): OrgVM {
  return { id: s.org_id, name: s.name, slug: s.slug, kind: s.kind, plan: s.plan, myRole: s.org_role };
}

/**
 * Resolve the caller's orgs (via my_orgs RPC) and the active one: the cookie's org if the
 * user is still a member, else the earliest membership. Returns current=null when the user
 * belongs to no org (first-run onboarding).
 */
export async function loadOrgContext(
  supabase: ServerSupabase,
): Promise<{ orgs: OrgVM[]; current: OrgVM | null }> {
  const { data } = await supabase.rpc("my_orgs");
  const orgs = ((data ?? []) as OrgSummary[]).map(toOrgVM);
  if (orgs.length === 0) return { orgs, current: null };
  const wanted = (await cookies()).get(CURRENT_ORG_COOKIE)?.value ?? null;
  const current = orgs.find((o) => o.id === wanted) ?? orgs[0]!; // length checked above
  return { orgs, current };
}
