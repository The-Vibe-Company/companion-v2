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
agents, curated containers, and skills across an organization and its teams. It turns the
single-operator Companion v1 engine (Hermes runtime, Granite memory, OpenRouter, pluggable infra) into
a collaborative web product with an **Organization → Team → User** hierarchy, **RBAC**, and per-resource
**visibility scopes** (user / team / org).

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

> **The thinnest genuinely-useful slice:** a self-hosted Companion v2 where a team can deploy a real
> Hermès agent, deploy one approved container from a curated catalog, and upload + attach one versioned
> skill — all under **Org → Team → User** RBAC with three visibility scopes, on **one** deployment
> provider.

### In scope (V0)

| Area | Included |
|---|---|
| **Install** | Single `docker compose up` bundle: Postgres, Redis, object storage (MinIO), web portal, reconcile worker. First user becomes Org Owner. |
| **Identity & access** | Organization → Team → User; email invitations; RBAC roles (Org Owner/Admin/Member/Guest, Team Admin/Member); visibility scopes (user/team/org) on every resource; "deploy **for** user/team/org" semantics. |
| **Providers** | **Local Docker** provider behind the pluggable interface; **Fly.io Machines** as fast-follow. (Kubernetes & Modal deferred to V1.) |
| **Pillar 1 — Agents** | Deploy ≥1 Hermès agent template; choose model via OpenRouter; attach skills; attach a Granite vault; chat surface. |
| **Pillar 2 — Containers** | Org-admin **approval** of images into the catalog; **1-click deploy** of ≥1 container; surface connection details/secrets. |
| **Pillar 3 — Skills** | Upload + **validate** + **version** ≥1 `SKILL.md` package; scope it; **attach** to an agent; sync into the runtime. |
| **Memory** | **Granite** vault provisioned and mounted for the agent (concrete V0 integration). |
| **Dashboard** | Basic list/detail views of agents, containers, and skills filtered by scope; deployment status & logs. |
| **Secrets** | Encrypted, write-only secret storage; OpenRouter and provider credentials referenced, never inlined. |
| **Audit** | Append-only audit log of mutating, deploy, and exec actions (in-app view minimal). |

### Out of scope (deferred)

SSO/SAML & SCIM · billing, quotas, cost dashboards · public/community marketplace & cross-org sharing ·
**Kubernetes** and **Modal** providers · audit export & compliance certifications · skill-execution
sandbox hardening · skill ratings/reviews · agent observability/tracing · Tailscale-style private
networking parity with v1.

---

## 5. Functional requirements

Each requirement has user stories with acceptance criteria. Priorities: **P0** = MVP, **P1** = V1,
**P2** = V2.

### 5.1 Organizations, teams & membership (P0)
- As an operator, on first run I become **Org Owner** so I can configure the org. *AC:* first
  authenticated user is granted `owner`; subsequent users join via invitation.
- As an Org Admin, I can **create teams** and **invite users** by email with an org role and optional
  team membership. *AC:* invitee receives a tokenized link; accepting creates the membership rows;
  expired/revoked tokens are rejected.
- As an Org Admin, I can **change roles** and **remove members**. *AC:* role changes take effect on the
  next request; removing a member revokes visibility immediately.

### 5.2 RBAC & visibility (P0)
- As any actor, I can only **see** resources whose scope I satisfy (own private, my team, my org), with
  Org Owner/Admin able to see everything in the tenant. *AC:* list/detail endpoints are scope-filtered;
  cross-tenant access is impossible (verified by tests).
- As an Org/Team Admin, I can **deploy a resource for** a specific user, my team, or the org. *AC:* the
  created resource's owner = the intended principal, visibility = the chosen scope, and the acting admin
  is recorded as creator in the audit log.

### 5.3 Skills Hub (P0)
- As a Builder, I can **upload a `SKILL.md` package** and have it validated and versioned. *AC:*
  invalid frontmatter, path traversal, or oversize archives are rejected with a clear error; a valid
  upload produces an immutable, checksummed `skill_versions` record with a semver.
- As a Builder, I can **scope** a skill (private/team/org) and **browse** skills I'm permitted to see.
- As an agent owner, I can **attach/detach a specific skill version** to an agent I can edit. *AC:*
  attaching triggers a reconcile that syncs the bundle into the running agent; `synced_at` reflects
  convergence; a private skill cannot be attached to a broader-scoped agent without promotion.

### 5.4 Hermès Agents (P0)
- As a Builder, I can **create and deploy an agent** from a template with a model route (OpenRouter), a
  system prompt, an optional Granite vault, attached skills, a provider, and a scope. *AC:* the agent
  reaches `running`, exposes a chat surface, and uses the attached skills and vault.
- As a permitted member, I can **open a chat** with an agent I can see and **stop/redeploy** agents I
  control.

### 5.5 Curated Container Catalog (P0)
- As an Org Admin, I can **approve an image/template** into the catalog (digest-pinned, with resource
  limits, required secrets, default scope). *AC:* only approved items are deployable; image is pinned by
  digest.
- As a member, I can **1-click deploy** a catalog item to a chosen scope and see its status, logs, and
  connection details. *AC:* deployment is created with my chosen owner/scope; secrets are injected at
  runtime, never exposed in config.

### 5.6 Providers & deployment lifecycle (P0)
- As an Org Admin, I can **register and test a provider** (local Docker for MVP) and store its
  credentials securely. *AC:* a connectivity test passes before the provider is enabled.
- As the system, I **reconcile** every deployment (observe → diff → apply → heal drift) idempotently.
  *AC:* re-running never double-provisions; orphaned external resources are detected and garbage-collected;
  destroy is idempotent and verified by re-observation.

### 5.7 Secrets & audit (P0)
- As an Org Admin, I can **set secrets** (write-only) that resources reference. *AC:* secret values are
  never returned by the API and never persisted in plaintext.
- As an Org Admin, I can **view an audit log** of who did what, to which resource, at which scope.

---

## 6. Non-functional requirements

- **Security & multi-tenancy:** strict `org_id` isolation with defense-in-depth (app-layer authz +
  database row-level security); the control plane **never executes** untrusted skill scripts or pulled
  images — all such execution happens inside sandboxed provider workloads.
- **Self-host simplicity:** one command to a working instance; opinionated, bundled defaults so the
  first deploy "just works."
- **Reliability:** reconcile loop converges within a bounded interval; transient provider errors retry
  with backoff; deployments report `degraded`/`error` clearly.
- **Performance:** scope-filtered lists return quickly at team/org scale (indexed `(org_id, scope,
  team_id)` access).
- **Observability:** structured logs + deployment status/log streaming in the UI (minimal in V0).
- **Internationalization-ready:** UI strings externalized from day one (English default).

---

## 7. Roadmap

| Phase | Theme | Headline capabilities |
|---|---|---|
| **V0 — MVP** | Self-host + 3 thin pillars + RBAC | Org/Team/User + RBAC + scopes · Local Docker (Fly fast-follow) · deploy Hermès agent · curated container 1-click · `SKILL.md` upload/version/attach · Granite + OpenRouter concrete · basic dashboard |
| **V1 — Collaboration & trust** | Make teams productive & observable | **Kubernetes** + **Modal** providers · **SSO/SAML** · **in-app audit** & usage · agent observability/logs · skill ratings/reviews + dependency pinning · private networking (Tailscale-style) · **pluggable runtime** beyond Hermes |
| **V2 — Scale & ecosystem** | Marketplace, monetization, compliance | Public/community **marketplace** (skills, agent + container templates) · **billing + quotas/cost controls** · **compliance** (audit export, SCIM, SOC2-ready, retention) · optional **managed cloud** · multi-org / federation |

**Where notable features land:** SSO/SAML → **V1**. In-app audit → **V1**, export/compliance → **V2**.
Marketplace → **V2**. Billing → **V2**. Kubernetes & Modal → **V1**.

---

## 8. Success metrics

### North Star
**Weekly active shared resources** — the number of agents + containers + skills used across a team/org
boundary (i.e., by someone other than their creator) per week. It captures the whole thesis at once:
**deployment × governance × sharing.**

| Category | Metrics |
|---|---|
| **Activation** | Time-to-first-deploy (install → first running agent); % of new orgs that deploy in all 3 pillars within 7 days |
| **Engagement** | Agent messages/week; running container instances; weekly active deployers |
| **Collaboration** | % of resources at team/org scope (vs private); cross-creator usage rate; skills attached across teams |
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
5. **Federation / multi-org.** Is cross-org sharing (a public/community marketplace) a core ambition or
   explicitly out — and does that change the data model we should commit to in V0?
