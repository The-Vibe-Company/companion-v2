"use client";

import type { OrgRole, TeamRole } from "@companion/contracts";
import { getBrowserSupabase } from "./supabase/client";

/**
 * Client wrappers for the org/team/membership/invitation RPCs. Mirrors lib/queries.ts:
 * every mutation is a SECURITY DEFINER RPC that enforces the real capability gate + guards
 * server-side; these just call it and surface the error message. Callers update optimistic
 * state then router.refresh() (or refresh-only) — see the org components.
 */

const db = () => getBrowserSupabase();
function ok(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

/* ---- Current org (a cookie, not an RPC) ----------------------------------- */
/** Switch the active workspace; the server reads the cookie on the next render. */
export async function setCurrentOrg(orgId: string): Promise<void> {
  const res = await fetch("/api/org", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ orgId }),
  });
  if (!res.ok) throw new Error("Could not switch workspace");
}

/* ---- Org lifecycle -------------------------------------------------------- */
export async function createOrg(name: string, kind: "personal" | "team"): Promise<{ id: string; slug: string }> {
  const { data, error } = await db().rpc("create_org", { p_name: name, p_kind: kind });
  ok(error);
  const r = (data ?? {}) as Record<string, unknown>;
  return { id: String(r.id), slug: String(r.slug) };
}

/* ---- Members -------------------------------------------------------------- */
export async function inviteMember(orgId: string, email: string, role: OrgRole): Promise<{ token: string }> {
  const { data, error } = await db().rpc("invite_member", { p_org: orgId, p_email: email, p_role: role });
  ok(error);
  return { token: String((data as Record<string, unknown>)?.token ?? "") };
}
export async function revokeInvite(inviteId: string): Promise<void> {
  const { error } = await db().rpc("revoke_invite", { p_invite: inviteId });
  ok(error);
}
export async function acceptInvite(token: string): Promise<{ orgId: string }> {
  const { data, error } = await db().rpc("accept_invite", { p_token: token });
  ok(error);
  return { orgId: String((data as Record<string, unknown>)?.org_id ?? "") };
}
export async function setMemberRole(orgId: string, userId: string, role: OrgRole): Promise<void> {
  const { error } = await db().rpc("set_member_role", { p_org: orgId, p_user: userId, p_role: role });
  ok(error);
}
export async function removeMember(orgId: string, userId: string): Promise<void> {
  const { error } = await db().rpc("remove_member", { p_org: orgId, p_user: userId });
  ok(error);
}
export async function leaveOrg(orgId: string): Promise<void> {
  const { error } = await db().rpc("leave_org", { p_org: orgId });
  ok(error);
}

/* ---- Teams ---------------------------------------------------------------- */
export async function createTeam(orgId: string, name: string): Promise<{ id: string; slug: string }> {
  const { data, error } = await db().rpc("create_team", { p_org: orgId, p_name: name });
  ok(error);
  const r = (data ?? {}) as Record<string, unknown>;
  return { id: String(r.id), slug: String(r.slug) };
}
export async function addTeamMember(orgId: string, teamId: string, userId: string, role: TeamRole): Promise<void> {
  const { error } = await db().rpc("add_team_member", { p_org: orgId, p_team: teamId, p_user: userId, p_role: role });
  ok(error);
}
export async function setTeamMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
  const { error } = await db().rpc("set_team_member_role", { p_team: teamId, p_user: userId, p_role: role });
  ok(error);
}
export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  const { error } = await db().rpc("remove_team_member", { p_team: teamId, p_user: userId });
  ok(error);
}

/** The join URL an admin copies for a pending invite. */
export function inviteLink(token: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  return `${base}/join/${token}`;
}
