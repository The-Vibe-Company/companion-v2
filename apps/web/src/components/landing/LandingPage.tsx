"use client";

/* Companion marketing landing (v6A "Keystroke").
   Ported from the claude.ai/design handoff (landing-v6a-app.jsx). English-only,
   yellow accent. Reuses the app's Button/Badge (cds) and Icon (lucide) so the
   page stays in sync with the real design system. The portal demo is
   presentational — it mirrors the real Skills list but is not API-wired. */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button, Badge } from "@/components/cds";
import { Icon } from "@/components/Icon";

const GITHUB_URL = "https://github.com/The-Vibe-Company/companion";
const SKILL_MD_URL = "https://github.com/anthropics/skills";

/* ---------------------------------------------------------------- copy --- */

const COPY = {
  nav: { story: "How it works", portal: "The portal", devs: "For developers" },
  github: "GitHub",
  navCta: "Get started",
  heroTitlePre: "You can't be good at everything. ",
  heroTitleMark: "Your team already is.",
  heroSub:
    "Skills are your colleagues' best prompts, packaged. Browse the team library, install the ones you need, and use them in your AI for anything.",
  ctaPrimary: "Start your team's library",
  ctaSecondary: "See how it works",
  heroNote: "Free and open source",
  libLabel: "Team skill library",
  libInstall: "Install",
  libInstalled: "Installed",
  step1Label: "Install a skill from your team",
  step2Label: "Use it for anything",
  alsoLabel: "Also in the library",
  chatTitle: "Tom's AI assistant",
  chatUserText: "Draft a post about our new release",
  chatReplyMeta: "using linkedin-posts · by Léa, marketing",
  chatReplyHook: "Shipping week: the release nobody believed we'd pull off.",
  chatReplyBody: "One idea, told like a story. Ends on a question for the comments.",
  chatCaption: "Installed once. Léa's expertise, whenever Tom needs it.",
  cardTitle: "LinkedIn posts that sound human",
  lossNum: "Without Companion",
  lossTitle: "The same prompt, written four times.",
  lossSub:
    "You're brilliant at your job, so your prompts for it are brilliant too. Same for everyone else, in their own corner. But nothing circulates: each team quietly rebuilds what another already perfected. Hours lost, every week, in every team.",
  lossPunch: "Sound familiar?",
  lostNote: { where: "Marie · product", text: "Meeting-summary prompt v7. The good one." },
  lostDm: {
    who: "Jonas",
    a: "blue",
    text: "anyone got a good prompt for meeting notes?",
    time: "Tue 9:14 · third ask this month",
  },
  lostDoc: { where: "Tom · engineering", text: "meeting-notes-prompt-FINAL-v2" },
  lostGhost: { where: "you, next week", text: "About to write it a fourth time" },
  turnNum: "With Companion",
  turnTitle: "Borrow the expert, every time.",
  turnSub:
    "A skill is an expert's know-how, packaged: the best prompt for the job, written by the person who does that job best, ready for anyone to use.",
  turnSteps: [
    {
      title: "Experts publish",
      desc: "Léa publishes her LinkedIn skill, Sam his debugging assistant. Each skill comes from the person who knows that job best.",
    },
    {
      title: "Everyone borrows",
      desc: "Search the library, click, use. You post like marketing, debug like engineering, analyze like finance.",
    },
    {
      title: "Simply and safely",
      desc: "Each skill is shared exactly as widely as its owner decides: private, team, or the whole company.",
    },
  ],
  payoffNum: "The result",
  payoffTitle: "Every expert's best work, one search away.",
  payoffSub:
    "The library grows every week. New hires start with the whole company's playbook on day one.",
  portalCaption: "The actual portal. Click around: star, filter, install.",
  portalDescs: {
    "linkedin-posts": "Léa's prompt for posts that hook in line one and never sound like a robot.",
    "meeting-summaries": "Paste a transcript, get decisions, owners and deadlines.",
    "debug-my-setup": "Sam's checklist prompt for fixing a broken local setup.",
    "sales-research": "A 10-minute company brief before any sales call.",
    "brand-voice": "Rewrites anything in the company tone.",
    "weekly-report": "Your Friday report, assembled from the week's notes.",
  } as Record<string, string>,
  proofs: [
    {
      title: "Nothing gets reinvented",
      desc: "Search before you write. If someone already cracked it, it's in the library, with their name on it.",
    },
    {
      title: "The best version wins",
      desc: "Each skill comes from the person who does that job best, and every improvement they make reaches everyone instantly.",
    },
    {
      title: "Simple and secure",
      desc: "Sharing is explicit. Every skill is visible exactly as widely as its owner decides, and you always know who can use what.",
    },
  ],
  buildersStrong: "For developers:",
  buildersText:
    " a real toolchain underneath. Versioned skills, a command line, and the open SKILL.md standard. Never a black box.",
  finaleTitle: "Your company is full of experts. Borrow them.",
  finaleSub: "Up and running in minutes. The first skills can be live this afternoon.",
  finaleNote: "Your next prompt is already written.",
  finaleSmall:
    "Open source, MIT licensed. And if you ever need it, it can run entirely on your own infrastructure.",
  finaleCta: "Get started",
  footerBy: "an open source tool by The Vibe Company",
  footerDocs: "Documentation",
};

type Copy = typeof COPY;

/* Portal rows — machine values stay literal, like a real screenshot. */
type PortalRow = {
  id: string;
  team: string;
  who: string;
  a: string;
  scope: "private" | "team" | "public";
  scopeLabel: string;
  ver: string;
  stars: number;
  when: string;
  recent?: boolean;
  draft?: boolean;
};

const PORTAL_ROWS: PortalRow[] = [
  { id: "linkedin-posts", team: "marketing", who: "Léa", a: "terracotta", scope: "public", scopeLabel: "public", ver: "1.4.0", stars: 13, when: "2h ago", recent: true },
  { id: "meeting-summaries", team: "product", who: "Marie", a: "violet", scope: "public", scopeLabel: "public", ver: "2.2.0", stars: 11, when: "yesterday", recent: true },
  { id: "debug-my-setup", team: "platform", who: "Sam", a: "amber", scope: "team", scopeLabel: "platform", ver: "3.0.1", stars: 8, when: "3d ago", recent: true },
  { id: "sales-research", team: "sales", who: "Jonas", a: "blue", scope: "team", scopeLabel: "sales", ver: "1.0.2", stars: 6, when: "1w ago" },
  { id: "brand-voice", team: "marketing", who: "Léa", a: "terracotta", scope: "public", scopeLabel: "public", ver: "1.1.0", stars: 9, when: "2w ago" },
  { id: "weekly-report", team: "you", who: "You", a: "slate", scope: "private", scopeLabel: "you", ver: "0.9.1", stars: 0, when: "4w ago", draft: true },
];
const SCOPE_ICON: Record<PortalRow["scope"], string> = { private: "lock", team: "users", public: "globe" };

/* ------------------------------------------------------------ utilities --- */

function useReveal() {
  useEffect(() => {
    const els = Array.from(document.querySelectorAll(".v5-reveal"));
    let fired = false;
    const io = new IntersectionObserver(
      (entries) => {
        fired = true;
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("v5-reveal--in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.1 },
    );
    els.forEach((el) => io.observe(el));
    /* Fail open: if IO never fires (some embedded contexts), reveal everything. */
    const fallback = setTimeout(() => {
      if (!fired) els.forEach((el) => el.classList.add("v5-reveal--in"));
    }, 700);
    return () => {
      clearTimeout(fallback);
      io.disconnect();
    };
  }, []);
}

const prefersReducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function Avatar({ who, tone, sm }: { who: string; tone: string; sm?: boolean }) {
  return (
    <span className={"v5-avatar v5-avatar--" + tone + (sm ? " v5-avatar--sm" : "")} aria-hidden="true">
      {who[0]}
    </span>
  );
}

function HandArrow() {
  return (
    <svg width="72" height="44" viewBox="0 0 72 44" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 36 C 22 30, 44 26, 64 12" />
      <path d="M52 10 l 12 2 -5 11" />
    </svg>
  );
}

/* ----------------------------------------------------------------- hero --- */

function ChatDemo({ c, animate, replayKey }: { c: Copy; animate: boolean; replayKey: number }) {
  const FINAL = 4;
  // SSR-deterministic initial state (no window access) to avoid a hydration
  // mismatch for reduced-motion users; the effect below settles to FINAL on mount.
  const [step, setStep] = useState(animate ? 0 : FINAL);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    if (!animate || prefersReducedMotion()) {
      setStep(FINAL);
      return;
    }
    setStep(0);
    timers.current.push(setTimeout(() => setStep(1), 1300));
    timers.current.push(setTimeout(() => setStep(2), 2300));
    timers.current.push(setTimeout(() => setStep(3), 3300));
    timers.current.push(setTimeout(() => setStep(4), 4100));
    return () => timers.current.forEach(clearTimeout);
  }, [animate, replayKey]);

  return (
    <div data-screen-label="hero-install">
      <div className="v6-flow">
        <div className="v6-flow__col">
          <span className="v6-steplabel">
            <span className="v6-steplabel__num">01</span>
            {c.step1Label}
          </span>
          <div className="v6-panel">
            <div className="v6-panel__head">
              <span className="v5-brand__mark v5-brand__mark--logo v5-brand__mark--sm" aria-hidden="true" />
              {c.libLabel}
            </div>
            <div className="v6-panel__body">
              <div className={"v6-libcard" + (step >= 1 ? " v6-libcard--installed" : "")}>
                <div className="v6-card__title">{c.cardTitle}</div>
                <div className="v6-card__by">
                  <Avatar who="Léa" tone="terracotta" />
                  Léa · marketing
                </div>
                <div className="v6-card__foot">
                  {step >= 1 ? (
                    <Badge tone="ok" dot>
                      {c.libInstalled}
                    </Badge>
                  ) : (
                    <Button variant="primary" size="sm">
                      {c.libInstall}
                    </Button>
                  )}
                  <span className="v6-card__stars">
                    <Icon name="star" size={12} />14
                  </span>
                </div>
              </div>
              <div className="v6-minilabel">{c.alsoLabel}</div>
              <div>
                <div className="v6-minirow">
                  <Avatar who="Jonas" tone="blue" sm />
                  <span className="v6-minirow__name">cold-emails</span>
                  <span className="v6-minirow__stars">
                    <Icon name="star" size={11} />11
                  </span>
                </div>
                <div className="v6-minirow">
                  <Avatar who="Marie" tone="violet" sm />
                  <span className="v6-minirow__name">meeting-summaries</span>
                  <span className="v6-minirow__stars">
                    <Icon name="star" size={11} />12
                  </span>
                </div>
                <div className="v6-minirow">
                  <Avatar who="Sam" tone="amber" sm />
                  <span className="v6-minirow__name">debug-my-setup</span>
                  <span className="v6-minirow__stars">
                    <Icon name="star" size={11} />8
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div className={"v6-flow__connector" + (step >= 1 ? "" : " v5-hidden")} aria-hidden="true">
          <span className="v6-skillchip">linkedin-posts</span>
          <svg width="56" height="12" viewBox="0 0 56 12" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
            <path d="M2 6h44" />
            <path d="m40 1 8 5-8 5" />
          </svg>
        </div>
        <div className="v6-flow__col">
          <span className="v6-steplabel">
            <span className="v6-steplabel__num">02</span>
            {c.step2Label}
          </span>
          <div className="v6-panel">
            <div className="v6-panel__head">
              <Avatar who="Tom" tone="teal" sm />
              {c.chatTitle}
            </div>
            <div className="v6-panel__body">
              <div className="v6-chatmsgs">
                {step >= 2 && (
                  <div className="v6-bubble-user">
                    <span className="v6-skillchip">linkedin-posts</span>
                    <span>{c.chatUserText}</span>
                  </div>
                )}
                {step >= 3 && (
                  <div className="v6-reply">
                    <div className="v6-reply__meta">
                      <Avatar who="Léa" tone="terracotta" sm />
                      {c.chatReplyMeta}
                    </div>
                    <div className="v6-reply__hook">{c.chatReplyHook}</div>
                    <div className="v6-reply__body">{c.chatReplyBody}</div>
                  </div>
                )}
              </div>
              <div className="v6-composer">
                <span className="v6-composer__ghost">…</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      <div className={"v6-caption" + (step >= 4 ? "" : " v5-hidden")}>
        <span className="v5-avatars">
          <Avatar who="Léa" tone="terracotta" />
          <Avatar who="Tom" tone="teal" />
        </span>
        {c.chatCaption}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- sections --- */

function Nav({ c }: { c: Copy }) {
  return (
    <header className="v5-nav">
      <div className="v5-wrap v5-nav__inner">
        <a className="v5-brand" href="#top" aria-label="Companion">
          <span className="v5-brand__mark v5-brand__mark--logo" aria-hidden="true" />
          <span className="v5-brand__name">Companion</span>
        </a>
        <nav className="v5-nav__links" aria-label="Sections">
          <a className="v5-nav__link" href="#loss">
            {c.nav.story}
          </a>
          <a className="v5-nav__link" href="#payoff">
            {c.nav.portal}
          </a>
          <a className="v5-nav__link" href="#devs">
            {c.nav.devs}
          </a>
        </nav>
        <span className="v5-nav__spacer"></span>
        <div className="v5-nav__actions">
          <Button variant="ghost" size="sm" onClick={() => window.open(GITHUB_URL, "_blank", "noopener,noreferrer")}>
            {c.github} ↗
          </Button>
          <Link href="/login" className="cds-btn cds-btn--sm cds-btn--primary">
            {c.navCta}
          </Link>
        </div>
      </div>
    </header>
  );
}

function Hero({ c, animate, replayKey }: { c: Copy; animate: boolean; replayKey: number }) {
  const [swept, setSwept] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSwept(true), 500);
    return () => clearTimeout(id);
  }, []);
  return (
    <section className="v5-hero v5-wrap" id="top" data-screen-label="hero">
      <h1>
        {c.heroTitlePre}
        <span className={"v5-mark" + (swept ? " v5-mark--on" : "")}>{c.heroTitleMark}</span>
      </h1>
      <p className="v5-hero__sub">{c.heroSub}</p>
      <div className="v5-hero__ctas">
        <Link href="/login" className="cds-btn cds-btn--md cds-btn--primary">
          {c.ctaPrimary}
        </Link>
        <Button variant="secondary" onClick={() => { location.hash = "#loss"; }}>
          {c.ctaSecondary}
        </Button>
      </div>
      <p className="v5-hero__note">{c.heroNote}</p>
      <ChatDemo c={c} animate={animate} replayKey={replayKey} />
    </section>
  );
}

function Loss({ c }: { c: Copy }) {
  return (
    <section className="v5-act v5-loss" id="loss" data-screen-label="act-2-loss">
      <div className="v5-wrap v5-loss__grid">
        <div>
          <p className="v5-act__num">{c.lossNum}</p>
          <h2 className="v5-reveal">{c.lossTitle}</h2>
          <p className="v5-act__sub v5-reveal">{c.lossSub}</p>
          <p className="v5-loss__punch v5-reveal">{c.lossPunch}</p>
        </div>
        <div className="v5-scatter v5-reveal" aria-hidden="true">
          <div className="v5-lost v5-lost--note">
            <div className="v5-lost__where">{c.lostNote.where}</div>
            <div className="v5-lost__text">{c.lostNote.text}</div>
          </div>
          <div className="v5-lost v5-lost--dm">
            <div className="v5-dm__row">
              <Avatar who={c.lostDm.who} tone={c.lostDm.a} sm />
              <div className="v5-dm__bubble">
                <div className="v5-lost__text">{c.lostDm.text}</div>
              </div>
            </div>
            <div className="v5-dm__time">{c.lostDm.time}</div>
          </div>
          <div className="v5-lost v5-lost--doc">
            <div className="v5-lost__where">{c.lostDoc.where}</div>
            <div className="v5-lost__text">{c.lostDoc.text}</div>
            <div className="v5-docline"></div>
            <div className="v5-docline"></div>
            <div className="v5-docline v5-docline--short"></div>
          </div>
          <div className="v5-lost v5-lost--ghost">
            <div className="v5-lost__where">{c.lostGhost.where}</div>
            <div className="v5-lost__text">{c.lostGhost.text}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Turn({ c }: { c: Copy }) {
  return (
    <section className="v5-act v5-turn" data-screen-label="act-3-turn">
      <div className="v5-wrap">
        <div className="v5-turn__head">
          <p className="v5-act__num">{c.turnNum}</p>
          <h2 className="v5-reveal">{c.turnTitle}</h2>
          <p className="v5-act__sub v5-reveal">{c.turnSub}</p>
        </div>
        <div className="v5-turn__steps">
          {c.turnSteps.map((s, i) => (
            <article className="v5-turn__step v5-reveal" key={s.title}>
              <span className="v5-turn__step-num">0{i + 1}</span>
              <h3>{s.title}</h3>
              <p>{s.desc}</p>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function PortalCapture({ c }: { c: Copy }) {
  const [selected, setSelected] = useState("linkedin-posts");
  const [starred, setStarred] = useState<Record<string, boolean>>({ "linkedin-posts": true, "meeting-summaries": true });
  const [installed, setInstalled] = useState<Record<string, boolean>>({ "meeting-summaries": true });
  const [nav, setNav] = useState("all");
  const [tab, setTab] = useState("all");

  const starsOf = (r: PortalRow) => r.stars + (starred[r.id] ? 1 : 0);
  const teams = ["marketing", "product", "platform", "sales"];

  let rows = PORTAL_ROWS;
  if (nav === "mine") rows = rows.filter((r) => r.team === "you");
  else if (nav === "starred") rows = rows.filter((r) => starred[r.id]);
  else if (nav.indexOf("team:") === 0) rows = rows.filter((r) => r.team === nav.slice(5));
  if (tab === "picks") rows = rows.filter((r) => starsOf(r) >= 9);
  if (tab === "recent") rows = rows.filter((r) => r.recent);

  const sel = PORTAL_ROWS.find((r) => r.id === selected) ?? PORTAL_ROWS[0]!;
  const navLabel =
    nav === "mine"
      ? "my skills"
      : nav === "starred"
        ? "starred"
        : nav.indexOf("team:") === 0
          ? "team: " + nav.slice(5)
          : null;

  const toggleStar = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    setStarred((s) => ({ ...s, [id]: !s[id] }));
  };

  const NavItem = ({ k, icon, label, count }: { k: string; icon: string; label: string; count: number }) => (
    <button
      type="button"
      className={"v6-reset-btn v5-portal__navitem" + (nav === k ? " v5-portal__navitem--active" : "")}
      onClick={() => setNav(k)}
    >
      <Icon name={icon} size={14} /> {label} <span className="v5-portal__navcount">{count}</span>
    </button>
  );

  return (
    <div className="v5-libframe v6-pframe v5-reveal" data-screen-label="portal-capture">
      <div className="v5-portal">
        <aside className="v5-portal__side">
          <div className="v5-portal__org">
            <span className="v5-brand__mark v5-brand__mark--sm">A</span>
            acme
            <span className="v5-portal__kbd">⌘K</span>
          </div>
          <NavItem k="mine" icon="user" label="My skills" count={PORTAL_ROWS.filter((r) => r.team === "you").length} />
          <div className="v5-portal__grouplabel">Workspace</div>
          <NavItem k="all" icon="layers" label="All skills" count={PORTAL_ROWS.length} />
          <NavItem k="starred" icon="star" label="Starred" count={PORTAL_ROWS.filter((r) => starred[r.id]).length} />
          <div className="v5-portal__grouplabel">Teams</div>
          {teams.map((t) => (
            <NavItem key={t} k={"team:" + t} icon="users" label={t} count={PORTAL_ROWS.filter((r) => r.team === t).length} />
          ))}
        </aside>
        <div className="v5-portal__main">
          <div className="v5-portal__head">
            <span className="v5-portal__title">Skills</span>
            <span className="v5-portal__count">{rows.length}</span>
            <span className="v5-portal__spacer"></span>
            <Button variant="primary" size="sm">
              Upload skill
            </Button>
          </div>
          <div className="v5-portal__viewbar">
            {([["all", "All skills"], ["picks", "Team picks"], ["recent", "Recently updated"]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={"v6-reset-btn v5-portal__view" + (tab === k ? " v5-portal__view--active" : "")}
                onClick={() => setTab(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="v5-portal__filterbar">
            <span className="v5-fchip">
              <Icon name="plus" size={11} /> Filter
            </span>
            {navLabel && (
              <span className="v5-fchip">
                <Icon name="users" size={11} />
                {navLabel}
                <button type="button" className="v6-reset-btn v6-fchip-x" aria-label="Clear filter" onClick={() => setNav("all")}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            )}
          </div>
          <div className="v5-portal__chead" aria-hidden="true">
            <span></span>
            <span>Skill</span>
            <span>Scope</span>
            <span>Version</span>
            <span style={{ textAlign: "right" }}>Stars</span>
            <span style={{ textAlign: "right" }}>Updated</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.id}
              className={"v5-portal__crow" + (r.id === selected ? " v5-portal__crow--active" : "")}
              role="button"
              tabIndex={0}
              onClick={() => setSelected(r.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  setSelected(r.id);
                }
              }}
            >
              <span className={"v5-vdot" + (r.draft ? " v5-vdot--unknown" : "")}></span>
              <span className="v5-portal__name">{r.id}</span>
              <span className="v5-portal__scope">
                <Icon name={SCOPE_ICON[r.scope]} size={11} />
                {r.scopeLabel}
              </span>
              <span className="v5-portal__ver">{r.ver}</span>
              <button
                type="button"
                aria-label={"Star " + r.id}
                className={"v6-reset-btn v6-pstar v5-portal__stars" + (starred[r.id] ? " v5-portal__stars--on" : "")}
                onClick={(e) => toggleStar(e, r.id)}
              >
                <Icon name="star" size={12} />
                {starsOf(r)}
              </button>
              <span className="v5-portal__when">{r.when}</span>
            </div>
          ))}
        </div>
        <aside className="v6-pdrawer">
          <div className="v6-pdrawer__head">
            <h3 className="v6-pdrawer__title">{sel.id}</h3>
            <span className="v5-portal__scope">
              <Icon name={SCOPE_ICON[sel.scope]} size={11} />
              {sel.scopeLabel}
            </span>
          </div>
          <p className="v6-pdrawer__desc">{c.portalDescs[sel.id] || ""}</p>
          <dl className="v6-pdrawer__kv">
            <dt>owner</dt>
            <dd>
              {sel.who} · {sel.team}
            </dd>
            <dt>version</dt>
            <dd>{sel.ver}</dd>
            <dt>stars</dt>
            <dd>{starsOf(sel)}</dd>
            <dt>updated</dt>
            <dd>{sel.when}</dd>
          </dl>
          <div className="v6-pdrawer__actions">
            {installed[sel.id] ? (
              <Badge tone="ok" dot>
                {c.libInstalled}
              </Badge>
            ) : (
              <Button variant="primary" size="sm" onClick={() => setInstalled((s) => ({ ...s, [sel.id]: true }))}>
                {c.libInstall}
              </Button>
            )}
            <button
              type="button"
              className={"v6-reset-btn v5-portal__stars" + (starred[sel.id] ? " v5-portal__stars--on" : "")}
              onClick={(e) => toggleStar(e, sel.id)}
            >
              <Icon name="star" size={12} />
              {starsOf(sel)}
            </button>
          </div>
        </aside>
      </div>
      <div className="v5-libframe__caption">{c.portalCaption}</div>
    </div>
  );
}

function Payoff({ c }: { c: Copy }) {
  return (
    <section className="v5-act" id="payoff" data-screen-label="act-4-payoff">
      <div className="v5-wrap">
        <p className="v5-act__num">{c.payoffNum}</p>
        <h2 className="v5-reveal">{c.payoffTitle}</h2>
        <p className="v5-act__sub v5-reveal">{c.payoffSub}</p>
        <PortalCapture c={c} />
        <div className="v5-proofs">
          {c.proofs.map((p, i) => (
            <div className="v5-proof v5-reveal" key={p.title}>
              <span className="v5-proof__num">0{i + 1}</span>
              <h3>{p.title}</h3>
              <p>{p.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Builders({ c }: { c: Copy }) {
  return (
    <div className="v5-builders" id="devs" data-screen-label="for-developers">
      <div className="v5-wrap v5-builders__inner">
        <span className="v5-builders__text">
          <strong>{c.buildersStrong}</strong>
          {c.buildersText}
        </span>
        <span className="v5-builders__code">companion skills push · pull · sync</span>
        <span className="v5-builders__spacer"></span>
        <Button variant="secondary" size="sm" onClick={() => window.open(GITHUB_URL, "_blank", "noopener,noreferrer")}>
          GitHub ↗
        </Button>
      </div>
    </div>
  );
}

function Finale({ c }: { c: Copy }) {
  return (
    <section className="v5-finale" id="start" data-screen-label="finale">
      <div className="v5-wrap">
        <h2>{c.finaleTitle}</h2>
        <p className="v5-finale__sub">{c.finaleSub}</p>
        <div className="v5-finale__note">
          <span className="v5-note__tape" aria-hidden="true"></span>
          {c.finaleNote}
        </div>
        <div className="v5-finale__ctas">
          <Link href="/login" className="cds-btn cds-btn--md cds-btn--primary">
            {c.finaleCta}
          </Link>
          <Button variant="secondary" onClick={() => window.open(GITHUB_URL, "_blank", "noopener,noreferrer")}>
            {c.github} ↗
          </Button>
        </div>
        <p className="v5-finale__small">{c.finaleSmall}</p>
      </div>
    </section>
  );
}

function Footer({ c }: { c: Copy }) {
  return (
    <footer className="v5-footer">
      <div className="v5-wrap v5-footer__inner">
        <span className="v5-brand">
          <span className="v5-brand__mark v5-brand__mark--logo v5-brand__mark--sm" aria-hidden="true" />
          <span className="v5-brand__name v5-brand__name--sm">Companion</span>
        </span>
        <span>{c.footerBy}</span>
        <span className="v5-footer__links">
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub ↗
          </a>
          <a href={SKILL_MD_URL} target="_blank" rel="noreferrer">
            SKILL.md ↗
          </a>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            {c.footerDocs} ↗
          </a>
        </span>
      </div>
    </footer>
  );
}

/* ------------------------------------------------------------------ app --- */

export function LandingPage() {
  const c = COPY;
  useReveal();

  return (
    <div className="v5-landing">
      <Nav c={c} />
      <main>
        <Hero c={c} animate={true} replayKey={0} />
        <Loss c={c} />
        <Turn c={c} />
        <Payoff c={c} />
        <Builders c={c} />
        <Finale c={c} />
      </main>
      <Footer c={c} />
    </div>
  );
}
