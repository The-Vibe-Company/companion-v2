"use client";

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import { fetchModels } from "@/lib/runQueries";
import { toModelProviders, type ModelProviderVM } from "@/components/runs/derive";

/* ============================ Model providers (personal + workspace) ============================
   One component, two scopes. Personal keys live under Account; workspace-shared keys under the
   Workspace group (owner/admin write, everyone else read-only). Connecting a provider enables its
   models in the run launcher — the key is resolved live at serve time, never copied onto a run. */

export interface ProviderScope {
  title: string;
  desc: string;
  lockText: string;
  /** Read-only: show connected providers but no connect/disconnect (non-admins on the workspace scope). */
  locked: boolean;
  /** Provider ids connected in THIS scope (personal list, or the org's shared list). */
  loadConnected: () => Promise<Set<string>>;
  connect: (provider: string, keyName: string, key: string) => Promise<void>;
  disconnect: (provider: string) => Promise<void>;
}

export function ProvidersPane({ scope }: { scope: ProviderScope }) {
  const [providers, setProviders] = useState<ModelProviderVM[] | null>(null);
  const [connectedIds, setConnectedIds] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const reload = () => setTick((t) => t + 1);

  useEffect(() => {
    let live = true;
    Promise.all([fetchModels(), scope.loadConnected()])
      .then(([catalog, ids]) => {
        if (!live) return;
        setProviders(toModelProviders(catalog));
        setConnectedIds(ids);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load providers."));
    return () => {
      live = false;
    };
    // scope.loadConnected identity is stable per render; tick drives reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  const connected = (providers ?? []).filter((p) => connectedIds.has(p.id));
  const available = (providers ?? []).filter((p) => !connectedIds.has(p.id) && p.envKeys.length > 0);

  const disconnect = async (id: string) => {
    setError(null);
    try {
      await scope.disconnect(id);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect.");
    }
  };

  return (
    <div className="sx-pane">
      <PaneHead title={scope.title} desc={scope.desc} />

      <div className="og-lockbar og-lockbar--wide" style={{ marginBottom: 18 }}>
        <Icon name="shield-check" size={13} />
        <span>{scope.lockText}</span>
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
                <span>{connected.length} connected</span>
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
                      {!scope.locked && (
                        <button className="mrow__x" title={`Disconnect ${p.name}`} onClick={() => void disconnect(p.id)}>
                          <Icon name="trash-2" size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {scope.locked ? (
            connected.length === 0 && <div className="sx-empty">Your workspace hasn’t shared any providers yet.</div>
          ) : (
            <>
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
                        onConnect={scope.connect}
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
        </>
      )}
    </div>
  );
}

/** Inline key entry for one provider — a password field + Connect/Cancel; the env var name is never shown. */
function ConnectRow({
  provider,
  onConnect,
  onCancel,
  onConnected,
  onError,
}: {
  provider: ModelProviderVM;
  onConnect: (provider: string, keyName: string, key: string) => Promise<void>;
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
      await onConnect(provider.id, provider.envKeys[0]!, key.trim());
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
