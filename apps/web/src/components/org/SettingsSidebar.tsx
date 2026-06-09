"use client";

import type { ReactNode } from "react";
import { Icon } from "../Icon";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import type { OrgCtx, SettingsRoute, SettingsView } from "./model";

/** One sidebar row — either an avatar chip (Profile / Workspace) or a Lucide icon. */
function NavItem({
  active,
  icon,
  avatar,
  label,
  meta,
  onClick,
}: {
  active: boolean;
  icon?: string;
  avatar?: ReactNode;
  label: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={"sx-item" + (active ? " is-active" : "")}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {avatar ?? <Icon name={icon ?? "circle"} size={16} />}
      <span className="sx-item__txt">{label}</span>
      {meta && <span className="sx-item__meta">{meta}</span>}
    </button>
  );
}

/**
 * Settings nav: three groups (Account / Workspace / Your teams). Teams are
 * collapsible blocks, each with its own General + Members and a gear that jumps
 * straight to its General pane. "Back to Skills" closes the surface; "+" creates
 * a team (managers only). Expanded-team state is owned by the parent (SettingsView).
 */
export function SettingsSidebar({
  ctx,
  route,
  go,
  expanded,
  toggleTeam,
  onCreateTeam,
  onClose,
  apiKeyCount,
  inviteCount,
}: {
  ctx: OrgCtx;
  route: SettingsRoute;
  go: (route: SettingsRoute) => void;
  expanded: Set<string>;
  toggleTeam: (teamId: string) => void;
  onCreateTeam: () => void;
  onClose: () => void;
  apiKeyCount: number;
  inviteCount: number;
}) {
  const me = ctx.user(ctx.myId);
  const ws = ctx.currentOrg;
  const is = (view: SettingsView, teamId?: string) =>
    route.view === view && (teamId === undefined || route.teamId === teamId);

  return (
    <nav className="sx-nav">
      <div className="sx-nav__top">
        <button className="sx-back" onClick={onClose}>
          <Icon name="arrow-left" size={15} />
          Back to Skills
        </button>
      </div>
      <div className="sx-nav__scroll">
        <div className="sx-group">
          <div className="sx-group__label">Account</div>
          <NavItem
            active={is("profile")}
            avatar={<span className="sx-av sx-av--me">{me.initials}</span>}
            label="Profile"
            onClick={() => go({ view: "profile" })}
          />
          <NavItem
            active={is("preferences")}
            icon="palette"
            label="Preferences"
            onClick={() => go({ view: "preferences" })}
          />
          <NavItem
            active={is("apikeys")}
            icon="key"
            label="API keys"
            meta={String(apiKeyCount)}
            onClick={() => go({ view: "apikeys" })}
          />
        </div>

        <div className="sx-group">
          <div className="sx-group__label">Workspace</div>
          <NavItem
            active={is("general")}
            avatar={
              <WorkspaceAvatar
                org={ws}
                className={
                  "sx-av sx-av--ws" + (ws.kind === "personal" && !ws.logoUrl ? " is-personal" : "")
                }
                size={20}
              />
            }
            label="General"
            onClick={() => go({ view: "general" })}
          />
          <NavItem
            active={is("members")}
            icon="users"
            label="Members"
            meta={String(ws.members.filter((m) => !m.pending).length)}
            onClick={() => go({ view: "members" })}
          />
          <NavItem
            active={is("invitations")}
            icon="mail"
            label="Invitations"
            meta={inviteCount ? String(inviteCount) : undefined}
            onClick={() => go({ view: "invitations" })}
          />
        </div>

        <div className="sx-group">
          <div className="sx-group__label">
            Your teams
            {ctx.canManage && (
              <button className="sx-group__add" title="New team" onClick={onCreateTeam}>
                <Icon name="plus" size={14} />
              </button>
            )}
          </div>
          {ws.teams.map((t) => {
            const open = expanded.has(t.id);
            return (
              <div key={t.id} className="sx-team-block">
                <div className="sx-team">
                  <button className="sx-team__btn" onClick={() => toggleTeam(t.id)}>
                    <span className={"sx-team__chev" + (open ? " is-open" : "")}>
                      <Icon name="chevron-right" size={14} />
                    </span>
                    <span className="sx-av">{t.name[0] ?? "?"}</span>
                    <span className="sx-team__name">{t.name}</span>
                  </button>
                  <button
                    className="sx-team__gear"
                    title="Team settings"
                    onClick={() => {
                      if (!open) toggleTeam(t.id);
                      go({ view: "team-general", teamId: t.id });
                    }}
                  >
                    <Icon name="settings" size={14} />
                  </button>
                </div>
                {open && (
                  <div className="sx-sub">
                    <NavItem
                      active={is("team-general", t.id)}
                      icon="settings"
                      label="General"
                      onClick={() => go({ view: "team-general", teamId: t.id })}
                    />
                    <NavItem
                      active={is("team-members", t.id)}
                      icon="users"
                      label="Members"
                      meta={String(t.members.length)}
                      onClick={() => go({ view: "team-members", teamId: t.id })}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
