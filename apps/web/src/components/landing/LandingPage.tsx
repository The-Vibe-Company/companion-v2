"use client";

/* Companion marketing landing (v10 "Linear Light").
   Clean, precise, product-forward light design: near-white surfaces, fine
   hairlines, soft shadows, restrained yellow accent, big real-product hero.
   Copy stays non-technical (skill = recipe). The portal demo mirrors the
   real Skills list but is presentational, not API-wired. */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/cds";
import { Icon } from "@/components/Icon";

const GITHUB_URL = "https://github.com/The-Vibe-Company/companion";
const SKILL_MD_URL = "https://github.com/anthropics/skills";

/* ---------------------------------------------------------------- copy --- */

const COPY = {
  nav: { idea: "The idea", difference: "The difference", why: "Why it matters" },
  github: "GitHub",
  navCta: "Get started",
  heroBadge: "For teams using AI",
  heroTitlePre: "You can't be good at everything. ",
  heroTitleMark: "Your team already is.",
  heroSub:
    "In every company, a few people have cracked how to get great results from AI. Companion is the team library where they save those methods — so everyone else gets the same results, in one click.",
  ctaPrimary: "Start your team's library",
  ctaSecondary: "See how it works",
  heroNote: "Free · Open source · Yours to keep",
  tickerLabel: "A few skills already in the library",
  libInstall: "Use this skill",
  libInstalled: "Added",
  lossNum: "Sound familiar?",
  lossTitle: "“Anyone got a good prompt for meeting notes?”",
  lossSub:
    "Tuesday, 9:14. Marie has the perfect method — buried in her notes app. Jonas asks the chat. Tom rewrites his own from scratch. The know-how exists, it just doesn't travel.",
  lossPunch: "Hours lost, every week, in every team.",
  lostNote: { where: "Marie · product", text: "Meeting-summary prompt v7. The good one." },
  lostDm: {
    who: "Jonas",
    a: "blue",
    text: "anyone got a good prompt for meeting notes?",
    time: "Tue 9:14 · third ask this month",
  },
  lostDoc: { where: "Tom · engineering", text: "meeting-notes-prompt-FINAL-v2" },
  lostGhost: { where: "you, next week", text: "About to write it a fourth time" },
  ideaNum: "The idea",
  ideaTitle: "A skill is a recipe for a task.",
  ideaSub:
    "The person who does a task best writes down exactly how they do it — what to ask, what to check, what to avoid. That's a skill. From then on, anyone can do that task the same way, with the same result.",
  ideaPoints: [
    {
      icon: "user",
      title: "Written by your best person",
      desc: "Not downloaded from the internet — Marie's method, from Marie.",
    },
    {
      icon: "zap",
      title: "Used in one click",
      desc: "No digging through docs, no asking around. Pick it and go.",
    },
    {
      icon: "arrow-up-circle",
      title: "Better every week",
      desc: "When Marie improves her method, everyone's version improves with it.",
    },
  ],
  diffNum: "The difference",
  diffTitle: "Same question. Different league.",
  diffWithoutLabel: "Without the skill",
  diffYou: "can you sum up this meeting?",
  diffWithoutAi:
    "The meeting covered the onboarding project and next steps. The team discussed timelines and some budget topics. A few action items were noted. Overall, it was a productive session.",
  diffWithoutCap: "Polite. Vague. Useless.",
  diffWithLabel: "With Marie's skill",
  diffWithChip: "meeting summaries · by Marie",
  diffWithAi1: "Decisions (3) — We will ship the new onboarding on the 24th…",
  diffWithAi2: "Actions (5) — Sam: staging fix, due Thursday…",
  diffWithCap: "Decisions, owners, deadlines. Every single time.",
  diffPunchPre: "Same AI. Same question. ",
  diffPunchMark: "The method makes the difference.",
  portalCaption: "click around: filter, pick a skill.",
  portalDescs: {
    "linkedin-posts": "Léa's method for posts that hook in line one and never sound like a robot.",
    "meeting-summaries": "Paste a transcript, get decisions, owners and deadlines.",
    "debug-my-setup": "Sam's checklist for fixing a broken setup, step by step.",
    "sales-research": "A 10-minute company brief before any sales call.",
    "brand-voice": "Rewrites anything in the company tone.",
    "weekly-report": "Your Friday report, assembled from the week's notes.",
  } as Record<string, string>,
  whyNum: "Why it matters",
  whyTitlePre: "Know-how that ",
  whyTitleMark: "stays in the building.",
  whySub:
    "Anyone can buy the same AI. Nobody else has your people's skills. That edge is yours — and it gets sharper every week.",
  whyCols: [
    {
      icon: "search",
      title: "Nothing gets reinvented",
      desc: "Search before you write. If someone already cracked it, it's in the library, with their name on it.",
    },
    {
      icon: "users",
      title: "People leave, skills stay",
      desc: "When Marie moves on, her method doesn't. New hires start with the whole company's playbook on day one.",
    },
    {
      icon: "arrow-up-circle",
      title: "Better every week",
      desc: "One person improves a skill, everyone gets the improvement. The gap with the outside grows quietly.",
    },
  ],
  trustTitle: "Safe by default.",
  trustText:
    "Keep a skill private in My Skills or share it with your organization. Companion can run its control plane and skill registry on your own servers, so governance stays on infrastructure you control.",
  trustDevStrong: "For the tech-curious:",
  trustDevText:
    " skills are versioned SKILL.md files — an open standard, never a black box. Free and open source, MIT licensed.",
  finaleTitlePre: "Your company is full of experts. ",
  finaleTitleMark: "Borrow them.",
  finaleSub: "Set up takes an afternoon. The first skills can be shared today.",
  finaleSmall: "Free and open source · runs on your own infrastructure if you want",
  finaleCta: "Get started",
  footerBy: "an open source tool by The Vibe Company",
  footerDocs: "Documentation",
};

type Copy = typeof COPY;

/* Portal rows — machine values stay literal, like a real screenshot. */
type PortalRow = {
  id: string;
  library: "personal" | "org";
  group: string;
  who: string;
  a: string;
  scopeLabel: string;
  ver: string;
  when: string;
  recent?: boolean;
  draft?: boolean;
};

const PORTAL_ROWS: PortalRow[] = [
  { id: "linkedin-posts", library: "org", group: "marketing", who: "Léa", a: "terracotta", scopeLabel: "Organization", ver: "1.4.0", when: "2h ago", recent: true },
  { id: "meeting-summaries", library: "org", group: "product", who: "Marie", a: "violet", scopeLabel: "Organization", ver: "2.2.0", when: "yesterday", recent: true },
  { id: "debug-my-setup", library: "org", group: "platform", who: "Sam", a: "amber", scopeLabel: "Organization", ver: "3.0.1", when: "3d ago", recent: true },
  { id: "sales-research", library: "org", group: "sales", who: "Jonas", a: "blue", scopeLabel: "Organization", ver: "1.0.2", when: "1w ago" },
  { id: "brand-voice", library: "org", group: "marketing", who: "Léa", a: "terracotta", scopeLabel: "Organization", ver: "1.1.0", when: "2w ago" },
  { id: "weekly-report", library: "personal", group: "operations", who: "You", a: "slate", scopeLabel: "My Skills", ver: "0.9.1", when: "4w ago", draft: true },
];
const SCOPE_ICON: Record<PortalRow["library"], string> = { personal: "lock", org: "users" };

/* Ticker chips — the portal rows in motion, plus a couple of off-screen extras. */
type TickerSkill = { id: string; who: string; a: string };
const TICKER_SKILLS: TickerSkill[] = [
  ...PORTAL_ROWS.filter((r) => !r.draft).map((r) => ({ id: r.id, who: r.who, a: r.a })),
  { id: "cold-emails", who: "Jonas", a: "blue" },
  { id: "incident-postmortem", who: "Sam", a: "amber" },
];

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

function Avatar({ who, tone, sm }: { who: string; tone: string; sm?: boolean }) {
  return (
    <span className={"v5-avatar v5-avatar--" + tone + (sm ? " v5-avatar--sm" : "")} aria-hidden="true">
      {who[0]}
    </span>
  );
}

/* The skill card — the "recipe" made tangible. */
function SkillCard() {
  return (
    <div className="v10-skill" aria-label="Example of a skill">
      <span className="v10-skill__chip">
        <Icon name="zap" size={11} /> Skill
      </span>
      <h3 className="v10-skill__title">Meeting summaries</h3>
      <p className="v10-skill__desc">Turn a raw meeting transcript into decisions, owners and deadlines.</p>
      <div className="v10-skill__who">
        <Avatar who="Marie" tone="violet" sm />
        Written by Marie · Product
      </div>
      <div className="v10-skill__stats">
        <span>
          <Icon name="users" size={11} /> Used by 23 teammates
        </span>
        <span>
          <Icon name="history" size={11} /> Updated this week
        </span>
      </div>
      <Link href="/login" className="v10-btn v10-btn--primary v10-btn--sm v10-skill__cta">
        Use this skill
      </Link>
    </div>
  );
}

/* ------------------------------------------------------------- sections --- */

function Nav({ c }: { c: Copy }) {
  return (
    <header className="v10-nav">
      <div className="v10-wrap v10-nav__inner">
        <a className="v5-brand" href="#top" aria-label="Companion">
          <span className="v10-wordmark" role="img" aria-label="Companion" />
        </a>
        <nav className="v10-nav__links" aria-label="Sections">
          <a className="v10-nav__link" href="#idea">
            {c.nav.idea}
          </a>
          <a className="v10-nav__link" href="#difference">
            {c.nav.difference}
          </a>
          <a className="v10-nav__link" href="#why">
            {c.nav.why}
          </a>
        </nav>
        <span className="v10-nav__spacer"></span>
        <div className="v10-nav__actions">
          <a
            className="v10-btn v10-btn--ghost v10-btn--sm"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {c.github} ↗
          </a>
          <Link href="/login" className="v10-btn v10-btn--primary v10-btn--sm">
            {c.navCta}
          </Link>
        </div>
      </div>
    </header>
  );
}

function Hero({ c }: { c: Copy }) {
  const [swept, setSwept] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setSwept(true), 500);
    return () => clearTimeout(id);
  }, []);
  return (
    <section className="v10-hero" id="top" data-screen-label="hero">
      <div className="v10-hero__glow" aria-hidden="true"></div>
      <div className="v10-wrap v10-hero__inner">
        <span className="v10-badge">
          <span className="v10-badge__dot" aria-hidden="true"></span>
          {c.heroBadge}
        </span>
        <h1 className="v10-h1">
          {c.heroTitlePre}
          <span className={"v10-hl" + (swept ? " v10-hl--on" : "")}>{c.heroTitleMark}</span>
        </h1>
        <p className="v10-hero__sub">{c.heroSub}</p>
        <div className="v10-hero__ctas">
          <Link href="/login" className="v10-btn v10-btn--primary">
            {c.ctaPrimary}
          </Link>
          <a className="v10-btn v10-btn--ghost" href="#problem">
            {c.ctaSecondary}
          </a>
        </div>
        <p className="v10-hero__note">{c.heroNote}</p>
        <div className="v10-hero__product v5-reveal">
          <PortalCapture c={c} />
        </div>
      </div>
    </section>
  );
}

function Ticker({ c }: { c: Copy }) {
  const chips = [...TICKER_SKILLS, ...TICKER_SKILLS];
  return (
    <section className="v10-ticker" data-screen-label="skill-ticker" aria-hidden="true">
      <div className="v10-wrap">
        <span className="v10-ticker__label">{c.tickerLabel}</span>
      </div>
      <div className="v10-ticker__mask">
        <div className="v10-ticker__track">
          {chips.map((s, i) => (
            <span className="v10-ticker__chip" key={s.id + i}>
              <Avatar who={s.who} tone={s.a} sm />
              <span className="v10-ticker__name">{s.id}</span>
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}

function Problem({ c }: { c: Copy }) {
  return (
    <section className="v10-sec" id="problem" data-screen-label="the-problem">
      <div className="v10-wrap v10-problem__grid">
        <div>
          <p className="v10-kick">{c.lossNum}</p>
          <h2 className="v10-h2 v5-reveal">{c.lossTitle}</h2>
          <p className="v10-sub v5-reveal">{c.lossSub}</p>
          <p className="v10-punch v5-reveal">
            <span className="v10-hl v10-hl--lit">{c.lossPunch}</span>
          </p>
        </div>
        <div className="v10-scatter v5-reveal" aria-hidden="true">
          <div className="v10-art v10-art--note">
            <div className="v10-art__where">{c.lostNote.where}</div>
            <div className="v10-art__text">{c.lostNote.text}</div>
          </div>
          <div className="v10-art v10-art--dm">
            <div className="v10-dm__row">
              <Avatar who={c.lostDm.who} tone={c.lostDm.a} sm />
              <div className="v10-dm__bubble">
                <div className="v10-art__text">{c.lostDm.text}</div>
              </div>
            </div>
            <div className="v10-dm__time">{c.lostDm.time}</div>
          </div>
          <div className="v10-art v10-art--doc">
            <div className="v10-art__where">{c.lostDoc.where}</div>
            <div className="v10-art__text">{c.lostDoc.text}</div>
            <div className="v10-docline"></div>
            <div className="v10-docline"></div>
            <div className="v10-docline v10-docline--short"></div>
          </div>
          <div className="v10-art v10-art--ghost">
            <div className="v10-art__where">{c.lostGhost.where}</div>
            <div className="v10-art__text">{c.lostGhost.text}</div>
          </div>
        </div>
      </div>
    </section>
  );
}

function Idea({ c }: { c: Copy }) {
  return (
    <section className="v10-sec v10-sec--dim" id="idea" data-screen-label="the-idea">
      <div className="v10-wrap v10-idea__grid">
        <div>
          <p className="v10-kick">{c.ideaNum}</p>
          <h2 className="v10-h2 v5-reveal">{c.ideaTitle}</h2>
          <p className="v10-sub v5-reveal">{c.ideaSub}</p>
          <div className="v10-idea__points">
            {c.ideaPoints.map((p) => (
              <div className="v10-idea__point v5-reveal" key={p.title}>
                <span className="v10-pic" aria-hidden="true">
                  <Icon name={p.icon} size={15} />
                </span>
                <div>
                  <h3>{p.title}</h3>
                  <p>{p.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="v5-reveal">
          <SkillCard />
        </div>
      </div>
    </section>
  );
}

function Compare({ c }: { c: Copy }) {
  return (
    <section className="v10-sec" id="difference" data-screen-label="the-difference">
      <div className="v10-wrap">
        <p className="v10-kick">{c.diffNum}</p>
        <h2 className="v10-h2 v5-reveal">{c.diffTitle}</h2>
        <div className="v10-cmp">
          <div className="v5-reveal">
            <p className="v10-cmp__label">{c.diffWithoutLabel}</p>
            <div className="v10-cmp__card">
              <div className="v10-cmp__you">{c.diffYou}</div>
              <div className="v10-cmp__ai">{c.diffWithoutAi}</div>
            </div>
            <p className="v10-cmp__cap">{c.diffWithoutCap}</p>
          </div>
          <div className="v5-reveal">
            <p className="v10-cmp__label v10-cmp__label--good">{c.diffWithLabel}</p>
            <div className="v10-cmp__card v10-cmp__card--good">
              <div className="v10-cmp__you">{c.diffYou}</div>
              <div className="v10-cmp__ai v10-cmp__ai--good">
                <span className="v10-cmp__skill">
                  <Icon name="zap" size={11} /> {c.diffWithChip}
                </span>
                <span>{c.diffWithAi1}</span>
                <span>{c.diffWithAi2}</span>
              </div>
            </div>
            <p className="v10-cmp__cap">{c.diffWithCap}</p>
          </div>
        </div>
        <p className="v10-punchline v5-reveal">
          {c.diffPunchPre}
          <span className="v10-hl v10-hl--lit">{c.diffPunchMark}</span>
        </p>
      </div>
    </section>
  );
}

function PortalCapture({ c }: { c: Copy }) {
  const [selected, setSelected] = useState("linkedin-posts");
  const [installed, setInstalled] = useState<Record<string, boolean>>({ "meeting-summaries": true });
  const [nav, setNav] = useState<PortalRow["library"]>("org");
  const [tab, setTab] = useState("all");

  let rows = PORTAL_ROWS.filter((r) => r.library === nav);
  if (tab === "recent") rows = rows.filter((r) => r.recent);

  const selectedId = rows.some((r) => r.id === selected) ? selected : rows[0]?.id;
  const sel = rows.find((r) => r.id === selectedId);
  const navLabel = nav === "personal" ? "My Skills" : null;

  const NavItem = ({ k, icon, label, count }: { k: PortalRow["library"]; icon: string; label: string; count: number }) => (
    <button
      type="button"
      className={"v6-reset-btn v5-portal__navitem" + (nav === k ? " v5-portal__navitem--active" : "")}
      aria-current={nav === k ? "true" : undefined}
      onClick={() => setNav(k)}
    >
      <Icon name={icon} size={14} /> {label} <span className="v5-portal__navcount">{count}</span>
    </button>
  );

  return (
    <div className="v10-libframe v6-pframe" data-screen-label="portal-capture">
      <div className="v5-portal">
        <aside className="v5-portal__side">
          <div className="v5-portal__org">
            <span className="v5-brand__mark v5-brand__mark--sm">Y</span>
            Your organization
          </div>
          <div className="v5-portal__grouplabel">Libraries</div>
          <NavItem k="personal" icon="user" label="My Skills" count={PORTAL_ROWS.filter((r) => r.library === "personal").length} />
          <NavItem k="org" icon="users" label="Organization" count={PORTAL_ROWS.filter((r) => r.library === "org").length} />
        </aside>
        <div className="v5-portal__main">
          <div className="v5-portal__head">
            <span className="v5-portal__title">{nav === "personal" ? "My Skills" : "Organization"}</span>
            <span className="v5-portal__count">{rows.length}</span>
            <span className="v5-portal__spacer"></span>
            <Link href="/login" className="cds-btn cds-btn--sm cds-btn--primary">
              Share a skill
            </Link>
          </div>
          <div className="v5-portal__viewbar">
            {([["all", "All skills"], ["recent", "Recently updated"]] as const).map(([k, label]) => (
              <button
                key={k}
                type="button"
                className={"v6-reset-btn v5-portal__view" + (tab === k ? " v5-portal__view--active" : "")}
                aria-current={tab === k ? "true" : undefined}
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
                <Icon name="lock" size={11} />
                {navLabel}
                <button type="button" className="v6-reset-btn v6-fchip-x" aria-label="Clear library filter" onClick={() => setNav("org")}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            )}
          </div>
          <div className="v5-portal__chead" aria-hidden="true">
            <span></span>
            <span>Skill</span>
            <span>Library</span>
            <span>Version</span>
            <span style={{ textAlign: "right" }}>Updated</span>
          </div>
          {rows.map((r) => (
            <div
              key={r.id}
              className={"v5-portal__crow" + (r.id === selectedId ? " v5-portal__crow--active" : "")}
              role="button"
              tabIndex={0}
              aria-pressed={r.id === selectedId}
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
                <Icon name={SCOPE_ICON[r.library]} size={11} />
                {r.scopeLabel}
              </span>
              <span className="v5-portal__ver">{r.ver}</span>
              <span className="v5-portal__when">{r.when}</span>
            </div>
          ))}
          {rows.length === 0 && (
            <div className="v5-portal__cempty">
              {nav === "personal" ? "No recently updated skills in My Skills." : "No skills match these filters."}
            </div>
          )}
        </div>
        {sel ? (
          <aside className="v6-pdrawer" aria-labelledby={`portal-skill-${sel.id}`}>
            <div className="v6-pdrawer__head">
              <Avatar who={sel.who} tone={sel.a} sm />
              <h3 className="v6-pdrawer__title" id={`portal-skill-${sel.id}`}>{sel.id}</h3>
              <span className="v5-portal__scope">
                <Icon name={SCOPE_ICON[sel.library]} size={11} />
                {sel.scopeLabel}
              </span>
            </div>
            <p className="v6-pdrawer__desc">{c.portalDescs[sel.id] || ""}</p>
            <dl className="v6-pdrawer__kv">
              <dt>{sel.library === "personal" ? "created by" : "shared by"}</dt>
              <dd>
                {sel.who} · {sel.group}
              </dd>
              <dt>version</dt>
              <dd>{sel.ver}</dd>
              <dt>updated</dt>
              <dd>{sel.when}</dd>
            </dl>
            <div className="v6-pdrawer__actions" aria-live="polite">
              <Button
                variant="primary"
                size="sm"
                aria-disabled={Boolean(installed[sel.id])}
                aria-pressed={Boolean(installed[sel.id])}
                onClick={() => {
                  if (!installed[sel.id]) setInstalled((s) => ({ ...s, [sel.id]: true }));
                }}
              >
                {installed[sel.id] ? c.libInstalled : c.libInstall}
              </Button>
            </div>
          </aside>
        ) : (
          <aside className="v6-pdrawer v6-pdrawer--empty" aria-label="Skill details">
            <p className="v6-pdrawer__desc">No skill selected.</p>
          </aside>
        )}
      </div>
      <div className="v5-libframe__caption">{c.portalCaption}</div>
    </div>
  );
}

function Why({ c }: { c: Copy }) {
  return (
    <section className="v10-sec v10-sec--dim" id="why" data-screen-label="why-it-matters">
      <div className="v10-wrap">
        <p className="v10-kick v10-kick--center">{c.whyNum}</p>
        <h2 className="v10-h2 v10-h2--center v5-reveal">
          {c.whyTitlePre}
          <span className="v10-hl v10-hl--lit">{c.whyTitleMark}</span>
        </h2>
        <p className="v10-sub v10-sub--center v5-reveal">{c.whySub}</p>
        <div className="v10-why">
          {c.whyCols.map((col) => (
            <div className="v10-why__card v5-reveal" key={col.title}>
              <span className="v10-pic" aria-hidden="true">
                <Icon name={col.icon} size={16} />
              </span>
              <h3>{col.title}</h3>
              <p>{col.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Trust({ c }: { c: Copy }) {
  return (
    <div className="v10-trust" data-screen-label="trust">
      <div className="v10-wrap v10-trust__inner">
        <h2 className="v10-trust__title">{c.trustTitle}</h2>
        <p className="v10-trust__text">{c.trustText}</p>
        <div className="v10-trust__dev">
          <span className="v10-trust__devtext">
            <strong>{c.trustDevStrong}</strong>
            {c.trustDevText}
          </span>
          <a
            className="v10-btn v10-btn--ghost v10-btn--sm"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            GitHub ↗
          </a>
        </div>
      </div>
    </div>
  );
}

function Finale({ c }: { c: Copy }) {
  return (
    <section className="v10-finale" id="start" data-screen-label="finale">
      <div className="v10-finale__glow" aria-hidden="true"></div>
      <div className="v10-wrap">
        <h2 className="v10-h2 v10-h2--center">
          {c.finaleTitlePre}
          <span className="v10-hl v10-hl--lit">{c.finaleTitleMark}</span>
        </h2>
        <p className="v10-finale__sub">{c.finaleSub}</p>
        <div className="v10-finale__ctas">
          <Link href="/login" className="v10-btn v10-btn--primary v10-btn--lg">
            {c.finaleCta}
          </Link>
          <a
            className="v10-btn v10-btn--ghost v10-btn--lg"
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
          >
            {c.github} ↗
          </a>
        </div>
        <p className="v10-finale__small">{c.finaleSmall}</p>
      </div>
    </section>
  );
}

function Footer({ c }: { c: Copy }) {
  return (
    <footer className="v10-footer">
      <div className="v10-wrap v10-footer__inner">
        <span className="v5-brand">
          <span className="v10-wordmark v10-wordmark--sm" role="img" aria-label="Companion" />
        </span>
        <span>{c.footerBy}</span>
        <span className="v10-footer__links">
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
    <div className="v10-landing">
      <a className="v10-skip" href="#main-content">Skip to content</a>
      <Nav c={c} />
      <main id="main-content">
        <Hero c={c} />
        <Ticker c={c} />
        <Problem c={c} />
        <Idea c={c} />
        <Compare c={c} />
        <Why c={c} />
        <Trust c={c} />
        <Finale c={c} />
      </main>
      <Footer c={c} />
    </div>
  );
}
