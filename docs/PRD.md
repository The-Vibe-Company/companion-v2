# Product Requirements Document — Companion v2

| | |
|---|---|
| **Status** | Draft v0.1 — pre-MVP |
| **Owner** | The Vibe Company |
| **License** | MIT (open-source, self-host first) |
| **Related** | [`vision.md`](vision.md) · [`product.md`](product.md) · [`design.md`](design.md) |

---

## 1. Summary

Companion v2 is an open-source, self-hostable, multi-tenant portal to **deploy, govern, and share** AI
agents, curated containers, and skills across an organization. It turns the
single-operator Companion v1 engine (Hermes runtime, Granite memory, OpenRouter, pluggable infra) into
a collaborative web product with an **Organization → User** hierarchy, **RBAC**, and org-wide skills
organized by **shared labels** (no per-resource visibility flags).

## 2. Problem

Teams adopting AI agents today have no governed home for them. Agents and prompts live on individual
laptops; skills are scattered across repos and chat threads; running a tool (a DB, an MCP server, a web
UI) means ad-hoc `docker run` commands with no approval or audit; and there is no shared, permissioned
way for a team to discover and reuse what others have built. Companion v1 solved this beautifully — for
one person. There is no open, self-hostable answer for a **team**.

## 3. Goals & non-goals

**Goals**
- Let a team self-host Companion in one command and govern AI resources with real RBAC.
- Make all three pillars — **Hermès Agents**, **Curated Container Catalog**, **Skills Hub** — usable
  end-to-end in the MVP, even if thin.
- Prove the **pluggable provider** abstraction against more than one backend early.
- Give the existing v1 community a credible reason and path to upgrade.

**Non-goals (for now)**
- Not an agent-orchestration framework, a no-code app builder, or a general-purpose PaaS (see
  [`vision.md`](vision.md#non-goals)).
- Not a closed SaaS. The core stays open and self-hostable.

---

## 4. MVP definition (V0)

> **The thinnest genuinely-useful slice:** a self-hosted Companion v2 where an org can deploy a real
> Hermès agent, deploy one approved container from a curated catalog, and upload + label one versioned
> skill — all under **Org → User** RBAC with org-wide skills, on **one** deployment provider.

### In scope (V0)

| Area | Included |
|---|---|
| **Install** | Single `docker compose up` bundle: Postgres, object storage (MinIO), Mailpit for local email, web portal, and API. First user becomes Org Owner. Temporal is prepared but deferred. |
| **Identity & access** | Organization → User; email invitations; RBAC roles (Org Owner/Admin/Developer); skills live in a private **My Skills** library or the org-wide library (`scope` personal/org), shareable one-way to the org, organized with shared org folders + private personal folders. |
| **Providers** | **Local Docker** provider behind the pluggable interface; **Fly.io Machines** as fast-follow. (Kubernetes & Modal deferred to V1.) |
| **Pillar 1 — Agents** | Deploy ≥1 Hermès agent template; choose model via OpenRouter; attach skills; attach a Granite vault; chat surface. |
| **Pillar 2 — Containers** | Org-admin **approval** of images into the catalog; **1-click deploy** of ≥1 container; surface connection details/secrets. |
| **Pillar 3 — Skills** | Upload + **validate** + **version** ≥1 `SKILL.md` package; organize with shared labels; **attach** to an agent; sync into the runtime. |
| **Memory** | **Granite** vault provisioned and mounted for the agent (concrete V0 integration). |
| **Dashboard** | Basic list/detail views of agents, containers, and skills (skills filterable by label, status, and dependencies); deployment status & logs. |
| **Secrets** | Encrypted, write-only secret storage; OpenRouter and provider credentials referenced, never inlined. |
| **Audit** | Append-only audit log of mutating, deploy, and exec actions (in-app view minimal). |
| **Managed SaaS billing** | Free and Pro plans; Pro is $10 USD/month per active member with Stripe Tax, automatic prorations, a seven-day delinquency grace period, and transactional skill quotas. Self-hosted remains fully unlocked without Stripe. |

### Out of scope (deferred)

SSO/SAML & SCIM · usage cost dashboards · community marketplace & cross-org sharing ·
**Kubernetes** and **Modal** providers · audit export & compliance certifications · skill-execution
sandbox hardening · skill ratings/reviews · agent observability/tracing · Tailscale-style private
networking parity with v1.

---

## 5. Functional requirements

Each requirement has user stories with acceptance criteria. Priorities: **P0** = MVP, **P1** = V1,
**P2** = V2.

### 5.1 Organizations & membership (P0)
- As an operator, on first run I become **Org Owner** so I can configure the org. *AC:* first
  authenticated user is granted `owner`; subsequent users join via invitation.
- As an Org Admin, I can **invite users** by email with an org role. *AC:* invitee receives a tokenized
  link; accepting creates the membership row; expired/revoked tokens are rejected.
- As an Org Admin, I can **change roles** and **remove members**. *AC:* role changes take effect on the
  next request; removing a member revokes access immediately.

### 5.2 RBAC (P0)
- As any actor, I can only act within orgs I'm a **member** of; Org Owner/Admin hold elevated org
  capabilities. *AC:* every endpoint is membership-gated and tenant-scoped; cross-tenant access is
  impossible (verified by tests).
- As any member, I can **read and modify every org-scoped skill** in my org. *AC:*
  create/edit/publish/archive/delete are allowed for any member of the org and denied for non-members;
  the acting user is recorded as the skill's creator for audit.
- As any member, I have a private **My Skills** library: skills I author there (`scope=personal`) are
  visible and editable **only by me** (admins included), and I can **Share** one into the org library
  (owner-only, one-way). *AC:* a personal skill never appears in another member's list/detail/search;
  share flips it to org-scoped; install records an org skill into My Skills without copying the row.

### 5.3 Skills Hub (P0)
- As a Builder, I can **upload a `SKILL.md` package** and have it validated and versioned. *AC:*
  invalid frontmatter, path traversal, or oversize archives are rejected with a clear error; a valid
  upload produces an immutable, checksummed `skill_versions` record with a semver.
- As any member, I can **file a skill under one or more labels** (org-wide shared folders) and **browse,
  filter, and search** all skills in the org. *AC:* labels are slash-separated paths with per-path color
  and icon; assigning, renaming, recoloring, or deleting a label is allowed for any member and reflected
  org-wide.
- As any member, I can **attach/detach a specific skill version** to an agent. *AC:* attaching triggers
  a reconcile that syncs the bundle into the running agent; `synced_at` reflects convergence.

### 5.4 Hermès Agents (P0)
- As a Builder, I can **create and deploy an agent** from a template with a model route (OpenRouter), a
  system prompt, an optional Granite vault, attached skills, and a provider. *AC:* the agent reaches
  `running`, exposes a chat surface, and uses the attached skills and vault.
- As a member, I can **open a chat** with any agent in the org and **stop/redeploy** agents.

### 5.5 Curated Container Catalog (P0)
- As an Org Admin, I can **approve an image/template** into the catalog (digest-pinned, with resource
  limits and required secrets). *AC:* only approved items are deployable; image is pinned by digest.
- As a member, I can **1-click deploy** a catalog item and see its status, logs, and connection details.
  *AC:* the deployment records me as creator; secrets are injected at runtime, never exposed in config.

### 5.6 Providers & deployment lifecycle (P0)
- As an Org Admin, I can **register and test a provider** (local Docker for MVP) and store its
  credentials securely. *AC:* a connectivity test passes before the provider is enabled.
- As the system, I **reconcile** every deployment (observe → diff → apply → heal drift) idempotently.
  *AC:* re-running never double-provisions; orphaned external resources are detected and garbage-collected;
  destroy is idempotent and verified by re-observation.

### 5.7 Secrets & audit (P0)
- As an Org Admin, I can **set secrets** (write-only) that resources reference. *AC:* secret values are
  never returned by the API and never persisted in plaintext.
- As an Org Admin, I can **view an audit log** of who did what and to which resource.

### 5.8 SaaS plans and seat billing (P0 managed service)

- As a workspace Owner/Admin, I can upgrade from Free to Pro through Stripe Checkout at $10 USD per
  active member per month and manage payment methods, invoices, and end-of-period cancellation in the
  Customer Portal. *AC:* Checkout quantity is server-controlled, Stripe Tax is enabled, and a second
  active subscription cannot be created. Stripe-managed promotion codes can be applied during Checkout;
  their discount duration, validity window, and redemption limits remain controlled by the SaaS operator in Stripe.
- As any member, I can see the effective plan, active and confirmed seats, estimated pre-tax monthly
  subtotal, payment/grace/cancellation state, and seat-sync health. *AC:* PATs cannot read or manage
  billing and Developers cannot open Checkout or Portal sessions.
- As a Free member, I retain org catalog access with up to 20 active-or-archived org skills, installed
  org skills in My Skills, and current-version downloads. *AC:* personal skills remain preserved but
  hidden, history is Pro-only, and over-limit catalogs freeze non-destructive mutations.
- As a Pro member, I can run skills against a shared UTC-calendar-month sandbox pool, initially
  configured at 250 minutes per active seat. *AC:* Free has zero minutes; launches, reactivations,
  follow-ups, and prewarming reserve capacity atomically and are rejected before provider work when
  the enforced pool is exhausted. The provider lifetime cannot exceed admitted minutes or cross the
  UTC reset boundary; actual wall time replaces temporary reservations after stop.
- As a member, I can disable personal launcher prewarming, which defaults on and consumes the same
  pool. *AC:* the preference persists per user and the launcher exposes used, reserved, and remaining
  minutes before launch. Additional paid minute packs and exact Vercel invoice pass-through are not
  part of the first release.
- As a self-hosted operator, I receive all Pro capabilities without Stripe. *AC:* Billing remains
  visible as an informational “Pro included” page, sandbox usage is unlimited, and Checkout, Portal,
  and Upgrade CTAs are absent.

---

## 6. Non-functional requirements

- **Security & multi-tenancy:** strict `org_id` isolation with defense-in-depth (app-layer authz +
  database row-level security); the control plane **never executes** untrusted skill scripts or pulled
  images — all such execution happens inside sandboxed provider workloads.
- **Self-host simplicity:** one command to a working instance; opinionated, bundled defaults so the
  first deploy "just works."
- **Reliability:** reconcile loop converges within a bounded interval; transient provider errors retry
  with backoff; deployments report `degraded`/`error` clearly.
- **Performance:** org-scoped skill lists return quickly at org scale (indexed `skills.org_id` and
  `skill_labels` lookups, with index-friendly label-prefix filtering).
- **Observability:** structured logs + deployment status/log streaming in the UI (minimal in V0).
- **Internationalization-ready:** UI strings externalized from day one (English default).

---

## 7. Roadmap

| Phase | Theme | Headline capabilities |
|---|---|---|
| **V0 — MVP** | Self-host + 3 thin pillars + RBAC | Org/User + RBAC + org-wide skills with shared labels · Local Docker (Fly fast-follow) · deploy Hermès agent · curated container 1-click · `SKILL.md` upload/version/label/attach · Granite + OpenRouter concrete · basic dashboard |
| **V1 — Collaboration & trust** | Make teams productive & observable | **Kubernetes** + **Modal** providers · **SSO/SAML** · **in-app audit** & usage · agent observability/logs · skill ratings/reviews + dependency pinning · private networking (Tailscale-style) · **pluggable runtime** beyond Hermes |
| **V2 — Scale & ecosystem** | Marketplace, usage economics, compliance | Community **marketplace** (skills, agent + container templates) · usage/cost controls · **compliance** (audit export, SCIM, SOC2-ready, retention) · multi-org / federation |

**Where notable features land:** SSO/SAML → **V1**. In-app audit → **V1**, export/compliance → **V2**.
Marketplace → **V2**. Free/Pro seat billing ships with the managed SaaS slice; usage cost dashboards
remain **V2**. Kubernetes & Modal → **V1**.

---

## 8. Success metrics

### North Star
**Weekly active shared resources** — the number of agents + containers + skills used within an org
(i.e., by someone other than their creator) per week. It captures the whole thesis at once:
**deployment × governance × sharing.**

| Category | Metrics |
|---|---|
| **Activation** | Time-to-first-deploy (install → first running agent); % of new orgs that deploy in all 3 pillars within 7 days |
| **Engagement** | Agent messages/week; running container instances; weekly active deployers |
| **Collaboration** | Cross-creator usage rate (resources used by non-creators); skills attached to agents by non-creators; labels in active use |
| **OSS / adoption** | GitHub stars growth; self-host installs (opt-in telemetry); skills published; external contributors/PRs; v1→v2 migrations |

---

## 9. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| 1 | **Scope creep** — three pillars at once dilute the MVP | Enforce thin vertical slices: one provider, one of each resource type, end-to-end; a ruthless out-of-scope list |
| 2 | **Supply-chain security** — malicious containers or skills run in tenant infra | Admin-approval gate + digest pinning for catalog; `SKILL.md` validation; resource limits; control plane never executes untrusted code; explicit sandbox model committed in V1 |
| 3 | **Provider-abstraction leakage** — Docker/Fly/K8s/Modal differ enough to break the seam | Validate the interface against ≥2 backends in V0 (Docker + Fly) before adding K8s/Modal; a `capabilities()` contract + per-provider conformance suite |
| 4 | **v1 community migration friction** — 2.4k★ expect CLI/IaC, get a web portal | Keep an API/CLI surface; provide a v1 import bridge; ship a credible self-host story so the base feels at home |
| 5 | **`SKILL.md` spec drift** — the open standard evolves | Track the canonical spec; validate against a versioned schema; treat the skill format as a versioned dependency |
| 6 | **Self-host operational burden** — multi-tenant + Postgres + providers is heavier than v1's CLI | One-command compose install; sane defaults; bundled Hermes/Granite/OpenRouter so first run works |

---

## 10. Open questions

These are the decisions most worth resolving early; they shape architecture and positioning.

1. **Skill execution trust model.** Skills can ship `scripts/`. Is V0 metadata/instructions-only, or
   executable — and what sandbox do we commit to, and when? This drives the whole security posture.
2. **Monetization vs OSS purity.** Where does revenue come from — managed cloud, an open-core
   SSO/compliance tier, or a marketplace take-rate — and does any of it touch the V0/V1 boundary?
3. **Relationship to v1.** Is v2 a successor that deprecates the CLI/IaC tool, a superset that absorbs
   it, or a parallel product? This determines migration tooling and community messaging.
4. **How opinionated on the runtime.** Is Hermes + Granite a permanent first-class default, or strictly
   a V0 reference implementation behind a pluggable runtime interface? Affects architecture and
   marketplace neutrality.
5. **Federation / multi-org.** Is cross-org sharing (a community marketplace) a core ambition or
   explicitly out — and does that change the data model we should commit to in V0?
