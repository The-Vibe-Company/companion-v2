"use client";

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import { deleteProviderConnection, fetchProviderConnections, setProviderConnection } from "@/lib/runQueries";

/* ============================ Account › Artifacts (Vanish) ============================
   The member's Vanish API key. Its presence ENABLES artifact publishing for their skill runs:
   files the agent saves into artifacts/ are collected server-side and published to vanish.sh as
   shareable links. Stored like a provider connection (write-only, envelope-encrypted) under the
   reserved provider id "vanish" — which never appears in the model picker. */

export function ArtifactsPane() {
  const [connected, setConnected] = useState<boolean | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    fetchProviderConnections()
      .then((r) => live && setConnected(r.connections.some((cn) => cn.provider === "vanish")))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load the artifacts settings."));
    return () => {
      live = false;
    };
  }, [tick]);

  const save = async () => {
    if (!key.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setProviderConnection({ provider: "vanish", key_name: "VANISH_API_KEY", key: key.trim() });
      setKey("");
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the key.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await deleteProviderConnection("vanish");
      setTick((t) => t + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not disconnect.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sx-pane">
      <PaneHead
        title="Artifacts (Vanish)"
        desc="Add your Vanish API key to let skill runs publish shareable artifact links. Files the agent saves into artifacts/ are collected after each reply and uploaded to vanish.sh."
      />

      <div className="og-lockbar og-lockbar--wide" style={{ marginBottom: 18 }}>
        <Icon name="shield-check" size={13} />
        <span>
          Your key is stored encrypted and used only on the server to publish artifacts — it never enters a sandbox.
        </span>
      </div>

      {error && (
        <div className="sx-empty" role="alert" style={{ color: "var(--color-danger)" }}>
          {error}
        </div>
      )}

      {connected === null ? (
        <div className="sx-empty">Loading…</div>
      ) : connected ? (
        <div className="mlist">
          <div className="mrow">
            <span className="keyic">
              <Icon name="link-2" size={16} />
            </span>
            <div className="mrow__id">
              <div className="og-mname">Vanish</div>
            </div>
            <div className="mrow__end">
              <span className="badge scopebadge">Connected</span>
              <button className="mrow__x" title="Disconnect Vanish" onClick={() => void disconnect()}>
                <Icon name="trash-2" size={15} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mlist">
          <div className="mrow" style={{ flexWrap: "wrap", gap: 8 }}>
            <span className="keyic">
              <Icon name="link-2" size={16} />
            </span>
            <div className="mrow__id">
              <div className="og-mname">Vanish</div>
            </div>
            <div className="mrow__end" style={{ gap: 8, flexWrap: "wrap" }}>
              <input
                className="sx-input"
                type="password"
                placeholder="Your Vanish API key"
                aria-label="Vanish API key"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void save();
                }}
                style={{ minWidth: 220 }}
              />
              <button className="btn-primary" disabled={!key.trim() || busy} onClick={() => void save()}>
                Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
