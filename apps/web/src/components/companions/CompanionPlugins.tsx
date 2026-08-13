"use client";

import { type FormEvent, useMemo, useState } from "react";
import type {
  CompanionPluginAccount,
  SaveCompanionPluginInput,
} from "@companion/contracts";
import { deleteCompanionPlugin, saveCompanionPlugin } from "@/lib/companions";
import { Icon } from "../Icon";
import { Dialog } from "../org/primitives";

function providerName(value: string): string {
  return value
    .split("-")
    .map((part) => part ? part[0]!.toLocaleUpperCase("en-US") + part.slice(1) : part)
    .join(" ");
}

function AddMcpDialog({
  orgId,
  onAdded,
  onClose,
}: {
  orgId: string;
  onAdded: (account: CompanionPluginAccount) => void;
  onClose: () => void;
}) {
  const [provider, setProvider] = useState("");
  const [label, setLabel] = useState("");
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [endpoint, setEndpoint] = useState("");
  const [args, setArgs] = useState("");
  const [credentialName, setCredentialName] = useState("Authorization");
  const [credentialValue, setCredentialValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const credential = credentialValue.trim()
      ? {
          credential_name: credentialName.trim(),
          credential_value: credentialValue,
        }
      : {};
    const input: SaveCompanionPluginInput = transport === "http"
      ? {
          provider: provider.trim().toLocaleLowerCase("en-US"),
          label: label.trim(),
          transport,
          url: endpoint.trim(),
          args: [],
          ...credential,
        }
      : {
          provider: provider.trim().toLocaleLowerCase("en-US"),
          label: label.trim(),
          transport,
          command: endpoint.trim(),
          args: args.trim() ? args.trim().split(/\s+/) : [],
          ...credential,
        };
    try {
      onAdded(await saveCompanionPlugin(orgId, input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This MCP account could not be connected.");
      setBusy(false);
    }
  };

  return (
    <Dialog
      icon="plug-zap"
      title="Add MCP"
      desc="Connect one account and give it a short label such as work or personal."
      onClose={onClose}
      closeDisabled={busy}
      className="og-dialog companions-plugin-dialog"
      foot={(
        <>
          <button
            type="button"
            className="cds-btn cds-btn--secondary cds-btn--md"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            form="companion-plugin-create"
            className="cds-btn cds-btn--primary cds-btn--md"
            disabled={busy || !provider.trim() || !label.trim() || !endpoint.trim()}
          >
            {busy ? "Connecting..." : "Connect MCP"}
          </button>
        </>
      )}
    >
      {error && <div className="companions-error" role="alert">{error}</div>}
      <form id="companion-plugin-create" className="companions-plugin-form" onSubmit={submit}>
        <div className="companions-plugin-form__pair">
          <label>
            Provider
            <input
              autoFocus
              required
              pattern="[a-z][a-z0-9-]*"
              maxLength={63}
              value={provider}
              onChange={(event) => setProvider(event.target.value)}
              placeholder="linear"
            />
          </label>
          <label>
            Account label
            <input
              required
              maxLength={40}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="work"
            />
          </label>
        </div>
        <label>
          Transport
          <select
            value={transport}
            onChange={(event) => {
              const next = event.target.value as "http" | "stdio";
              setTransport(next);
              setEndpoint("");
              setArgs("");
              setCredentialName(next === "http" ? "Authorization" : "MCP_TOKEN");
            }}
          >
            <option value="http">HTTP</option>
            <option value="stdio">Command (stdio)</option>
          </select>
        </label>
        <label>
          {transport === "http" ? "MCP URL" : "Command"}
          <input
            required
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
            placeholder={transport === "http" ? "https://mcp.example.com" : "github-mcp-server"}
          />
        </label>
        {transport === "stdio" && (
          <label>
            Arguments
            <input
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              placeholder="stdio"
            />
          </label>
        )}
        <div className="companions-plugin-form__pair">
          <label>
            {transport === "http" ? "Auth header" : "Secret environment variable"}
            <input
              value={credentialName}
              onChange={(event) => setCredentialName(event.target.value)}
              placeholder={transport === "http" ? "Authorization" : "MCP_TOKEN"}
            />
          </label>
          <label>
            Credential
            <input
              type="password"
              value={credentialValue}
              onChange={(event) => setCredentialValue(event.target.value)}
              placeholder="Optional"
              autoComplete="off"
            />
          </label>
        </div>
        <p className="companions-new-form__hint">
          Credentials are write-only and encrypted. Reconnect the account to replace one.
        </p>
      </form>
    </Dialog>
  );
}

export function CompanionPlugins({
  orgId,
  initialAccounts,
  onBack,
}: {
  orgId: string;
  initialAccounts: CompanionPluginAccount[];
  onBack: () => void;
}) {
  const [accounts, setAccounts] = useState(initialAccounts);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const groups = useMemo(() => {
    const grouped = new Map<string, CompanionPluginAccount[]>();
    for (const account of accounts) {
      grouped.set(account.provider, [...(grouped.get(account.provider) ?? []), account]);
    }
    return [...grouped.entries()];
  }, [accounts]);

  const remove = async (account: CompanionPluginAccount) => {
    setRemoving(account.id);
    setError(null);
    try {
      await deleteCompanionPlugin(orgId, account.id);
      setAccounts((current) => current.filter((item) => item.id !== account.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This MCP account could not be disconnected.");
    } finally {
      setRemoving(null);
    }
  };

  return (
    <section className="companions-plugins" aria-labelledby="plugins-title">
      <header className="companions-head companions-plugins__head">
        <div className="companions-plugins__title">
          <button type="button" className="iconbtn" aria-label="Back to Companions" onClick={onBack}>
            <Icon name="arrow-left" size={16} />
          </button>
          <div>
            <h1 id="plugins-title">Plugins</h1>
            <p>MCP servers. Connect multiple accounts with labels.</p>
          </div>
        </div>
        <button
          type="button"
          className="cds-btn cds-btn--primary cds-btn--md"
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" size={15} /> Add MCP
        </button>
      </header>

      <div className="companions-content">
        {error && <div className="companions-error" role="alert">{error}</div>}
        {groups.length === 0 ? (
          <div className="companions-empty">
            <Icon name="plug-zap" size={22} />
            <strong>No MCP accounts connected</strong>
            <p>Connect a server here. Plugins never add controls to the conversation.</p>
            <button
              type="button"
              className="cds-btn cds-btn--primary cds-btn--md"
              onClick={() => setAdding(true)}
            >
              Add MCP
            </button>
          </div>
        ) : (
          <div className="companions-plugin-list">
            {groups.map(([provider, providerAccounts]) => (
              <section className="companions-plugin-row" key={provider}>
                <span className="companions-plugin-icon" aria-hidden="true">
                  {provider.slice(0, 1).toLocaleUpperCase("en-US")}
                </span>
                <strong>{providerName(provider)}</strong>
                <span className="companions-state companions-state--ok">
                  <i aria-hidden="true" /> Connected
                </span>
                <div className="companions-plugin-labels">
                  {providerAccounts.map((account) => (
                    <span className="companions-plugin-label" key={account.id}>
                      <span>{account.label}</span>
                      <button
                        type="button"
                        aria-label={`Disconnect ${providerName(provider)} ${account.label}`}
                        disabled={removing === account.id}
                        onClick={() => void remove(account)}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    </span>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>

      {adding && (
        <AddMcpDialog
          orgId={orgId}
          onAdded={(account) => {
            setAccounts((current) => [...current, account]);
            setAdding(false);
          }}
          onClose={() => setAdding(false)}
        />
      )}
    </section>
  );
}
