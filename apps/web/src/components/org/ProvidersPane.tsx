"use client";

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import { deleteProviderConnection, fetchAgentModels, setProviderConnection } from "@/lib/agentQueries";
import { toModelProviders, type ModelProviderVM } from "@/components/agents/derive";

/* ============================ Account › Model providers ============================
   Personal AI-provider keys, lifted out of the create-agent flow into a discoverable home.
   Connect a provider once and every agent you create can use its models — the key is
   referenced live at run time, never copied onto an agent or shown as a variable. */
export function ProvidersPane() {
  const [providers, setProviders] = useState<ModelProviderVM[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let live = true;
    fetchAgentModels()
      .then((r) => live && setProviders(toModelProviders(r)))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load providers."));
    return () => {
      live = false;
    };
  }, [tick]);

  const connected = providers?.filter((p) => p.connected) ?? [];
  const available = providers?.filter((p) => !p.connected && p.envKeys.length > 0) ?? [];

  const disconnect = async (id: string) => {
    setError(null);
    try {
      await deleteProviderConnection(id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect.");
    }
  };

  return (
    <div className="sx-pane">
      <PaneHead
        title="Model providers"
        desc="Connect the AI providers your agents run on. Your key is stored encrypted, used only to run your agents, and never shown again."
      />

      <div className="og-lockbar og-lockbar--wide" style={{ marginBottom: 18 }}>
        <Icon name="shield-check" size={13} />
        <span>Keys are personal to you and stored encrypted — Companion never displays them again.</span>
      </div>

      {error && (
        <div className="sx-empty" role="alert" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {providers === null ? (
        <div className="sx-empty">Loading providers…</div>
      ) : (
        <>
          {connected.length > 0 && (
            <>
              <div className="mlist__lbl">
                <span>
                  {connected.length} connected
                </span>
              </div>
              <div className="mlist">
                {connected.map((p) => (
                  <div className="mrow" key={p.id}>
                    <span className="keyic">
                      <Icon name="cpu" size={16} />
                    </span>
                    <div className="mrow__id">
                      <div className="og-mname">{p.name}</div>
                    </div>
                    <div className="mrow__end">
                      <span className="badge scopebadge">Connected</span>
                      <button className="mrow__x" title={`Disconnect ${p.name}`} onClick={() => void disconnect(p.id)}>
                        <Icon name="trash-2" size={15} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          <div className="mlist__lbl" style={{ marginTop: connected.length ? 16 : 0 }}>
            <span>Available</span>
          </div>
          {available.length === 0 ? (
            <div className="sx-empty">Every provider is connected.</div>
          ) : (
            <div className="mlist">
              {available.map((p) =>
                connecting === p.id ? (
                  <ConnectRow
                    key={p.id}
                    provider={p}
                    onCancel={() => setConnecting(null)}
                    onConnected={() => {
                      setConnecting(null);
                      reload();
                    }}
                    onError={setError}
                  />
                ) : (
                  <div className="mrow" key={p.id}>
                    <span className="keyic">
                      <Icon name="cpu" size={16} />
                    </span>
                    <div className="mrow__id">
                      <div className="og-mname">{p.name}</div>
                    </div>
                    <div className="mrow__end">
                      <button className="btn-sec" onClick={() => setConnecting(p.id)}>
                        Connect
                      </button>
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** Inline key entry for one provider — a password field + Connect/Cancel; the env var name is never shown. */
function ConnectRow({
  provider,
  onCancel,
  onConnected,
  onError,
}: {
  provider: ModelProviderVM;
  onCancel: () => void;
  onConnected: () => void;
  onError: (message: string | null) => void;
}) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    onError(null);
    try {
      await setProviderConnection({ provider: provider.id, key_name: provider.envKeys[0]!, key: key.trim() });
      onConnected();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not save the key.");
      setBusy(false);
    }
  };
  return (
    <div className="mrow" style={{ flexWrap: "wrap", gap: 8 }}>
      <span className="keyic">
        <Icon name="cpu" size={16} />
      </span>
      <div className="mrow__id">
        <div className="og-mname">{provider.name}</div>
      </div>
      <div className="mrow__end" style={{ gap: 8, flexWrap: "wrap" }}>
        <input
          className="sx-input"
          type="password"
          autoFocus
          placeholder={`Your ${provider.name} API key`}
          aria-label={`API key for ${provider.name}`}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
          }}
          style={{ minWidth: 220 }}
        />
        <button className="btn-primary" disabled={!key.trim() || busy} onClick={() => void save()}>
          Connect
        </button>
        <button className="btn-sec" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
