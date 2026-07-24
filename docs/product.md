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
| **Member / Consumer** | Keep useful work and context together; discover and reuse the right skills | Work is fragmented across one-off chats and technical tools; starting an agent means rebuilding its environment | Creates a private Project, chooses approved Skills and a model, then runs durable OpenCode sessions over shared files — no shell required |

---

## 3. The three pillars

**Projects is the work surface across these pillars, not a fourth pillar.** A Project gives one member a
private, durable Vercel Sandbox with synchronized Skills, automatically available Secrets, a default
model, shared Files, and multiple OpenCode conversations. The machine suspends when idle and resumes
with its state; members see `Conversations`, `Files`, `Skills`, and read-only `Access`, not runtime,
secret values, or package machinery.
Sharing a Project is deferred; creator privacy has no admin override.

Every skill lives in one of two **libraries**. **My Skills** is private: a member authors skills there
(only they can see them) and can also install org skills into it; it is organized by that member's own
**personal folders**. The **Organization** library is flat and org-wide: every skill in it is visible to
every member, and any member can edit, publish, archive, or delete it. A member moves a personal skill
into the org library with one action — **Share to organization** (owner-only, one-way). The platform
records `creator_id` (who authored a skill) for Activity and audit, and it is also the owner of a
personal skill; nothing crosses organization boundaries.

To stay organized, skills are filed under **labels** ("folders"): the Organization library uses an
org-wide **shared** tree, and My Skills uses each member's **personal** tree. A folder path is
slash-separated (e.g. `marketing/seo`), multi-assigned per skill, each path with its own color and
icon, empty folders allowed. Any member can create, assign, rename, recolor, or delete folders in
either tree they own access to (org folders are shared; personal folders are private).

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
assigns a **semantic version**, and stores it in the registry. Organization skills are visible to the
whole org;
members file skills under **labels** to keep them organized, then **attach opt-in** to agents — anyone
chooses exactly which skill versions go on which agents, and the agent picks them up on its next
reconcile. The hub is both a **registry** (publish, version, browse, label) and a **binding mechanism**
(attach to agents).

The creator of an organization skill, or an Owner/Admin, may pin its current immutable version as a
**public release**. The stable link exposes metadata to anyone, while package bytes require a verified
Companion account or a delegated agent approved through Agent Auth. Publishing a newer internal
version never changes the public release automatically.

---

## 4. Core user journeys

### Project — configure once → run many conversations
A Member selects **Projects** → presses `+` → chooses a name, default activated model, and accessible
Skills. Companion prepares one private persistent sandbox. Every active generic Secret the member can
use and every effective configured model-provider credential is injected at activation without exposing
its value. The Member starts one or more conversations with a direct prompt, optional Files, and an optional
model override. OpenCode handles the work; Companion renders its real transcript and tool activity.
Conversations may run concurrently against the same Files, so overlapping writes are last-writer-wins.
After ten idle minutes the VM checkpoints and stops, while the Project remains resumable.
If recovery needs attention, the owner can explicitly retry the same workspace. The command never
replaces the sandbox or checkpoint with a fresh empty Project.

The Project remains useful as its history grows. Conversations stay in creation order rather than
jumping when background work completes, and the five most recent appear beneath the Project in the
sidebar. The full Project page searches the durable history and separates active from archived
conversations. Members can rename, archive, undo, and restore; a running conversation stops before it
archives, and conversations are never permanently deleted in V1. A background result remains marked
`New result` or `Failed` until the member opens it.

Files stay part of the conversation. Input attachments return beside the exact message that used them,
and each turn identifies its exact created or updated file versions. Desktop preview keeps the
conversation and composer visible; mobile uses a full drawer. A member can add shared Files directly
to the Project without creating a synthetic conversation, or attach them to a prompt through selection,
drag-and-drop, or paste so they remain tied to that message. A recoverable turn failure keeps the
conversation, Files, and composer available; only a workspace-wide failure uses `Project needs
attention`.

The context rail has only `Files`, `Skills`, and `Access`. Access lists safe Secret names and sources
plus model connections without values. Models use member-facing names such as `GPT-5 · OpenAI`, while
technical routes remain in details. Projects may be archived and restored; permanent deletion is a
separate destructive action that explicitly removes conversations, Files, and workspace state.

Project instructions, memory across conversations, scheduled tasks, browser control, live artifacts,
and native Office preview are deferred product capabilities rather than hidden parts of this flow.

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

### Public skill release — pin → share → authenticated install
A creator or Owner/Admin opens an organization skill → explicitly pins its current version → shares
the stable `/s/{token}` link. A visitor can inspect the pinned public metadata without signing in,
then either downloads the exact ZIP with a verified account or copies an install prompt. The prompt
connects Claude Code or Codex through delegated device approval, verifies the ZIP, asks for global or
project scope and replacement consent, and installs only that root skill without executing scripts or
resolving dependencies/secrets. A later publish leaves the old public release active until an explicit
promotion; unpublishing removes package access without changing the URL.
Renaming is unavailable while a release is pinned, because the stable page identity must continue to
match the immutable package. The creator or an Owner/Admin first removes the release, renames the
skill, publishes a version with the new name, and explicitly makes that version public.

---

## 5. Access model (product view)

**Org roles:** `Owner` (everything, incl. billing/delete) → `Admin` (members, providers, catalog) →
`Developer` (publish skills, define and deploy agents and containers).

There are **no teams**. A permission decision combines two checks: **is the actor a member of this
org** (the tenant rule) **and does the actor's org role permit the action** (the role rule). On top of
that, skills carry one library axis: **org** skills are the flat case — every member can read and edit
any of them — while **personal** skills (My Skills) are private to their creator, with no admin
override. The only thing recorded per skill is its creator (provenance/audit), which is also the owner
of a personal skill. Skills are organized, not gated, by **labels** (shared org folders + private
personal folders). See
[`design.md`](design.md) for the full model.

Projects follow the same strict creator-only rule as personal skills and skill runs. A same-org Owner or
Admin cannot list, read, edit, attach skills to, or enumerate conversations from another member's
Project. Attaching an organization skill grants no new access to that skill; attaching a personal skill
is possible only while its creator can already access it.

Project Skills update automatically between active turns. This deliberately treats every member allowed
to publish an organization Skill as trusted code for Projects using that Skill: the updated package can
run with every Secret available to the Project. The sandbox protects the control plane, not a Secret
from code intentionally executed inside that sandbox.

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
