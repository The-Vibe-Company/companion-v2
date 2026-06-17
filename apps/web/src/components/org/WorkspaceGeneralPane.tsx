"use client";

import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Icon } from "../Icon";
import { PaneHead, EditField } from "./paneKit";
import { RoleDot } from "./primitives";
import { orgRole } from "./roles";
import { WorkspaceLogoPicker } from "./WorkspaceLogoPicker";
import type { OrgCtx } from "./model";

/* ============================ Workspace › General ============================ */
export function WorkspaceGeneralPane({ ctx }: { ctx: OrgCtx }) {
  const ws = ctx.currentOrg;
  const [host, setHost] = useState("");
  const [domainDraft, setDomainDraft] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  useEffect(() => setHost(window.location.host), []);
  const urlPrefix = host ? `${host}/` : "";
  const domainPlaceholder = ctx.domainJoin.actorDomainIsPersonal || !ctx.domainJoin.actorDomain ? "client.com" : ctx.domainJoin.actorDomain;
  const addDomain = async () => {
    const domain = domainDraft.trim();
    if (!domain || ctx.busy) return;
    setDomainError(null);
    try {
      await ctx.addAccessDomain(domain);
      setDomainDraft("");
    } catch (error) {
      setDomainError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className="sx-pane">
      <PaneHead title="Workspace" desc="Identity and configuration for the whole organization. Visible to all members." />

      <div className="sx-profile sx-profile--team">
        <WorkspaceLogoPicker ctx={ctx} />
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
            Let people with matching verified work emails discover and join this workspace during onboarding.
            Owners and admins can add their own verified corporate email domain here.
          </p>
          <div className="sx-domainbox">
            {ctx.canManage && (
              <form
                className="sx-domainbox__add"
                onSubmit={(e) => {
                  e.preventDefault();
                  void addDomain();
                }}
              >
                <div className="sx-inputwrap">
                  <span className="pfx">@</span>
                  <input
                    className="sx-input sx-input--mono"
                    style={{ "--pfx": "30px" } as CSSProperties}
                    value={domainDraft}
                    placeholder={domainPlaceholder}
                    aria-label="Domain to allow during onboarding"
                    aria-invalid={domainError ? true : undefined}
                    aria-describedby={domainError ? "domain-access-error" : undefined}
                    disabled={ctx.busy}
                    onChange={(e) => setDomainDraft(e.target.value)}
                  />
                </div>
                <button className="btn-sec" type="submit" disabled={!domainDraft.trim() || ctx.busy}>
                  <Icon name="plus" size={14} />Add
                </button>
                {domainError && (
                  <div className="sx-field__hint sx-field__hint--error" id="domain-access-error" aria-live="polite">
                    {domainError}
                  </div>
                )}
              </form>
            )}
            {ws.accessDomains.length ? (
              <div className="sx-domainlist">
                {ws.accessDomains.map((domain) => (
                  <div className="sx-domainrow" key={domain.id}>
                    <span className="sx-domainrow__icon"><Icon name="globe-2" size={14} /></span>
                    <div className="sx-domainrow__meta">
                      <div className="sx-domainrow__name">@{domain.domain}</div>
                      <div className="sx-domainrow__sub">Added {domain.createdAt}</div>
                    </div>
                    {ctx.canManage && (
                      <button
                        className="iconbtn"
                        aria-label={`Remove ${domain.domain}`}
                        title={`Remove ${domain.domain}`}
                        disabled={ctx.busy}
                        onClick={() => void ctx.removeAccessDomain(domain.id)}
                      >
                        <Icon name="x" size={14} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div className="sx-readline">
                <Icon name="info" size={14} />
                No domains are enabled. People can still join by invitation.
              </div>
            )}
            {!ctx.canManage && (
              <div className="sx-field__hint">Only owners and admins can manage domain access.</div>
            )}
          </div>
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
            <span className="sx-def__k">Access domains</span>
            <span className="sx-def__v">
              {ws.accessDomains.length ? (
                <>{ws.accessDomains.length} enabled</>
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
