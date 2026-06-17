"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Icon } from "@/components/Icon";
import { Avatar, EmojiPicker, hashColor, initialsOf, LOGO_COLORS } from "@/components/branding";
export { Avatar, EmojiPicker, hashColor, initialsOf, LOGO_COLORS } from "@/components/branding";
import {
  brandIconCandidates,
  firstLoadableBrandIconCandidate,
  normalizeWebsiteDomain,
  type BrandIconCandidate,
  type OnboardingMatchedOrg,
} from "@/lib/onboarding";

/* ----------------------------------------------------------- shared types */
export interface LogoCandidate {
  id: string;
  color: string;
  initial: string;
  /** When set, the candidate is a real fetched logo image rather than a colored initial tile. */
  src?: string;
}

export interface OrgDraft {
  name: string;
  website: string;
  logo: LogoCandidate | null;
  candidates: LogoCandidate[];
  fetchedFrom: string;
  domain: string;
}

export interface TeamDraft {
  name: string;
  color: string;
  emoji?: string;
}

/* =========================================================== ASIDE / STEPS */
export function Aside({
  steps,
  stepIndex,
  meName,
  meEmail,
  onLogout,
}: {
  steps: string[];
  stepIndex: number;
  meName: string;
  meEmail: string;
  onLogout: () => void;
}) {
  return (
    <aside className="ob-aside">
      <div className="ob-brand">
        <span className="ob-brand__mark" aria-hidden="true" />
        <span className="ob-brand__wm">Companion</span>
      </div>
      <nav className="ob-steps">
        {steps.map((label, i) => {
          const state = i < stepIndex ? "is-done" : i === stepIndex ? "is-active" : "";
          return (
            <div className={`ob-step ${state}`} key={label}>
              <span className="ob-step__num">{i < stepIndex ? <Icon name="check" size={13} /> : i + 1}</span>
              <span className="ob-step__label">{label}</span>
            </div>
          );
        })}
      </nav>
      <div className="ob-aside__foot">
        <div className="ob-acct">
          <span className="ob-avatar ob-avatar--sm ob-avatar--ring" style={{ background: hashColor(meName || "You") }}>
            {initialsOf(meName || "You")}
          </span>
          <div className="ob-acct__meta">
            <div className="ob-acct__name">{meName || "You"}</div>
            <div className="ob-acct__email">{meEmail}</div>
          </div>
          <button className="ob-logout" onClick={onLogout} aria-label="Log out" title="Log out">
            <Icon name="log-out" size={16} />
          </button>
        </div>
      </div>
    </aside>
  );
}

/* ============================================================ SCREEN: ACCOUNT */
export function ScreenAccount({
  name,
  email,
  setName,
  onNext,
}: {
  name: string;
  email: string;
  setName: (v: string) => void;
  onNext: () => void;
}) {
  const valid = name.trim().length >= 2 && /.+@.+\..+/.test(email);
  return (
    <div className="ob-panel" key="account">
      <p className="ob-eyebrow">Create your account</p>
      <h1 className="ob-h1">Welcome to Companion</h1>
      <p className="ob-sub">Leverage all your AI as a team. First, tell us who you are.</p>
      <div className="ob-body">
        <div className="ob-field">
          <label className="ob-field__label" htmlFor="f-name">Your name</label>
          <input
            id="f-name"
            className="ob-input"
            autoFocus
            value={name}
            placeholder="Alex Rivera"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && valid) onNext();
            }}
          />
        </div>
        <div className="ob-field">
          <label className="ob-field__label" htmlFor="f-email">Work email</label>
          <div className="ob-lockfield">
            <input
              id="f-email"
              className="ob-input ob-input--mono"
              type="email"
              value={email}
              readOnly
              tabIndex={-1}
              aria-label="Work email (verified)"
            />
            <span className="ob-lockbadge"><Icon name="lock" size={11} /> Verified</span>
          </div>
          <span className="ob-field__hint">You're signed in with this email. We use its domain to find your organization.</span>
        </div>
      </div>
      <div className="ob-foot">
        <button className="cds-btn cds-btn--lg cds-btn--primary ob-btn-block" disabled={!valid} onClick={onNext}>
          Continue
          <span className="cds-btn__icon"><Icon name="arrow-right" /></span>
        </button>
      </div>
    </div>
  );
}

/* ============================================================ SCREEN: DETECTING */
export function ScreenDetecting({ domain }: { domain: string | null }) {
  return (
    <div className="ob-panel" key="detecting">
      <div className="ob-detecting">
        <div className="ob-detecting__spin" />
        <div>
          <div className="ob-detecting__t">Looking for your organization</div>
          <div className="ob-detecting__d">checking {domain || "your domain"}…</div>
        </div>
      </div>
    </div>
  );
}

/* ================================================ SCREEN: ORG FOUND (domain access) */
export function ScreenFound({
  orgs,
  selectedOrgId,
  setSelectedOrgId,
  onJoin,
  onCreateInstead,
  busy,
}: {
  orgs: OnboardingMatchedOrg[];
  selectedOrgId: string | null;
  setSelectedOrgId: (id: string) => void;
  onJoin: () => void;
  onCreateInstead: () => void;
  busy: boolean;
}) {
  const selected = orgs.find((org) => org.id === selectedOrgId) ?? orgs[0]!;
  const hasMany = orgs.length > 1;
  return (
    <div className="ob-panel" key="found">
      <p className="ob-eyebrow">{hasMany ? "Organizations found" : "Organization found"}</p>
      <h1 className="ob-h1">{hasMany ? "Choose your organization" : `Join ${selected.name} on Companion`}</h1>
      <p className="ob-sub">
        We found {hasMany ? "organizations" : "an organization"} that allow verified <code>@{selected.domain}</code> addresses.
      </p>
      <div className="ob-body">
        <div className="ob-orglist" aria-label="Organizations available for your email domain">
          {orgs.map((org) => (
            <button
              key={org.id}
              type="button"
              className={`ob-orgcard ob-orgcard--choice${org.id === selected.id ? " is-sel" : ""}`}
              aria-pressed={org.id === selected.id}
              onClick={() => setSelectedOrgId(org.id)}
            >
              <Avatar size="lg" color={hashColor(org.name)} initial={initialsOf(org.name)} />
              <div className="ob-orgcard__meta">
                <div className="ob-orgcard__name">{org.name}</div>
                <div className="ob-orgcard__domain">{org.domain}</div>
                <div className="ob-orgcard__stats">
                  <span>{org.memberCount} {org.memberCount === 1 ? "member" : "members"}</span>
                  <span className="ob-dot-sep">·</span>
                  <span>{org.teamCount} {org.teamCount === 1 ? "team" : "teams"}</span>
                </div>
              </div>
              {org.id === selected.id && <span className="ob-choice-check"><Icon name="check" size={13} /></span>}
            </button>
          ))}
        </div>
        <div className="ob-note ob-note--ok">
          <Icon name="unlock" size={15} />
          <span>
            <b>{selected.name} allows @{selected.domain} addresses.</b> No invite needed — you'll be added as a member.
          </span>
        </div>
        <button className="cds-btn cds-btn--lg cds-btn--primary ob-btn-block" disabled={busy} onClick={onJoin}>
          {busy ? (
            <span className="cds-spinner" />
          ) : (
            <>
              <span className="cds-btn__icon"><Icon name="log-in" /></span>Join {selected.name}
            </>
          )}
        </button>
      </div>
      <div className="ob-foot">
        <button className="ob-skip" onClick={onCreateInstead}>Create a new organization instead</button>
      </div>
    </div>
  );
}

/* ============================================================ SCREEN: CREATE ORG */
export function ScreenCreateOrg({
  org,
  setOrg,
  domainHint,
  onNext,
  onBack,
}: {
  org: OrgDraft;
  setOrg: Dispatch<SetStateAction<OrgDraft>>;
  domainHint: string | null;
  onNext: () => void;
  onBack: () => void;
}) {
  const [fetchState, setFetchState] = useState<"idle" | "loading" | "done">("idle");
  const fetchToken = useRef(0);
  const mounted = useRef(true);
  const valid = org.name.trim().length >= 2;
  const hasFetchedLogo = org.candidates.some((c) => c.src);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const startFetch = useCallback(
    (site: string) => {
      const clean = normalizeWebsiteDomain(site);
      const token = ++fetchToken.current;
      if (clean.length < 4 || !clean.includes(".")) {
        setOrg((o) => ({ ...o, candidates: [], logo: null, fetchedFrom: "" }));
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
        if (!mounted.current || token !== fetchToken.current) return; // a newer fetch superseded this one
        const cands: LogoCandidate[] = fetchedIcon
          ? [{ id: `fav-${fetchedIcon.domain}`, color: colorCands[0]!.color, initial: colorCands[0]!.initial, src: fetchedIcon.url }, ...colorCands]
          : colorCands;
        setOrg((o) => ({ ...o, candidates: cands, logo: cands[0]!, fetchedFrom: fetchedIcon?.domain ?? clean }));
        setFetchState("done");
      };

      // Real favicon fetch (best-effort). Falls back to derived color tiles if it errors/times out.
      if (typeof window !== "undefined") {
        const iconCandidates = brandIconCandidates(clean);
        firstLoadableBrandIconCandidate(iconCandidates, async (icon) => {
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
      } else {
        finish(null);
      }
    },
    [setOrg],
  );

  // Auto-run once if we arrived with a prefilled website (from the email domain).
  const didAuto = useRef(false);
  useEffect(() => {
    if (!didAuto.current && org.website && fetchState === "idle") {
      didAuto.current = true;
      startFetch(org.website);
    }
  }, [org.website, fetchState, startFetch]);

  return (
    <div className="ob-panel" key="create_org">
      <p className="ob-eyebrow">New organization</p>
      <h1 className="ob-h1">Set up your organization</h1>
      <p className="ob-sub">This is the top-level home for your agents, teams, and skills.</p>
      <div className="ob-body">
        <div className="ob-field">
          <label className="ob-field__label" htmlFor="o-name">Organization name</label>
          <input
            id="o-name"
            className="ob-input"
            autoFocus
            value={org.name}
            placeholder="Acme Inc."
            onChange={(e) => setOrg((o) => ({ ...o, name: e.target.value }))}
          />
        </div>
        <div className="ob-field">
          <label className="ob-field__label" htmlFor="o-site">
            Website <span className="ob-field__opt">optional</span>
          </label>
          <div className="ob-inputwrap">
            <span className="ob-inputwrap__pre">https://</span>
            <input
              id="o-site"
              className="ob-input ob-input--mono"
              value={org.website}
              placeholder={domainHint || "acme.com"}
              onChange={(e) => {
                const v = e.target.value;
                setOrg((o) => ({ ...o, website: v }));
                startFetch(v);
              }}
            />
          </div>
          <span className="ob-field__hint">We'll try to pull your logo and brand color from here.</span>
        </div>

        {fetchState !== "idle" && (
          <div className="ob-logofetch">
            {fetchState === "loading" ? (
              <>
                <span className="ob-avatar ob-avatar--md" style={{ background: "var(--color-surface-raised)" }}>
                  <span className="cds-spinner" />
                </span>
                <div className="ob-logofetch__status" role="status" aria-live="polite" aria-busy="true">
                  <div className="ob-logofetch__line">Fetching brand assets…</div>
                  <div className="ob-logofetch__sub">reading {org.website.replace(/^https?:\/\//, "") || "site"}/favicon</div>
                </div>
              </>
            ) : (
              <>
                <div className="ob-logofetch__status" role="status" aria-live="polite" aria-busy="false">
                  <div className="ob-logofetch__line">
                    {hasFetchedLogo ? (
                      <>
                        <Icon name="check" size={14} style={{ color: "var(--color-ok)" }} /> Found a logo on{" "}
                        <span className="ob-logofetch__host">{org.fetchedFrom}</span>
                      </>
                    ) : (
                      <>
                        <Icon name="info" size={14} style={{ color: "var(--color-faint)" }} /> Generated logo options for{" "}
                        <span className="ob-logofetch__host">{org.fetchedFrom}</span>
                      </>
                    )}
                  </div>
                  <div className="ob-logofetch__sub">{hasFetchedLogo ? "pick one, or use initials" : "no site logo found; pick one, or use initials"}</div>
                </div>
                <div className="ob-logo-opts">
                  {org.candidates.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      className={`ob-logo-opt${org.logo && org.logo.id === c.id ? " is-sel" : ""}`}
                      aria-label={c.src ? `Use logo from ${org.fetchedFrom}` : `Use ${c.initial} generated logo`}
                      aria-pressed={org.logo?.id === c.id}
                      onClick={() => setOrg((o) => ({ ...o, logo: c }))}
                    >
                      <Avatar size="md" color={c.color} initial={c.initial} src={c.src} />
                      {org.logo && org.logo.id === c.id && (
                        <span className="ob-logo-opt__check"><Icon name="check" size={11} /></span>
                      )}
                    </button>
                  ))}
                  <button
                    type="button"
                    className="ob-logo-upload"
                    title="Use initials"
                    aria-label="Use initials"
                    onClick={() =>
                      setOrg((o) => ({
                        ...o,
                        logo: { id: "up", color: o.logo?.color || hashColor(o.name), initial: initialsOf(o.name || "Org") },
                      }))
                    }
                  >
                    <Icon name="hash" size={15} />
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
      <div className="ob-foot">
        <button className="ob-backlink" onClick={onBack}><Icon name="arrow-left" size={15} />Back</button>
        <span className="ob-spacer" />
        <button className="cds-btn cds-btn--lg cds-btn--primary" disabled={!valid} onClick={onNext}>
          Continue<span className="cds-btn__icon"><Icon name="arrow-right" /></span>
        </button>
      </div>
    </div>
  );
}

/* =========================================================== SCREEN: CREATE TEAM */
export function ScreenCreateTeam({
  team,
  setTeam,
  orgName,
  onNext,
  onBack,
}: {
  team: TeamDraft;
  setTeam: Dispatch<SetStateAction<TeamDraft>>;
  orgName: string;
  onNext: () => void;
  onBack: () => void;
}) {
  const [picker, setPicker] = useState(false);
  const valid = team.name.trim().length >= 2;
  const initial = team.name.trim() ? initialsOf(team.name) : "T";
  return (
    <div className="ob-panel" key="create_team">
      <p className="ob-eyebrow">First team</p>
      <h1 className="ob-h1">Create your first team</h1>
      <p className="ob-sub">
        Teams group people and the agents they share inside {orgName || "your organization"}. You can add more later.
      </p>
      <div className="ob-body">
        <div className="ob-logorow">
          <div className="ob-logorow__pick">
            <button className="ob-emoji-trigger" onClick={() => setPicker((p) => !p)} aria-label="Choose a team icon" title="Choose an icon">
              <Avatar size="lg" color={team.color} initial={initial} emoji={team.emoji} />
              <span className="ob-emoji-edit"><Icon name={team.emoji ? "pencil" : "smile-plus"} size={12} /></span>
            </button>
            {picker && (
              <EmojiPicker
                value={team.emoji}
                onPick={(e) => {
                  setTeam((t) => ({ ...t, emoji: e || undefined }));
                  setPicker(false);
                }}
                onClose={() => setPicker(false)}
              />
            )}
          </div>
          <div className="ob-field" style={{ flex: 1 }}>
            <label className="ob-field__label" htmlFor="t-name">Team name</label>
            <input
              id="t-name"
              className="ob-input"
              autoFocus
              value={team.name}
              placeholder="Platform"
              onChange={(e) => setTeam((t) => ({ ...t, name: e.target.value }))}
              onKeyDown={(e) => {
                if (e.key === "Enter" && valid) onNext();
              }}
            />
          </div>
        </div>
        <div className="ob-field">
          <label className="ob-field__label">Team color</label>
          <div className="ob-swatches">
            {LOGO_COLORS.map((c) => (
              <button
                key={c}
                className={`ob-swatch${team.color === c ? " is-sel" : ""}`}
                style={{ background: c }}
                aria-label="color"
                onClick={() => setTeam((t) => ({ ...t, color: c }))}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="ob-foot">
        <button className="ob-backlink" onClick={onBack}><Icon name="arrow-left" size={15} />Back</button>
        <span className="ob-spacer" />
        <button className="cds-btn cds-btn--lg cds-btn--primary" disabled={!valid} onClick={onNext}>
          Continue<span className="cds-btn__icon"><Icon name="arrow-right" /></span>
        </button>
      </div>
    </div>
  );
}

/* =============================================================== SCREEN: INVITE */
export function ScreenInvite({
  invites,
  setInvites,
  allowDomain,
  setAllowDomain,
  domain,
  onFinish,
  onBack,
}: {
  invites: string[];
  setInvites: Dispatch<SetStateAction<string[]>>;
  allowDomain: boolean;
  setAllowDomain: (v: boolean) => void;
  domain: string | null;
  onFinish: () => void;
  onBack: () => void;
}) {
  const [draft, setDraft] = useState("");
  const add = (raw: string) => {
    const v = raw.trim().replace(/,$/, "");
    if (/.+@.+\..+/.test(v) && !invites.includes(v)) setInvites((xs) => [...xs, v]);
    setDraft("");
  };
  const canAutoJoin = !!domain;
  return (
    <div className="ob-panel" key="invite">
      <p className="ob-eyebrow">Invite your team</p>
      <h1 className="ob-h1">Bring in your collaborators</h1>
      <p className="ob-sub">
        Invite people by email{canAutoJoin ? ", or enable your domain for self-serve joining" : ""}. Skip and do this later if you like.
      </p>
      <div className="ob-body">
        <div className="ob-field">
          <label className="ob-field__label">Invite by email</label>
          <div
            className="ob-invitebox"
            onClick={(e) => {
              const i = e.currentTarget.querySelector("input");
              if (i) i.focus();
            }}
          >
            {invites.map((em) => (
              <span className="ob-chip" key={em}>
                {em}
                <button className="ob-chip__x" onClick={() => setInvites((xs) => xs.filter((x) => x !== em))} aria-label={`Remove ${em}`}>
                  <Icon name="x" size={12} />
                </button>
              </span>
            ))}
            <input
              className="ob-invitebox__input"
              value={draft}
              placeholder={invites.length ? "Add another…" : "name@company.com"}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === "," || e.key === " ") {
                  e.preventDefault();
                  add(draft);
                } else if (e.key === "Backspace" && !draft && invites.length) {
                  setInvites((xs) => xs.slice(0, -1));
                }
              }}
              onBlur={() => draft && add(draft)}
            />
          </div>
          <span className="ob-field__hint">Press Enter or comma to add. They'll get a link to join your organization.</span>
        </div>

        {canAutoJoin && (
          <label className={`ob-toggcard${allowDomain ? " is-on" : ""}`}>
            <div className="ob-toggcard__meta">
              <div className="ob-toggcard__t">Allow @{domain} addresses to join this organization</div>
              <div className="ob-toggcard__d">
                New people who sign up with a matching verified email can choose this organization without an invite. You can change this in settings.
              </div>
            </div>
            <span className="ob-switch">
              <input type="checkbox" checked={allowDomain} onChange={(e) => setAllowDomain(e.target.checked)} />
              <span className="ob-switch__track" />
              <span className="ob-switch__thumb" />
            </span>
          </label>
        )}
      </div>
      <div className="ob-foot">
        <button className="ob-backlink" onClick={onBack}><Icon name="arrow-left" size={15} />Back</button>
        <span className="ob-spacer" />
        {invites.length === 0 && !allowDomain ? (
          <button className="cds-btn cds-btn--lg cds-btn--secondary" onClick={onFinish}>Skip for now</button>
        ) : (
          <button className="cds-btn cds-btn--lg cds-btn--primary" onClick={onFinish}>
            {invites.length ? `Send ${invites.length} invite${invites.length > 1 ? "s" : ""}` : "Finish"}
            <span className="cds-btn__icon"><Icon name="arrow-right" /></span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ============================================================== SCREEN: WELCOME */
export function ScreenWelcome({
  path,
  org,
  team,
  invites,
  allowDomain,
  domain,
  joinedOrg,
  busy,
  onEnter,
}: {
  path: "create" | "join";
  org: OrgDraft;
  team: TeamDraft;
  invites: string[];
  allowDomain: boolean;
  domain: string | null;
  joinedOrg: OnboardingMatchedOrg | null;
  busy: boolean;
  onEnter: () => void;
}) {
  const isJoin = path === "join" && joinedOrg != null;
  const name = isJoin ? joinedOrg!.name : org.name;
  const logoColor = isJoin ? hashColor(joinedOrg!.name) : org.logo?.color ?? hashColor(org.name);
  const logoInitial = isJoin ? initialsOf(joinedOrg!.name) : org.logo?.initial ?? initialsOf(org.name);
  const logoSrc = isJoin ? undefined : org.logo?.src;
  return (
    <div className="ob-panel" key="welcome">
      <div className="ob-bigmark">
        <span className="ob-check-xl"><Icon name="check" size={26} /></span>
        <h1 className="ob-h1">{isJoin ? `You're in, welcome to ${name}` : `${name} is ready`}</h1>
        <p className="ob-sub" style={{ textAlign: "center", margin: "9px auto 0" }}>
          {isJoin
            ? "You've joined the organization. Here's what you can access."
            : "Your organization is set up. Here's a recap before you dive in."}
        </p>
      </div>
      <div className="ob-body">
        <div className="ob-summary">
          <div className="ob-srow">
            <Avatar size="sm" color={logoColor} initial={logoInitial} src={logoSrc} />
            <div className="ob-srow__meta">
              <div className="ob-srow__t">{name}</div>
              <div className="ob-srow__d">
                {isJoin ? `Joined as member · ${joinedOrg!.memberCount + 1} people` : "Organization · you're the owner"}
              </div>
            </div>
            <span className="ob-srow__tag">org</span>
          </div>

          {isJoin ? (
            <div className="ob-srow">
              <span className="ob-avatar ob-avatar--sm" style={{ background: "var(--color-surface-raised)", color: "var(--color-muted)" }}>
                <Icon name="users" size={14} />
              </span>
              <div className="ob-srow__meta">
                <div className="ob-srow__t">
                  {joinedOrg!.teamCount} {joinedOrg!.teamCount === 1 ? "team" : "teams"}
                </div>
                <div className="ob-srow__d">Browse and request to join teams inside {name}</div>
              </div>
              <span className="ob-srow__tag">teams</span>
            </div>
          ) : (
            <>
              <div className="ob-srow">
                <Avatar size="sm" color={team.color} initial={initialsOf(team.name)} emoji={team.emoji} />
                <div className="ob-srow__meta">
                  <div className="ob-srow__t">{team.name}</div>
                  <div className="ob-srow__d">Your first team · you're the admin</div>
                </div>
                <span className="ob-srow__tag">team</span>
              </div>
              <div className="ob-srow">
                <span className="ob-avatar ob-avatar--sm" style={{ background: "var(--color-surface-raised)", color: "var(--color-muted)" }}>
                  <Icon name="mail" size={14} />
                </span>
                <div className="ob-srow__meta">
                  <div className="ob-srow__t">
                    {invites.length ? `${invites.length} invite${invites.length > 1 ? "s" : ""} sent` : "No invites yet"}
                  </div>
                  <div className="ob-srow__d">
                    {allowDomain && domain ? `@${domain} is enabled for onboarding` : "Domain access is off"}
                  </div>
                </div>
                <span className="ob-srow__tag">members</span>
              </div>
            </>
          )}
        </div>
      </div>
      <div className="ob-foot">
        <button className="cds-btn cds-btn--lg cds-btn--primary ob-btn-block" disabled={busy} onClick={onEnter}>
          {busy ? (
            <span className="cds-spinner" />
          ) : (
            <>
              <span className="cds-btn__icon"><Icon name="arrow-right" /></span>
              {isJoin ? `Open ${name}` : "Go to your dashboard"}
            </>
          )}
        </button>
      </div>
    </div>
  );
}
