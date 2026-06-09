"use client";

import { useState } from "react";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import { Avatar } from "./primitives";
import { RoleSelect } from "./RoleSelect";
import { ORG_ROLES, ORG_ROLE_ORDER, orgRole } from "./roles";
import type { OrgCtx, OrgMember, SeedUser } from "./model";

/**
 * Workspace › Members — Linear-style hairline rows. Active members only; pending
 * invitations live in InvitationsPane. Roles, last-owner, and owner-only-changes-owner
 * locks mirror the org capability model.
 */
export function MembersPane({ ctx, onInvite }: { ctx: OrgCtx; onInvite: () => void }) {
  const org = ctx.currentOrg;
  const [q, setQ] = useState("");

  const members = org.members
    .filter((m) => !m.pending)
    .map((m) => ({ m, u: ctx.user(m.userId) }))
    .filter(({ u }) => !q || u.name.toLowerCase().includes(q.toLowerCase()) || (u.email || "").toLowerCase().includes(q.toLowerCase()));
  const owners = org.members.filter((m) => m.role === "owner" && !m.pending).length;

  // A plain render function (not a nested component) so the rows aren't unmounted/remounted
  // on every parent state change (search keystrokes).
  const renderRow = (m: OrgMember, u: SeedUser) => {
    const isMe = m.userId === ctx.myId;
    const lastOwner = m.role === "owner" && owners <= 1;
    const targetOwner = m.role === "owner";
    const canEdit = ctx.canManage && (!targetOwner || ctx.isOwner) && !lastOwner;
    const order = ctx.isOwner ? ORG_ROLE_ORDER : ORG_ROLE_ORDER.filter((r) => r !== "owner");
    return (
      <div className="mrow" key={m.userId}>
        <Avatar u={u} size={34} />
        <div className="mrow__id">
          <div className="og-mname">
            {u.name}
            {isMe && <span className="og-myou">you</span>}
          </div>
          <div className="og-memail">{u.email}</div>
        </div>
        <div className="mrow__end">
          <span className="mrow__meta">{m.joined}</span>
          <RoleSelect
            role={m.role}
            roles={ORG_ROLES}
            order={order}
            canManage={canEdit}
            lockReason={
              !ctx.canManage
                ? "Only owners and admins can change roles"
                : lastOwner
                  ? "A workspace needs at least one owner"
                  : targetOwner
                    ? "Only an owner can change another owner"
                    : ""
            }
            onChange={(r) => ctx.setMemberRole(org.id, m.userId, r as OrgMember["role"])}
          />
          <button
            className="mrow__x"
            disabled={(!ctx.canManage && !isMe) || lastOwner || (targetOwner && !ctx.isOwner && !isMe)}
            title={lastOwner ? "Can't remove the last owner" : isMe ? "Leave workspace" : "Remove member"}
            onClick={() => ctx.removeMember(org.id, m.userId)}
          >
            <Icon name={isMe ? "log-out" : "user-minus"} size={15} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="sx-pane">
      <PaneHead
        title="Members"
        desc={`People in ${org.name}. Roles control what each member can do across the workspace.`}
        action={
          ctx.canManage ? (
            <button className="btn-primary" onClick={onInvite}>
              <Icon name="user-plus" size={14} />
              Invite members
            </button>
          ) : null
        }
      />

      {!ctx.canManage && (
        <div className="og-lockbar">
          <Icon name="lock" size={13} />
          You&apos;re a {orgRole(ctx.myRole).label.toLowerCase()} here. Only owners and admins can manage members.
        </div>
      )}

      <div className="og-toolbar">
        <div className="og-search">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search members" aria-label="Search members" />
        </div>
      </div>

      <div className="mlist__lbl">
        <span>
          {members.length} member{members.length === 1 ? "" : "s"}
        </span>
        <span className="n">role</span>
      </div>
      <div className="mlist">{members.map(({ m, u }) => renderRow(m, u))}</div>
    </div>
  );
}
