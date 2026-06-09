"use client";

import { useEffect, useState } from "react";
import { Icon } from "../Icon";
import { PaneHead, EditField } from "./paneKit";
import { RoleDot } from "./primitives";
import { orgRole } from "./roles";
import type { OrgCtx } from "./model";

/* ============================ Workspace › General ============================ */
export function WorkspaceGeneralPane({ ctx }: { ctx: OrgCtx }) {
  const ws = ctx.currentOrg;
  // The workspace URL is host-relative: show the real deployment host (self-host friendly), not a
  // hard-coded domain. Resolved after mount so SSR and first client render agree (no host on the
  // server); the prefix is cosmetic until then.
  const [host, setHost] = useState("");
  useEffect(() => setHost(window.location.host), []);
  const urlPrefix = host ? `${host}/` : "";

  return (
    <div className="sx-pane">
      <PaneHead title="Workspace" desc="Identity and configuration for the whole organization. Visible to all members." />

      <div className="sx-profile">
        <span className="sx-profile__av" style={{ borderRadius: "var(--radius-md)" }}>{ws.name[0]}</span>
        <div className="sx-profile__meta">
          <div className="sx-profile__name">{ws.name}</div>
          <div className="sx-profile__email">{urlPrefix}{ws.slug}</div>
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
        prefix={urlPrefix}
        placeholder="acme"
        hint="Used in links and the API base path. Lowercase letters, numbers, and dashes."
        value={ws.slug}
        locked={!ctx.canManage}
        onSave={(s) => ctx.setWorkspace({ slug: s.toLowerCase().replace(/[^a-z0-9-]/g, "-") })}
      />

      {ws.kind === "team" && (
        <div className="sx-sec">
          <h2 className="sx-sec__h">Domain access</h2>
          <p className="sx-sec__d">
            Let people with a matching verified work email join the workspace without an invite — the same
            option offered during onboarding.
          </p>
          {ctx.domainJoin.actorDomainIsPersonal || !ctx.domainJoin.actorDomain ? (
            <div className="sx-readline">
              <Icon name="info" size={14} />
              Domain auto-join requires a corporate email domain on your account (not a personal provider like
              Gmail).
            </div>
          ) : ctx.domainJoin.actorDomain !== ws.domain && ws.domain ? (
            <div className="sx-readline">
              <Icon name="lock" size={14} />
              This workspace is linked to <code>@{ws.domain}</code>. Only an admin with that same email domain
              can change auto-join.
            </div>
          ) : (
            <label
              className={"ob-toggcard" + (ws.domainAutoJoin ? " is-on" : "")}
              style={ctx.canManage ? undefined : { cursor: "default", opacity: 0.85 }}
            >
              <div className="ob-toggcard__meta">
                <div className="ob-toggcard__t">
                  Let anyone with @{ws.domain ?? ctx.domainJoin.actorDomain} join automatically
                </div>
                <div className="ob-toggcard__d">
                  New signups with a verified <code>@{ws.domain ?? ctx.domainJoin.actorDomain}</code> address are
                  added as members without an invite. You can change this later in settings.
                </div>
              </div>
              <span className="ob-switch">
                <input
                  type="checkbox"
                  checked={ws.domainAutoJoin}
                  disabled={!ctx.canManage}
                  onChange={(e) => ctx.setWorkspace({ domainAutoJoin: e.target.checked })}
                />
                <span className="ob-switch__track" />
                <span className="ob-switch__thumb" />
              </span>
            </label>
          )}
        </div>
      )}

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
            <span className="sx-def__k">Domain auto-join</span>
            <span className="sx-def__v">
              {ws.domainAutoJoin && ws.domain ? (
                <>On · @{ws.domain}</>
              ) : ws.domain ? (
                <>Off · @{ws.domain} claimed</>
              ) : (
                <span style={{ color: "var(--color-faint)" }}>Off</span>
              )}
            </span>
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
