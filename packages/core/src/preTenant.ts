import { sql } from "drizzle-orm";
import type { Db } from "@companion/db";
import type { OrgRole } from "@companion/contracts";

/**
 * Narrow PostgreSQL RPCs for lookups that necessarily happen before an organization can be selected.
 *
 * The application login is deliberately NOBYPASSRLS. Calling tenant tables directly without
 * `app.org_id` would therefore return no rows for login, PAT/share/invite discovery or billing work
 * discovery. Each function below delegates only the minimum cross-tenant lookup to a SECURITY
 * DEFINER function installed by migration 0034. Bootstrap writes use an explicit tenant context and
 * ordinary RLS policies.
 */

function resultRows<T>(result: unknown): T[] {
  return Array.from(result as Iterable<T>);
}

export interface PreTenantOrganizationRow {
  org_id: string;
  name: string;
  slug: string;
  kind: "personal" | "team";
  org_role: OrgRole;
  color: string | null;
  logo_url: string | null;
  member_count: number | string;
}

export async function listPreTenantOrganizations(database: Db, userId: string): Promise<PreTenantOrganizationRow[]> {
  const result = await database.execute(sql`
    select * from companion_list_user_orgs(${userId})
  `);
  return resultRows<PreTenantOrganizationRow>(result);
}

export async function preTenantUsersShareOrganization(
  database: Db,
  actorId: string,
  targetId: string,
): Promise<boolean> {
  const result = await database.execute(sql`
    select companion_users_share_org(${actorId}, ${targetId}) as shared
  `);
  return resultRows<{ shared: boolean }>(result)[0]?.shared ?? false;
}

export interface PreTenantJoinableOrganizationRow {
  org_id: string;
  name: string;
  domain: string;
  member_count: number | string;
}

export async function listPreTenantJoinableOrganizations(
  database: Db,
  userId: string,
): Promise<PreTenantJoinableOrganizationRow[]> {
  const result = await database.execute(sql`
    select * from companion_list_joinable_orgs(${userId})
  `);
  return resultRows<PreTenantJoinableOrganizationRow>(result);
}

export async function lockPreTenantInvitation(input: {
  database: Db;
  userId: string;
  token: string;
}): Promise<{ inviteId: string; orgId: string; orgRole: OrgRole } | null> {
  const result = await input.database.execute(sql`
    select
      invitation."invite_id"::text as "inviteId",
      invitation."org_id"::text as "orgId",
      invitation."org_role" as "orgRole"
    from companion_lock_invitation_for_actor(
      ${input.userId},
      ${input.token}
    ) as invitation
  `);
  return resultRows<{ inviteId: string; orgId: string; orgRole: OrgRole }>(result)[0] ?? null;
}

export interface PreTenantApiTokenRow {
  org_id: string;
  user_id: string;
  scopes: unknown;
  email: string;
  name: string;
}

export async function resolvePreTenantApiToken(
  database: Db,
  tokenHash: string,
): Promise<PreTenantApiTokenRow | null> {
  const result = await database.execute(sql`
    select * from companion_resolve_api_token(${tokenHash})
  `);
  return resultRows<PreTenantApiTokenRow>(result)[0] ?? null;
}

export interface PreTenantRefreshableApiTokenRow {
  token_id: string;
  org_id: string;
  user_id: string;
  token_name: string;
  scopes: unknown;
  expires_at: string;
  is_expired: boolean;
}

/**
 * Lock a PAT for the dedicated refresh flow before a tenant is known.
 *
 * The SECURITY DEFINER function applies the fixed 30-day recovery window, rejects revoked tokens
 * and departed users, and never returns the token hash. Its row lock remains held by the caller's
 * transaction so only one concurrent request can replace an expired token.
 */
export async function lockPreTenantApiTokenForRefresh(
  database: Db,
  tokenHash: string,
): Promise<PreTenantRefreshableApiTokenRow | null> {
  const result = await database.execute(sql`
    select * from companion_lock_api_token_for_refresh(${tokenHash})
  `);
  return resultRows<PreTenantRefreshableApiTokenRow>(result)[0] ?? null;
}

export interface PreTenantSkillPreviewRow {
  slug: string;
  display_name: string | null;
  description: string;
  creator_name: string;
  creator_initials: string;
  current_version: string;
  frontmatter: string;
  updated_at: string;
}

export async function getPreTenantSkillPreview(
  database: Db,
  token: string,
): Promise<PreTenantSkillPreviewRow | null> {
  const result = await database.execute(sql`
    select * from companion_public_skill_preview(${token})
  `);
  return resultRows<PreTenantSkillPreviewRow>(result)[0] ?? null;
}

export async function getPreTenantSkillShareTarget(
  database: Db,
  token: string,
  userId: string,
): Promise<{ org_id: string; slug: string } | null> {
  const result = await database.execute(sql`
    select target."org_id"::text as "org_id", target."slug"
    from companion_skill_share_target(${token}, ${userId}) as target
  `);
  return resultRows<{ org_id: string; slug: string }>(result)[0] ?? null;
}

export async function resolvePreTenantBillingOrganization(
  database: Db,
  input: { subscriptionId?: string | null; customerId?: string | null },
): Promise<string | null> {
  const result = await database.execute(sql`
    select companion_billing_org_for_stripe_event(
      ${input.subscriptionId ?? null},
      ${input.customerId ?? null}
    )::text as "orgId"
  `);
  return resultRows<{ orgId: string | null }>(result)[0]?.orgId ?? null;
}

export async function listPreTenantBillingSyncCandidates(
  database: Db,
  input: { now: Date; full: boolean; limit: number },
): Promise<string[]> {
  const result = await database.execute(sql`
    select candidate."org_id"::text as "orgId"
    from companion_list_billing_sync_candidates(
      ${input.now.toISOString()}::timestamptz,
      ${input.full},
      ${input.limit}
    ) as candidate
  `);
  return resultRows<{ orgId: string }>(result).map((row) => row.orgId);
}
