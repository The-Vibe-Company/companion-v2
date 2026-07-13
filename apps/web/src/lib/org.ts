"use client";

import type { ApiTokenRow, IssuedToken, OrgRole, TokenScope } from "@companion/contracts";
import { apiFetch } from "./apiClient";

export async function setCurrentOrg(orgId: string): Promise<void> {
  await apiFetch("/v1/orgs/current", {
    method: "POST",
    body: JSON.stringify({ orgId }),
  });
}

export async function createOrg(name: string, kind: "personal" | "team"): Promise<{ id: string; slug: string }> {
  return apiFetch("/v1/orgs", {
    method: "POST",
    body: JSON.stringify({ name, kind }),
  });
}

export async function inviteMember(_orgId: string, email: string, role: OrgRole, acknowledgeSeatBilling = false): Promise<{ token: string }> {
  const safeRole = role === "owner" ? "admin" : role;
  return apiFetch("/v1/invitations", {
    method: "POST",
    body: JSON.stringify({ email, role: safeRole, acknowledgeSeatBilling }),
  });
}

export async function revokeInvite(inviteId: string): Promise<void> {
  await apiFetch(`/v1/invitations/${inviteId}`, { method: "DELETE" });
}

export async function acceptInvite(token: string): Promise<{ orgId: string }> {
  return apiFetch("/v1/invitations/accept", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

export async function setMemberRole(_orgId: string, userId: string, role: OrgRole): Promise<void> {
  await apiFetch(`/v1/orgs/current/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export async function removeMember(_orgId: string, userId: string): Promise<void> {
  await apiFetch(`/v1/orgs/current/members/${userId}`, { method: "DELETE" });
}

export async function leaveOrg(_orgId: string): Promise<void> {
  throw new Error("Leaving orgs is not implemented in the greenfield API yet");
}

export function inviteLink(token: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  return `${base}/join/${token}`;
}

/** Rename the signed-in user. Mirrors `PUT /v1/users/me`. */
export async function updateMe(name: string): Promise<{ id: string; name: string; initials: string }> {
  return apiFetch("/v1/users/me", {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
}

/** Upload (or replace) the signed-in user's avatar. Mirrors `POST /v1/users/me/avatar`. */
export async function uploadUserAvatar(file: File): Promise<{ avatarUrl: string | null }> {
  const fd = new FormData();
  fd.append("file", file);
  return apiFetch("/v1/users/me/avatar", { method: "POST", body: fd });
}

/** Remove the signed-in user's custom avatar (revert to Gravatar / initials). Mirrors `DELETE /v1/users/me/avatar`. */
export async function removeUserAvatar(): Promise<{ avatarUrl: string | null }> {
  return apiFetch("/v1/users/me/avatar", { method: "DELETE" });
}

/**
 * Rename and/or re-slug the current workspace. Mirrors `PUT /v1/orgs/current`.
 * Returns the server-normalized values so the caller can reconcile (the server slugifies).
 */
export async function updateOrg(
  patch: {
    name?: string;
    slug?: string;
    color?: string | null;
    logoUrl?: string | null;
    skillNamingPolicy?: string | null;
  },
): Promise<{
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  domainAutoJoin: boolean;
  color: string | null;
  logoUrl: string | null;
  skillNamingPolicy: string | null;
}> {
  return apiFetch("/v1/orgs/current", {
    method: "PUT",
    body: JSON.stringify(patch),
  });
}

export async function addAccessDomain(domain: string, acknowledgeSeatBilling = false): Promise<{ id: string; domain: string; createdAt: string }> {
  return apiFetch("/v1/orgs/current/domains", {
    method: "POST",
    body: JSON.stringify({ domain, acknowledgeSeatBilling }),
  });
}

export async function startBillingCheckout(): Promise<{ url: string }> {
  return apiFetch("/v1/billing/checkout", { method: "POST" });
}

export async function openBillingPortal(): Promise<{ url: string }> {
  return apiFetch("/v1/billing/portal", { method: "POST" });
}

export async function removeAccessDomain(domainId: string): Promise<void> {
  await apiFetch(`/v1/orgs/current/domains/${domainId}`, { method: "DELETE" });
}

/** Upload a workspace logo image. Mirrors `POST /v1/orgs/current/logo`. */
export async function uploadWorkspaceLogo(file: File): Promise<{
  id: string;
  name: string;
  slug: string;
  domain: string | null;
  domainAutoJoin: boolean;
  color: string | null;
  logoUrl: string | null;
}> {
  const fd = new FormData();
  fd.append("file", file);
  return apiFetch("/v1/orgs/current/logo", { method: "POST", body: fd });
}

/** List the signed-in user's personal access tokens. Mirrors `GET /v1/tokens`. */
export async function listTokens(): Promise<ApiTokenRow[]> {
  return apiFetch("/v1/tokens");
}

/** Issue a new personal access token. Returns the one-time plaintext `token`. */
export async function issueToken(input: { name: string; scopes: TokenScope[] }): Promise<IssuedToken> {
  return apiFetch("/v1/tokens", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

/** Revoke a personal access token. Mirrors `DELETE /v1/tokens/:id`. */
export async function revokeToken(id: string): Promise<void> {
  await apiFetch(`/v1/tokens/${id}`, { method: "DELETE" });
}
