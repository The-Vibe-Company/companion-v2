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
| Interface | CLI + IaC (TOML, `validate`/`plan`/`apply`) | Web portal + API + CLI |
| Identity & access | None | Org → Team → User, RBAC, invites |
| State | Local SQLite + TOML files | Postgres, multi-tenant |
| Sharing | Personal fleet; manual copies | Workspace visibility: Private / team shares / Everyone |
| Skills | Ad-hoc, per-fleet | Versioned `SKILL.md` registry with dependencies, discussion, archive |
| Target assistants | One runtime (fixed) | Any assistant that supports `SKILL.md` (Claude Code, Codex, Cursor, …) |
| Install | Manual file copies on each machine | One-click install + auto-update detection per machine |
| Governance | None | Ownership, visibility, and audit fully separated and tracked |

### Companion v2 vs the adjacent landscape

| Tool / category | Strong at | Missing for this job | Companion v2's wedge |
|---|---|---|---|
| **Backstage / IDPs** | Software catalog, templates, plugin RBAC | No skills concept, no install workflow — a metadata layer | A registry that actually **installs** + versioning + governance |
| **Coolify / Dokploy** | Self-hosted PaaS, 1-click services | No skills, no team governance, not assistant-aware | Same 1-click ease **+ multi-tenant governance for skills** |
| **Dify / n8n** | Build AI apps / automate flows | Builders, not skill registries; weak shared governance | Deploy & govern **many skills** across teams |
| **Hugging Face Spaces** | Share/host ML apps, community | SaaS-first, no self-host governance, not your infra | **Self-hostable, org-private, RBAC-governed** sharing |
| **GitHub org + repos** | Code hosting, versioning | No install workflow, no visibility model, no auto-update | Workspace visibility + one-click install + update detection |
| **AI assistants (Claude Code, Cursor, Codex)** | Run skills locally, per user | Solo only, no team sharing, manual sync | The **team layer above** any assistant |

> **The wedge, in one sentence:** the only **open-source, self-hostable** registry that unifies
> governed multi-tenant **publish + version + share + auto-install** of `SKILL.md` packages behind one
> **Org → Team → User** RBAC model.

---

## 2. Personas

| Persona | Goals | Pains today | Success looks like |
|---|---|---|---|
| **Org Admin / Platform Owner** | Stand up the org, set policy, control who can publish what, keep skills secure & self-hosted | No governance over skills; shadow prompt folders; can't vet or audit who uses what | One portal where every skill is permissioned & attributable; approves ownership changes; sleeps at night |
| **Team Lead** | Provision their team, share team skills, watch adoption | Manual per-person setup; no team sharing; "is everyone on the latest version?" on repeat | Self-serve team space; team-owned skills; install status visible without tickets |
| **Builder / Developer** | Publish & version skills, attach dependencies, drive adoption | Skills scattered in repos and chats; no clean versioning; hard to share safely | Publish a `SKILL.md` once, version & share it; the team gets notified and installs in one click |
| **Member / Consumer** | Discover & **install** the right skill; stay up to date | Doesn't know what exists; copies folders from peers; runs stale versions | Browses a catalog, installs an approved skill in one click, auto-detects updates — no shell required |

---

## 3. The Skills Hub

The Skills Hub is the product. It is both a **registry** (publish, version, browse, share) and a
**delivery mechanism** (one-click install on each member's machine, with update detection).

Skills carry explicit **workspace visibility**:

- **Private** — derived from `everyone=false` and no team shares.
- **Team shares** — one or more teams can be attached to the skill's visibility.
- **Everyone** — every member of the current workspace/organization can see it.

Everyone is not internet-wide and never crosses organization boundaries. Ownership is separate from
visibility: a skill can be owned by a user or a team, and a team-owned skill can be edited by that
team's Admins and Editors. Visibility only decides who can **read** the skill: selected teams,
Everyone, both, or neither. The acting admin is recorded as creator in the audit log. *Who can edit
it*, *who can see it*, and *who created it* are independent.

### What a skill gets

- **Validation & versioning.** A `SKILL.md` package (frontmatter + optional `scripts/`,
  `references/`, `assets/`) is validated on upload; a valid upload produces an immutable,
  checksummed, semver-tagged version.
- **Dependencies (skill → skill).** A version may declare that it requires other skills by slug.
  Each version keeps its exact graph; statuses (Satisfied / Missing / Archived / Visibility mismatch
  / Cycle) are computed live on read. Publishing hard-blocks missing, cyclic, or visibility-mismatched
  edges.
- **Discussion.** A threaded, single-nest discussion lives on each skill's detail page, optionally
  linked to a specific version. Threads can be deprecated (never deleted) by the author, an org admin,
  or the skill owner.
- **Archive.** A skill can be soft-archived (hidden from default lists) but stays viewable,
  restorable, and downloadable while any published version still references it — so existing installs
  never break.
- **Companion skill (install & update detection).** A built-in helper skill (`companion`) ships with
  the portal. Members install it once on their machine; it analyzes, uploads, validates, and checks
  which of the user's skills are out of date against the registry. Per-member install state is
  tracked so the workspace knows who is on which version.
- **Preflight on upload.** The publish flow returns a dependency plan (declared / already-published /
  must-upload / removed-since-previous / archival candidates) so the builder can resolve everything
  in one go.
- **Personal Access Tokens.** Scoped PATs (`skills:read` / `skills:write`) let the CLI and the
  companion skill publish and install programmatically — without a browser session.

---

## 4. Core user journeys

### Onboarding — create org → invite team → first skill
1. An operator self-hosts (single `docker compose up`). The **first user becomes Org Owner**.
2. They create an **Organization**, create a **Team**, and invite members by email with roles.
3. From a starter template or by uploading a package, they publish the org's **first skill** and set
   it to Everyone. *Activation milestone: time-to-first-skill-published.*

### Publish a skill (Builder)
A Builder authors a `SKILL.md` (frontmatter: `name`, `description`, `compatibility`, `metadata`,
`allowed-tools`, optional `requirements`) → uploads via web or CLI → the portal **validates** the
frontmatter, runs the **dependency preflight**, and assigns a registry version → the Builder chooses
a personal or team owner and sets **Everyone** and/or team visibility shares → the skill enters the
registry. Targeted re-publishes are idempotent and provenance-tracked.

### Install & stay up to date (Member)
A Member browses the workspace catalog → opens a skill → clicks **install** → the companion skill
flies the package onto their machine into the right assistant directory → the workspace records the
install → when a new version is published, the companion skill reports **update available** and the
member reinstalls in one click. No shell, no manual copies.

### Govern (Org Admin / Team Admin)
An admin opens a skill they can edit → changes **visibility** (Private / teams / Everyone) or
**ownership** (transfer to a user or team) → the change cascades through the dependency graph and is
written to the audit log. Members outside the new visibility lose read access on the next request.

---

## 5. Access model (product view)

**Org roles:** `Owner` (everything, incl. billing/delete) → `Admin` (members, teams, ownership &
visibility changes on any skill) → `Member` (publish privately or to allowed teams, install anything
they can see) → `Guest` (read-only on explicitly shared resources).

**Team roles:** `Admin` (manage team membership and edit team-owned resources) →
`Editor` (edit team-owned resources) → `Reader` (read team-owned and team-visible resources).

A permission decision combines two checks: **can the actor see the skill** (the visibility rule) **and
can the actor perform the action** (the role rule). Ownership and visibility are independent: a
team-visibility share grants read; team ownership is what grants team Admins/Editors write access.
See [`design.md`](design.md) for the full model.

---

## 6. Open-source & community model

- **MIT, self-host first.** The product is fully usable on your own infrastructure with one command.
- **Continuity with v1.** Companion v2 keeps an API/CLI surface so the existing 2.4k-star community
  feels at home. The mission is the same (give a team governed access to AI capabilities); the
  implementation pivoted from a personal runtime to a team skills registry.
- **Open standards.** `SKILL.md`, MCP — Companion connects open pieces.
- **Contribution.** The validation pipeline, the companion-skill helper, and the dependency model are
  designed as clean seams so the community can add new skill formats, new install targets, and new
  workspace behaviors. See [`CLAUDE.md`](../CLAUDE.md).
- **Commercialization** (later, optional, open-core): a hosted/managed offering and enterprise
  features (SSO/SAML, compliance) — never at the expense of the self-host experience. Tracked as an
  [open question](PRD.md#10-open-questions).
