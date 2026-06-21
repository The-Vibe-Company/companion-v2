# Product Requirements Document — Companion v2

| | |
|---|---|
| **Status** | Draft v0.2 — MVP in flight (Skills Hub shipped) |
| **Owner** | The Vibe Company |
| **License** | MIT (open-source, self-host first) |
| **Related** | [`vision.md`](vision.md) · [`product.md`](product.md) · [`design.md`](design.md) |

---

## 1. Summary

Companion v2 is an open-source, self-hostable, multi-tenant portal to **publish, govern, version,
share, and install** AI skills (`SKILL.md` packages) across an organization and its teams. It is the
team edition of [Companion v1](https://github.com/The-Vibe-Company/companion): the same mission —
give a team governed access to AI capabilities — rehomed around an **Organization → Team → User**
hierarchy with **RBAC**, workspace-local **visibility** (Private / team shares / Everyone), and
one-click install with update detection on every teammate's machine.

## 2. Problem

Teams adopting AI assistants today have no governed home for their skills. Skills live on individual
laptops, scattered across repos and chat threads, copied from wikis by hand. Every engineer
reinstalls the same skill on every machine, runs stale versions without knowing it, and there is no
shared, permissioned way to discover, version, and reuse what others have built. Companion v1 solved
the personal case beautifully — for one operator. There is no open, self-hostable answer for a
**team**.

## 3. Goals & non-goals

**Goals**
- Let a team self-host Companion in one command and govern AI skills with real RBAC.
- Make the Skills Hub usable end-to-end in the MVP: **publish → validate → version → share →
  install → update**.
- Ship the **companion skill** so each member's assistants stay in sync with the registry.
- Provide an API/CLI surface for programmatic publish and install.
- Give the existing v1 community a credible reason and path to upgrade.

**Non-goals (for now)**
- Not an agent runtime, not a container catalog, not a PaaS (see [`vision.md`](vision.md#non-goals)).
- Hosted agents (opencode-based) and standalone MCP hosting are **exploration** only — not in the
  MVP. See [open questions](#10-open-questions).
- Not a closed SaaS. The core stays open and self-hostable.

---

## 4. MVP definition (V0)

> **The thinnest genuinely-useful slice:** a self-hosted Companion v2 where a team can publish a
> validated `SKILL.md` skill, govern its visibility and ownership, share it across teams or with
> everyone, and have every member install it in one click and stay up to date — all under
> **Org → Team → User** RBAC.

### In scope (V0)

| Area | Included |
|---|---|
| **Install** | Single `docker compose up` bundle: Postgres, object storage (MinIO), Mailpit for local email, web portal, and API. First user becomes Org Owner. |
| **Identity & access** | Organization → Team → User; email invitations; RBAC roles (Org Owner/Admin/Member, Team Admin/Editor/Reader); user/team ownership; visibility through Private, team shares, and Everyone; domain-driven onboarding (free vs corporate, auto-join). |
| **Auth** | Better Auth with email/password + 6-digit OTP email verification + Google OAuth (conditional). |
| **Skills Hub** | Upload + validate + version `SKILL.md` packages; set ownership (user/team) and visibility (Private/team/Everyone); transfer ownership; soft-archive + restore; threaded **discussion** per skill/version; **dependency graph** (skill → skill) with live statuses and publish-time hard-block on missing/cyclic/mismatched edges; **dependency preflight** plan on validate. |
| **Companion skill** | Built-in helper skill (`companion`) for upload, validation, dependency analysis, and update detection against the registry. |
| **Install tracking** | Per-member install state (`local_skill_installs`) so the workspace knows who is on which version. |
| **Tokens** | Scoped personal access tokens (`skills:read` / `skills:write`) for CLI/companion-skill publish/install. |
| **CLI** | `companion` CLI for publish, install, and package operations (talks REST). |
| **Audit** | Append-only `audit_log` of mutating actions (publish, visibility/ownership change, archive/restore, install, token issue/revoke). |

### Out of scope (deferred)

SSO/SAML & SCIM · billing, quotas, cost dashboards · community marketplace & cross-org sharing ·
**hosted agents** (opencode) · standalone **MCP** hosting · audit export & compliance certifications ·
skill ratings/reviews · skill-execution sandbox hardening (execution stays in the assistant, never in
the control plane).

---

## 5. Functional requirements

Each requirement has user stories with acceptance criteria. Priorities: **P0** = MVP, **P1** = V1,
**P2** = V2.

### 5.1 Organizations, teams & membership (P0)
- As an operator, on first run I become **Org Owner** so I can configure the org. *AC:* first
  authenticated user is granted `owner`; subsequent users join via invitation or domain auto-join.
- As an Org Admin, I can **create teams** and **invite users** by email with an org role and optional
  team membership. *AC:* invitee receives a tokenized link; accepting creates the membership rows;
  expired/revoked tokens are rejected.
- As an Org Admin, I can **change roles** and **remove members**. *AC:* role changes take effect on
  the next request; removing a member revokes visibility immediately.

### 5.2 RBAC & visibility (P0)
- As any actor, I can only **see** skills whose visibility I satisfy (owner, Everyone, or any shared
  team), with Org Owner/Admin able to see everything in the tenant. *AC:* list/detail endpoints are
  visibility-filtered; cross-tenant access is impossible (verified by tests).
- As an Org Admin or Team Admin/Editor, I can **own a skill as** a specific user or editable team,
  then choose separate read visibility for teams and/or Everyone. *AC:* team ownership grants write
  access only to that owner team's Admins/Editors; team visibility shares grant read access only; the
  acting admin is recorded as creator in the audit log.

### 5.3 Skills Hub (P0)
- As a Builder, I can **upload a `SKILL.md` package** and have it validated and versioned. *AC:*
  invalid frontmatter, path traversal, or oversize archives are rejected with a clear error; a valid
  upload produces an immutable, checksummed `skill_versions` record with a semver.
- As a Builder, I can set a skill to Private, Everyone, one team, multiple teams, or Everyone plus
  teams, and **browse** skills I'm permitted to see.
- As a Builder, I can declare **dependencies** (slugs) on a version and get a **dependency plan** on
  validate. *AC:* publishing hard-blocks missing, cyclic, or visibility-mismatched edges; live
  statuses (Satisfied / Missing / Archived / Visibility mismatch / Cycle blocked) are computed on
  read.
- As a Builder, I can open a **threaded discussion** on a skill (optionally pinned to a version) and
  deprecate threads I own or administer. *AC:* replies are single-nest; deprecated threads are
  greyed/struck, never deleted.
- As a Builder, I can **soft-archive** a skill I can edit. *AC:* archived skills drop from default
  lists but stay viewable, restorable, and downloadable while a published version still references
  them.
- As an Org Admin or owner, I can **transfer ownership** or change visibility. *AC:* the change
  cascades through the dependency graph and is written to the audit log; readers outside the new
  visibility lose access on the next request.

### 5.4 Companion skill & install tracking (P0)
- As a Member, I can **install the companion skill** from the built-in catalog and report my install
  state. *AC:* the workspace records `(org_id, user_id, skill_key, installed_version, agent)` and
  shows Not installed / Installed / Update available derived from the bundled version.
- As a Member, I can **install any published skill** I can see. *AC:* the companion skill flies the
  package onto my machine into the right assistant directory; the workspace records the install.
- As a Member, I see **update available** when the registry version is ahead of my installed one.
  *AC:* reinstalls in one click.

### 5.5 Tokens & public API (P0)
- As a Builder, I can **issue a scoped PAT** (`skills:read` and/or `skills:write`) for CLI/companion
  use. *AC:* only the `sha256` hash is stored; the plaintext `cmp_pat_…` is shown once.
- As the API surface, **only PAT-enabled skills endpoints** accept a bearer token; every other
  endpoint rejects it. *AC:* session-authenticated only for everything else; a token cannot mint
  another.
- As an Org Admin, I can **revoke any token** by id. *AC:* subsequent requests bearing it are
  rejected.

### 5.6 Audit (P0)
- As an Org Admin, I can **view an audit log** of who did what, to which skill, and with which
  visibility. *AC:* every mutating action writes an `audit_log` row scoped to `org_id`.

---

## 6. Non-functional requirements

- **Security & multi-tenancy:** strict `org_id` isolation with defense-in-depth (app-layer authz +
  database row-level security as a future layer); the control plane **never executes** untrusted
  skill scripts — all such execution happens inside the user's assistant, never on the server.
- **Self-host simplicity:** one command to a working instance; opinionated, bundled defaults so the
  first publish "just works."
- **Performance:** visibility-filtered lists return quickly at team/workspace scale (indexed
  `skills.everyone` and `skill_team_shares` access).
- **Observability:** structured logs + skill activity surfaced in the UI (minimal in V0).
- **Internationalization-ready:** UI strings externalized from day one (English default).

---

## 7. Roadmap

| Phase | Theme | Headline capabilities |
|---|---|---|
| **V0 — MVP** | Self-host + governed Skills Hub | Org/Team/User + RBAC + workspace visibility · Skills Hub (validation, versioning, dependencies, discussion, archive) · companion skill + install tracking · CLI + tokens · domain onboarding · audit log |
| **V1 — Collaboration & trust** | Make teams productive & observable | **SSO/SAML** · **in-app audit** & usage · skill ratings/reviews + dependency pinning · **opencode agent hosting** (exploration) |
| **V2 — Scale & ecosystem** | Marketplace, monetization, compliance | Community **marketplace** (cross-org skills, later MCPs) · **billing + quotas/cost controls** · **compliance** (audit export, SCIM, SOC2-ready, retention) · optional **managed cloud** · multi-org / federation |

**Where notable features land:** SSO/SAML → **V1**. In-app audit → **V1**, export/compliance → **V2**.
Marketplace → **V2**. Billing → **V2**. Hosted agents (opencode) and standalone MCP hosting →
**exploration**, considered for V1 at the earliest.

---

## 8. Success metrics

### North Star
**Weekly active shared skills** — the number of skills installed/used across a team/org boundary
(i.e., by someone other than their publisher) per week. It captures the whole thesis at once:
**publishing × governance × sharing.**

| Category | Metrics |
|---|---|
| **Activation** | Time-to-first-skill-published (install → first published skill); % of new orgs that publish ≥1 shared skill within 7 days |
| **Engagement** | Installs/week; weekly active publishers; skills published per org |
| **Collaboration** | % of skills shared with teams or Everyone (vs private); cross-creator install rate; dependencies across teams |
| **OSS / adoption** | GitHub stars growth; self-host installs (opt-in telemetry); skills published; external contributors/PRs; v1→v2 migrations |

---

## 9. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Adoption inertia** — teams keep copying skills around instead of centralizing | Ship the companion skill so install + update are dramatically easier than the manual status quo; workspace-visible install status creates social pull |
| 2 | **Supply-chain security** — skills ship `scripts/` that run on members' machines | Validate packages on upload; declared `requirements` (secrets/env) are notes only, never values; the control plane never executes skill code; companion skill surfaces what a package contains before install |
| 3 | **`SKILL.md` spec drift** — the open standard evolves | Track the canonical spec; validate against a versioned schema; treat the skill format as a versioned dependency |
| 4 | **Self-host operational burden** — multi-tenant + Postgres + S3 is heavier than v1's CLI | One-command compose install; sane defaults; bundled Better Auth + MinIO + Mailpit so first run works |
| 5 | **Scope creep** — agents/MCPs/marketplace pulling the team away from the skills wedge | Exploration items live in [open questions](#10-open-questions), not the V0 backlog; ruthless out-of-scope list |
| 6 | **v1 community migration friction** — 2.4k★ expect a CLI runtime, get a skills registry | Be explicit about the pivot (same mission, new implementation); keep an API/CLI surface; reuse the `companion` brand |

---

## 10. Open questions

These are the decisions most worth resolving early; they shape architecture and positioning.

1. **Skill execution trust model.** Skills can ship `scripts/`. The control plane will never execute
   them — the user's assistant does. How do we make that trust boundary legible to members, and what
   does the companion skill show before an install (provenance, owner, diff)?
2. **Monetization vs OSS purity.** Where does revenue come from — managed cloud, an open-core
   SSO/compliance tier, or a marketplace take-rate — and does any of it touch the V0/V1 boundary?
3. **Relationship to v1.** v2 inherits v1's mission and brand but pivots from a personal runtime to
   a team skills registry. How do we message that to the existing 2.4k★ community, and is there any
   migration tooling worth shipping?
4. **opencode-based agents.** Hosting agents (opencode + attached skills + MCPs + on-demand/cron
   triggers) is the most interesting exploration. Should we commit to it? What does hosting look
   like — sandbox model, secret injection, trigger runtime, observability?
5. **MCPs as a registry asset.** Should the registry stay pure `SKILL.md`, or should MCP servers
   become a first-class resource type (publishable, versioned, shareable) — and if so, when?
6. **Federation / multi-org marketplace.** Is cross-org sharing (a community marketplace of skills) a
   core ambition or explicitly out — and does that change the data model we should commit to in V0?
