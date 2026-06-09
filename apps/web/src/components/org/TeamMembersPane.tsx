"use client";

import { useEffect, useRef, useState } from "react";
import type { TeamRole } from "@companion/contracts";
import { Icon } from "../Icon";
import { PaneHead } from "./paneKit";
import { Avatar, RoleDot } from "./primitives";
import { RoleSelect } from "./RoleSelect";
import { ORG_ROLES, TEAM_ROLES, TEAM_ROLE_ORDER } from "./roles";
import { teamManageable } from "./TeamGeneralPane";
import type { OrgCtx, OrgMember, OrgTeam } from "./model";

/* ============================ Team › Members ============================ */
export function TeamMembersPane({ ctx, team }: { ctx: OrgCtx; team: OrgTeam }) {
  const manage = teamManageable(ctx, team);
  const admins = team.members.filter((m) => m.role === "admin").length;
  const addable = ctx.currentOrg.members.filter(
    (m) => !m.pending && !team.members.some((x) => x.userId === m.userId),
  );

  return (
    <div className="sx-pane">
      <PaneHead
        title={team.name + " · Members"}
        desc={"Who belongs to " + team.name + ". Team roles decide what each person can do with this team's skills."}
        action={
          manage && addable.length > 0 ? (
            <AddTeamMember ctx={ctx} addable={addable} onAdd={(uid) => ctx.addTeamMember(ctx.currentOrg.id, team.id, uid, "editor")} />
          ) : null
        }
      />

      {!manage && (
        <div className="og-lockbar">
          <Icon name="lock" size={13} />
          Only org admins or this team's admins can manage members.
        </div>
      )}

      <div className="mlist__lbl">
        <span>{team.members.length} member{team.members.length === 1 ? "" : "s"}</span>
        <span className="n">team role · workspace</span>
      </div>
      <div className="mlist">
        {team.members.map((tm) => {
          const u = ctx.user(tm.userId);
          const orgM = ctx.currentOrg.members.find((m) => m.userId === tm.userId);
          const lastAdmin = tm.role === "admin" && admins <= 1;
          return (
            <div className="mrow" key={tm.userId}>
              <Avatar u={u} size={34} />
              <div className="mrow__id">
                <div className="og-mname">
                  {u.name}
                  {tm.userId === ctx.myId && <span className="og-myou">you</span>}
                </div>
                <div className="og-memail">{u.email}</div>
              </div>
              <div className="mrow__end">
                <span className="mrow__meta" title="Workspace role">
                  <RoleDot role={orgM ? orgM.role : "developer"} />
                  {orgM ? (ORG_ROLES[orgM.role]?.label ?? orgM.role).toLowerCase() : "—"}
                </span>
                <RoleSelect
                  role={tm.role}
                  roles={TEAM_ROLES}
                  order={TEAM_ROLE_ORDER}
                  canManage={manage && !lastAdmin}
                  lockReason={!manage ? "Only admins can change team roles" : "A team needs at least one admin"}
                  onChange={(r) => ctx.setTeamMemberRole(ctx.currentOrg.id, team.id, tm.userId, r as TeamRole)}
                />
                <button
                  className="mrow__x"
                  disabled={!manage || lastAdmin}
                  title={lastAdmin ? "Can't remove the last admin" : "Remove from team"}
                  onClick={() => ctx.removeTeamMember(ctx.currentOrg.id, team.id, tm.userId)}
                >
                  <Icon name="user-minus" size={15} />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {manage && addable.length === 0 && (
        <p className="sx-field__hint" style={{ marginTop: 12 }}>
          Everyone in the workspace is already on this team.
        </p>
      )}
    </div>
  );
}

function AddTeamMember({ ctx, addable, onAdd }: { ctx: OrgCtx; addable: OrgMember[]; onAdd: (userId: string) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <span style={{ position: "relative" }} ref={ref}>
      <button className="btn-primary" onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={14} />
        Add member
      </button>
      {open && (
        <div className="og-menu" role="menu" style={{ width: 268 }}>
          {addable.map((m) => {
            const u = ctx.user(m.userId);
            return (
              <button key={m.userId} className="og-menu__item" onClick={() => { onAdd(m.userId); setOpen(false); }}>
                <Avatar u={u} size={26} cls="og-mav" />
                <span className="og-menu__txt">
                  <div className="og-menu__name" style={{ fontFamily: "var(--font-ui)", fontWeight: 500 }}>{u.name}</div>
                  <div className="og-menu__desc">{u.email}</div>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </span>
  );
}
