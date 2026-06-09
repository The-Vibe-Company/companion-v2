"use client";

import { useState } from "react";
import type { OrgRole } from "@companion/contracts";
import { Icon } from "../Icon";
import { Dialog, RoleDot } from "./primitives";
import { ORG_ROLE_ORDER, orgRole } from "./roles";
import type { OrgCtx } from "./model";

function slugify(s: string): string {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Invite-to-workspace dialog. On submit it fires `ctx.inviteMember` (which routes
 * the surface to Invitations on success) and closes.
 */
export function InviteDialog({ ctx, onClose }: { ctx: OrgCtx; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("developer");
  const order = (ctx.isOwner ? ORG_ROLE_ORDER : ORG_ROLE_ORDER.filter((r) => r !== "owner")).slice().reverse();
  const valid = /\S+@\S+\.\S+/.test(email);
  const submit = () => {
    if (!valid) return;
    void ctx.inviteMember(ctx.currentOrg.id, email.trim(), role);
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
    </Dialog>
  );
}

/**
 * Create-team dialog. On submit it fires `ctx.createTeam` (which expands the new
 * team and routes to its General pane on success) and closes.
 */
export function CreateTeamDialog({ ctx, onClose }: { ctx: OrgCtx; onClose: () => void }) {
  const [name, setName] = useState("");
  const valid = name.trim().length >= 2;
  const submit = () => {
    if (!valid) return;
    void ctx.createTeam(ctx.currentOrg.id, name.trim());
    onClose();
  };
  return (
    <Dialog
      icon="layers"
      title="New team"
      desc="Create a team inside the workspace. You'll be its first admin."
      onClose={onClose}
      foot={
        <>
          <span className="og-spacer" />
          <button className="btn-sec" onClick={onClose}>
            Cancel
          </button>
          <button className="btn-primary" disabled={!valid} onClick={submit}>
            <Icon name="plus" size={14} />
            Create team
          </button>
        </>
      }
    >
      <div className="og-field">
        <label className="og-field__label">Team name</label>
        <input
          className="sx-input"
          autoFocus
          placeholder="Platform"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        <span className="og-field__hint">
          {name.trim()
            ? "Scope: team/" + slugify(name)
            : "Scopes skills and groups members. Add people after creating it."}
        </span>
      </div>
    </Dialog>
  );
}
