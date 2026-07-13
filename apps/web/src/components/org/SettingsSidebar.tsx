"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";
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
 * Settings nav: two groups (Account / Workspace). "Back to Skills" closes the
 * surface.
 */
export function SettingsSidebar({
  ctx,
  route,
  go,
  onClose,
  apiKeyCount,
  inviteCount,
}: {
  ctx: OrgCtx;
  route: SettingsRoute;
  go: (route: SettingsRoute) => void;
  onClose: () => void;
  apiKeyCount: number;
  inviteCount: number;
}) {
  const me = ctx.user(ctx.myId);
  const ws = ctx.currentOrg;
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const is = (view: SettingsView) => route.view === view;
  const goTo = (nextRoute: SettingsRoute) => {
    go(nextRoute);
    setMobileMenuOpen(false);
  };

  useEffect(() => {
    const query = window.matchMedia("(max-width: 820px)");
    const sync = () => {
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
              avatar={<UserAvatar className="sx-av sx-av--me" avatarUrl={me.avatarUrl} initials={me.initials} />}
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
              active={is("models") || is("providers")}
              icon="boxes"
              label="Models"
              onClick={() => goTo({ view: "models" })}
            />
            <NavItem
              active={is("artifacts")}
              icon="link-2"
              label="Artifacts (Vanish)"
              onClick={() => goTo({ view: "artifacts" })}
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
              active={is("org-models") || is("org-providers")}
              icon="boxes"
              label="Shared models"
              onClick={() => goTo({ view: "org-models" })}
            />
            <NavItem
              active={is("org-artifacts")}
              icon="link-2"
              label="Shared artifacts"
              onClick={() => goTo({ view: "org-artifacts" })}
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
            <NavItem
              active={is("billing")}
              icon="credit-card"
              label="Billing"
              meta={
                ctx.billing?.billingEnabled
                  ? ctx.billing.entitlements.computedPlan === "pro"
                    ? "Pro"
                    : "Free"
                  : "Included"
              }
              onClick={() => goTo({ view: "billing" })}
            />
          </div>
        </div>
      </nav>
    </>
  );
}
