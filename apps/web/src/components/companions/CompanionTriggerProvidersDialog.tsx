"use client";

import { type FormEvent, useMemo, useState } from "react";
import type {
  CompanionTriggerProviderAccount,
  CreateCompanionTriggerProviderAccountInput,
} from "@companion/contracts";
import {
  disconnectCompanionTriggerProviderAccount,
  saveCompanionTriggerProviderAccount,
  startCompanionPluginOAuth,
} from "@/lib/companions";
import { Badge } from "../cds";
import { Dialog } from "../org/primitives";
import { PluginMark } from "./PluginMark";

type TriggerProvider = CompanionTriggerProviderAccount["provider"];
type OAuthTriggerProvider = keyof typeof OAUTH_SERVER;

const PROVIDERS: Array<{
  id: TriggerProvider;
  label: string;
  description: string;
}> = [
  {
    id: "github",
    label: "GitHub",
    description: "Companion registers repository webhooks with the same OAuth account as GitHub MCP.",
  },
  {
    id: "sentry",
    label: "Sentry",
    description: "Companion registers project service hooks with the same OAuth account as Sentry MCP.",
  },
  {
    id: "linear",
    label: "Linear",
    description: "Connect one webhook key once; every Companion can then create Linear triggers.",
  },
];

const OAUTH_SERVER = {
  github: "io.github.github/github-mcp-server",
  sentry: "io.sentry/mcp",
} as const;

function isOAuthTriggerProvider(provider: TriggerProvider): provider is OAuthTriggerProvider {
  return provider === "github" || provider === "sentry";
}

export interface CompanionTriggerProvidersApi {
  disconnectCompanionTriggerProviderAccount: typeof disconnectCompanionTriggerProviderAccount;
  saveCompanionTriggerProviderAccount: typeof saveCompanionTriggerProviderAccount;
  startCompanionPluginOAuth: typeof startCompanionPluginOAuth;
}

const defaultApi: CompanionTriggerProvidersApi = {
  disconnectCompanionTriggerProviderAccount,
  saveCompanionTriggerProviderAccount,
  startCompanionPluginOAuth,
};

function providerLabel(provider: TriggerProvider): string {
  return PROVIDERS.find((item) => item.id === provider)?.label ?? provider;
}

function replaceAccount(
  accounts: readonly CompanionTriggerProviderAccount[],
  account: CompanionTriggerProviderAccount,
): CompanionTriggerProviderAccount[] {
  const withoutMatch = accounts.filter((item) => item.id !== account.id
    && !(item.provider === account.provider && item.label === account.label));
  return [...withoutMatch, account].sort((left, right) => (
    left.provider.localeCompare(right.provider) || left.label.localeCompare(right.label)
  ));
}

function ApiKeyDialog({
  orgId,
  provider,
  initialLabel,
  api,
  onSaved,
  onClose,
}: {
  orgId: string;
  provider: TriggerProvider;
  initialLabel?: string;
  api: CompanionTriggerProvidersApi;
  onSaved: (account: CompanionTriggerProviderAccount) => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initialLabel ?? "");
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input: CreateCompanionTriggerProviderAccountInput = {
      provider,
      label: label.trim(),
      credential: credential.trim(),
    };
    if (!input.label || !input.credential || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await api.saveCompanionTriggerProviderAccount(orgId, input));
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This provider could not be connected.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      icon={<PluginMark provider={provider} size="md" variant="glyph" />}
      title={`Connect ${providerLabel(provider)} with an API key`}
      desc="This write-only fallback is stored encrypted once and becomes available to every Companion."
      onClose={onClose}
      closeDisabled={busy}
      className="og-dialog companions-trigger-provider-key-dialog"
      foot={(
        <>
          <button type="button" className="cds-btn cds-btn--secondary" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="trigger-provider-key-form" className="cds-btn cds-btn--primary" disabled={busy || !label.trim() || !credential.trim()}>
            {busy ? "Connecting…" : "Connect provider"}
          </button>
        </>
      )}
    >
      <form id="trigger-provider-key-form" className="companions-plugin-form" onSubmit={(event) => void submit(event)}>
        <label>
          Account label
          <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={40} autoFocus={!initialLabel} placeholder="e.g. work" />
        </label>
        <label>
          API key
          <input type="password" value={credential} onChange={(event) => setCredential(event.target.value)} autoFocus={Boolean(initialLabel)} autoComplete="off" />
        </label>
        <p className="companions-new-form__hint">
          The key is write-only. Companion creates and maintains the remote webhooks for you.
        </p>
        {error && <div className="companions-error" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

function OAuthConnectDialog({
  orgId,
  provider,
  initialLabel,
  api,
  onClose,
}: {
  orgId: string;
  provider: "github" | "sentry";
  initialLabel?: string;
  api: CompanionTriggerProvidersApi;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(initialLabel ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!label.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const authorizationUrl = await api.startCompanionPluginOAuth(orgId, {
        server_name: OAUTH_SERVER[provider],
        label: label.trim(),
      });
      window.location.assign(authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "OAuth authorization could not start.");
      setBusy(false);
    }
  }

  return (
    <Dialog
      icon={<PluginMark provider={provider} size="md" variant="glyph" />}
      title={`Connect ${providerLabel(provider)}`}
      desc="Authorize once. The same encrypted OAuth account powers MCP tools and member-wide trigger registration."
      onClose={onClose}
      closeDisabled={busy}
      className="og-dialog companions-trigger-provider-oauth-dialog"
      foot={(
        <>
          <button type="button" className="cds-btn cds-btn--secondary" onClick={onClose} disabled={busy}>Cancel</button>
          <button type="submit" form="trigger-provider-oauth-form" className="cds-btn cds-btn--primary" disabled={busy || !label.trim()}>
            {busy ? "Opening OAuth…" : "Continue with OAuth"}
          </button>
        </>
      )}
    >
      <form id="trigger-provider-oauth-form" className="companions-plugin-form" onSubmit={(event) => void submit(event)}>
        <label>
          Account label
          <input value={label} onChange={(event) => setLabel(event.target.value)} maxLength={40} autoFocus placeholder="e.g. work" />
        </label>
        <p className="companions-new-form__hint">
          Trigger access is live for every Companion immediately. MCP tools still use their own per-Companion attachment.
        </p>
        {error && <div className="companions-error" role="alert">{error}</div>}
      </form>
    </Dialog>
  );
}

export function CompanionTriggerProvidersDialog({
  orgId,
  accounts,
  onAccountsChange,
  onMcpAccountRemoved,
  onClose,
  api = defaultApi,
}: {
  orgId: string;
  accounts: readonly CompanionTriggerProviderAccount[];
  onAccountsChange: (accounts: CompanionTriggerProviderAccount[]) => void;
  onMcpAccountRemoved?: (accountId: string) => void;
  onClose: () => void;
  api?: CompanionTriggerProvidersApi;
}) {
  const [keyTarget, setKeyTarget] = useState<{ provider: TriggerProvider; label?: string } | null>(null);
  const [oauthTarget, setOauthTarget] = useState<{ provider: "github" | "sentry"; label?: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const childDialogOpen = keyTarget !== null || oauthTarget !== null;
  const grouped = useMemo(() => new Map(PROVIDERS.map((provider) => [
    provider.id,
    accounts.filter((account) => account.provider === provider.id),
  ])), [accounts]);

  async function disconnect(account: CompanionTriggerProviderAccount) {
    const dependent = account.dependent_trigger_count === 1
      ? "1 dependent trigger"
      : `${account.dependent_trigger_count} dependent triggers`;
    const oauthImpact = account.mcp_account_id
      ? " Its MCP tool account will also be removed."
      : "";
    if (!window.confirm(
      `Disconnect ${providerLabel(account.provider)} “${account.label}”? ${dependent} across all Companions will become unregistered and cannot receive events until you reconnect and retry registration.${oauthImpact}`,
    )) return;
    setBusyId(account.id);
    setError(null);
    try {
      const disconnected = await api.disconnectCompanionTriggerProviderAccount(orgId, account.id);
      if (account.mcp_account_id) onMcpAccountRemoved?.(account.mcp_account_id);
      onAccountsChange(replaceAccount(accounts, disconnected));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This provider could not be disconnected.");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <div aria-hidden={childDialogOpen || undefined} inert={childDialogOpen ? true : undefined}>
        <Dialog
          icon="zap"
          title="Trigger providers"
          desc="Connect once at member level. Every Companion can create its own triggers immediately—there is no attachment step."
          onClose={onClose}
          closeDisabled={Boolean(busyId)}
          className="og-dialog companions-trigger-providers-dialog"
          foot={<button type="button" className="cds-btn cds-btn--primary" onClick={onClose}>Done</button>}
        >
          {error && <div className="companions-error" role="alert">{error}</div>}
          <div className="companions-trigger-provider-catalog">
          {PROVIDERS.map((provider) => {
            const providerAccounts = grouped.get(provider.id) ?? [];
            const hasConnectedAccount = providerAccounts.some((account) => account.status === "connected");
            return (
              <section className="companions-trigger-provider-card" key={provider.id}>
                <div className="companions-trigger-provider-card__head">
                  <PluginMark provider={provider.id} size="md" />
                  <div>
                    <strong>{provider.label}</strong>
                    <p>{provider.description}</p>
                  </div>
                </div>
                {providerAccounts.length > 0 && (
                  <ul className="companions-trigger-provider-accounts">
                    {providerAccounts.map((account) => (
                      <li key={account.id}>
                        <span>
                          <strong>{account.label}</strong>
                          <small>{account.credential_source === "mcp_oauth" ? "Shared OAuth" : "Encrypted API key"} · {account.dependent_trigger_count} {account.dependent_trigger_count === 1 ? "trigger" : "triggers"}</small>
                        </span>
                        <Badge tone={account.status === "connected" ? "ok" : "danger"} dot>
                          {account.status === "connected" ? "Connected" : "Disconnected"}
                        </Badge>
                        {account.status === "connected" ? (
                          <button type="button" className="chat-context__link" disabled={busyId === account.id} onClick={() => void disconnect(account)}>
                            {busyId === account.id ? "Disconnecting…" : "Disconnect"}
                          </button>
                        ) : account.provider === "linear" || account.credential_source === "api_key" ? (
                          <button type="button" className="chat-context__link" onClick={() => setKeyTarget({ provider: account.provider, label: account.label })}>Reconnect</button>
                        ) : isOAuthTriggerProvider(account.provider) ? (
                          <button type="button" className="chat-context__link" onClick={() => setOauthTarget({ provider: account.provider === "github" ? "github" : "sentry", label: account.label })}>Reconnect</button>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="companions-trigger-provider-card__actions">
                  {provider.id === "linear" ? (
                    <button type="button" className="cds-btn cds-btn--secondary cds-btn--sm" onClick={() => setKeyTarget({ provider: provider.id })}>Connect Linear</button>
                  ) : isOAuthTriggerProvider(provider.id) ? (
                    <>
                      <button type="button" className="cds-btn cds-btn--secondary cds-btn--sm" onClick={() => setOauthTarget({ provider: provider.id === "github" ? "github" : "sentry" })}>Connect {provider.label}</button>
                      {!hasConnectedAccount && (
                        <button type="button" className="chat-context__link" onClick={() => setKeyTarget({ provider: provider.id })}>Use API key instead</button>
                      )}
                    </>
                  ) : null}
                </div>
              </section>
            );
          })}
          </div>
          <p className="companions-new-form__hint">
            Trigger provider access is member-wide. MCP tool accounts remain separately attached per Companion.
          </p>
        </Dialog>
      </div>

      {keyTarget && (
        <ApiKeyDialog
          orgId={orgId}
          provider={keyTarget.provider}
          initialLabel={keyTarget.label}
          api={api}
          onSaved={(account) => onAccountsChange(replaceAccount(accounts, account))}
          onClose={() => setKeyTarget(null)}
        />
      )}
      {oauthTarget && (
        <OAuthConnectDialog
          orgId={orgId}
          provider={oauthTarget.provider}
          initialLabel={oauthTarget.label}
          api={api}
          onClose={() => setOauthTarget(null)}
        />
      )}
    </>
  );
}
