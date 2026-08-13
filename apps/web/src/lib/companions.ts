import type {
  Companion,
  CompanionDesktop,
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
    // Fail closed before a stuck proxy leaves the dialog spinning.
    signal: AbortSignal.timeout(10_000),
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

/**
 * Runtime read. The default is the control-plane projection, so it is safe after a failed wake and
 * for a Viewer. `live` observes the Box an Owner or Editor already runs; it never resumes one, so a
 * status read cannot become a wake.
 */
export async function getCompanionRuntime(
  orgId: string,
  companionId: string,
  options: { live?: boolean } = {},
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/runtime${options.live ? "?live=true" : ""}`,
    { headers: orgHeaders(orgId) },
  );
  return result.companion;
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

/**
 * Owner/Editor computer use: one handoff to the Box desktop Lux drives. The request observes a Box
 * that is already running and never resumes one, and the returned URL is used immediately instead of
 * being kept anywhere.
 */
export async function openCompanionDesktop(
  orgId: string,
  companionId: string,
): Promise<CompanionDesktop> {
  return apiFetch<CompanionDesktop>(
    `/v1/companions/${encodeURIComponent(companionId)}/runtime/desktop`,
    { method: "POST", headers: orgHeaders(orgId), body: "{}" },
  );
}

export type { CompanionProvidersResponse };
export type { CompanionPluginsResponse };
