import type {
  Companion,
  CompanionDesktop,
  CompanionPluginAccount,
  CompanionPluginOAuthStartInput,
  CompanionPluginOAuthStartResponse,
  CompanionPluginsResponse,
  CompanionProviderConnection,
  CompanionProviderOAuthStartResponse,
  CompanionProvidersResponse,
  CompanionRegistryDetailResponse,
  CompanionRegistryListResponse,
  CompanionShareRole,
  CompanionShares,
  CompanionThread,
  SaveCompanionProviderInput,
  SaveCompanionPluginInput,
  UpdateCompanionInput,
} from "@companion/contracts";
import { apiFetch } from "./apiClient";

function orgHeaders(orgId: string): HeadersInit {
  return { "x-companion-org": orgId };
}

/**
 * Every Companion the caller may read, with each thread's last line projected on. This is the poll
 * behind the conversation list, so it stays on the control-plane read model and never contacts Box.
 */
export async function listCompanions(orgId: string): Promise<Companion[]> {
  const result = await apiFetch<{ companions: Companion[] }>("/v1/companions", {
    headers: orgHeaders(orgId),
  });
  return result.companions;
}

export async function createCompanion(
  orgId: string,
  input: {
    name: string;
    persona?: string;
    provider_id: string;
    model_id: string;
    selected_skill_ids?: string[];
    can_write_skills?: boolean;
    selected_mcp_account_ids?: string[];
  },
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>("/v1/companions", {
    method: "POST",
    headers: orgHeaders(orgId),
    body: JSON.stringify(input),
  });
  return result.companion;
}

export async function updateCompanion(
  orgId: string,
  companionId: string,
  input: UpdateCompanionInput,
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}`,
    {
      method: "PATCH",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.companion;
}

export async function deleteCompanion(orgId: string, companionId: string): Promise<void> {
  await apiFetch(`/v1/companions/${encodeURIComponent(companionId)}`, {
    method: "DELETE",
    headers: orgHeaders(orgId),
  });
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

/** Begin a curated MCP OAuth flow; the caller navigates to the returned provider URL. */
export async function startCompanionPluginOAuth(
  orgId: string,
  input: CompanionPluginOAuthStartInput,
): Promise<string> {
  const result = await apiFetch<CompanionPluginOAuthStartResponse>(
    "/v1/companion-plugins/oauth/start",
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(12_000),
    },
  );
  return result.authorization_url;
}

/**
 * Browse/search the official MCP registry through the companion-v2 API proxy. The browser never
 * calls the registry itself; the proxy caches and falls back to pins when the registry is down.
 */
export async function listCompanionRegistry(
  orgId: string,
  params: { search?: string; cursor?: string } = {},
): Promise<CompanionRegistryListResponse> {
  const query = new URLSearchParams();
  if (params.search) query.set("search", params.search);
  if (params.cursor) query.set("cursor", params.cursor);
  const suffix = query.toString() ? `?${query.toString()}` : "";
  return apiFetch<CompanionRegistryListResponse>(`/v1/companion-registry/servers${suffix}`, {
    headers: orgHeaders(orgId),
    signal: AbortSignal.timeout(12_000),
  });
}

/** Fetch one registry server's latest connect metadata through the proxy. */
export async function getCompanionRegistryServer(
  orgId: string,
  name: string,
): Promise<CompanionRegistryDetailResponse> {
  return apiFetch<CompanionRegistryDetailResponse>(
    `/v1/companion-registry/server?name=${encodeURIComponent(name)}`,
    {
      headers: orgHeaders(orgId),
      signal: AbortSignal.timeout(12_000),
    },
  );
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

export async function startCompanionProviderOAuth(
  orgId: string,
  providerId: "anthropic" | "openai-codex",
): Promise<CompanionProviderOAuthStartResponse> {
  return apiFetch<CompanionProviderOAuthStartResponse>("/v1/companion-providers/oauth/start", {
    method: "POST",
    headers: orgHeaders(orgId),
    body: JSON.stringify({ provider_id: providerId }),
    signal: AbortSignal.timeout(35_000),
  });
}

export async function completeCompanionProviderOAuth(
  orgId: string,
  authorizationCode: string,
): Promise<CompanionProviderConnection> {
  const result = await apiFetch<{ connection: CompanionProviderConnection }>(
    "/v1/companion-providers/oauth/complete",
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ authorization_code: authorizationCode }),
      signal: AbortSignal.timeout(35_000),
    },
  );
  return result.connection;
}

export async function pollCompanionProviderOAuth(
  orgId: string,
): Promise<
  | { status: "pending" }
  | { status: "connected"; connection: CompanionProviderConnection }
> {
  return apiFetch("/v1/companion-providers/oauth/poll", {
    method: "POST",
    headers: orgHeaders(orgId),
    signal: AbortSignal.timeout(65_000),
  });
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

/**
 * Send one message. `clientMessageId` names the turn this send creates, so the control plane stores
 * it once however many times the request reaches it: a resend can only ever resolve to the same turn.
 */
export async function sendCompanionMessage(
  orgId: string,
  companionId: string,
  content: string,
  clientMessageId: string,
): Promise<CompanionThread> {
  const result = await apiFetch<{ thread: CompanionThread }>(
    `/v1/companions/${encodeURIComponent(companionId)}/messages`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ content, client_message_id: clientMessageId }),
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
 * Allow, Deny, or answer a pending permission card. Owner/Editor only; Viewer is refused by the API.
 */
export async function decideCompanionDecision(
  orgId: string,
  companionId: string,
  requestId: string,
  input: { action: "allow" } | { action: "deny" } | { action: "answer"; answer: string },
): Promise<CompanionThread> {
  const result = await apiFetch<{ thread: CompanionThread }>(
    `/v1/companions/${encodeURIComponent(companionId)}/decisions/${encodeURIComponent(requestId)}`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
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
