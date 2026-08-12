"use client";

import { type FormEvent, useState } from "react";
import type {
  CompanionProviderAuthMethod,
  CompanionProvidersResponse,
  SaveCompanionProviderInput,
} from "@companion/contracts";
import {
  deleteCompanionProvider,
  saveCompanionProvider,
  setDefaultCompanionProvider,
} from "@/lib/companions";
import { Dialog } from "../org/primitives";

/**
 * Workspace model-provider credentials. Owner/Admin only, one compact form, write-only values: the
 * list surface stays free of credential chrome.
 */
export function CompanionProvidersDialog({
  orgId,
  providers,
  onProviders,
  onClose,
}: {
  orgId: string;
  providers: CompanionProvidersResponse;
  onProviders: (providers: CompanionProvidersResponse) => void;
  onClose: () => void;
}) {
  const available = providers.catalog.filter(
    (provider) => !providers.connections.some(
      (connection) => connection.provider_id === provider.id,
    ),
  );
  const [providerToAdd, setProviderToAdd] = useState(available[0]?.id ?? "");
  const [authMethod, setAuthMethod] = useState<CompanionProviderAuthMethod>(
    available[0]?.auth_methods[0] ?? "api_key",
  );
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerName = (id: string) =>
    providers.catalog.find((provider) => provider.id === id)?.name ?? id;
  const selectedDefinition = providers.catalog.find((provider) => provider.id === providerToAdd);

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!providerToAdd) return;
    setBusy(true);
    setError(null);
    try {
      const parsed = authMethod === "subscription"
        ? JSON.parse(credential) as Record<string, unknown>
        : credential.trim();
      if (
        authMethod === "subscription"
        && (!parsed || typeof parsed !== "object" || parsed.type !== "oauth")
      ) {
        throw new Error("Paste one Pi subscription entry whose type is oauth.");
      }
      const input: SaveCompanionProviderInput = authMethod === "subscription"
        ? { auth_method: "subscription", credential: parsed as Record<string, unknown> }
        : { auth_method: "api_key", credential: parsed as string };
      const connection = await saveCompanionProvider(orgId, providerToAdd, input);
      let defaultProviderId = providers.default_provider_id;
      if (!defaultProviderId) {
        await setDefaultCompanionProvider(orgId, providerToAdd);
        defaultProviderId = providerToAdd;
      }
      const connections = [...providers.connections, connection];
      onProviders({ ...providers, connections, default_provider_id: defaultProviderId });
      setCredential("");
      const next = providers.catalog.find((provider) =>
        !connections.some((candidate) => candidate.provider_id === provider.id));
      setProviderToAdd(next?.id ?? "");
      setAuthMethod(next?.auth_methods[0] ?? "api_key");
    } catch (cause) {
      setError(cause instanceof SyntaxError
        ? "Subscription credential must be valid JSON."
        : cause instanceof Error ? cause.message : "Provider could not be connected.");
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (providerId: string) => {
    setBusy(true);
    setError(null);
    try {
      await setDefaultCompanionProvider(orgId, providerId);
      onProviders({ ...providers, default_provider_id: providerId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Default provider could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (providerId: string) => {
    if (!window.confirm(
      `Disconnect ${providerName(providerId)}? Companions using it cannot start until it is reconnected.`,
    )) return;
    setBusy(true);
    setError(null);
    try {
      await deleteCompanionProvider(orgId, providerId);
      const connections = providers.connections.filter(
        (connection) => connection.provider_id !== providerId,
      );
      onProviders({
        ...providers,
        connections,
        default_provider_id: providers.default_provider_id === providerId
          ? null
          : providers.default_provider_id,
      });
      if (!providerToAdd) {
        setProviderToAdd(providerId);
        setAuthMethod(
          providers.catalog.find((provider) => provider.id === providerId)?.auth_methods[0]
            ?? "api_key",
        );
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider could not be disconnected.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      icon="plug-zap"
      title="Model providers"
      desc="Credentials are encrypted, write-only, and shared by every Companion in this workspace."
      onClose={onClose}
      closeDisabled={busy}
      className="og-dialog companions-providers-dialog"
      foot={(
        <button type="button" className="cds-btn cds-btn--secondary cds-btn--md" onClick={onClose}>
          Done
        </button>
      )}
    >
      {error && <div className="companions-error" role="alert">{error}</div>}

      {providers.connections.length ? (
        <div className="companions-provider-list">
          {providers.connections.map((connection) => (
            <div className="companions-provider-row" key={connection.provider_id}>
              <div>
                <strong>{providerName(connection.provider_id)}</strong>
                <span>
                  {connection.auth_method === "api_key" ? "API key" : "Subscription"}
                  {providers.default_provider_id === connection.provider_id
                    ? " · Workspace default"
                    : ""}
                </span>
              </div>
              {providers.can_manage && (
                <div className="companions-provider-actions">
                  {providers.default_provider_id !== connection.provider_id && (
                    <button
                      type="button"
                      className="cds-btn cds-btn--secondary cds-btn--sm"
                      disabled={busy}
                      onClick={() => void makeDefault(connection.provider_id)}
                    >
                      Make default
                    </button>
                  )}
                  <button
                    type="button"
                    className="cds-btn cds-btn--ghost cds-btn--sm"
                    disabled={busy}
                    onClick={() => void disconnect(connection.provider_id)}
                  >
                    Disconnect
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="companions-provider-empty">
          {providers.can_manage
            ? "Connect one provider to create a Companion."
            : "Ask a workspace admin to connect a provider."}
        </p>
      )}

      {providers.can_manage && available.length > 0 && (
        <form className="companions-provider-add" onSubmit={connect}>
          <label>
            Provider
            <select
              value={providerToAdd}
              onChange={(event) => {
                const id = event.target.value;
                setProviderToAdd(id);
                setAuthMethod(
                  providers.catalog.find((provider) => provider.id === id)?.auth_methods[0]
                    ?? "api_key",
                );
                setCredential("");
              }}
            >
              {available.map((provider) => (
                <option key={provider.id} value={provider.id}>{provider.name}</option>
              ))}
            </select>
          </label>
          <label>
            Authentication
            <select
              value={authMethod}
              onChange={(event) => {
                setAuthMethod(event.target.value as CompanionProviderAuthMethod);
                setCredential("");
              }}
            >
              {selectedDefinition?.auth_methods.map((method) => (
                <option key={method} value={method}>
                  {method === "api_key" ? "API key" : "Subscription"}
                </option>
              ))}
            </select>
          </label>
          <label className="companions-credential">
            {authMethod === "api_key" ? "API key" : "Pi subscription credential"}
            {authMethod === "api_key" ? (
              <input
                required
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
              />
            ) : (
              <>
                <textarea
                  required
                  rows={4}
                  value={credential}
                  onChange={(event) => setCredential(event.target.value)}
                  placeholder={'{"type":"oauth", ...}'}
                />
                <span>Paste only this provider&apos;s entry from Pi <code>auth.json</code>.</span>
              </>
            )}
          </label>
          <button
            type="submit"
            className="cds-btn cds-btn--secondary cds-btn--md"
            disabled={busy || !credential.trim() || !providerToAdd}
          >
            {busy ? "Connecting..." : "Connect provider"}
          </button>
        </form>
      )}
    </Dialog>
  );
}
