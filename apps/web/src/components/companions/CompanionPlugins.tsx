"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  CompanionPluginAccount,
  CompanionRegistryConnect,
  CompanionRegistryServer,
  CompanionRegistrySource,
  SaveCompanionPluginInput,
} from "@companion/contracts";
import { companionPluginOAuthServerNameSchema } from "@companion/contracts";
import {
  deleteCompanionPlugin,
  getCompanionRegistryServer,
  listCompanionRegistry,
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

function connectSummary(connect: CompanionRegistryConnect): string {
  return connect.transport === "http" ? connect.url : [connect.command, ...connect.args].join(" ");
}

/** Map registry connect metadata plus the user's label and secret into a THE-321 save input. */
function toSaveInput(
  server: CompanionRegistryServer,
  connect: CompanionRegistryConnect,
  label: string,
  credentialValue: string,
): SaveCompanionPluginInput {
  const credential = connect.credential && credentialValue.trim()
    ? { credential_name: connect.credential.name, credential_value: credentialValue }
    : {};
  if (connect.transport === "http") {
    return {
      provider: server.provider,
      label,
      transport: "http",
      url: connect.url,
      args: [],
      ...credential,
    };
  }
  return {
    provider: server.provider,
    label,
    transport: "stdio",
    command: connect.command,
    args: connect.args,
    ...credential,
  };
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

/**
 * Connect a registry server with a required label. The provider and endpoint come from registry
 * metadata (freshened by a detail read for non-pinned servers); only the label and an optional
 * credential are entered here. Connecting reuses THE-321's save path, so the same server can be
 * connected several times under different labels and a duplicate label returns a 409.
 */
function RegistryConnectDialog({
  orgId,
  server,
  onConnected,
  onClose,
}: {
  orgId: string;
  server: CompanionRegistryServer;
  onConnected: (account: CompanionPluginAccount) => void;
  onClose: () => void;
}) {
  const [connect, setConnect] = useState<CompanionRegistryConnect | null>(server.connect);
  const [loadingDetail, setLoadingDetail] = useState(!server.pinned);
  const [label, setLabel] = useState("");
  const [credentialValue, setCredentialValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const oauth = companionPluginOAuthServerNameSchema.safeParse(server.name).success;

  useEffect(() => {
    if (server.pinned) return;
    let active = true;
    setLoadingDetail(true);
    void getCompanionRegistryServer(orgId, server.name)
      .then((detail) => {
        if (active && detail.server.connect) setConnect(detail.server.connect);
      })
      .catch(() => {
        // Keep the list metadata; the browse proxy already fell back to cache/pins if needed.
      })
      .finally(() => {
        if (active) setLoadingDetail(false);
      });
    return () => {
      active = false;
    };
  }, [orgId, server.name, server.pinned]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busyRef.current) return;
    const trimmed = label.trim();
    if (!trimmed) {
      setError("An account label is required.");
      return;
    }
    if (!connect) {
      setError("This server has no connectable endpoint yet. Use Add custom MCP instead.");
      return;
    }
    if (!oauth && connect.credential?.required && !credentialValue.trim()) {
      setError(`${connect.credential.name} is required for this server.`);
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    let redirecting = false;
    try {
      if (oauth) {
        const authorizationUrl = await startCompanionPluginOAuth(orgId, {
          server_name: companionPluginOAuthServerNameSchema.parse(server.name),
          label: trimmed,
        });
        window.location.assign(authorizationUrl);
        redirecting = true;
        return;
      }
      const account = await saveCompanionPlugin(
        orgId,
        toSaveInput(server, connect, trimmed, credentialValue),
      );
      onConnected(account);
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
            form="companion-registry-connect"
            className="cds-btn cds-btn--primary cds-btn--md"
            disabled={busy || loadingDetail || !connect}
            aria-busy={busy}
          >
            {busy ? "Connecting..." : oauth ? "Continue with OAuth" : "Connect"}
          </button>
        </>
      )}
    >
      {error && <div className="companions-error" role="alert">{error}</div>}
      <form
        id="companion-registry-connect"
        className="companions-plugin-form"
        noValidate
        autoComplete="off"
        onSubmit={(event) => void onSubmit(event)}
      >
        <dl className="companions-registry-meta">
          <div>
            <dt>Provider</dt>
            <dd>{server.provider}</dd>
          </div>
          <div>
            <dt>{connect?.transport === "stdio" ? "Command" : "Endpoint"}</dt>
            <dd className="companions-registry-meta__mono">
              {loadingDetail
                ? "Loading…"
                : connect
                  ? connectSummary(connect)
                  : "No connectable endpoint"}
            </dd>
          </div>
        </dl>
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
        {!oauth && connect?.credential && (
          <label>
            {connect.credential.name}
            {connect.credential.required ? "" : " (optional)"}
            <input
              type={connect.credential.is_secret ? "password" : "text"}
              value={credentialValue}
              placeholder={connect.credential.is_secret ? "Paste token" : "Value"}
              autoComplete="off"
              onChange={(event) => setCredentialValue(event.target.value)}
            />
            {connect.credential.description && (
              <span className="companions-registry-meta__hint">{connect.credential.description}</span>
            )}
          </label>
        )}
        <p className="companions-new-form__hint">
          {oauth
            ? "You will authorize this account on the provider's website. Tokens remain write-only and encrypted."
            : "Credentials are write-only and encrypted. Reconnect the account to replace one."}
        </p>
      </form>
    </Dialog>
  );
}

function RegistryServerCard({
  server,
  onConnect,
}: {
  server: CompanionRegistryServer;
  onConnect: (server: CompanionRegistryServer) => void;
}) {
  return (
    <article className="companions-registry-card">
      <span className="companions-plugin-icon" aria-hidden="true">
        {server.title.slice(0, 1).toLocaleUpperCase("en-US")}
      </span>
      <div className="companions-registry-card__body">
        <strong>
          {server.title}
          {server.pinned && <span className="companions-registry-pin">Verified</span>}
        </strong>
        {server.description && <p>{server.description}</p>}
      </div>
      <button
        type="button"
        className="cds-btn cds-btn--secondary cds-btn--sm"
        disabled={!server.connect}
        title={server.connect ? undefined : "No connectable endpoint yet"}
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
  const [connecting, setConnecting] = useState<CompanionRegistryServer | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [oauthNotice, setOauthNotice] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  const [searchInput, setSearchInput] = useState("");
  const [pins, setPins] = useState<CompanionRegistryServer[]>([]);
  const [servers, setServers] = useState<CompanionRegistryServer[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [source, setSource] = useState<CompanionRegistrySource | null>(null);
  const [registryLoading, setRegistryLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [registryError, setRegistryError] = useState<string | null>(null);
  const requestRef = useRef(0);

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

  const loadRegistry = useCallback(
    async (search: string, cursor: string | null, append: boolean) => {
      const requestId = ++requestRef.current;
      if (append) setLoadingMore(true);
      else setRegistryLoading(true);
      setRegistryError(null);
      try {
        const result = await listCompanionRegistry(orgId, {
          search: search || undefined,
          cursor: cursor || undefined,
        });
        if (requestId !== requestRef.current) return;
        setPins(result.pins);
        setServers((current) => append ? [...current, ...result.servers] : result.servers);
        setNextCursor(result.next_cursor);
        setSource(result.source);
      } catch (cause) {
        if (requestId !== requestRef.current) return;
        setRegistryError(
          cause instanceof Error ? cause.message : "The MCP registry could not be reached.",
        );
      } finally {
        if (requestId === requestRef.current) {
          setRegistryLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [orgId],
  );

  // Debounce the search box; each keystroke replaces the results from the first page.
  useEffect(() => {
    const query = searchInput.trim();
    const timer = setTimeout(() => void loadRegistry(query, null, false), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [searchInput, loadRegistry]);

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

  const onConnected = (account: CompanionPluginAccount) => {
    setAccounts((current) => [...current, account]);
    setConnecting(null);
  };

  const searching = searchInput.trim().length > 0;

  return (
    <section className="companions-plugins" aria-labelledby="plugins-title">
      <header className="companions-head companions-plugins__head">
        <div className="companions-plugins__title">
          <button type="button" className="iconbtn" aria-label="Back to Companions" onClick={onBack}>
            <Icon name="arrow-left" size={16} />
          </button>
          <div>
            <h1 id="plugins-title">Plugins</h1>
            <p>Browse the MCP registry and connect servers with labels.</p>
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
          <p className="companions-registry-note" role="status">{oauthNotice.message}</p>
        )}
        {oauthNotice?.tone === "error" && (
          <div className="companions-error" role="alert">{oauthNotice.message}</div>
        )}
        {error && <div className="companions-error" role="alert">{error}</div>}

        {groups.length > 0 && (
          <section className="companions-plugin-section" aria-label="Connected accounts">
            <h2 className="companions-plugin-section__title">Connected</h2>
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
          </section>
        )}

        {!searching && pins.length > 0 && (
          <section className="companions-plugin-section" aria-label="Recommended servers">
            <h2 className="companions-plugin-section__title">Recommended</h2>
            <div className="companions-registry-grid">
              {pins.map((server) => (
                <RegistryServerCard key={server.name} server={server} onConnect={setConnecting} />
              ))}
            </div>
          </section>
        )}

        <section className="companions-plugin-section" aria-label="Browse the MCP registry">
          <h2 className="companions-plugin-section__title">Browse the registry</h2>
          <label className="companions-search">
            <Icon name="search" size={15} />
            <input
              type="search"
              value={searchInput}
              placeholder="Search MCP servers"
              aria-label="Search MCP servers"
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>

          {source === "unavailable" && (
            <p className="companions-registry-note" role="status">
              The MCP registry is unavailable right now. Recommended servers above still work.
            </p>
          )}
          {registryError && <div className="companions-error" role="alert">{registryError}</div>}

          {registryLoading ? (
            <p className="companions-registry-note">Loading servers…</p>
          ) : servers.length === 0 ? (
            <p className="companions-registry-note">
              {searching ? "No servers match this search." : "No servers to browse right now."}
            </p>
          ) : (
            <>
              <div className="companions-registry-grid">
                {servers.map((server) => (
                  <RegistryServerCard key={server.name} server={server} onConnect={setConnecting} />
                ))}
              </div>
              {nextCursor && (
                <button
                  type="button"
                  className="cds-btn cds-btn--secondary cds-btn--md companions-registry-more"
                  disabled={loadingMore}
                  onClick={() => void loadRegistry(searchInput.trim(), nextCursor, true)}
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              )}
            </>
          )}
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
        <RegistryConnectDialog
          orgId={orgId}
          server={connecting}
          onConnected={onConnected}
          onClose={() => setConnecting(null)}
        />
      )}
    </section>
  );
}
