import type {
  Companion,
  CompanionPluginAccount,
  CompanionPluginsResponse,
  CompanionProviderConnection,
  CompanionProvidersResponse,
  CompanionShareRole,
  CompanionShares,
  CompanionThread,
  SaveCompanionProviderInput,
  SaveCompanionPluginInput,
} from "@companion/contracts";
import { apiFetch } from "./apiClient";

function orgHeaders(orgId: string): HeadersInit {
  return { "x-companion-org": orgId };
}

export async function createCompanion(
  orgId: string,
  input: { name: string; persona?: string; provider_id: string },
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>("/v1/companions", {
    method: "POST",
    headers: orgHeaders(orgId),
    body: JSON.stringify(input),
  });
  return result.companion;
}

export async function saveCompanionPlugin(
  orgId: string,
  input: SaveCompanionPluginInput,
): Promise<CompanionPluginAccount> {
  const result = await apiFetch<{ account: CompanionPluginAccount }>("/v1/companion-plugins", {
    method: "POST",
    headers: orgHeaders(orgId),
    body: JSON.stringify(input),
  });
  return result.account;
}

export async function deleteCompanionPlugin(orgId: string, accountId: string): Promise<void> {
  await apiFetch(`/v1/companion-plugins/${encodeURIComponent(accountId)}`, {
    method: "DELETE",
    headers: orgHeaders(orgId),
  });
}

export async function saveCompanionProvider(
  orgId: string,
  providerId: string,
  input: SaveCompanionProviderInput,
): Promise<CompanionProviderConnection> {
  const result = await apiFetch<{ connection: CompanionProviderConnection }>(
    `/v1/companion-providers/${encodeURIComponent(providerId)}`,
    {
      method: "PUT",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.connection;
}

export async function deleteCompanionProvider(orgId: string, providerId: string): Promise<void> {
  await apiFetch(`/v1/companion-providers/${encodeURIComponent(providerId)}`, {
    method: "DELETE",
    headers: orgHeaders(orgId),
  });
}

export async function setDefaultCompanionProvider(
  orgId: string,
  providerId: string,
): Promise<void> {
  await apiFetch("/v1/companion-providers/default", {
    method: "PUT",
    headers: orgHeaders(orgId),
    body: JSON.stringify({ provider_id: providerId }),
  });
}

export async function setCompanionProvider(
  orgId: string,
  companionId: string,
  providerId: string,
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/provider`,
    {
      method: "PUT",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ provider_id: providerId }),
    },
  );
  return result.companion;
}

export async function getCompanionShares(
  orgId: string,
  companionId: string,
): Promise<CompanionShares> {
  const result = await apiFetch<{ shares: CompanionShares }>(
    `/v1/companions/${encodeURIComponent(companionId)}/shares`,
    { headers: orgHeaders(orgId) },
  );
  return result.shares;
}

export async function setCompanionWorkspaceShare(
  orgId: string,
  companionId: string,
  role: CompanionShareRole | null,
): Promise<CompanionShares> {
  const result = await apiFetch<{ shares: CompanionShares }>(
    `/v1/companions/${encodeURIComponent(companionId)}/shares/workspace`,
    {
      method: "PUT",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ role }),
    },
  );
  return result.shares;
}

export async function inviteCompanionMember(
  orgId: string,
  companionId: string,
  email: string,
  role: CompanionShareRole,
): Promise<CompanionShares> {
  const result = await apiFetch<{ shares: CompanionShares }>(
    `/v1/companions/${encodeURIComponent(companionId)}/shares/members`,
    {
      method: "PUT",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ email, role }),
    },
  );
  return result.shares;
}

export async function updateCompanionMemberRole(
  orgId: string,
  companionId: string,
  userId: string,
  role: CompanionShareRole,
): Promise<CompanionShares> {
  const result = await apiFetch<{ shares: CompanionShares }>(
    `/v1/companions/${encodeURIComponent(companionId)}/shares/members/${encodeURIComponent(userId)}`,
    {
      method: "PATCH",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ role }),
    },
  );
  return result.shares;
}

export async function revokeCompanionMember(
  orgId: string,
  companionId: string,
  userId: string,
): Promise<CompanionShares> {
  const result = await apiFetch<{ shares: CompanionShares }>(
    `/v1/companions/${encodeURIComponent(companionId)}/shares/members/${encodeURIComponent(userId)}`,
    { method: "DELETE", headers: orgHeaders(orgId) },
  );
  return result.shares;
}

export async function getCompanionThread(
  orgId: string,
  companionId: string,
): Promise<CompanionThread> {
  const result = await apiFetch<{ thread: CompanionThread }>(
    `/v1/companions/${encodeURIComponent(companionId)}/thread`,
    { headers: orgHeaders(orgId) },
  );
  return result.thread;
}

export async function sendCompanionMessage(
  orgId: string,
  companionId: string,
  content: string,
): Promise<CompanionThread> {
  const result = await apiFetch<{ thread: CompanionThread }>(
    `/v1/companions/${encodeURIComponent(companionId)}/messages`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ content }),
    },
  );
  return result.thread;
}

/** Hands pending messages to Pi and projects new Pi events; only Owner/Editor may call it. */
export async function syncCompanionThread(
  orgId: string,
  companionId: string,
): Promise<CompanionThread> {
  const result = await apiFetch<{ thread: CompanionThread }>(
    `/v1/companions/${encodeURIComponent(companionId)}/thread/sync`,
    { method: "POST", headers: orgHeaders(orgId), body: "{}" },
  );
  return result.thread;
}

export async function startCompanionRuntime(
  orgId: string,
  companionId: string,
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/runtime/start`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ client_surface: "web" }),
    },
  );
  return result.companion;
}

export type { CompanionProvidersResponse };
export type { CompanionPluginsResponse };
