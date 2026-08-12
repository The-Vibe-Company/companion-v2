import type {
  Companion,
  CompanionProviderConnection,
  CompanionProvidersResponse,
  SaveCompanionProviderInput,
} from "@companion/contracts";
import { apiFetch } from "./apiClient";

function orgHeaders(orgId: string): HeadersInit {
  return { "x-companion-org": orgId };
}

export async function createCompanion(
  orgId: string,
  input: { name: string; provider_id: string },
): Promise<Companion> {
  const result = await apiFetch<{ companion: Companion }>("/v1/companions", {
    method: "POST",
    headers: orgHeaders(orgId),
    body: JSON.stringify(input),
  });
  return result.companion;
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

export type { CompanionProvidersResponse };
