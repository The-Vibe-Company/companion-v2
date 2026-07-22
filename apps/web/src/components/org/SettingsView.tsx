"use client";

import { Fragment } from "react";
import { Icon } from "../Icon";
import { SettingsSidebar } from "./SettingsSidebar";
import { ProfilePane } from "./ProfilePane";
import { PreferencesPane } from "./PreferencesPane";
import { ApiKeysPane } from "./ApiKeysPane";
import { ModelsPane, type ModelScope } from "./ModelsPane";
import { WorkspaceGeneralPane } from "./WorkspaceGeneralPane";
import {
  deleteModelProviderConnection,
  deleteOrgModelProviderConnection,
  fetchModelProviderConnections,
  fetchOrgModelProviderConnections,
  saveActivatedModels,
  saveOrgActivatedModels,
  setModelProviderConnection,
  setOrgModelProviderConnection,
} from "@/lib/runQueries";
import { MembersPane } from "./MembersPane";
import { InvitationsPane } from "./InvitationsPane";
import { BillingPane } from "./BillingPane";
import { GitHubPane } from "./GitHubPane";
import { ConnectedAgentsPane } from "./ConnectedAgentsPane";
import { InviteDialog } from "./dialogs";
import { canonicalizeSettingsRoute } from "./model";
import type { ApiKeyVM, Invite, OrgCtx, SettingsDialog, SettingsRoute } from "./model";

/** Breadcrumb segments for the current route — [section, page] (ported from app.jsx). */
function crumbFor(ctx: OrgCtx, route: SettingsRoute): string[] {
  const ws = ctx.currentOrg;
  switch (route.view) {
    case "profile":
      return ["Account", "Profile"];
    case "preferences":
      return ["Account", "Preferences"];
    // `providers`/`org-providers` are legacy aliases: keys are managed on the merged Models panes.
    case "providers":
    case "models":
      return ["Account", "Models"];
    case "apikeys":
      return ["Account", "API keys"];
    case "agents":
      return ["Account", "Connected agents"];
    case "org-providers":
    case "org-models":
      return [ws.name, "Shared models"];
    case "general":
      return [ws.name, "General"];
    case "members":
      return [ws.name, "Members"];
    case "invitations":
      return [ws.name, "Invitations"];
    case "github":
      return [ws.name, ctx.canManage ? "GitHub" : "General"];
    case "billing":
      return [ws.name, "Billing"];
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
  const activeRoute = canonicalizeSettingsRoute(route, ctx.canManage);
  const personalModels: ModelScope = {
    title: "Models",
    desc: "Compose your run launcher: activate models and connect each provider with its own write-only API key.",
    locked: false,
    readiness: "any",
    select: (activated) => activated.personal,
    ghost: { label: "From workspace", select: (activated) => activated.org },
    save: (models) => saveActivatedModels(models).then((r) => r.activated),
    loadConnected: () => fetchModelProviderConnections().then((r) => r.connections),
    connect: (provider, keyName, apiKey) => setModelProviderConnection({ provider, key_name: keyName, api_key: apiKey }).then((r) => r.connection),
    connectionScope: "personal",
    disconnect: (provider) => deleteModelProviderConnection(provider).then(() => {}),
  };
  const workspaceModels: ModelScope = {
    title: "Shared models",
    desc: "Curate the models every member can run and connect shared providers with dedicated write-only API keys.",
    locked: !ctx.canManage,
    readiness: "scope",
    select: (activated) => activated.org,
    save: (models) => saveOrgActivatedModels(models).then((r) => r.activated),
    loadConnected: () => fetchOrgModelProviderConnections().then((r) => r.connections),
    connect: (provider, keyName, apiKey) => setOrgModelProviderConnection({ provider, key_name: keyName, api_key: apiKey }).then((r) => r.connection),
    connectionScope: "organization",
    disconnect: (provider) => deleteOrgModelProviderConnection(provider).then(() => {}),
  };
  let pane: React.ReactNode;
  if (activeRoute.view === "profile") pane = <ProfilePane ctx={ctx} />;
  else if (activeRoute.view === "preferences") pane = <PreferencesPane ctx={ctx} />;
  // Distinct keys: the two provider panes are the SAME component type at the same tree position,
  // so without a key React would reuse the state (loaded connected ids) across a direct
  // personal ↔ workspace view switch.
  // `providers`/`org-providers` are legacy aliases of the merged Models panes (old deep-links).
  else if (activeRoute.view === "models" || activeRoute.view === "providers")
    pane = <ModelsPane key="models" scope={personalModels} />;
  else if (activeRoute.view === "org-models" || activeRoute.view === "org-providers")
    pane = <ModelsPane key="org-models" scope={workspaceModels} />;
  else if (activeRoute.view === "apikeys") pane = <ApiKeysPane ctx={ctx} keys={apiKeys} />;
  else if (activeRoute.view === "agents") pane = <ConnectedAgentsPane />;
  else if (activeRoute.view === "general") pane = <WorkspaceGeneralPane ctx={ctx} />;
  else if (activeRoute.view === "members") pane = <MembersPane ctx={ctx} onInvite={() => onDialog("invite")} />;
  else if (activeRoute.view === "invitations")
    pane = <InvitationsPane ctx={ctx} invites={invites} onInvite={() => onDialog("invite")} />;
  else if (activeRoute.view === "github") pane = <GitHubPane ctx={ctx} />;
  else if (activeRoute.view === "billing") pane = <BillingPane ctx={ctx} />;
  else pane = <WorkspaceGeneralPane ctx={ctx} />;

  const crumb = crumbFor(ctx, activeRoute);

  return (
    <div className="sx">
      <SettingsSidebar
        ctx={ctx}
        route={activeRoute}
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
