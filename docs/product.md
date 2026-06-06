# Product

This document describes **who** Companion v2 is for, **how** it is positioned, and **what** the
experience is. For the "why," see [`vision.md`](vision.md). For the build plan, see [`PRD.md`](PRD.md).
For the technical design, see [`design.md`](design.md).

---

## 1. Positioning

### Companion v1 → v2

| Dimension | Companion v1 | Companion v2 |
|---|---|---|
| Primary user | Single operator | Organizations & teams |
| Interface | CLI + IaC (TOML, `validate`/`plan`/`apply`) | Web portal + API (+ optional CLI) |
| Identity & access | None | Org → Team → User, RBAC, invites |
| State | Local SQLite + TOML files | Postgres, multi-tenant |
| Sharing | Personal fleet; manual copies | Visibility scopes: user / team / org |
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
> `SKILL.md` registry** behind one **Org → Team → User** RBAC model.

---

## 2. Personas

| Persona | Goals | Pains today | Success looks like |
|---|---|---|---|
| **Org Admin / Platform Owner** | Stand up the org, set policy, curate the approved catalog, control providers/secrets/budget, keep it secure & self-hosted | No governance over agents; shadow AI tools; can't vet images/skills; no central audit | One portal where every resource is scoped & attributable; approves the catalog once; sleeps at night |
| **Team Lead** | Provision their team, manage who deploys what, share team agents/skills, watch usage | Manual per-person setup; no team-scoped sharing; no visibility into team activity | Self-serve team space; team-scoped resources; activity visible without tickets |
| **Builder / Developer** | Publish & version skills, define agent and container templates, deploy fast | Skills scattered in repos; redeploying agents is CLI/IaC toil; hard to share safely | Publish a `SKILL.md` once, version & scope it; deploy a Hermès agent with attached skills in minutes |
| **Member / Consumer** | Discover & **use** the right agents/tools; propose new skills | Doesn't know what exists or how to access it; gated behind ops; no UI | Browses a catalog, opens a chat with a permitted agent, proposes a skill — no shell required |

---

## 3. The three pillars

Every agent, container, and skill carries one **visibility scope**:

- **`private`** — only the owner.
- **`team`** — every member of a specific team.
- **`org`** — everyone in the organization.

Admins can deploy a resource **for** someone else: the resource is owned by the intended principal (a
user, a team, or the org) and visible at the chosen scope, while the acting admin is recorded as its
creator in the audit log. *Who it's for*, *who can see it*, and *who created it* are independent.

### Pillar 1 — Hermès Agents
Deploy curated AI agents built on the **Hermes** runtime, with **Granite** markdown memory and model
routing via **OpenRouter**. An agent is a declared configuration — model route, system prompt, an
optional memory vault, and a set of attached skills — that the platform deploys to a chosen provider
and exposes as a chat surface. Agents are scoped (private/team/org) like any resource.

### Pillar 2 — Curated Container Catalog
Org Admins **approve** images and templates into a catalog — databases, MCP servers, developer tools,
web UIs — pinned by digest, with sane resource limits and required secrets declared up front. Members
then **deploy them in one click** to a team or for themselves. The governance gate (only approved
images are deployable) is the entire point: capability without the security free-for-all.

### Pillar 3 — Skills Hub
Anyone can upload a [`SKILL.md`](https://github.com/anthropics/skills) package (a folder with
`SKILL.md` frontmatter plus optional `scripts/`, `references/`, `assets/`). The hub **validates** it,
assigns a **semantic version**, and stores it in the registry. Skills are **scoped** (private/team/org)
and **attached opt-in** to agents — an owner chooses exactly which skill versions go on which agents,
and the agent picks them up on its next reconcile. The hub is both a **registry** (publish, version,
browse, share) and a **binding mechanism** (attach to agents).

---

## 4. Core user journeys

### Onboarding — create org → invite team → first deploy
1. An operator self-hosts (single `docker compose up`). The **first user becomes Org Owner**.
2. They create an **Organization**, create a **Team**, and invite members by email with roles.
3. They configure one **deployment provider** (local Docker by default) and **model credentials**
   (OpenRouter).
4. From a starter template, they deploy the org's **first Hermès agent** and land in a working chat.
   *Activation milestone: time-to-first-deploy.*

### Pillar 1 — deploy a Hermès agent with team skills
A Builder picks a curated agent template → selects a provider and model (OpenRouter) → **attaches one
or more skills** from the registry → optionally attaches a **Granite vault** for memory → sets
visibility to **team** → deploys. The agent appears in the team's catalog and members open a chat.

### Pillar 2 — deploy a curated container
An Org Admin reviews and **approves** a Docker image/template into the catalog (resource limits,
required secrets, default scope). A Builder or Team Lead browses the approved catalog → clicks
**1-click deploy** → a scoped instance spins up → connection details and secrets are surfaced to
permitted members. Only approved images are deployable.

### Pillar 3 — skills: upload → share → attach
A Builder uploads a `SKILL.md` package → the portal **validates** the frontmatter (`name`,
`description`, version, declared tools) and assigns a version → the Builder **scopes** it
(private/team/org) → it enters the registry → any permitted user **attaches** it (opt-in) to an agent
they can edit → the agent gains the skill on its next run. Versioning lets teams **pin** or **upgrade**.

---

## 5. Access model (product view)

**Org roles:** `Owner` (everything, incl. billing/delete) → `Admin` (members, teams, providers,
catalog, deploy at any scope) → `Member` (use resources, deploy at private/own-team scope) → `Guest`
(read-only on explicitly shared resources).

**Team roles:** `Admin` (manage team membership, deploy for the team, attach skills to team agents) →
`Member` (use team resources, deploy privately).

A permission decision combines two checks: **can the actor see the resource** (the scope rule) **and
can the actor perform the action** (the role rule). The "admin deploys *for* X" case is handled by
separating ownership, visibility, and provenance — see [`design.md`](design.md) for the full
model.

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
