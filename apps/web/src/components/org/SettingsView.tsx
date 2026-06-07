"use client";

import { Icon } from "../Icon";
import { GeneralPane } from "./GeneralPane";
import { MembersSection } from "./MembersSection";
import { TeamsSection } from "./TeamsSection";
import { InviteDialog, CreateTeamDialog } from "./dialogs";
import type { OrgCtx, SettingsDialog, SettingsTab } from "./model";

/** The settings surface: left nav (General/Members/Teams) + the active pane + dialogs. */
export function SettingsView({
  ctx,
  tab,
  dialog,
  onTab,
  onDialog,
  onClose,
}: {
  ctx: OrgCtx;
  tab: SettingsTab;
  dialog: SettingsDialog;
  onTab: (t: SettingsTab) => void;
  onDialog: (d: SettingsDialog) => void;
  onClose: () => void;
}) {
  const org = ctx.currentOrg;
  return (
    <div className="og-set">
      <div className="og-set__top">
        <button className="og-set__back" onClick={onClose}>
          <Icon name="arrow-left" size={14} />
          Back to skills
        </button>
        <div className="og-set__crumb">
          <Icon name="settings" size={14} /> Settings <span>/</span> <b>{org.name}</b>
        </div>
      </div>
      <div className="og-set__body">
        <nav className="og-snav">
          <div className="og-snav__label">Workspace</div>
          <button className={"og-snav__item" + (tab === "general" ? " is-active" : "")} onClick={() => onTab("general")}>
            <span className="og-snav__av">{org.name[0]}</span>General
          </button>
          <button className={"og-snav__item" + (tab === "members" ? " is-active" : "")} onClick={() => onTab("members")}>
            <Icon name="users" size={15} />Members
          </button>
          <button className={"og-snav__item" + (tab === "teams" ? " is-active" : "")} onClick={() => onTab("teams")}>
            <Icon name="layers" size={15} />Teams
          </button>
        </nav>
        <div className="og-pane">
          {ctx.error && (
            <div className="og-errbar" role="alert">
              <Icon name="alert-triangle" size={14} />
              <span style={{ flex: 1 }}>{ctx.error}</span>
              <button className="og-errbar__x" onClick={() => ctx.setError(null)} aria-label="Dismiss">
                <Icon name="x" size={13} />
              </button>
            </div>
          )}
          {tab === "general" && <GeneralPane org={org} ctx={ctx} />}
          {tab === "members" && <MembersSection org={org} ctx={ctx} onInvite={() => onDialog("invite")} />}
          {tab === "teams" && <TeamsSection org={org} ctx={ctx} onCreateTeam={() => onDialog("team")} />}
        </div>
      </div>
      {dialog === "invite" && <InviteDialog org={org} ctx={ctx} onClose={() => onDialog(null)} />}
      {dialog === "team" && <CreateTeamDialog org={org} ctx={ctx} onClose={() => onDialog(null)} />}
    </div>
  );
}
