import "server-only";
import { cookies } from "next/headers";
import type { OrgSummary } from "@companion/contracts";
import type { OrgVM } from "./types";
import { serverApiFetch } from "./apiServer";

export const CURRENT_ORG_COOKIE = "companion_org";

function toOrgVM(s: OrgSummary): OrgVM {
  return {
    id: s.org_id,
    name: s.name,
    slug: s.slug,
    kind: s.kind,
    plan: s.plan,
    myRole: s.org_role,
    color: s.color ?? null,
    logoUrl: s.logo_url ?? null,
  };
}

export async function loadOrgContext(): Promise<{ orgs: OrgVM[]; current: OrgVM | null }> {
  const orgs = (await serverApiFetch<OrgSummary[]>("/v1/orgs")).map(toOrgVM);
  if (orgs.length === 0) return { orgs, current: null };
  const wanted = (await cookies()).get(CURRENT_ORG_COOKIE)?.value ?? null;
  const current = orgs.find((o) => o.id === wanted) ?? orgs[0]!;
  return { orgs, current };
}
