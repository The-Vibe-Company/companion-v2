"use client";

import { Fragment } from "react";
import { Icon } from "../Icon";
import { SettingsSidebar } from "./SettingsSidebar";
import { ProfilePane } from "./ProfilePane";
import { PreferencesPane } from "./PreferencesPane";
import { ApiKeysPane } from "./ApiKeysPane";
import { ModelsPane, type ModelScope } from "./ModelsPane";
import { ArtifactsPane, type ArtifactScope } from "./ArtifactsPane";
import { WorkspaceGeneralPane } from "./WorkspaceGeneralPane";
import {
  deleteModelProviderConnection,
  deleteOrgModelProviderConnection,
  deleteOrgVanishConnection,
  deleteVanishConnection,
  fetchModelProviderConnections,
  fetchOrgModelProviderConnections,
  fetchOrgVanishConnection,
  fetchVanishConnection,
  saveActivatedModels,
  saveOrgActivatedModels,
  setModelProviderConnection,
  setOrgModelProviderConnection,
  setOrgVanishConnection,
  setVanishConnection,
} from "@/lib/runQueries";
import { MembersPane } from "./MembersPane";
import { InvitationsPane } from "./InvitationsPane";
import { BillingPane } from "./BillingPane";
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
    // `providers`/`org-providers` are legacy aliases: keys are managed on the merged Models panes.
    case "providers":
    case "models":
      return ["Account", "Models"];
    case "artifacts":
      return ["Account", "Artifacts (Vanish)"];
    case "apikeys":
      return ["Account", "API keys"];
    case "org-providers":
    case "org-models":
      return [ws.name, "Shared models"];
    case "org-artifacts":
      return [ws.name, "Shared artifacts (Vanish)"];
    case "general":
      return [ws.name, "General"];
    case "members":
      return [ws.name, "Members"];
    case "invitations":
      return [ws.name, "Invitations"];
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
  const personalModels: ModelScope = {
    title: "Models",
    desc: "Compose your run launcher: activate models and connect each provider with its own write-only API key.",
    lockText: "Provider keys are stored separately from Secrets. Your personal key takes precedence over a workspace key.",
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
    lockText: "Shared with every member. Only owners and admins can change these.",
    locked: !ctx.canManage,
    readiness: "scope",
    select: (activated) => activated.org,
    save: (models) => saveOrgActivatedModels(models).then((r) => r.activated),
    loadConnected: () => fetchOrgModelProviderConnections().then((r) => r.connections),
    connect: (provider, keyName, apiKey) => setOrgModelProviderConnection({ provider, key_name: keyName, api_key: apiKey }).then((r) => r.connection),
    connectionScope: "organization",
    disconnect: (provider) => deleteOrgModelProviderConnection(provider).then(() => {}),
  };
  const personalArtifacts: ArtifactScope = {
    id: "personal",
    orgId: ctx.currentOrg.id,
    title: "Artifacts (Vanish)",
    desc: "Bind Vanish to an accessible vault secret so your runs can publish files saved under artifacts/. Your personal binding takes precedence over the workspace binding.",
    lockText: "Personal to you. The binding stores only a secret reference, and disconnecting never deletes the vault secret.",
    locked: false,
    loadConnected: () => fetchVanishConnection().then((r) => r.connection),
    connect: (secretId) => setVanishConnection(secretId).then((r) => r.connection),
    disconnect: () => deleteVanishConnection().then(() => {}),
  };
  const workspaceArtifacts: ArtifactScope = {
    id: "organization",
    orgId: ctx.currentOrg.id,
    title: "Shared artifacts (Vanish)",
    desc: "Bind Vanish for every member who has no personal Vanish binding. Shared bindings can reference Organization vault secrets only.",
    lockText: "Shared with every member. Only owners and admins can change this binding; disconnecting never deletes the vault secret.",
    locked: !ctx.canManage,
    loadConnected: () => fetchOrgVanishConnection().then((r) => r.connection),
    connect: (secretId) => setOrgVanishConnection(secretId).then((r) => r.connection),
    disconnect: () => deleteOrgVanishConnection().then(() => {}),
  };

  let pane: React.ReactNode;
  if (route.view === "profile") pane = <ProfilePane ctx={ctx} />;
  else if (route.view === "preferences") pane = <PreferencesPane ctx={ctx} />;
  // Distinct keys: the two provider panes are the SAME component type at the same tree position,
  // so without a key React would reuse the state (loaded connected ids) across a direct
  // personal ↔ workspace view switch.
  // `providers`/`org-providers` are legacy aliases of the merged Models panes (old deep-links).
  else if (route.view === "models" || route.view === "providers")
    pane = <ModelsPane key="models" scope={personalModels} />;
  else if (route.view === "artifacts") pane = <ArtifactsPane key="artifacts" scope={personalArtifacts} />;
  else if (route.view === "org-models" || route.view === "org-providers")
    pane = <ModelsPane key="org-models" scope={workspaceModels} />;
  else if (route.view === "org-artifacts")
    pane = <ArtifactsPane key="org-artifacts" scope={workspaceArtifacts} />;
  else if (route.view === "apikeys") pane = <ApiKeysPane ctx={ctx} keys={apiKeys} />;
  else if (route.view === "general") pane = <WorkspaceGeneralPane ctx={ctx} />;
  else if (route.view === "members") pane = <MembersPane ctx={ctx} onInvite={() => onDialog("invite")} />;
  else if (route.view === "invitations")
    pane = <InvitationsPane ctx={ctx} invites={invites} onInvite={() => onDialog("invite")} />;
  else if (route.view === "billing") pane = <BillingPane ctx={ctx} />;
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
