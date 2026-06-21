# Vision

> **Tagline:** *Where teams share and govern their AI skills.*

## The one-paragraph vision

Companion v2 makes an organization's AI skills as easy to publish, version, share, and attach as a
Git repository — **open-source, self-hostable, and permissioned from day one.** A builder publishes a
versioned `SKILL.md` package once; an org admin sets visibility and ownership once; every teammate's
AI assistant (Claude Code, Codex, Cursor, …) gets the right skills, kept up to date automatically —
with no shell, no scatter-gunned README, and no "did you update?" Slack pings. It is the team edition
of [Companion v1](https://github.com/The-Vibe-Company/companion), rehomed around an
**Organization → Team → User** hierarchy with RBAC and workspace-local visibility.

## Why now

- **Skills became a standard.** The [`SKILL.md`](https://github.com/anthropics/skills) format is now
  an open, multi-tool standard. Skills are portable assets — but there is no governed, self-hostable
  place for a team to publish, version, and share them.
- **Assistants are everywhere; skills are not.** Every engineer now runs Claude Code, Codex, Cursor,
  or similar — and each one reinstalls the same skills by hand, copies prompt snippets from a wiki,
  or ghosts out of date the moment someone improves them. There is no shared source of truth.
- **Companion v1 outgrew the solo operator.** Companion v1 (2.4k★, MIT) was built for one person.
  The community is hitting the multi-user wall right now: teams want to **share** skills, **govern**
  who can publish, and **know** that everyone is on the right version — not each maintain a private
  fleet. v2 is the answer to "great — how does my *team* use this?"

## The 10x bet

Become the **"GitHub-for-skills" hub that teams self-host** — one portal that collapses three jobs
that today require three separate workarounds:

| Today you stitch together… | Companion v2 collapses it into… |
|---|---|
| A wiki/Drive folder of prompt snippets | …a versioned, governed **skills registry** |
| Scattered repos with README install steps | …**one-click install** + auto-update per machine |
| "Did everyone update their skill?" Slack pings | …registry-driven **update detection** + provenance |

The 10x is **not** a better AI assistant or a new agent runtime. It's collapsing **publish + govern +
share** of skills into a single, opinionated, open product that runs on your own infrastructure — so
that spreading a skill across a team stops being a copy-paste project and becomes a self-serve
workflow.

## What we believe (guiding principles)

1. **Self-host first.** Your skills, your secrets, your infrastructure. The hosted offering, when it
   comes, is the same artifacts behind a control plane — never a fork that leaves self-hosters behind.
2. **Open standards over lock-in.** `SKILL.md` and MCP. Companion is the hub that connects open
   pieces, not a walled garden.
3. **Governed by default.** Every skill has an owner, explicit visibility, and an audit trail.
   Sharing is explicit; access is always attributable.
4. **Assistant-agnostic.** A skill is a portable asset that works with any assistant that supports
   the `SKILL.md` standard — Claude Code, Codex, Cursor, and what comes next.
5. **Ownership, visibility, and role are orthogonal.** *Who can edit a skill* (user owner, owner
   team Admin/Editor, or org admin), *who can see it* (Everyone or shared teams), and *what role the
   actor has* are separate axes that compose into one clear decision.

## Who it's for

Companion v2 serves the whole chain of people around team AI infrastructure:

- **Platform owners / Org Admins** who need governance, security, and a single source of truth.
- **Team leads** who want a self-serve space for their team without filing tickets.
- **Builders & developers** who publish and version skills, and want them adopted.
- **Members** who just want the **right skill, on the right version, in one click** — with no shell.

See [`product.md`](product.md) for detailed personas and journeys.

## Where we're heading (exploration, not a commitment)

The skills registry is the foundation. The natural next layer we are **exploring** is hosted agents
built on [opencode](https://github.com/sst/opencode) — a place where a team defines an agent, attaches
the right skills and MCP servers, and triggers it on demand or on a schedule (cron). This is
**exploration**: not a roadmap promise, not in the MVP, and not guaranteed to ship as described. We
call it out so the architecture does not paint us into a corner, and so contributors know where we
are looking. See [`PRD.md`](PRD.md#10-open-questions) for the open questions that shape it.

## Non-goals

To stay sharp, Companion v2 is deliberately **not**:

- **An agent-orchestration framework.** We are a registry/hub *for* skills, not a replacement for
  LangGraph, the Agents SDK, or any runtime.
- **An AI coding assistant.** We do not compete with Claude Code, Codex, or Cursor — we feed them
  shared, governed skills.
- **An agent runtime or execution host (for now).** Running agents is an exploration, not the MVP.
- **A closed SaaS.** The core is and stays open-source and self-hostable.

## The north star

If Companion v2 works, the signal is simple: **shared skills in active use across a team or org
boundary** — skills installed and used by people who didn't publish them. That single metric captures
the whole thesis at once: skills get **published**, they're **governed** enough to trust, and they're
**shared** enough to matter. See [`PRD.md`](PRD.md#8-success-metrics) for how we measure it.
