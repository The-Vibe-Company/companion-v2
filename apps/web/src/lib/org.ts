"use client";

import type { OrgRole, TeamRole } from "@companion/contracts";
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

export async function inviteMember(_orgId: string, email: string, role: OrgRole): Promise<{ token: string }> {
  const safeRole = role === "owner" ? "admin" : role;
  return apiFetch("/v1/invitations", {
    method: "POST",
    body: JSON.stringify({ email, role: safeRole }),
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

export async function createTeam(_orgId: string, name: string): Promise<{ id: string; slug: string }> {
  return apiFetch("/v1/teams", {
    method: "POST",
    body: JSON.stringify({ name }),
  });
}

export async function addTeamMember(
  _orgId: string,
  teamId: string,
  userId: string,
  role: TeamRole,
): Promise<void> {
  await apiFetch(`/v1/teams/${teamId}/members`, {
    method: "POST",
    body: JSON.stringify({ userId, role }),
  });
}

export async function setTeamMemberRole(teamId: string, userId: string, role: TeamRole): Promise<void> {
  await apiFetch(`/v1/teams/${teamId}/members/${userId}`, {
    method: "PATCH",
    body: JSON.stringify({ role }),
  });
}

export async function removeTeamMember(teamId: string, userId: string): Promise<void> {
  await apiFetch(`/v1/teams/${teamId}/members/${userId}`, { method: "DELETE" });
}

export function inviteLink(token: string): string {
  const base = typeof window !== "undefined" ? window.location.origin : "";
  return `${base}/join/${token}`;
}
