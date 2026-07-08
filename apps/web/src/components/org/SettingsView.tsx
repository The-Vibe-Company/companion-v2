"use client";

import { Fragment } from "react";
import { Icon } from "../Icon";
import { SettingsSidebar } from "./SettingsSidebar";
import { ProfilePane } from "./ProfilePane";
import { PreferencesPane } from "./PreferencesPane";
import { ApiKeysPane } from "./ApiKeysPane";
import { ProvidersPane, type ProviderScope } from "./ProvidersPane";
import { ArtifactsPane } from "./ArtifactsPane";
import { WorkspaceGeneralPane } from "./WorkspaceGeneralPane";
import {
  deleteOrgProviderConnection,
  deleteProviderConnection,
  fetchOrgProviderConnections,
  fetchProviderConnections,
  setOrgProviderConnection,
  setProviderConnection,
} from "@/lib/runQueries";
import { MembersPane } from "./MembersPane";
import { InvitationsPane } from "./InvitationsPane";
import { InviteDialog } from "./dialogs";
import type { ApiKeyVM, Invite, OrgCtx, SettingsDialog, SettingsRoute } from "./model";

/** Breadcrumb segments for the current route — [section, page] (ported from app.jsx). */
function crumbFor(ctx: OrgCtx, route: SettingsRoute): string[] {
  const ws = ctx.currentOrg;
  switch (route.view) {
    case "profile":
      return ["Account", "Profile"];
    case "preferences":
      return ["Account", "Preferences"];
    case "providers":
      return ["Account", "Model providers"];
    case "artifacts":
      return ["Account", "Artifacts (Vanish)"];
    case "apikeys":
      return ["Account", "API keys"];
    case "org-providers":
      return [ws.name, "Shared providers"];
    case "general":
      return [ws.name, "General"];
    case "members":
      return [ws.name, "Members"];
    case "invitations":
      return [ws.name, "Invitations"];
    default:
      return [ws.name];
  }
}

/**
 * The settings surface: the `.sx` shell = collapsible sidebar + main column
 * (breadcrumb + the active pane), the workspace-level dialogs, and the shared
 * error bar.
 */
export function SettingsView({
  ctx,
  route,
  dialog,
  apiKeys,
  invites,
  onView,
  onDialog,
  onClose,
}: {
  ctx: OrgCtx;
  route: SettingsRoute;
  dialog: SettingsDialog;
  apiKeys: ApiKeyVM[];
  invites: Invite[];
  onView: (route: SettingsRoute) => void;
  onDialog: (dialog: SettingsDialog) => void;
  onClose: () => void;
}) {
  const personalProviders: ProviderScope = {
    title: "Model providers",
    desc: "Connect the AI providers your skill runs use. Your key is stored encrypted, used only to run skills you launch, and never shown again.",
    lockText: "Keys are personal to you and stored encrypted — Companion never displays them again.",
    locked: false,
    loadConnected: () => fetchProviderConnections().then((r) => new Set(r.connections.map((cn) => cn.provider))),
    connect: (provider, keyName, key) => setProviderConnection({ provider, key_name: keyName, key }).then(() => {}),
    disconnect: (provider) => deleteProviderConnection(provider).then(() => {}),
  };
  const workspaceProviders: ProviderScope = {
    title: "Shared model providers",
    desc: "Connect AI providers once for the whole workspace. Members without their own key use these. Stored encrypted, never shown again.",
    lockText: "Shared with every member. Only owners and admins can change these.",
    locked: !ctx.canManage,
    loadConnected: () => fetchOrgProviderConnections().then((r) => new Set(r.connections.map((cn) => cn.provider))),
    connect: (provider, keyName, key) => setOrgProviderConnection({ provider, key_name: keyName, key }).then(() => {}),
    disconnect: (provider) => deleteOrgProviderConnection(provider).then(() => {}),
  };

  let pane: React.ReactNode;
  if (route.view === "profile") pane = <ProfilePane ctx={ctx} />;
  else if (route.view === "preferences") pane = <PreferencesPane ctx={ctx} />;
  // Distinct keys: the two provider panes are the SAME component type at the same tree position,
  // so without a key React would reuse the state (loaded connected ids) across a direct
  // personal ↔ workspace view switch.
  else if (route.view === "providers") pane = <ProvidersPane key="providers" scope={personalProviders} />;
  else if (route.view === "artifacts") pane = <ArtifactsPane />;
  else if (route.view === "org-providers") pane = <ProvidersPane key="org-providers" scope={workspaceProviders} />;
  else if (route.view === "apikeys") pane = <ApiKeysPane ctx={ctx} keys={apiKeys} />;
  else if (route.view === "general") pane = <WorkspaceGeneralPane ctx={ctx} />;
  else if (route.view === "members") pane = <MembersPane ctx={ctx} onInvite={() => onDialog("invite")} />;
  else if (route.view === "invitations")
    pane = <InvitationsPane ctx={ctx} invites={invites} onInvite={() => onDialog("invite")} />;
  else pane = <WorkspaceGeneralPane ctx={ctx} />;

  const crumb = crumbFor(ctx, route);

  return (
    <div className="sx">
      <SettingsSidebar
        ctx={ctx}
        route={route}
        go={onView}
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
    </div>
  );
}
