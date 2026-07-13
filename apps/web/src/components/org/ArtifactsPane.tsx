"use client";

import { useEffect, useState } from "react";
import type { ProviderConnectionRow, SecretRow } from "@companion/contracts";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import { fetchSecrets } from "@/lib/secrets";
import { VaultSecretField, secretReferenceFromRow, type VaultSecretReference } from "../secrets/VaultSecretField";

/** One Vanish binding scope. Both variants reference the generic vault and never own its secrets. */
export interface ArtifactScope {
  id: "personal" | "organization";
  orgId: string;
  title: string;
  desc: string;
  lockText: string;
  /** Workspace members can inspect the shared binding, but only owners/admins may change it. */
  locked: boolean;
  loadConnected: () => Promise<ProviderConnectionRow[]>;
  connect: (provider: string, keyName: string, secretId: string) => Promise<ProviderConnectionRow>;
  disconnect: (provider: string) => Promise<void>;
}

/** Keep the workspace selector organization-only even when the actor can access other audiences. */
export function selectArtifactSecretReferences(
  rows: SecretRow[],
  scopeId: ArtifactScope["id"],
): VaultSecretReference[] {
  return rows
    .filter(
      (secret) =>
        secret.can_use &&
        !secret.disabled_at &&
        !secret.deleted_at &&
        (scopeId !== "organization" || secret.audience === "organization"),
    )
    .map(secretReferenceFromRow);
}

/** Scoped Vanish binding. Disconnect removes only the binding, never the referenced vault secret. */
export function ArtifactsPane({ scope }: { scope: ArtifactScope }) {
  const [connection, setConnection] = useState<ProviderConnectionRow | null>(null);
  const [secrets, setSecrets] = useState<VaultSecretReference[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadedSuccessfully, setLoadedSuccessfully] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    const secretsRequest = scope.locked ? Promise.resolve([] as SecretRow[]) : fetchSecrets(scope.orgId);
    Promise.all([scope.loadConnected(), secretsRequest])
      .then(([connections, rows]) => {
        if (!live) return;
        setConnection(connections.find((candidate) => candidate.provider === "vanish") ?? null);
        setSecrets(selectArtifactSecretReferences(rows, scope.id));
        setLoadedSuccessfully(true);
      })
      .catch((cause) => live && setError(cause instanceof Error ? cause.message : "Could not load artifact settings."))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
    // Each scope is keyed by SettingsView; tick is the only in-place reload trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope.id, scope.locked, scope.orgId, tick]);

  const connect = async () => {
    if (!selected || busy || scope.locked) return;
    setBusy(true);
    setError(null);
    try {
      const nextConnection = await scope.connect("vanish", "VANISH_API_KEY", selected);
      setConnection(nextConnection);
      setSelected(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not bind the Vanish secret.");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (busy || scope.locked) return;
    setBusy(true);
    setError(null);
    try {
      await scope.disconnect("vanish");
      setConnection(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not disconnect Vanish.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sx-pane">
      <PaneHead
        title={scope.title}
        desc={scope.desc}
      />

      <div className="og-lockbar og-lockbar--wide" style={{ marginBottom: 18 }}>
        <Icon name="shield-check" size={13} />
        <span>{scope.lockText}</span>
      </div>

      {error && (
        <div className="sx-empty settings-load-error" role="alert">
          <span>{error}</span>
          <button type="button" className="btn-sec" onClick={() => setTick((value) => value + 1)}>Retry</button>
        </div>
      )}

      {loading && !loadedSuccessfully ? (
        <div className="mlist" aria-label={`Loading ${scope.title}`}>
          <div className="mrow" style={{ opacity: 0.55 }}><span className="keyic" /><div className="mrow__id">Loading vault references…</div></div>
        </div>
      ) : !loadedSuccessfully ? null : connection ? (
        <div className="mlist">
          <div className="mrow">
            <span className="keyic"><Icon name="link-2" size={16} /></span>
            <div className="mrow__id">
              <div className="og-mname">Vanish</div>
              <div className="og-memail">{connection.secret_name} · {connection.secret_audience} · {connection.secret_owner_name}</div>
            </div>
            <div className="mrow__end">
              <span className="badge scopebadge">Connected</span>
              {!scope.locked && (
                <button
                  type="button"
                  className="mrow__x"
                  title="Disconnect Vanish; keep the vault secret"
                  aria-label="Disconnect Vanish; keep the vault secret"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  <Icon name="trash-2" size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      ) : scope.locked ? (
        <div className="sx-empty">Vanish is not connected for this workspace. Ask a workspace owner or admin to connect it.</div>
      ) : (
        <div className="artifact-secret-bind">
          <VaultSecretField
            orgId={scope.orgId}
            envKey="VANISH_API_KEY"
            candidates={secrets}
            value={selected}
            onChange={setSelected}
            required
            label="Vanish credential"
            helper="Used by Companion after a reply to publish artifacts. The value does not enter the skill sandbox."
            audience={scope.id}
            onCreated={(secret) => setSecrets((rows) => [...rows, secret])}
          />
          <button type="button" className="btn-primary" disabled={!selected || busy} onClick={() => void connect()}>
            {busy ? "Connecting…" : "Connect Vanish"}
          </button>
        </div>
      )}
    </div>
  );
}
