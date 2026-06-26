"use client";

import { useRef, useState } from "react";
import { USER_AVATAR_FILE_ACCEPT, isAllowedUserAvatarFile, isHostedAvatarUrl } from "@companion/contracts";
import { Icon } from "../Icon";
import { UserAvatar } from "../UserAvatar";
import { PaneHead, EditField } from "./paneKit";
import type { OrgCtx } from "./model";

/**
 * The big profile avatar + its picker (upload a custom photo, or remove it to fall back to the
 * user's Gravatar / colored initials). Mirrors `WorkspaceLogoPicker`, minus the website-fetch mode.
 */
function ProfileAvatarPicker({ ctx }: { ctx: OrgCtx }) {
  const me = ctx.user(ctx.myId);
  const [open, setOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasCustom = !!me.avatarUrl && isHostedAvatarUrl(me.avatarUrl);
  const close = () => setOpen(false);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!isAllowedUserAvatarFile(file)) {
      ctx.setError("Profile photo must be a PNG, JPEG, WebP, or GIF image.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      await ctx.uploadUserAvatar(file);
      close();
    } catch {
      // surfaced via ctx.error
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const removePhoto = async () => {
    setUploading(true);
    try {
      await ctx.removeUserAvatar();
      close();
    } catch {
      // surfaced via ctx.error
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="sx-profile__pick">
      <button
        type="button"
        className="ob-emoji-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="Change profile photo"
        aria-expanded={open}
        title="Change photo"
        disabled={uploading || ctx.busy}
      >
        <UserAvatar className="sx-profile__av" avatarUrl={me.avatarUrl} initials={me.initials} />
        <span className="ob-emoji-edit">
          {uploading ? (
            <span className="cds-spinner" style={{ width: 12, height: 12 }} />
          ) : (
            <Icon name={hasCustom ? "pencil" : "upload"} size={12} />
          )}
        </span>
      </button>

      <input
        ref={fileRef}
        type="file"
        className="sx-file-input"
        accept={USER_AVATAR_FILE_ACCEPT}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />

      {open && (
        <>
          <div className="ob-emoji-backdrop" onClick={close} />
          <div className="sx-logo-pop" role="dialog" aria-label="Change profile photo" onClick={(e) => e.stopPropagation()}>
            <div className="og-menu sx-logo-pop__menu" role="menu">
              <button
                type="button"
                className="og-menu__item"
                role="menuitem"
                onClick={() => fileRef.current?.click()}
                disabled={uploading}
              >
                <Icon name="upload" size={14} />
                <span className="og-menu__txt">
                  <div className="og-menu__name" style={{ fontFamily: "var(--font-ui)" }}>Upload from file</div>
                  <div className="og-menu__desc">PNG, JPEG, WebP, or GIF · max 2 MB</div>
                </span>
              </button>
              {hasCustom && (
                <button type="button" className="og-menu__item" role="menuitem" onClick={() => void removePhoto()}>
                  <Icon name="rotate-ccw" size={14} />
                  <span className="og-menu__txt">
                    <div className="og-menu__name" style={{ fontFamily: "var(--font-ui)" }}>Remove photo</div>
                    <div className="og-menu__desc">Go back to your Gravatar or initials</div>
                  </span>
                </button>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

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
        <ProfileAvatarPicker ctx={ctx} />
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
