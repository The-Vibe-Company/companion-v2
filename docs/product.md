# Product

This document describes **who** Companion v2 is for, **how** it is positioned, and **what** the
experience is. For the "why," see [`vision.md`](vision.md). For the build plan, see [`PRD.md`](PRD.md).
For the technical design, see [`design.md`](design.md).

---

## 1. Positioning

### Companion v1 → v2

| Dimension | Companion v1 | Companion v2 |
|---|---|---|
| Primary user | Single operator | Organizations |
| Interface | CLI + IaC (TOML, `validate`/`plan`/`apply`) | Web portal + API (+ optional CLI) |
| Identity & access | None | Org → User, RBAC, invites |
| State | Local SQLite + TOML files | Postgres, multi-tenant |
| Sharing | Personal fleet; manual copies | Org-wide by default; organized with shared labels |
| Deploy targets | Fly.io (primary) | Pluggable: Docker · Fly · Kubernetes · Modal |
| Skills | Ad-hoc, per-fleet | Versioned `SKILL.md` registry + opt-in attach |
| Containers | Hand-defined in config | Org-admin-approved catalog, 1-click |
| Runtime | Hermes + Granite (fixed) | Hermes + Granite (V0); runtime pluggable later |

### Companion v2 vs the adjacent landscape

| Tool / category | Strong at | Missing for this job | Companion v2's wedge |
|---|---|---|---|
| **Backstage / IDPs** | Software catalog, templates, plugin RBAC | No runtime, no deploy, no skills — a metadata layer | A catalog that actually **deploys** + agents + skills |
| **Coolify / Dokploy** | Self-hosted PaaS, 1-click services | No org/team/RBAC, no skills, not agent-aware | Same 1-click ease **+ multi-tenant governance + agents/skills** |
| **Dify / n8n** | Build AI apps / automate flows | Builders, not registries; weak shared governance | Deploy & govern **many** agents/tools across teams |
| **Hugging Face Spaces** | Share/host ML apps, community | SaaS-first, no self-host governance, not your infra | **Self-hostable, org-private, RBAC-governed** sharing |
| **GitHub org + Actions** | Code hosting, CI, org permissions | CI, not an agent/tool runtime or skills registry | Runtime + curated catalog + skills under a familiar org model |
| **Agent frameworks** (LangGraph, Agents SDK, Coze) | Building & orchestrating agents | Dev frameworks, not a team portal | The **portal/hub layer above** any runtime |

> **The wedge, in one sentence:** the only **open-source, self-hostable** portal that unifies governed
> multi-tenant **deployment of AI agents**, a **curated container catalog**, and a **versioned
> `SKILL.md` registry** behind one **Org → User** RBAC model.

---

## 2. Personas

| Persona | Goals | Pains today | Success looks like |
|---|---|---|---|
| **Org Admin / Platform Owner** | Stand up the org, set policy, curate the approved catalog, control providers/secrets/budget, keep it secure & self-hosted | No governance over agents; shadow AI tools; can't vet images/skills; no central audit | One portal where every resource is permissioned & attributable; approves the catalog once; sleeps at night |
| **Builder / Developer** | Publish & version skills, organize them with labels, define agent and container templates, deploy fast | Skills scattered in repos; redeploying agents is CLI/IaC toil; hard to find what already exists | Publish a `SKILL.md` once, version it, file it under a label; deploy a Hermès agent with attached skills in minutes |
| **Member / Consumer** | Discover & **use** the right agents/tools; contribute new skills | Doesn't know what exists or how to access it; gated behind ops; no UI | Browses the org catalog, opens a chat with a permitted agent, adds a skill — no shell required |

---

## 3. The three pillars

Skills are **flat and org-wide**: every skill is visible to every member of the organization, and any
member can create, edit, publish, archive, or delete any skill. There is no owner and no per-skill
visibility flag. The platform records `creator_id` (who authored a skill) for Activity and audit — it
is provenance, not an access right. Org-wide visibility never crosses organization boundaries.

To stay organized without restricting access, skills are filed under **labels** ("folders") — an
org-wide **shared** tree of slash-separated paths (e.g. `marketing/seo`), multi-assigned per skill,
each path with its own color and icon, empty folders allowed. Any member can create, assign, rename,
recolor, or delete labels.

### Pillar 1 — Hermès Agents
Deploy curated AI agents built on the **Hermes** runtime, with **Granite** markdown memory and model
routing via **OpenRouter**. An agent is a declared configuration — model route, system prompt, an
optional memory vault, and a set of attached skills — that the platform deploys to a chosen provider
and exposes as a chat surface. Agents are visible to everyone in the organization.

### Pillar 2 — Curated Container Catalog
Org Admins **approve** images and templates into a catalog — databases, MCP servers, developer tools,
web UIs — pinned by digest, with sane resource limits and required secrets declared up front. Members
then **deploy them in one click** for the organization. The governance gate (only approved
images are deployable) is the entire point: capability without the security free-for-all.

### Pillar 3 — Skills Hub
Anyone can upload a [`SKILL.md`](https://github.com/anthropics/skills) package (a folder with
`SKILL.md` frontmatter plus optional `scripts/`, `references/`, `assets/`). The hub **validates** it,
assigns a **semantic version**, and stores it in the registry. Every skill is visible to the whole org;
members file skills under **labels** to keep them organized, then **attach opt-in** to agents — anyone
chooses exactly which skill versions go on which agents, and the agent picks them up on its next
reconcile. The hub is both a **registry** (publish, version, browse, label) and a **binding mechanism**
(attach to agents).

---

## 4. Core user journeys

### Onboarding — create org → invite members → first deploy
1. An operator self-hosts (single `docker compose up`). The **first user becomes Org Owner**.
2. They create an **Organization** and invite members by email with org roles.
3. They configure one **deployment provider** (local Docker by default) and **model credentials**
   (OpenRouter).
4. From a starter template, they deploy the org's **first Hermès agent** and land in a working chat.
   *Activation milestone: time-to-first-deploy.*

### Pillar 1 — deploy a Hermès agent with skills
A Builder picks a curated agent template → selects a provider and model (OpenRouter) → **attaches one
or more skills** from the registry → optionally attaches a **Granite vault** for memory → deploys. The
agent appears in the org catalog and any member can open a chat.

### Pillar 2 — deploy a curated container
An Org Admin reviews and **approves** a Docker image/template into the catalog (resource limits,
required secrets). A Builder browses the approved catalog → clicks **1-click deploy** → an instance
spins up → connection details and secrets are surfaced to org members. Only approved images are
deployable.

### Pillar 3 — skills: upload → label → attach
A Builder uploads a `SKILL.md` package → the portal **validates** the frontmatter (`name`,
`description`, `compatibility`, `metadata`, and `allowed-tools`) and assigns a registry version → it
enters the registry, visible to the whole org → the Builder files it under one or more **labels** to
keep it organized → any member **attaches** it (opt-in) to an agent → the agent gains the skill on its
next run. Versioning lets members **pin** or **upgrade**.

---

## 5. Access model (product view)

**Org roles:** `Owner` (everything, incl. billing/delete) → `Admin` (members, providers, catalog) →
`Developer` (publish skills, define and deploy agents and containers).

There are **no teams** and no per-resource visibility. A permission decision combines two checks:
**is the actor a member of this org** (the tenant rule) **and does the actor's org role permit the
action** (the role rule). Skills are the flat case: every member can read every skill, and any member
can create, edit, publish, archive, or delete any skill — the only thing recorded per skill is its
creator (provenance/audit). Skills are organized, not gated, by **shared labels**. See
[`design.md`](design.md) for the full model.

---

## 6. Open-source & community model

- **MIT, self-host first.** The product is fully usable on your own infrastructure with one command.
- **Continuity with v1.** Companion v2 keeps an API/CLI surface so the existing 2.4k-star community
  feels at home, and aims to provide an **import bridge** for v1 fleets.
- **Open standards.** `SKILL.md`, MCP, OpenRouter, OCI — Companion connects open pieces.
- **Contribution.** The provider abstraction and the runtime layer are designed as clean seams so the
  community can add new deploy targets and (later) new agent runtimes. See [`CLAUDE.md`](../CLAUDE.md).
- **Commercialization** (later, optional, open-core): a hosted/managed offering and enterprise
  features (SSO/SAML, compliance) — never at the expense of the self-host experience. Tracked as an
  [open question](PRD.md#10-open-questions).
