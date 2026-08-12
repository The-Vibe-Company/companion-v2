"use client";

import { type FormEvent, useEffect, useState } from "react";
import type {
  Companion,
  CompanionShareRole,
  CompanionShares,
} from "@companion/contracts";
import {
  getCompanionShares,
  inviteCompanionMember,
  revokeCompanionMember,
  setCompanionWorkspaceShare,
  updateCompanionMemberRole,
} from "@/lib/companions";
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
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<CompanionShareRole>("viewer");
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

  const invite = async (event: FormEvent) => {
    event.preventDefault();
    await run(() => inviteCompanionMember(orgId, companion.id, email.trim(), role));
    setEmail("");
  };

  return (
    <Dialog
      icon="users"
      title={`Share ${companion.name}`}
      desc="Give workspace members access to this Companion."
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
          <span>Applies to every current member unless they have a member-specific role.</span>
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

      <form className="companions-share-invite" onSubmit={invite}>
        <label>
          Invite workspace member
          <input
            required
            type="email"
            maxLength={320}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="teammate@company.com"
          />
        </label>
        <label>
          Role
          <select
            value={role}
            onChange={(event) => setRole(event.target.value as CompanionShareRole)}
          >
            <option value="viewer">Viewer</option>
            <option value="editor">Editor</option>
          </select>
        </label>
        <button
          type="submit"
          className="cds-btn cds-btn--primary cds-btn--md"
          disabled={busy || !email.trim()}
        >
          {busy ? "Saving..." : "Invite"}
        </button>
      </form>

      <div className="companions-share-members" aria-busy={!shares}>
        <h4>People with access</h4>
        {!shares ? (
          <p>Loading access...</p>
        ) : (
          shares.members.map((member) => (
            <div className="companions-share-member" key={member.user_id}>
              <div>
                <strong>{member.name}</strong>
                <span>{member.email}</span>
              </div>
              {member.is_owner ? (
                <span className="companions-role">Owner</span>
              ) : (
                <div className="companions-share-member-actions">
                  <select
                    aria-label={`${member.name} role`}
                    value={member.role}
                    disabled={busy}
                    onChange={(event) => void run(() => updateCompanionMemberRole(
                      orgId,
                      companion.id,
                      member.user_id,
                      event.target.value as CompanionShareRole,
                    ))}
                  >
                    <option value="viewer">Viewer</option>
                    <option value="editor">Editor</option>
                  </select>
                  <button
                    type="button"
                    className="cds-btn cds-btn--ghost cds-btn--sm"
                    disabled={busy}
                    onClick={() => void run(() => revokeCompanionMember(
                      orgId,
                      companion.id,
                      member.user_id,
                    ))}
                  >
                    Revoke
                  </button>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </Dialog>
  );
}
