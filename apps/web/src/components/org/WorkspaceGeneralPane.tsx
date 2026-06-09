"use client";

import { Icon } from "../Icon";
import { PaneHead, EditField } from "./paneKit";
import { RoleDot } from "./primitives";
import { orgRole } from "./roles";
import type { OrgCtx } from "./model";

/* ============================ Workspace › General ============================ */
export function WorkspaceGeneralPane({ ctx }: { ctx: OrgCtx }) {
  const ws = ctx.currentOrg;

  return (
    <div className="sx-pane">
      <PaneHead title="Workspace" desc="Identity and configuration for the whole organization. Visible to all members." />

      <div className="sx-profile">
        <span className="sx-profile__av" style={{ borderRadius: "var(--radius-md)" }}>{ws.name[0]}</span>
        <div className="sx-profile__meta">
          <div className="sx-profile__name">{ws.name}</div>
          <div className="sx-profile__email">companion.dev/{ws.slug}</div>
        </div>
      </div>

      {!ctx.canManage && (
        <div className="og-lockbar">
          <Icon name="lock" size={13} />
          You&apos;re a {orgRole(ctx.myRole).label.toLowerCase()} here. Only owners and admins can edit workspace settings.
        </div>
      )}

      <EditField
        label="Workspace name"
        hint="The display name for this organization."
        value={ws.name}
        locked={!ctx.canManage}
        onSave={(n) => ctx.setWorkspace({ name: n })}
      />

      <EditField
        label="URL identifier"
        mono
        prefix="companion.dev/"
        placeholder="acme"
        hint="Used in links and the API base path. Lowercase letters, numbers, and dashes."
        value={ws.slug}
        locked={!ctx.canManage}
        onSave={(s) => ctx.setWorkspace({ slug: s.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
      />

      <div className="sx-sec">
        <h2 className="sx-sec__h">Details</h2>
        <div className="sx-defs">
          <div className="sx-def">
            <span className="sx-def__k">Plan</span>
            <span className="sx-def__v">
              <span className="badge badge--accent"><Icon name="sparkles" size={11} />{ws.plan === "team" ? "Team" : "Free"}</span>
            </span>
          </div>
          <div className="sx-def">
            <span className="sx-def__k">Kind</span>
            <span className="sx-def__v">{ws.kind === "personal" ? "Personal workspace" : "Team organization"}</span>
          </div>
          <div className="sx-def">
            <span className="sx-def__k">Workspace id</span>
            <span className="sx-def__v mono">{ws.id}</span>
          </div>
          <div className="sx-def">
            <span className="sx-def__k">Created</span>
            <span className="sx-def__v">{ws.created}</span>
          </div>
          <div className="sx-def">
            <span className="sx-def__k">Your role</span>
            <span className="sx-def__v"><RoleDot role={ctx.myRole} /> {orgRole(ctx.myRole).label}</span>
          </div>
        </div>
      </div>

      <div className="sx-sec">
        <h2 className="sx-sec__h" style={{ color: "var(--color-danger)" }}>Danger zone</h2>
        <div className="sx-danger">
          <div className="sx-danger__row">
            <div className="sx-danger__txt">
              <div className="sx-danger__t">Delete workspace</div>
              <div className="sx-danger__d">Permanently remove {ws.name}, its teams, members, and every skill. This cannot be undone.</div>
            </div>
            <button
              className="btn-danger"
              disabled
              title="Workspace deletion isn't available yet — contact support"
            >
              <Icon name="trash-2" size={14} />Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
