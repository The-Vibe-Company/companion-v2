# Vision

> **Tagline:** *The open hub for your team's AI agents, tools, and skills.*

## The one-paragraph vision

Companion v2 makes an entire organization's AI agents, curated tools, and skills as easy to deploy,
govern, and share as a Git repository — **open-source, self-hostable, and permissioned from day one.**
It takes the engine that powered one operator's personal agent fleet in v1 (the Hermes runtime,
Granite memory, OpenRouter model routing, and pluggable infrastructure) and wraps it in a
multi-tenant web portal where an **Organization → User** hierarchy with RBAC governs every
resource. A builder publishes a versioned `SKILL.md` package once; an admin approves a Postgres or
MCP-server container once; a builder defines a Hermès agent once — and everyone across the org
gets **one-click, governed access**, with no shell, no TOML, and no infrastructure tickets.

## Why now

- **Skills became a standard.** The [`SKILL.md`](https://github.com/anthropics/skills) format is now
  an open, multi-tool standard. Skills are portable assets — but there is no governed, self-hostable
  place for a team to publish, version, and share them.
- **Tools are proliferating.** MCP servers, vector stores, and curated containers are multiplying.
  Teams want a **vetted, one-click catalog**, not a pile of `docker run` commands in a wiki.
- **Agents outgrew the solo operator.** Companion v1 (2.4k★, MIT) was built for one person and
  explicitly has no teams, orgs, or permissions. The community is hitting the multi-user wall right
  now. v2 is the answer to "great — how does my *org* use this?"

## The 10x bet

Become the **"GitHub-for-agents" control plane that teams self-host** — one portal that unifies
three jobs that today require three separate systems:

| Today you stitch together… | Companion v2 collapses it into… |
|---|---|
| An internal developer portal (Backstage) for a catalog | …a catalog that actually **deploys** |
| A PaaS (Coolify/Fly/K8s) to run things | …pluggable deploy under shared **governance** |
| A wiki/Drive to share prompts & skills | …a versioned, governed **skills registry** |

The 10x is **not** a better agent runtime. It's collapsing **deploy + govern + share** into a single,
opinionated, open product that runs on your own infrastructure — so that adopting AI agents across a
team stops being an ops project and becomes a self-serve workflow.

## What we believe (guiding principles)

1. **Self-host first.** Your agents, your secrets, your infrastructure. The hosted offering, when it
   comes, is the same artifacts behind a control plane — never a fork that leaves self-hosters behind.
2. **Open standards over lock-in.** `SKILL.md`, MCP, OpenRouter, OCI images. Companion is the hub that
   connects open pieces, not a walled garden.
3. **Governed by default.** Every action is permissioned by org role and recorded in an audit trail;
   access is always attributable. Skills are shared org-wide and organized by labels, not gated per
   resource — governance lives at the org membership boundary, not in per-skill visibility flags.
4. **Desired-state everywhere.** Every deployable is a declared intent; a reconciler converges
   reality and heals drift. The v1 plan/apply discipline, re-homed for orgs.
5. **Membership and role compose into one decision.** *Is the actor a member of this org* and *what
   org role do they hold* are the two axes of every permission. Skills add no third axis: every member
   can read and modify every skill; labels organize them without restricting access.
6. **Provider-agnostic.** Where a resource runs — local Docker, Fly, Kubernetes, Modal — is a choice,
   not a constraint baked into the product.

## Who it's for

Companion v2 serves the whole chain of people around team AI infrastructure:

- **Platform owners / Org Admins** who need governance, security, and a single source of truth.
- **Builders & developers** who publish skills, define agents, and ship containers without filing tickets.
- **Members** who just want to *use* the right agent or tool — from a UI, with no shell.

See [`product.md`](product.md) for detailed personas and journeys.

## Non-goals

To stay sharp, Companion v2 is deliberately **not**:

- **An agent-orchestration framework.** We are the portal/hub *above* runtimes, not a replacement for
  LangGraph, the Agents SDK, or Hermes itself.
- **A no-code app builder.** We deploy and govern agents and tools; we don't build single AI apps the
  way Dify or n8n do.
- **A general-purpose PaaS.** We run agent- and team-adjacent workloads from a curated catalog, not
  arbitrary production microservices.
- **A closed SaaS.** The core is and stays open-source and self-hostable.

## The north star

If Companion v2 works, the signal is simple: **shared resources in active use across an org** —
agents, containers, and skills being used by people who didn't create them. That single
metric captures the whole thesis at once: things get **deployed**, they're **governed** enough to
trust, and they're **shared** enough to matter. See [`PRD.md`](PRD.md#8-success-metrics) for how we
measure it.
