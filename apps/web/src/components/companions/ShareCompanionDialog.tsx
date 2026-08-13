"use client";

import { useEffect, useState } from "react";
import type {
  Companion,
  CompanionShareRole,
  CompanionShares,
} from "@companion/contracts";
import { getCompanionShares, setCompanionWorkspaceShare } from "@/lib/companions";
import { Dialog } from "../org/primitives";

export function ShareCompanionDialog({
  orgId,
  companion,
  onClose,
}: {
  orgId: string;
  companion: Companion;
  onClose: () => void;
}) {
  const [shares, setShares] = useState<CompanionShares | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getCompanionShares(orgId, companion.id)
      .then((result) => {
        if (active) setShares(result);
      })
      .catch((cause) => {
        if (active) setError(cause instanceof Error ? cause.message : "Sharing could not be loaded.");
      });
    return () => {
      active = false;
    };
  }, [companion.id, orgId]);

  const run = async (action: () => Promise<CompanionShares>) => {
    setBusy(true);
    setError(null);
    try {
      setShares(await action());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sharing could not be updated.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      icon="users"
      title={`Share ${companion.name}`}
      desc="Give every workspace member access to this Companion."
      onClose={onClose}
      closeDisabled={busy}
      className="og-dialog companions-share-dialog"
      foot={(
        <button type="button" className="cds-btn cds-btn--secondary cds-btn--md" onClick={onClose}>
          Done
        </button>
      )}
    >
      {error && <div className="companions-error" role="alert">{error}</div>}

      <div className="companions-share-workspace">
        <div>
          <strong>Workspace access</strong>
          <span>Applies to every current member of the workspace.</span>
        </div>
        <select
          aria-label="Workspace access"
          value={shares?.workspace_role ?? "private"}
          disabled={!shares || busy}
          onChange={(event) => {
            const value = event.target.value;
            void run(() => setCompanionWorkspaceShare(
              orgId,
              companion.id,
              value === "private" ? null : value as CompanionShareRole,
            ));
          }}
        >
          <option value="private">Private</option>
          <option value="viewer">Viewer</option>
          <option value="editor">Editor</option>
        </select>
      </div>
    </Dialog>
  );
}
