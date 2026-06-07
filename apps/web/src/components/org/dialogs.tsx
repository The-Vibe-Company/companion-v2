"use client";

import { useState } from "react";
import type { OrgRole } from "@companion/contracts";
import { Icon } from "../Icon";
import { Dialog, RoleDot } from "./primitives";
import { ORG_ROLE_ORDER, orgRole } from "./roles";
import type { OrgCtx, OrgFull } from "./model";

export function InviteDialog({ org, ctx, onClose }: { org: OrgFull; ctx: OrgCtx; onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<OrgRole>("developer");
  const order = ctx.isOwner ? ORG_ROLE_ORDER : ORG_ROLE_ORDER.filter((r) => r !== "owner");
  const valid = /\S+@\S+\.\S+/.test(email);
  const submit = () => {
    if (!valid) return;
    void ctx.inviteMember(org.id, email.trim(), role);
    onClose();
  };
  return (
    <Dialog
      icon="user-plus"
      title={`Invite to ${org.name}`}
      desc={`Send an invite to join ${org.name}. They'll appear as pending until they accept the link.`}
      onClose={onClose}
      foot={
        <>
          <span className="og-spacer" />
          <button className="og-btn" onClick={onClose}>Cancel</button>
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
          className="og-input og-input--mono"
          autoFocus
          placeholder="name@company.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
      </div>
      <div className="og-field">
        <label className="og-field__label">Role</label>
        <div className="og-seg">
          {order.slice().reverse().map((r) => (
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

export function CreateTeamDialog({ org, ctx, onClose }: { org: OrgFull; ctx: OrgCtx; onClose: () => void }) {
  const [name, setName] = useState("");
  const valid = name.trim().length >= 2;
  const submit = () => {
    if (!valid) return;
    void ctx.createTeam(org.id, name.trim());
    onClose();
  };
  return (
    <Dialog
      icon="layers"
      title="New team"
      desc={`Create a team inside ${org.name}. You'll be its first admin.`}
      onClose={onClose}
      foot={
        <>
          <span className="og-spacer" />
          <button className="og-btn" onClick={onClose}>Cancel</button>
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
          className="og-input"
          autoFocus
          placeholder="Platform"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
        />
        <span className="og-field__hint">Scopes skills and groups members. You can add people after creating it.</span>
      </div>
    </Dialog>
  );
}
