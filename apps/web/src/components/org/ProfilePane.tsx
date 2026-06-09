"use client";

import { useRef } from "react";
import { Icon } from "../Icon";
import { PaneHead, EditField } from "./paneKit";
import type { OrgCtx } from "./model";

/**
 * Account › Profile — the current user's personal account: big avatar, name + email,
 * an editable full name, the read-only verified email, and a sign-out action.
 */
export function ProfilePane({ ctx }: { ctx: OrgCtx }) {
  const me = ctx.user(ctx.myId);
  // Sign out via a full-page form POST to /v1/auth/logout (mirrors OnboardingFlow): the
  // route handler clears the session cookie and 303s to /login in one shot. A client-side
  // `fetch` + `router.push` races the redirect — the still-live cookie bounces back to /skills.
  const logoutForm = useRef<HTMLFormElement>(null);
  const signOut = () => logoutForm.current?.submit();

  return (
    <div className="sx-pane">
      <form ref={logoutForm} method="post" action="/v1/auth/logout" hidden />
      <PaneHead
        title="Profile"
        desc="Your personal account. This is how you appear across every workspace you belong to."
      />

      <div className="sx-profile">
        <span className="sx-profile__av">{me.initials}</span>
        <div className="sx-profile__meta">
          <div className="sx-profile__name">{me.name}</div>
          <div className="sx-profile__email">{me.email}</div>
        </div>
      </div>

      <EditField
        label="Full name"
        hint="Shown on members lists, audit records, and skill ownership."
        value={me.name}
        onSave={(n) => ctx.setMyName(n)}
      />

      <div className="sx-field">
        <label className="sx-field__label">Email</label>
        <div className="sx-readline">
          <Icon name="mail" size={14} />
          <span>{me.email}</span>
          <span className="badge badge--ok">
            <Icon name="check" size={11} />
            verified
          </span>
        </div>
        <span className="sx-field__hint">
          Your email is managed by your identity provider and can&apos;t be changed here.
        </span>
      </div>

      <div className="sx-sec">
        <h2 className="sx-sec__h">Sessions</h2>
        <p className="sx-sec__d">
          You can sign out of this device. Other settings live under Preferences.
        </p>
        <button className="btn-sec" type="button" onClick={signOut}>
          <Icon name="log-out" size={14} />
          Sign out
        </button>
      </div>
    </div>
  );
}
