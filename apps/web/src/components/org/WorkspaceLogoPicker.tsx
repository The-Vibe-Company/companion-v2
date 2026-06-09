"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "../Icon";
import { Avatar, LOGO_COLORS } from "@/components/branding";
import {
  brandIconCandidates,
  firstLoadableBrandIconCandidate,
  normalizeWebsiteDomain,
  type BrandIconCandidate,
} from "@/lib/onboarding";
import { ORG_LOGO_FILE_ACCEPT, isAllowedOrgLogoFile } from "@companion/contracts";
import { hashColor, initialsOf } from "@/lib/settingsViewModel";
import type { OrgCtx } from "./model";

interface LogoCandidate {
  id: string;
  color: string;
  initial: string;
  src?: string;
}

type LogoMode = "menu" | "website";

function isHostedLogoUrl(logoUrl: string): boolean {
  return /\/v1\/orgs\/[^/]+\/logo(?:\?|$)/.test(logoUrl);
}

/** Workspace avatar + logo picker (file upload, website fetch, or remove). */
export function WorkspaceLogoPicker({ ctx }: { ctx: OrgCtx }) {
  const ws = ctx.currentOrg;
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<LogoMode>("menu");
  const [website, setWebsite] = useState("");
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "done">("idle");
  const [candidates, setCandidates] = useState<LogoCandidate[]>([]);
  const [fetchedFrom, setFetchedFrom] = useState("");
  const [uploading, setUploading] = useState(false);
  const [logoBust, setLogoBust] = useState(0);
  const fetchToken = useRef(0);
  const fileRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);

  const wsColor = ws.color ?? hashColor(ws.name);
  const wsInitial = initialsOf(ws.name);
  const canEditLogo = ctx.canManage;
  const hasFetchedLogo = candidates.some((c) => c.src);
  const logoSrc = ws.logoUrl
    ? isHostedLogoUrl(ws.logoUrl)
      ? `${ws.logoUrl.split("?")[0]}?v=${logoBust}`
      : ws.logoUrl
    : undefined;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const close = () => {
    setOpen(false);
    setMode("menu");
    setWebsite("");
    setFetchState("idle");
    setCandidates([]);
    setFetchedFrom("");
  };

  const avatar = (
    <Avatar size="lg" color={wsColor} initial={wsInitial} src={logoSrc} ring={false} />
  );

  const startFetch = useCallback((site: string) => {
    const clean = normalizeWebsiteDomain(site);
    const token = ++fetchToken.current;
    if (clean.length < 4 || !clean.includes(".")) {
      setCandidates([]);
      setFetchedFrom("");
      setFetchState("idle");
      return;
    }
    setFetchState("loading");

    const base = clean.split(".")[0]!;
    const colorCands: LogoCandidate[] = [
      { id: "c1", color: hashColor(clean), initial: base.slice(0, 1).toUpperCase() },
      { id: "c2", color: LOGO_COLORS[(base.length + 2) % LOGO_COLORS.length]!, initial: base.slice(0, 2).toUpperCase() },
    ];

    const finish = (fetchedIcon: BrandIconCandidate | null) => {
      if (!mounted.current || token !== fetchToken.current) return;
      const cands: LogoCandidate[] = fetchedIcon
        ? [
            {
              id: `fav-${fetchedIcon.domain}`,
              color: colorCands[0]!.color,
              initial: colorCands[0]!.initial,
              src: fetchedIcon.url,
            },
            ...colorCands,
          ]
        : colorCands;
      setCandidates(cands);
      setFetchedFrom(fetchedIcon?.domain ?? clean);
      setFetchState("done");
    };

    void firstLoadableBrandIconCandidate(brandIconCandidates(clean), async (icon) => {
      const controller = new AbortController();
      let timeout: number | null = null;
      try {
        const request = fetch(icon.url, { signal: controller.signal })
          .then((response) => response.ok)
          .catch(() => false);
        const deadline = new Promise<boolean>((resolve) => {
          timeout = window.setTimeout(() => {
            controller.abort();
            resolve(false);
          }, 2500);
        });
        return await Promise.race([request, deadline]);
      } catch {
        return false;
      } finally {
        if (timeout) window.clearTimeout(timeout);
      }
    }).then(finish);
  }, []);

  const applyCandidate = (candidate: LogoCandidate) => {
    ctx.setWorkspace({
      color: candidate.color,
      logoUrl: candidate.src ?? null,
    });
    if (candidate.src) setLogoBust(Date.now());
    close();
  };

  const removeLogo = () => {
    ctx.setWorkspace({ logoUrl: null });
    close();
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (!isAllowedOrgLogoFile(file)) {
      ctx.setError("Logo must be a PNG, JPEG, WebP, or GIF image.");
      if (fileRef.current) fileRef.current.value = "";
      return;
    }
    setUploading(true);
    try {
      await ctx.uploadWorkspaceLogo(file);
      setLogoBust(Date.now());
      close();
    } catch {
      // surfaced via ctx.error
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  if (!canEditLogo) {
    return <span className="sx-profile__av sx-profile__av--team">{avatar}</span>;
  }

  return (
    <div className="sx-profile__pick">
      <button
        type="button"
        className="ob-emoji-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="Change workspace logo"
        aria-expanded={open}
        title="Change logo"
        disabled={uploading || ctx.busy}
      >
        {avatar}
        <span className="ob-emoji-edit">
          {uploading ? (
            <span className="cds-spinner" style={{ width: 12, height: 12 }} />
          ) : (
            <Icon name={ws.logoUrl ? "pencil" : "upload"} size={12} />
          )}
        </span>
      </button>

      <input
        ref={fileRef}
        type="file"
        className="sx-file-input"
        accept={ORG_LOGO_FILE_ACCEPT}
        onChange={(e) => void onFile(e.target.files?.[0])}
      />

      {open && (
        <>
          <div className="ob-emoji-backdrop" onClick={close} />
          <div className="sx-logo-pop" role="dialog" aria-label="Change workspace logo" onClick={(e) => e.stopPropagation()}>
            {mode === "menu" ? (
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
                <button
                  type="button"
                  className="og-menu__item"
                  role="menuitem"
                  onClick={() => setMode("website")}
                >
                  <Icon name="globe" size={14} />
                  <span className="og-menu__txt">
                    <div className="og-menu__name" style={{ fontFamily: "var(--font-ui)" }}>Upload from website</div>
                    <div className="og-menu__desc">Fetch a favicon from your company site</div>
                  </span>
                </button>
                {ws.logoUrl && (
                  <button type="button" className="og-menu__item" role="menuitem" onClick={removeLogo}>
                    <Icon name="rotate-ccw" size={14} />
                    <span className="og-menu__txt">
                      <div className="og-menu__name" style={{ fontFamily: "var(--font-ui)" }}>Remove logo</div>
                      <div className="og-menu__desc">Go back to colored initials</div>
                    </span>
                  </button>
                )}
              </div>
            ) : (
              <div className="sx-logo-pop__panel">
                <button type="button" className="sx-logo-pop__back" onClick={() => setMode("menu")}>
                  <Icon name="arrow-left" size={14} />
                  Back
                </button>
                <div className="sx-field sx-field--compact" style={{ marginBottom: 14 }}>
                  <label className="sx-field__label" htmlFor="ws-site">
                    Website
                  </label>
                  <div className="ob-inputwrap">
                    <span className="ob-inputwrap__pre">https://</span>
                    <input
                      id="ws-site"
                      className="ob-input ob-input--mono sx-input"
                      value={website}
                      autoFocus
                      placeholder={ws.domain ?? "acme.com"}
                      onChange={(e) => {
                        const v = e.target.value;
                        setWebsite(v);
                        startFetch(v);
                      }}
                    />
                  </div>
                </div>

                {fetchState !== "idle" && (
                  <div className="ob-logofetch" style={{ marginBottom: 14 }}>
                    {fetchState === "loading" ? (
                      <>
                        <span className="ob-avatar ob-avatar--md" style={{ background: "var(--color-surface-raised)" }}>
                          <span className="cds-spinner" />
                        </span>
                        <div className="ob-logofetch__status" role="status" aria-live="polite" aria-busy="true">
                          <div className="ob-logofetch__line">Fetching brand assets…</div>
                          <div className="ob-logofetch__sub">
                            reading {website.replace(/^https?:\/\//, "") || "site"}/favicon
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <div className="ob-logofetch__status" role="status" aria-live="polite" aria-busy="false">
                          <div className="ob-logofetch__line">
                            {hasFetchedLogo ? (
                              <>
                                <Icon name="check" size={14} style={{ color: "var(--color-ok)" }} /> Found a logo on{" "}
                                <span className="ob-logofetch__host">{fetchedFrom}</span>
                              </>
                            ) : (
                              <>
                                <Icon name="info" size={14} style={{ color: "var(--color-faint)" }} /> Generated logo
                                options for <span className="ob-logofetch__host">{fetchedFrom}</span>
                              </>
                            )}
                          </div>
                          <div className="ob-logofetch__sub">
                            {hasFetchedLogo ? "pick one to replace your workspace logo" : "no site logo found; pick initials"}
                          </div>
                        </div>
                        <div className="ob-logo-opts">
                          {candidates.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              className="ob-logo-opt"
                              aria-label={c.src ? `Use logo from ${fetchedFrom}` : `Use ${c.initial} generated logo`}
                              onClick={() => applyCandidate(c)}
                            >
                              <Avatar size="md" color={c.color} initial={c.initial} src={c.src} />
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}

                <div className="sx-field sx-field--compact" style={{ marginBottom: 0 }}>
                  <label className="sx-field__label">Or pick a color</label>
                  <div className="ob-swatches">
                    {LOGO_COLORS.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={"ob-swatch" + (wsColor === color ? " is-sel" : "")}
                        style={{ background: color }}
                        aria-label="Workspace color"
                        aria-pressed={wsColor === color}
                        onClick={() => ctx.setWorkspace({ color })}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
