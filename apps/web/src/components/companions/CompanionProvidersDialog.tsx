"use client";

import { type FormEvent, useState } from "react";
import type {
  CompanionProviderAuthMethod,
  CompanionProviderConnection,
  CompanionProviderOAuthStartResponse,
  CompanionProvidersResponse,
} from "@companion/contracts";
import {
  completeCompanionProviderOAuth,
  deleteCompanionProvider,
  pollCompanionProviderOAuth,
  saveCompanionProvider,
  setDefaultCompanionProvider,
  startCompanionProviderOAuth,
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
  const [oauthFlow, setOauthFlow] = useState<CompanionProviderOAuthStartResponse | null>(null);
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const providerName = (id: string) =>
    providers.catalog.find((provider) => provider.id === id)?.name ?? id;
  const selectedDefinition = providers.catalog.find((provider) => provider.id === providerToAdd);

  const acceptConnection = async (connection: CompanionProviderConnection) => {
    let defaultProviderId = providers.default_provider_id;
    if (!defaultProviderId) {
      await setDefaultCompanionProvider(orgId, connection.provider_id);
      defaultProviderId = connection.provider_id;
    }
    const connections = [...providers.connections, connection];
    onProviders({ ...providers, connections, default_provider_id: defaultProviderId });
    setCredential("");
    setAuthorizationCode("");
    setOauthFlow(null);
    const next = providers.catalog.find((provider) =>
      !connections.some((candidate) => candidate.provider_id === provider.id));
    setProviderToAdd(next?.id ?? "");
    setAuthMethod(next?.auth_methods[0] ?? "api_key");
  };

  const connect = async (event: FormEvent) => {
    event.preventDefault();
    if (!providerToAdd) return;
    setBusy(true);
    setError(null);
    try {
      if (authMethod === "subscription") {
        const started = await startCompanionProviderOAuth(
          orgId,
          providerToAdd as "anthropic" | "openai-codex",
        );
        setOauthFlow(started);
        setAuthorizationCode("");
        return;
      }
      const connection = await saveCompanionProvider(orgId, providerToAdd, {
        auth_method: "api_key",
        credential: credential.trim(),
      });
      await acceptConnection(connection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider could not be connected.");
    } finally {
      setBusy(false);
    }
  };

  const completeSubscription = async () => {
    if (!oauthFlow) return;
    setBusy(true);
    setError(null);
    try {
      let connection: CompanionProviderConnection | null;
      if (oauthFlow.flow === "authorization_code") {
        connection = await completeCompanionProviderOAuth(orgId, authorizationCode);
      } else {
        const result = await pollCompanionProviderOAuth(orgId);
        connection = result.status === "connected" ? result.connection : null;
      }
      if (!connection) {
        setError("Authorization is still waiting. Finish sign-in, then check again.");
        return;
      }
      await acceptConnection(connection);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Provider sign-in could not be completed.");
      setOauthFlow(null);
      setAuthorizationCode("");
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
                setOauthFlow(null);
                setAuthorizationCode("");
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
                setOauthFlow(null);
                setAuthorizationCode("");
              }}
            >
              {selectedDefinition?.auth_methods.map((method) => (
                <option key={method} value={method}>
                  {method === "api_key" ? "API key" : "Subscription"}
                </option>
              ))}
            </select>
          </label>
          {authMethod === "api_key" ? (
            <label className="companions-credential">
              API key
              <input
                required
                type="password"
                autoComplete="off"
                value={credential}
                onChange={(event) => setCredential(event.target.value)}
              />
            </label>
          ) : oauthFlow ? (
            <div className="companions-provider-oauth">
              {oauthFlow.flow === "authorization_code" ? (
                <>
                  <p>
                    Open Claude sign-in and approve Companion. Then enter the one-time code or final
                    redirect URL shown by Claude.
                  </p>
                  <a
                    className="cds-btn cds-btn--secondary cds-btn--md"
                    href={oauthFlow.authorization_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Claude sign-in
                  </a>
                  <label>
                    Authorization code
                    <input
                      autoComplete="off"
                      value={authorizationCode}
                      onChange={(event) => setAuthorizationCode(event.target.value)}
                    />
                  </label>
                </>
              ) : (
                <>
                  <p>Open ChatGPT device sign-in and enter this one-time code:</p>
                  <code className="companions-provider-oauth__code">{oauthFlow.user_code}</code>
                  <a
                    className="cds-btn cds-btn--secondary cds-btn--md"
                    href={oauthFlow.verification_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open ChatGPT sign-in
                  </a>
                </>
              )}
              <button
                type="button"
                className="cds-btn cds-btn--primary cds-btn--md"
                disabled={
                  busy
                  || (oauthFlow.flow === "authorization_code" && !authorizationCode.trim())
                }
                onClick={() => void completeSubscription()}
              >
                {busy
                  ? "Connecting..."
                  : oauthFlow.flow === "device_code" ? "Check connection" : "Finish connection"}
              </button>
            </div>
          ) : (
            <div className="companions-provider-oauth-intro">
              <p>
                Sign in with {selectedDefinition?.name}. Tokens are stored encrypted and never
                returned to this browser.
              </p>
            </div>
          )}
          {!oauthFlow && (
            <button
              type="submit"
              className="cds-btn cds-btn--secondary cds-btn--md"
              disabled={
                busy
                || !providerToAdd
                || (authMethod === "api_key" && !credential.trim())
              }
            >
              {busy
                ? "Connecting..."
                : authMethod === "subscription" ? "Continue to sign in" : "Connect provider"}
            </button>
          )}
        </form>
      )}
    </Dialog>
  );
}
