"use client";

import { Fragment, useEffect } from "react";
import { Icon } from "../Icon";
import { SettingsSidebar } from "./SettingsSidebar";
import { ProfilePane } from "./ProfilePane";
import { PreferencesPane } from "./PreferencesPane";
import { ApiKeysPane } from "./ApiKeysPane";
import { WorkspaceGeneralPane } from "./WorkspaceGeneralPane";
import { MembersPane } from "./MembersPane";
import { InvitationsPane } from "./InvitationsPane";
import { TeamGeneralPane } from "./TeamGeneralPane";
import { TeamMembersPane } from "./TeamMembersPane";
import { InviteDialog, CreateTeamDialog } from "./dialogs";
import type { ApiKeyVM, Invite, OrgCtx, SettingsDialog, SettingsRoute } from "./model";

/** Breadcrumb segments for the current route — [section, page] (ported from app.jsx). */
function crumbFor(ctx: OrgCtx, route: SettingsRoute): string[] {
  const ws = ctx.currentOrg;
  const team = route.teamId ? ctx.currentOrg.teams.find((t) => t.id === route.teamId) : null;
  switch (route.view) {
    case "profile":
      return ["Account", "Profile"];
    case "preferences":
      return ["Account", "Preferences"];
    case "apikeys":
      return ["Account", "API keys"];
    case "general":
      return [ws.name, "General"];
    case "members":
      return [ws.name, "Members"];
    case "invitations":
      return [ws.name, "Invitations"];
    case "team-general":
      return [team ? team.name : "Team", "General"];
    case "team-members":
      return [team ? team.name : "Team", "Members"];
    default:
      return [ws.name];
  }
}

/**
 * The settings surface: the `.sx` shell = collapsible sidebar + main column
 * (breadcrumb + the active pane), the workspace-level dialogs, and the shared
 * error bar. A route guard redirects team panes back to Workspace › General when
 * the targeted team disappears (e.g. after a delete or a switch).
 */
export function SettingsView({
  ctx,
  route,
  dialog,
  apiKeys,
  invites,
  expanded,
  onView,
  onDialog,
  onToggleTeam,
  onClose,
}: {
  ctx: OrgCtx;
  route: SettingsRoute;
  dialog: SettingsDialog;
  apiKeys: ApiKeyVM[];
  invites: Invite[];
  expanded: Set<string>;
  onView: (route: SettingsRoute) => void;
  onDialog: (dialog: SettingsDialog) => void;
  onToggleTeam: (teamId: string) => void;
  onClose: () => void;
}) {
  // Resolve the current team (team panes only) and guard against deletion.
  const team =
    route.view === "team-general" || route.view === "team-members"
      ? ctx.currentOrg.teams.find((t) => t.id === route.teamId) ?? null
      : null;
  useEffect(() => {
    if ((route.view === "team-general" || route.view === "team-members") && !team) {
      onView({ view: "general" });
    }
  }, [route.view, team, onView]);

  let pane: React.ReactNode;
  if (route.view === "profile") pane = <ProfilePane ctx={ctx} />;
  else if (route.view === "preferences") pane = <PreferencesPane ctx={ctx} />;
  else if (route.view === "apikeys") pane = <ApiKeysPane ctx={ctx} keys={apiKeys} />;
  else if (route.view === "general") pane = <WorkspaceGeneralPane ctx={ctx} />;
  else if (route.view === "members") pane = <MembersPane ctx={ctx} onInvite={() => onDialog("invite")} />;
  else if (route.view === "invitations")
    pane = <InvitationsPane ctx={ctx} invites={invites} onInvite={() => onDialog("invite")} />;
  else if (route.view === "team-general" && team)
    pane = <TeamGeneralPane ctx={ctx} team={team} key={team.id} />;
  else if (route.view === "team-members" && team)
    pane = <TeamMembersPane ctx={ctx} team={team} key={team.id} />;
  else pane = <WorkspaceGeneralPane ctx={ctx} />;

  const crumb = crumbFor(ctx, route);

  return (
    <div className="sx">
      <SettingsSidebar
        ctx={ctx}
        route={route}
        go={onView}
        expanded={expanded}
        toggleTeam={onToggleTeam}
        onCreateTeam={() => onDialog("team")}
        onClose={onClose}
        apiKeyCount={apiKeys.length}
        inviteCount={invites.length}
      />
      <div className="sx-main">
        <div className="sx-crumb">
          <Icon name="settings" size={13} />
          <span>Settings</span>
          {crumb.map((c, i) => (
            <Fragment key={i}>
              <span className="sx-crumb__sep">/</span>
              {i === crumb.length - 1 ? <b>{c}</b> : <span>{c}</span>}
            </Fragment>
          ))}
        </div>
        <div className="sx-scroll">
          {ctx.error && (
            <div className="og-errbar" role="alert">
              <Icon name="alert-triangle" size={14} />
              <span style={{ flex: 1 }}>{ctx.error}</span>
              <button className="og-errbar__x" onClick={() => ctx.setError(null)} aria-label="Dismiss">
                <Icon name="x" size={13} />
              </button>
            </div>
          )}
          {pane}
        </div>
      </div>
      {dialog === "invite" && <InviteDialog ctx={ctx} onClose={() => onDialog(null)} />}
      {dialog === "team" && <CreateTeamDialog ctx={ctx} onClose={() => onDialog(null)} />}
    </div>
  );
}
