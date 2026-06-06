# CLAUDE.md

Guidance for Claude Code agents and human contributors working in this repository.

## Project overview

**Companion v2** is an open-source (MIT), self-hostable, multi-tenant **portal** to deploy, govern, and
share AI agents, curated containers, and skills across an organization and its teams. It is the team
version of [Companion v1](https://github.com/The-Vibe-Company/companion) (a single-operator CLI/IaC tool
for personal agent fleets), built around an **Organization → Team → User** hierarchy with RBAC and
per-resource visibility scopes.

Read these before making non-trivial changes:
- [`docs/vision.md`](docs/vision.md) — why this exists, principles, non-goals.
- [`docs/product.md`](docs/product.md) — personas, the three pillars, journeys, access model.
- [`docs/design.md`](docs/design.md) — **authoritative architecture**: data model, RBAC, provider
  abstraction, runtime integration. *(Maintained by the core team — treat it as the source of truth and
  keep it in sync with the code.)*
- [`docs/PRD.md`](docs/PRD.md) — MVP scope, requirements, roadmap, metrics.

> **Status:** pre-MVP. The repository currently contains the launch documents; the application is being
> scaffolded. The layout and contracts below are the **target** described in `docs/design.md` — confirm
> against the actual tree before assuming a path exists.

## The three pillars (domain vocabulary — keep it consistent)

1. **Hermès Agents** — agents on the **Hermes** runtime, with **Granite** memory and **OpenRouter** model
   routing.
2. **Curated Container Catalog** — org-admin-approved images/templates, deployed 1-click.
3. **Skills Hub** — versioned `SKILL.md` packages, scoped and attached opt-in to agents.

Canonical terms — **do not invent synonyms**:
- Hierarchy: **Organization → Team → User**.
- Org roles: **Owner, Admin, Member, Guest**. Team roles: **Admin, Member**.
- Visibility **scope**: **`private` (user) / `team` / `org`** on every resource.
- Deploy targets are **providers**: **Docker (local), Fly, Kubernetes, Modal**.

## Target repository layout

```
apps/
  web/        # Next.js App Router — UI, tRPC client, Auth.js
  api/        # tRPC routers + REST/OpenAPI gateway (service layer entrypoints)
  worker/     # reconcile loop + job runner (no HTTP surface)
packages/
  db/         # Drizzle schema, migrations, query helpers  ← data source of truth
  core/       # domain services (authz, scoping, deploy orchestration) — NO Next.js deps
  providers/  # provider port + adapters: docker/, fly/, k8s/, modal/
  hermes/     # Hermes config builder + runtime sync
  granite/    # vault provisioning + mount/share
  skills/     # SKILL.md parse / validate / version / package
  contracts/  # shared Zod schemas + tRPC types (consumed by web, api, worker, cli)
  auth/       # Auth.js config + RBAC policy engine
cli/          # `companion` CLI — talks REST/OpenAPI
deploy/       # docker-compose.yaml (self-host) + helm/ chart
docs/         # vision / product / design / PRD
```

**Anchor files** (the contracts the system hinges on — see `docs/design.md`):
- `packages/db/schema.ts` — all entities + the `org_id` / `scope` / `owner_id` / `team_id` columns.
- `packages/auth/policy.ts` — typed RBAC: visibility gate + capability gate; the "deploy for" logic.
- `packages/providers/port.ts` — the `DeploymentProvider` interface + neutral `DeploySpec`.
- `apps/worker/reconcile.ts` — observe → diff → apply → drift loop.
- `packages/hermes/configBuilder.ts` — agent + skills + vault + model + secrets → `DeploySpec`.

## Conventions & invariants

- **Stack:** TypeScript everywhere, pnpm workspaces + Turborepo, **Drizzle ORM** (not Prisma),
  **tRPC** internally with a thin REST/OpenAPI gateway for the CLI and integrations, Auth.js for auth,
  BullMQ on Redis for jobs, S3-compatible object storage (MinIO in compose).
- **`packages/core` and `packages/providers` must not depend on Next.js** — the worker and CLI import
  them directly.
- **One source of truth for types:** entities live in `packages/db`; shared contracts in
  `packages/contracts`. Don't redefine shapes ad hoc.
- **Scope × role are orthogonal.** Authorization = a **visibility gate** (can the actor see it?) **plus**
  a **capability gate** (can the actor do it?). Enforce in the **service layer** (`packages/core`) so
  web, REST, and the worker share one path — never only in route handlers.
- **"Deploy for" semantics:** keep ownership, visibility, and provenance as **three distinct columns** —
  `owner_id` (the principal it's for), `scope`/`team_id` (visibility), and creator/audit (who acted).
- **Desired-state:** every deployable is a row of declared intent; the reconciler converges reality and
  heals drift. Provisioning is **idempotent** (keyed so retries never double-provision).
- **Secrets** are envelope-encrypted, **write-only** over the API, referenced by id, and injected by the
  provider at the last moment. Never log, return, or persist plaintext secrets.
- **Security boundary (non-negotiable):** the control plane **never executes** untrusted skill scripts or
  pulled images. All such execution happens inside sandboxed provider workloads. Catalog images are
  admin-approved and digest-pinned.
- **Multi-tenancy:** every row carries `org_id`; add Postgres row-level security as defense-in-depth.
  Any new query must be scoped to the tenant.
- **Frontend must follow [`DESIGN.md`](DESIGN.md).** Any UI, styling, copy, component, layout, or
  interaction change must respect the root `DESIGN.md` visual contract and keep design tokens, product
  tone, accessibility, and absolute bans intact.

## Development workflow (planned)

```bash
docker compose up           # postgres + redis + minio + web + worker
pnpm db:migrate             # apply Drizzle migrations
pnpm db:seed                # seed an org/team/user for local dev
pnpm dev                    # run web + worker in watch mode
```

(Exact scripts land with the scaffold; update this section when they do.)

## Tests & quality gates

- **RBAC is table-driven and exhaustive.** Add cases to the role × scope × action matrix whenever you
  touch authorization; assert cross-tenant access is denied.
- **`DESIGN.md` follows the Google Design.md format.** Any change to the root `DESIGN.md` must pass
  `npx --yes @google/design.md@0.2.0 lint DESIGN.md --format json`; CI runs this automatically when
  `DESIGN.md` changes.
- **Provider conformance suite.** Every provider adapter must pass the same contract tests; verify the
  `capabilities()` declaration matches real behavior (e.g., exec, persistent volumes, scale-to-zero).
- **Reconcile idempotency.** Re-applying a deployment must not create duplicates; destroy must be
  idempotent and verified by re-observation.

## When you finish a change

- If you changed architecture, the data model, RBAC, the provider seam, or a runtime integration,
  **update [`docs/design.md`](docs/design.md)** (and this file's anchors if paths moved). Keep the docs
  and the code in agreement.
- Match the surrounding code's style; keep `packages/core`/`providers` framework-free.
- Prefer extending existing contracts in `packages/contracts` over introducing parallel ones.
