"use client";

import { useState } from "react";
import type { OrgRole } from "@companion/contracts";
import { Icon } from "../Icon";
import { Dialog, RoleDot } from "./primitives";
import { ORG_ROLE_ORDER, orgRole } from "./roles";
import type { OrgCtx } from "./model";

/**
 * Invite-to-workspace dialog. On submit it fires `ctx.inviteMember` (which routes
 * the surface to Invitations on success) and closes.
 */
export function InviteDialog({ ctx, onClose }: { ctx: OrgCtx; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("developer");
  const [acknowledgeSeatBilling, setAcknowledgeSeatBilling] = useState(false);
  const requiresSeatConsent = ctx.billing?.billingEnabled && ctx.billing.entitlements.computedPlan === "pro";
  const order = (ctx.isOwner ? ORG_ROLE_ORDER : ORG_ROLE_ORDER.filter((r) => r !== "owner")).slice().reverse();
  const valid = /\S+@\S+\.\S+/.test(email) && (!requiresSeatConsent || acknowledgeSeatBilling);
  const submit = () => {
    if (!valid) return;
    void ctx.inviteMember(ctx.currentOrg.id, email.trim(), role, acknowledgeSeatBilling);
    onClose();
  };
  return (
    <Dialog
      icon="user-plus"
      title={`Invite to ${ctx.currentOrg.name}`}
      desc="Send an invite to join the workspace. They'll appear under Invitations until they accept."
      onClose={onClose}
      foot={
        <>
          <span className="og-spacer" />
          <button className="btn-sec" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!valid} onClick={submit}>
            <Icon name="send" size={14} />
            Send invite
          </button>
        </>
      }
    >
      <div className="og-field">
        <label className="og-field__label">Email address</label>
        <input
          className="sx-input sx-input--mono"
          autoFocus
          placeholder="name@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </div>
      <div className="og-field">
        <label className="og-field__label">Role</label>
        <div className="og-seg">
          {order.map((r) => (
            <button key={r} className={"og-seg__btn" + (role === r ? " is-on" : "")} onClick={() => setRole(r)}>
              <RoleDot role={r} />
              {orgRole(r).label}
            </button>
          ))}
        </div>
        <span className="og-field__hint">{orgRole(role).desc}</span>
      </div>
      {requiresSeatConsent && (
        <label className="sx-billing-consent">
          <input type="checkbox" checked={acknowledgeSeatBilling} onChange={(event) => setAcknowledgeSeatBilling(event.target.checked)} />
          <span>An accepted invitation adds one $10 USD/month seat. Stripe prorates the change for the current billing period.</span>
        </label>
      )}
    </Dialog>
  );
}
