import type {
  Companion,
  CompanionDesktop,
  CompanionOperation,
  CompanionPluginAccount,
  CompanionPluginOAuthStartInput,
  CompanionPluginOAuthStartResponse,
  CompanionPluginsResponse,
  CompanionProviderConnection,
  CompanionProviderOAuthStartResponse,
  CompanionProvidersResponse,
  CompanionRoutine,
  CompanionShareRole,
  CompanionShares,
  CompanionThread,
  CompanionTrigger,
  CancelCompanionTurnAcceptedResponse,
  CreateCompanionRoutineInput,
  CreateCompanionTriggerInput,
  SendCompanionMessageAcceptedResponse,
  SaveCompanionProviderInput,
  SaveCompanionPluginInput,
  UpdateCompanionInput,
  UpdateCompanionRoutineInput,
  UpdateCompanionTriggerInput,
} from "@companion/contracts";
import {
  COMPANION_OPERATION_IDEMPOTENCY_HEADER,
  type RestartCompanionRuntimeInput,
} from "@companion/contracts/companion-runtime";
import { apiFetch } from "./apiClient";

function orgHeaders(orgId: string): HeadersInit {
  return { "x-companion-org": orgId };
}

function operationHeaders(orgId: string, requestId: string): HeadersInit {
  return {
    "x-companion-org": orgId,
    [COMPANION_OPERATION_IDEMPOTENCY_HEADER]: requestId,
  };
}

/** A desktop handoff is the only browser request that waits on a private runtime round trip. */
const DESKTOP_HANDOFF_TIMEOUT_MS = 45_000;

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

/** Provider/model data is client-loaded so a cold pi.dev refresh cannot block the Companions list
 * route. The API still owns the bounded live-catalog lookup and its bundled fallback. */
export async function listCompanionProviders(orgId: string): Promise<CompanionProvidersResponse> {
  return apiFetch<CompanionProvidersResponse>("/v1/companion-providers", {
    headers: orgHeaders(orgId),
  });
}

export async function createCompanion(
  orgId: string,
  input: {
    name: string;
    persona?: string;
    provider_id: string;
    model_id: string;
    selected_skill_ids?: string[];
    selected_mcp_account_ids?: string[];
    icon?: { shape?: number; mouth?: number; accessory?: number; color?: number };
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

export async function deleteCompanion(
  orgId: string,
  companionId: string,
  requestId: string,
): Promise<CompanionOperation> {
  const result = await apiFetch<{ operation: CompanionOperation }>(
    `/v1/companions/${encodeURIComponent(companionId)}`,
    {
      method: "DELETE",
      headers: operationHeaders(orgId, requestId),
    },
  );
  return result.operation;
}

export async function updateCompanionMemberState(
  orgId: string,
  companionId: string,
  input: { pinned?: boolean; hidden?: boolean; unread?: boolean },
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/member-state`,
    {
      method: "PATCH",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.companion;
}

export async function duplicateCompanion(
  orgId: string,
  companionId: string,
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/duplicate`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
    },
  );
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
  files: readonly File[] = [],
): Promise<SendCompanionMessageAcceptedResponse> {
  const path = `/v1/companions/${encodeURIComponent(companionId)}/messages`;
  if (files.length === 0) {
    return apiFetch<SendCompanionMessageAcceptedResponse>(path, {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ content, client_message_id: clientMessageId }),
    });
  }
  // A send carrying files uploads them inside this request, so the accepted turn and the files it
  // names are durable together. That trades the sub-second text ACK for however long the upload
  // takes, which is why the deadline below is the upload's rather than the ordinary one.
  const form = new FormData();
  form.set("content", content);
  form.set("client_message_id", clientMessageId);
  for (const file of files) form.append("file", file, file.name);
  return apiFetch<SendCompanionMessageAcceptedResponse>(
    path,
    { method: "POST", headers: orgHeaders(orgId), body: form },
    { timeoutMs: COMPANION_ATTACHMENT_UPLOAD_TIMEOUT_MS },
  );
}

/** How long a send may spend uploading before the composer gives the draft back. */
const COMPANION_ATTACHMENT_UPLOAD_TIMEOUT_MS = 120_000;

/** Where one stored attachment's bytes are read from. Re-authorized on every single request. */
export function companionAttachmentUrl(companionId: string, attachmentId: string): string {
  return `/v1/companions/${encodeURIComponent(companionId)}/attachments/${encodeURIComponent(attachmentId)}`;
}

/**
 * Retry an interrupted turn. The caller owns the retry id so a repeated HTTP request resolves to
 * the same durable operation instead of scheduling another Pi recycle.
 */
export async function retryCompanionTurn(
  orgId: string,
  companionId: string,
  turnId: string,
  retryId: string,
): Promise<CompanionOperation> {
  const result = await apiFetch<{ operation: CompanionOperation }>(
    `/v1/companions/${encodeURIComponent(companionId)}/turns/${encodeURIComponent(turnId)}/retry`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify({ retry_id: retryId }),
    },
  );
  return result.operation;
}

/** Stop an active turn, dequeue a follow-up, or cancel an interrupted turn. */
export async function cancelCompanionTurn(
  orgId: string,
  companionId: string,
  turnId: string,
): Promise<CancelCompanionTurnAcceptedResponse> {
  return apiFetch<CancelCompanionTurnAcceptedResponse>(
    `/v1/companions/${encodeURIComponent(companionId)}/turns/${encodeURIComponent(turnId)}/cancel`,
    { method: "POST", headers: orgHeaders(orgId), body: "{}" },
  );
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
 * Runtime read. This is always the PostgreSQL projection, including for Owners and Editors; status
 * polling must never become a Box observation or a wake.
 */
export async function getCompanionRuntime(
  orgId: string,
  companionId: string,
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>(
    `/v1/companions/${encodeURIComponent(companionId)}/runtime`,
    { headers: orgHeaders(orgId) },
  );
  return result.companion;
}

/** Queue an explicit lifecycle operation; completion is observed through PostgreSQL projections. */
export async function restartCompanionRuntime(
  orgId: string,
  companionId: string,
  input: RestartCompanionRuntimeInput,
  requestId: string,
): Promise<CompanionOperation> {
  const result = await apiFetch<{ operation: CompanionOperation }>(
    `/v1/companions/${encodeURIComponent(companionId)}/runtime/restart`,
    {
      method: "POST",
      headers: operationHeaders(orgId, requestId),
      body: JSON.stringify(input),
    },
  );
  return result.operation;
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
    { timeoutMs: DESKTOP_HANDOFF_TIMEOUT_MS },
  );
}

export async function listCompanionRoutines(
  orgId: string,
  companionId: string,
): Promise<CompanionRoutine[]> {
  const result = await apiFetch<{ routines: CompanionRoutine[] }>(
    `/v1/companions/${encodeURIComponent(companionId)}/routines`,
    { headers: orgHeaders(orgId) },
  );
  return result.routines;
}

export async function createCompanionRoutine(
  orgId: string,
  companionId: string,
  input: CreateCompanionRoutineInput,
): Promise<CompanionRoutine> {
  const result = await apiFetch<{ routine: CompanionRoutine }>(
    `/v1/companions/${encodeURIComponent(companionId)}/routines`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.routine;
}

export async function updateCompanionRoutine(
  orgId: string,
  companionId: string,
  routineId: string,
  input: UpdateCompanionRoutineInput,
): Promise<CompanionRoutine> {
  const result = await apiFetch<{ routine: CompanionRoutine }>(
    `/v1/companions/${encodeURIComponent(companionId)}/routines/${encodeURIComponent(routineId)}`,
    {
      method: "PATCH",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.routine;
}

export async function deleteCompanionRoutine(
  orgId: string,
  companionId: string,
  routineId: string,
): Promise<void> {
  await apiFetch(
    `/v1/companions/${encodeURIComponent(companionId)}/routines/${encodeURIComponent(routineId)}`,
    { method: "DELETE", headers: orgHeaders(orgId) },
  );
}

/**
 * Triggers are the event-driven siblings of routines. The list carries each trigger's webhook URL
 * for Owner/Editor readers; a Viewer receives `webhook_url: null` and no secret ever travels bare.
 */
export async function listCompanionTriggers(
  orgId: string,
  companionId: string,
): Promise<CompanionTrigger[]> {
  const result = await apiFetch<{ triggers: CompanionTrigger[] }>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers`,
    { headers: orgHeaders(orgId) },
  );
  return result.triggers;
}

export async function createCompanionTrigger(
  orgId: string,
  companionId: string,
  input: CreateCompanionTriggerInput,
): Promise<CompanionTrigger> {
  const result = await apiFetch<{ trigger: CompanionTrigger }>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers`,
    {
      method: "POST",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.trigger;
}

export async function updateCompanionTrigger(
  orgId: string,
  companionId: string,
  triggerId: string,
  input: UpdateCompanionTriggerInput,
): Promise<CompanionTrigger> {
  const result = await apiFetch<{ trigger: CompanionTrigger }>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers/${encodeURIComponent(triggerId)}`,
    {
      method: "PATCH",
      headers: orgHeaders(orgId),
      body: JSON.stringify(input),
    },
  );
  return result.trigger;
}

export async function deleteCompanionTrigger(
  orgId: string,
  companionId: string,
  triggerId: string,
): Promise<void> {
  await apiFetch(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers/${encodeURIComponent(triggerId)}`,
    { method: "DELETE", headers: orgHeaders(orgId) },
  );
}

/** Invalidate the old webhook URL and mint a new one; the response carries the updated trigger. */
export async function rotateCompanionTriggerSecret(
  orgId: string,
  companionId: string,
  triggerId: string,
): Promise<CompanionTrigger> {
  const result = await apiFetch<{ trigger: CompanionTrigger }>(
    `/v1/companions/${encodeURIComponent(companionId)}/triggers/${encodeURIComponent(triggerId)}/rotate-secret`,
    { method: "POST", headers: orgHeaders(orgId), body: "{}" },
  );
  return result.trigger;
}
