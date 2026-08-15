"use client";

import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  CompanionPluginAccount,
  CompanionPluginCatalogEntry,
  SaveCompanionPluginInput,
} from "@companion/contracts";
import {
  COMPANION_PLUGIN_CATALOG,
  companionPluginOAuthServerNameSchema,
} from "@companion/contracts";
import {
  deleteCompanionPlugin,
  saveCompanionPlugin,
  startCompanionPluginOAuth,
} from "@/lib/companions";
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
  const formRef = useRef<HTMLFormElement>(null);
  // Only transport is React-controlled (drives conditional fields). Everything else is a
  // native uncontrolled form so submit reads the live DOM via FormData — the same path a
  // normal browser user and Chrome automation share after real input.
  const [transport, setTransport] = useState<"http" | "stdio">("http");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const nextProvider = String(data.get("provider") ?? "").trim().toLocaleLowerCase("en-US");
    const nextLabel = String(data.get("label") ?? "").trim();
    const nextTransport = (String(data.get("transport") ?? transport) || "http") as "http" | "stdio";
    const nextEndpoint = String(data.get("endpoint") ?? "").trim();
    const nextArgs = String(data.get("args") ?? "").trim();
    const nextCredentialName = String(data.get("credential_name") ?? "").trim();
    const nextCredentialValue = String(data.get("credential_value") ?? "");

    if (busyRef.current) return;

    if (!nextProvider || !nextLabel || !nextEndpoint) {
      setError("Provider, account label, and endpoint are required.");
      return;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(nextProvider)) {
      setError("Provider must be lowercase letters, digits, or hyphens, and start with a letter.");
      return;
    }

    busyRef.current = true;
    setBusy(true);
    setError(null);
    if (nextTransport !== transport) setTransport(nextTransport);

    const credential = nextCredentialValue.trim()
      ? {
          credential_name: nextCredentialName || (nextTransport === "http" ? "Authorization" : "MCP_TOKEN"),
          credential_value: nextCredentialValue,
        }
      : {};
    const input: SaveCompanionPluginInput = nextTransport === "http"
      ? {
          provider: nextProvider,
          label: nextLabel,
          transport: nextTransport,
          url: nextEndpoint,
          args: [],
          ...credential,
        }
      : {
          provider: nextProvider,
          label: nextLabel,
          transport: nextTransport,
          command: nextEndpoint,
          args: nextArgs ? nextArgs.split(/\s+/) : [],
          ...credential,
        };

    try {
      const account = await saveCompanionPlugin(orgId, input);
      onAdded(account);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This MCP account could not be connected.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      icon="plug-zap"
      title="Add custom MCP"
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
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Connecting..." : "Connect MCP"}
          </button>
        </>
      )}
    >
      {error && <div className="companions-error" role="alert">{error}</div>}
      <form
        id="companion-plugin-create"
        ref={formRef}
        className="companions-plugin-form"
        noValidate
        autoComplete="off"
        onSubmit={(event) => void onSubmit(event)}
      >
        <div className="companions-plugin-form__pair">
          <label>
            Provider
            <input
              name="provider"
              autoFocus
              required
              maxLength={63}
              placeholder="e.g. linear"
              title="Lowercase letters, digits, and hyphens; must start with a letter"
              autoComplete="off"
            />
          </label>
          <label>
            Account label
            <input
              name="label"
              required
              maxLength={40}
              placeholder="e.g. work"
              autoComplete="off"
            />
          </label>
        </div>
        <label>
          Transport
          <select
            name="transport"
            value={transport}
            onChange={(event) => {
              const next = event.target.value as "http" | "stdio";
              setTransport(next);
              const form = formRef.current;
              if (!form) return;
              const endpointInput = form.elements.namedItem("endpoint");
              const argsInput = form.elements.namedItem("args");
              const credNameInput = form.elements.namedItem("credential_name");
              if (endpointInput instanceof HTMLInputElement) endpointInput.value = "";
              if (argsInput instanceof HTMLInputElement) argsInput.value = "";
              if (credNameInput instanceof HTMLInputElement) {
                credNameInput.value = next === "http" ? "Authorization" : "MCP_TOKEN";
              }
            }}
          >
            <option value="http">HTTP</option>
            <option value="stdio">Command (stdio)</option>
          </select>
        </label>
        <label>
          {transport === "http" ? "MCP URL" : "Command"}
          <input
            name="endpoint"
            required
            placeholder={transport === "http" ? "https://mcp.example.com" : "github-mcp-server"}
            autoComplete="off"
          />
        </label>
        {transport === "stdio" && (
          <label>
            Arguments
            <input
              name="args"
              placeholder="stdio"
              autoComplete="off"
            />
          </label>
        )}
        <div className="companions-plugin-form__pair">
          <label>
            {transport === "http" ? "Auth header" : "Secret environment variable"}
            <input
              name="credential_name"
              key={`credential-name-${transport}`}
              defaultValue={transport === "http" ? "Authorization" : "MCP_TOKEN"}
              placeholder={transport === "http" ? "Authorization" : "MCP_TOKEN"}
              autoComplete="off"
            />
          </label>
          <label>
            Credential
            <input
              type="password"
              name="credential_value"
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

/** Connect one product-curated plugin through its brokered OAuth flow. */
function CatalogConnectDialog({
  orgId,
  server,
  onClose,
}: {
  orgId: string;
  server: CompanionPluginCatalogEntry;
  onClose: () => void;
}) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    const trimmed = label.trim();
    if (!trimmed) {
      setError("An account label is required.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let redirecting = false;
    try {
      const authorizationUrl = await startCompanionPluginOAuth(orgId, {
        server_name: companionPluginOAuthServerNameSchema.parse(server.server_name),
        label: trimmed,
      });
      window.location.assign(authorizationUrl);
      redirecting = true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "This MCP account could not be connected.");
    } finally {
      if (!redirecting) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  return (
    <Dialog
      icon="plug-zap"
      title={`Connect ${server.title}`}
      desc="Give this account a short label such as work or personal."
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
            form="companion-catalog-connect"
            className="cds-btn cds-btn--primary cds-btn--md"
            disabled={busy}
            aria-busy={busy}
          >
            {busy ? "Connecting..." : "Continue with OAuth"}
          </button>
        </>
      )}
    >
      {error && <div className="companions-error" role="alert">{error}</div>}
      <form
        id="companion-catalog-connect"
        className="companions-plugin-form"
        noValidate
        autoComplete="off"
        onSubmit={(event) => void onSubmit(event)}
      >
        <label>
          Account label
          <input
            value={label}
            autoFocus
            required
            maxLength={40}
            placeholder="e.g. work"
            autoComplete="off"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <p className="companions-new-form__hint">
          You will authorize this account on the provider&apos;s website. Tokens remain write-only
          and encrypted.
        </p>
      </form>
    </Dialog>
  );
}

function CatalogPluginCard({
  server,
  onConnect,
}: {
  server: CompanionPluginCatalogEntry;
  onConnect: (server: CompanionPluginCatalogEntry) => void;
}) {
  return (
    <article className="companions-catalog-card">
      <span className="companions-plugin-icon" aria-hidden="true">
        {server.title.slice(0, 1).toLocaleUpperCase("en-US")}
      </span>
      <div className="companions-catalog-card__body">
        <strong>{server.title}</strong>
        {server.description && <p>{server.description}</p>}
      </div>
      <button
        type="button"
        className="cds-btn cds-btn--secondary cds-btn--sm"
        onClick={() => onConnect(server)}
      >
        Connect
      </button>
    </article>
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
  const [connecting, setConnecting] = useState<CompanionPluginCatalogEntry | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oauthNotice, setOauthNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("oauth") === "connected") {
      setOauthNotice({ tone: "success", message: "MCP account connected." });
    } else {
      const oauthError = url.searchParams.get("oauth_error");
      if (oauthError) {
        setOauthNotice({
          tone: "error",
          message: oauthError === "duplicate_label"
            ? "That provider already has an account with this label."
            : "OAuth authorization did not complete. Try connecting again.",
        });
      }
    }
    if (url.searchParams.has("oauth") || url.searchParams.has("oauth_error")) {
      url.searchParams.delete("oauth");
      url.searchParams.delete("oauth_error");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

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
            <p>Connect approved plugins or add a custom MCP server.</p>
          </div>
        </div>
        <button
          type="button"
          className="cds-btn cds-btn--secondary cds-btn--md"
          onClick={() => setAdding(true)}
        >
          <Icon name="plus" size={15} /> Add custom MCP
        </button>
      </header>

      <div className="companions-content">
        {oauthNotice?.tone === "success" && (
          <p className="companions-catalog-note" role="status">{oauthNotice.message}</p>
        )}
        {oauthNotice?.tone === "error" && (
          <div className="companions-error" role="alert">{oauthNotice.message}</div>
        )}
        {error && <div className="companions-error" role="alert">{error}</div>}

        <section className="companions-plugin-section" aria-label="Connected accounts">
          <h2 className="companions-plugin-section__title">Connected</h2>
          {groups.length === 0 ? (
            <p className="companions-catalog-note">No plugins connected yet.</p>
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
        </section>

        <section className="companions-plugin-section" aria-label="Available plugins">
          <h2 className="companions-plugin-section__title">Available plugins</h2>
          <div className="companions-catalog-grid">
            {COMPANION_PLUGIN_CATALOG.map((server) => (
              <CatalogPluginCard
                key={server.server_name}
                server={server}
                onConnect={setConnecting}
              />
            ))}
          </div>
        </section>
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

      {connecting && (
        <CatalogConnectDialog
          orgId={orgId}
          server={connecting}
          onClose={() => setConnecting(null)}
        />
      )}
    </section>
  );
}
