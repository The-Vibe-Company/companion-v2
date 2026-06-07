"use client";

import { useState } from "react";
import { Icon } from "../Icon";
import { inviteLink } from "@/lib/org";
import { Avatar } from "./primitives";
import { RoleSelect } from "./RoleSelect";
import { ORG_ROLES, ORG_ROLE_ORDER, orgRole } from "./roles";
import type { OrgCtx, OrgFull, OrgMember, SeedUser } from "./model";

export function MembersSection({ org, ctx, onInvite }: { org: OrgFull; ctx: OrgCtx; onInvite: () => void }) {
  const [q, setQ] = useState("");
  const [copied, setCopied] = useState<string | null>(null);

  const members = org.members
    .map((m) => ({ m, u: ctx.user(m.userId) }))
    .filter(({ u }) => !q || u.name.toLowerCase().includes(q.toLowerCase()) || (u.email || "").toLowerCase().includes(q.toLowerCase()));
  const active = members.filter(({ m }) => !m.pending);
  const pending = members.filter(({ m }) => m.pending);
  const owners = org.members.filter((m) => m.role === "owner" && !m.pending).length;

  const copy = async (token: string) => {
    try {
      await navigator.clipboard.writeText(inviteLink(token));
      setCopied(token);
      setTimeout(() => setCopied((c) => (c === token ? null : c)), 1600);
    } catch {
      ctx.setError("Could not copy the invite link");
    }
  };

  const Row = ({ m, u }: { m: OrgMember; u: SeedUser }) => {
    const isMe = m.userId === ctx.myId;
    const lastOwner = m.role === "owner" && owners <= 1;
    const targetOwner = m.role === "owner";
    const canEdit = !m.pending && ctx.canManage && (!targetOwner || ctx.isOwner) && !lastOwner;
    const assignOrder = ctx.isOwner ? ORG_ROLE_ORDER : ORG_ROLE_ORDER.filter((r) => r !== "owner");
    return (
      <div className={"og-mrow" + (m.pending ? " og-mrow--pending" : "")}>
        <div className="og-mwho">
          <Avatar u={u} />
          <div className="og-mmeta">
            <div className="og-mname">
              {u.name}
              {isMe && <span className="og-myou">you</span>}
              {m.pending && <span className="og-invited">invited</span>}
            </div>
            <div className="og-memail">{u.email}</div>
          </div>
        </div>
        <RoleSelect
          role={m.role}
          roles={ORG_ROLES}
          order={assignOrder}
          canManage={canEdit}
          lockReason={
            m.pending
              ? "Role applies once the invite is accepted"
              : !ctx.canManage
                ? "Only owners and admins can change roles"
                : lastOwner
                  ? "An organization needs at least one owner"
                  : targetOwner
                    ? "Only an owner can change another owner"
                    : ""
          }
          onChange={(r) => ctx.setMemberRole(org.id, m.userId, r as OrgMember["role"])}
        />
        {m.pending && m.inviteToken ? (
          <button className="og-copylink" onClick={() => copy(m.inviteToken as string)} title="Copy invite link">
            <Icon name={copied === m.inviteToken ? "check" : "link-2"} size={13} />
            {copied === m.inviteToken ? "Copied" : "Copy link"}
          </button>
        ) : (
          <span className="og-mjoined">{m.joined}</span>
        )}
        <button
          className="og-mx"
          disabled={m.pending ? !ctx.canManage : (!ctx.canManage && !isMe) || lastOwner || (targetOwner && !ctx.isOwner && !isMe)}
          title={m.pending ? "Revoke invite" : lastOwner ? "Can't remove the last owner" : isMe ? "Leave organization" : "Remove member"}
          onClick={() => (m.pending && m.inviteId ? ctx.revokeInvite(org.id, m.inviteId) : ctx.removeMember(org.id, m.userId))}
        >
          <Icon name={m.pending ? "x" : isMe ? "log-out" : "user-minus"} size={15} />
        </button>
      </div>
    );
  };

  return (
    <div className="og-pane__inner">
      <div className="og-pane__head" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h2 className="og-pane__title">Members</h2>
          <p className="og-pane__desc">People in {org.name}. Roles control what each member can do across the workspace.</p>
        </div>
        {ctx.canManage && (
          <button className="btn-primary" onClick={onInvite}>
            <Icon name="user-plus" size={14} />
            Invite members
          </button>
        )}
      </div>

      {!ctx.canManage && (
        <div className="og-team__role" style={{ marginBottom: 14 }}>
          <Icon name="lock" size={13} />
          You are a {orgRole(ctx.myRole).label.toLowerCase()} in this workspace. Only owners and admins can manage members.
        </div>
      )}

      <div className="og-toolbar">
        <div className="og-search">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search members" />
        </div>
      </div>

      <div className="og-mlist">
        <div className="og-mrow og-mrow--head">
          <span>{active.length} member{active.length === 1 ? "" : "s"}</span>
          <span>Role</span>
          <span>Joined</span>
          <span></span>
        </div>
        {active.map(({ m, u }) => <Row key={m.userId} m={m} u={u} />)}
      </div>

      {pending.length > 0 && (
        <>
          <p className="og-seclabel">
            Pending invites <span className="og-seclabel__n">{pending.length}</span>
          </p>
          <div className="og-mlist">{pending.map(({ m, u }) => <Row key={m.userId} m={m} u={u} />)}</div>
        </>
      )}
    </div>
  );
}
