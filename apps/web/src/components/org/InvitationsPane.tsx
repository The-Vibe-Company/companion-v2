"use client";

import { useState } from "react";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import { RoleDot } from "./primitives";
import { orgRole } from "./roles";
import type { Invite, OrgCtx } from "./model";

/** Shareable join link for a pending invite, using the current host (SSR-safe fallback). */
function joinLink(token: string): string {
  const host = typeof window !== "undefined" ? window.location.host : "companion.dev";
  return `https://${host}/join/${token}`;
}

/**
 * Workspace › Invitations — pending invites to join the workspace. Managers can copy the
 * join link or revoke; non-managers see a lock bar. People move to Members on accept.
 * (Resend isn't wired yet — there's no resend RPC — so it isn't surfaced.)
 */
export function InvitationsPane({
  ctx,
  invites,
  onInvite,
}: {
  ctx: OrgCtx;
  invites: Invite[];
  onInvite: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(joinLink(token));
      // The inline "Copied" label on the button is the visible feedback.
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 1600);
    } catch {
      ctx.setError("Could not copy the invite link");
    }
  };

  return (
    <div className="sx-pane">
      <PaneHead
        title="Invitations"
        desc="Pending invites to join the workspace. People appear as members once they accept."
        action={
          ctx.canManage && (
            <button className="btn-primary" onClick={onInvite}>
              <Icon name="user-plus" size={14} />
              Invite members
            </button>
          )
        }
      />

      {!ctx.canManage && (
        <div className="og-lockbar">
          <Icon name="lock" size={13} />
          Only owners and admins can send or revoke invitations.
        </div>
      )}

      {invites.length === 0 ? (
        <div className="sx-empty">No pending invitations. Invite teammates to get them into the workspace.</div>
      ) : (
        <>
          <div className="mlist__lbl">
            <span>{invites.length} pending</span>
          </div>
          <div className="mlist">
            {invites.map((inv) => (
              <div className="mrow" key={inv.id}>
                <span className="og-invrow__ic">
                  <Icon name="mail" size={14} />
                </span>
                <div className="mrow__id">
                  <div className="og-invrow__email">{inv.email}</div>
                  <div className="og-invrow__sub">
                    Invited {inv.invited}
                    {inv.by && ` · by ${inv.by}`}
                  </div>
                </div>
                <div className="mrow__end">
                  <span className="mrole">
                    <RoleDot role={inv.role} />
                    {orgRole(inv.role).label}
                  </span>
                  <button className="og-copylink" onClick={() => copy(inv.token)}>
                    <Icon name={copied === inv.token ? "check" : "link-2"} size={13} />
                    {copied === inv.token ? "Copied" : "Copy link"}
                  </button>
                  <button
                    className="mrow__x"
                    style={{ opacity: 1 }}
                    title="Revoke invite"
                    disabled={!ctx.canManage}
                    onClick={() => ctx.revokeInvite(ctx.currentOrg.id, inv.id)}
                  >
                    <Icon name="x" size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
