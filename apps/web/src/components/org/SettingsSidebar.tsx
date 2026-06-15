"use client";

import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { Icon } from "../Icon";
import { WorkspaceAvatar } from "./WorkspaceAvatar";
import { TeamAvatar } from "./TeamAvatar";
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
      type="button"
      className={"sx-item" + (active ? " is-active" : "")}
      aria-current={active ? "page" : undefined}
      title={label}
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
  const navId = useId();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [isNarrowViewport, setIsNarrowViewport] = useState(false);
  const is = (view: SettingsView, teamId?: string) =>
    route.view === view && (teamId === undefined || route.teamId === teamId);
  const goTo = (nextRoute: SettingsRoute) => {
    go(nextRoute);
    setMobileMenuOpen(false);
  };

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => {
      setIsNarrowViewport(query.matches);
      if (!query.matches) setMobileMenuOpen(false);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!mobileMenuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mobileMenuOpen]);

  return (
    <>
      {mobileMenuOpen && (
        <button
          type="button"
          className="sx-nav-scrim"
          aria-label="Close settings menu"
          onClick={() => setMobileMenuOpen(false)}
        />
      )}
      <nav className={"sx-nav" + (mobileMenuOpen ? " is-mobile-open" : "")}>
        <div className="sx-nav__top">
          <button
            type="button"
            className="sx-menu-toggle"
            aria-label={mobileMenuOpen ? "Collapse settings menu" : "Expand settings menu"}
            aria-expanded={mobileMenuOpen}
            onClick={() => setMobileMenuOpen((open) => !open)}
          >
            <Icon name={mobileMenuOpen ? "panel-left-close" : "panel-left-open"} size={16} />
          </button>
          <button type="button" className="sx-back" title="Back to Skills" onClick={onClose}>
            <Icon name="arrow-left" size={15} />
            <span className="sx-back__txt">Back to Skills</span>
          </button>
        </div>
        <div className="sx-nav__scroll">
          <div className="sx-group">
            <div className="sx-group__label">Account</div>
            <NavItem
              active={is("profile")}
              avatar={<span className="sx-av sx-av--me">{me.initials}</span>}
              label="Profile"
              onClick={() => goTo({ view: "profile" })}
            />
            <NavItem
              active={is("preferences")}
              icon="palette"
              label="Preferences"
              onClick={() => goTo({ view: "preferences" })}
            />
            <NavItem
              active={is("apikeys")}
              icon="key"
              label="API keys"
              meta={String(apiKeyCount)}
              onClick={() => goTo({ view: "apikeys" })}
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
              onClick={() => goTo({ view: "general" })}
            />
            <NavItem
              active={is("members")}
              icon="users"
              label="Members"
              meta={String(ws.members.filter((m) => !m.pending).length)}
              onClick={() => goTo({ view: "members" })}
            />
            <NavItem
              active={is("invitations")}
              icon="mail"
              label="Invitations"
              meta={inviteCount ? String(inviteCount) : undefined}
              onClick={() => goTo({ view: "invitations" })}
            />
          </div>

          <div className="sx-group">
            <div className="sx-group__label">
              Your teams
              {ctx.canManage && (
                <button type="button" className="sx-group__add" title="New team" onClick={onCreateTeam}>
                  <Icon name="plus" size={14} />
                </button>
              )}
            </div>
            {ws.teams.map((t) => {
              const open = expanded.has(t.id);
              const subnavId = `${navId}-team-${t.id}-subnav`;
              return (
                <div key={t.id} className="sx-team-block">
                  <div className="sx-team">
                    <button
                      type="button"
                      className="sx-team__btn"
                      title={t.name}
                      aria-expanded={open}
                      aria-controls={subnavId}
                      onClick={() => {
                        if (isNarrowViewport && !mobileMenuOpen) {
                          setMobileMenuOpen(true);
                          if (!open) toggleTeam(t.id);
                          return;
                        }
                        toggleTeam(t.id);
                      }}
                    >
                      <span className={"sx-team__chev" + (open ? " is-open" : "")}>
                        <Icon name="chevron-right" size={14} />
                      </span>
                      <TeamAvatar team={t} className="sx-av" />
                      <span className="sx-team__name">{t.name}</span>
                    </button>
                    <button
                      type="button"
                      className="sx-team__gear"
                      title="Team settings"
                      onClick={() => {
                        if (!open) toggleTeam(t.id);
                        goTo({ view: "team-general", teamId: t.id });
                      }}
                    >
                      <Icon name="settings" size={14} />
                    </button>
                  </div>
                  {open && (
                    <div className="sx-sub" id={subnavId}>
                      <NavItem
                        active={is("team-general", t.id)}
                        icon="settings"
                        label="General"
                        onClick={() => goTo({ view: "team-general", teamId: t.id })}
                      />
                      <NavItem
                        active={is("team-members", t.id)}
                        icon="users"
                        label="Members"
                        meta={String(t.members.length)}
                        onClick={() => goTo({ view: "team-members", teamId: t.id })}
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </nav>
    </>
  );
}
