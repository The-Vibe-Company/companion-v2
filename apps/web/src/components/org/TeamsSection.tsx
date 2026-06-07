"use client";

import { useEffect, useRef, useState } from "react";
import type { TeamRole } from "@companion/contracts";
import { Icon } from "../Icon";
import { Avatar, RoleDot } from "./primitives";
import { RoleSelect } from "./RoleSelect";
import { TEAM_ROLES, TEAM_ROLE_ORDER, teamRole } from "./roles";
import type { OrgCtx, OrgFull, OrgMember } from "./model";

export function TeamsSection({ org, ctx, onCreateTeam }: { org: OrgFull; ctx: OrgCtx; onCreateTeam: () => void }) {
  const [openTeams, setOpenTeams] = useState<Set<string>>(() => new Set(org.teams[0] ? [org.teams[0].id] : []));
  const toggle = (id: string) =>
    setOpenTeams((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="og-pane__inner">
      <div className="og-pane__head" style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 16 }}>
        <div>
          <h2 className="og-pane__title">Teams</h2>
          <p className="og-pane__desc">
            Teams group members and scope skills inside {org.name}. A member can belong to several teams, each with its own role.
          </p>
        </div>
        {ctx.canManage && (
          <button className="btn-primary" onClick={onCreateTeam}>
            <Icon name="plus" size={14} />
            New team
          </button>
        )}
      </div>

      {org.teams.length === 0 ? (
        <div className="og-empty">No teams yet. Create one to group members and scope skills.</div>
      ) : (
        <div className="og-teams">
          {org.teams.map((t) => {
            const open = openTeams.has(t.id);
            const myMem = t.members.find((m) => m.userId === ctx.myId);
            const admins = t.members.filter((m) => m.role === "admin").length;
            const teamManage = ctx.canManage || (myMem && myMem.role === "admin");
            const addable = org.members.filter((m) => !m.pending && !t.members.some((x) => x.userId === m.userId));
            return (
              <div className="og-team" key={t.id}>
                <div className="og-team__head" onClick={() => toggle(t.id)}>
                  <span className={"og-team__chev" + (open ? " is-open" : "")}>
                    <Icon name="chevron-right" size={14} />
                  </span>
                  <span className="og-team__av">{t.name[0]}</span>
                  <div>
                    <div className="og-team__name">{t.name}</div>
                    <div className="og-team__sub">{t.members.length} member{t.members.length === 1 ? "" : "s"}</div>
                  </div>
                  <span className="og-team__spacer" />
                  {myMem ? (
                    <span className="og-team__role">
                      <RoleDot role={myMem.role} />you · {teamRole(myMem.role).label.toLowerCase()}
                    </span>
                  ) : (
                    <span className="og-team__role" style={{ color: "var(--color-faint)" }}>
                      not a member
                    </span>
                  )}
                </div>
                {open && (
                  <div className="og-team__body">
                    {t.members.map((tm) => {
                      const u = ctx.user(tm.userId);
                      const lastAdmin = tm.role === "admin" && admins <= 1;
                      return (
                        <div className="og-trow" key={tm.userId}>
                          <div className="og-mwho">
                            <Avatar u={u} size={26} />
                            <div className="og-mmeta">
                              <div className="og-mname" style={{ fontWeight: 400 }}>
                                {u.name}
                                {tm.userId === ctx.myId && <span className="og-myou">you</span>}
                              </div>
                            </div>
                          </div>
                          <RoleSelect
                            role={tm.role}
                            roles={TEAM_ROLES}
                            order={TEAM_ROLE_ORDER}
                            canManage={Boolean(teamManage) && !lastAdmin}
                            lockReason={!teamManage ? "Only org admins or team admins can change roles" : "A team needs at least one admin"}
                            onChange={(r) => ctx.setTeamMemberRole(org.id, t.id, tm.userId, r as TeamRole)}
                          />
                          <button
                            className="og-mx"
                            disabled={!teamManage || lastAdmin}
                            title={lastAdmin ? "Can't remove the last admin" : "Remove from team"}
                            onClick={() => ctx.removeTeamMember(org.id, t.id, tm.userId)}
                          >
                            <Icon name="user-minus" size={15} />
                          </button>
                        </div>
                      );
                    })}
                    {teamManage && addable.length > 0 && (
                      <AddToTeam addable={addable} ctx={ctx} onAdd={(uid) => ctx.addTeamMember(org.id, t.id, uid, "editor")} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function AddToTeam({ addable, ctx, onAdd }: { addable: OrgMember[]; ctx: OrgCtx; onAdd: (userId: string) => void }) {
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
    <span style={{ position: "relative", display: "block" }} ref={ref}>
      <button className="og-team__add" onClick={() => setOpen((o) => !o)}>
        <Icon name="plus" size={14} />
        Add member
      </button>
      {open && (
        <div className="og-menu" style={{ left: 4, right: "auto", width: 230, top: "100%" }} role="menu">
          {addable.map((m) => {
            const u = ctx.user(m.userId);
            return (
              <button key={m.userId} className="og-menu__item" onClick={() => { onAdd(m.userId); setOpen(false); }}>
                <Avatar u={u} size={24} cls="og-mav" />
                <span className="og-menu__txt">
                  <div className="og-menu__name" style={{ fontFamily: "var(--font-ui)" }}>{u.name}</div>
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
