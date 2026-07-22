"use client";

import { useEffect, useRef, useState } from "react";
import { clearSkillPublicVersion, setSkillPublicVersion } from "@/lib/queries";
import type { SkillVM } from "@/lib/types";
import { Icon } from "../Icon";
import { useModalA11y } from "./UploadDialog";

export function PublicReleaseDialog({
  skill,
  onClose,
  onChanged,
}: {
  skill: SkillVM;
  onClose: () => void;
  onChanged: (version: string | null) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [publicVersion, setPublicVersion] = useState(skill.publicVersion ?? null);
  const [busy, setBusy] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  useModalA11y(dialogRef, onClose);

  const publicHref = `/s/${encodeURIComponent(skill.shareToken)}`;
  const [publicUrl, setPublicUrl] = useState(publicHref);
  useEffect(() => setPublicUrl(`${window.location.origin}${publicHref}`), [publicHref]);
  const canPromote = Boolean(skill.version && publicVersion !== skill.version);

  const promote = async () => {
    if (!skill.version || busy) return;
    setBusy(true);
    setError(null);
    try {
      await setSkillPublicVersion(skill.id, skill.version);
      setPublicVersion(skill.version);
      onChanged(skill.version);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update the public release.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await clearSkillPublicVersion(skill.id);
      setPublicVersion(null);
      onChanged(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not remove the public release.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!navigator.clipboard) {
      setCopyState("error");
      return;
    }
    try {
      await navigator.clipboard.writeText(publicUrl);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("error");
    }
  };

  return (
    <div
      className="up-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="up public-release"
        role="dialog"
        aria-modal="true"
        aria-labelledby="public-release-title"
        ref={dialogRef}
        tabIndex={-1}
      >
        <div className="up__head">
          <div className="up__titles">
            <h2 className="up__title" id="public-release-title">
              {publicVersion ? "Manage public link" : "Make skill public"}
            </h2>
            <p className="up__sub">
              The stable link exposes metadata to anyone. Package access still requires a verified account or an approved agent.
            </p>
          </div>
          <button className="up__x" type="button" onClick={onClose} aria-label="Close">
            <Icon name="x" size={17} />
          </button>
        </div>

        <div className="public-release__body">
          <div className="public-release__versions" aria-label="Release versions">
            <span>Current <b className="mono">v{skill.version ?? "none"}</b></span>
            <span aria-hidden="true">·</span>
            <span>Public <b className="mono">{publicVersion ? `v${publicVersion}` : "none"}</b></span>
          </div>

          {publicVersion ? (
            <div className="public-release__link">
              <label htmlFor="public-release-url">Public link</label>
              <div>
                <input id="public-release-url" className="mono" readOnly value={publicUrl} />
                <button className="btn-sec" type="button" onClick={copy}>
                  <Icon name={copyState === "copied" ? "check" : "copy"} size={14} />
                  {copyState === "copied" ? "Copied" : "Copy"}
                </button>
              </div>
              {copyState === "error" && <p role="alert">Could not copy the link. Select and copy it manually.</p>}
            </div>
          ) : (
            <div className="public-release__note">
              <Icon name="globe" size={15} />
              <span>
                Making <b className="mono">v{skill.version ?? "none"}</b> public creates an installable, immutable release. New versions stay private until you promote them.
              </span>
            </div>
          )}

          {publicVersion && canPromote && (
            <div className="public-release__note">
              <Icon name="git-commit" size={15} />
              <span>
                <b className="mono">v{publicVersion}</b> stays public until you explicitly replace it with <b className="mono">v{skill.version}</b>.
              </span>
            </div>
          )}

          {error && (
            <div className="up-errblock" role="alert">
              <Icon name="alert-triangle" size={14} />
              {error}
            </div>
          )}
        </div>

        <div className="up__foot">
          {publicVersion && (
            <button className="btn-ghost public-release__remove" type="button" disabled={busy} onClick={remove}>
              <Icon name="lock" size={14} />
              Stop public access
            </button>
          )}
          <span className="up__footspacer" />
          <button className="btn-ghost" type="button" onClick={onClose} disabled={busy}>
            Close
          </button>
          {canPromote && (
            <button className="btn-primary" type="button" disabled={busy || !skill.version} onClick={promote}>
              {busy ? <span className="cds-spinner" /> : <Icon name="globe" size={14} />}
              Make v{skill.version} public
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
