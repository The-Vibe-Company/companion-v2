# AGENTS.md

Operating guide for AI coding agents (Claude Code, Cursor, Codex, …) and human contributors working in
this repository. This is the **canonical** contributor guide; `CLAUDE.md` is a symlink to it.

> **Read this first, then verify against the tree.** Paths and contracts move. When this file and the
> code disagree, trust the code and fix this file in the same change.

---

## 1. What Companion v2 is

Companion v2 is an open-source (MIT), self-hostable, **multi-tenant portal** to deploy, govern, and share
AI agents, curated containers, and skills across an organization. It is the team version of
[Companion v1](https://github.com/The-Vibe-Company/companion) (a single-operator CLI/IaC tool), built
around an **Organization → User** hierarchy with RBAC and org-wide sharing.

Think *"GitHub for your team's agents"* — open-source, running on your own infrastructure.

**Current status (read the tree, not the marketing):** the **Skills Hub** is the implemented slice —
Postgres + Drizzle, Better Auth, S3/MinIO storage, a Hono `/v1/*` API, a Next.js portal, a worker, and
the `companion` CLI. **Skill Runs** (one-shot sandboxed executions) and **Cowork Projects** (persistent
sandboxes) are implemented on top of Vercel Sandbox + OpenCode. Managed SaaS adds Stripe seat billing;
self-host stays fully unlocked without Stripe. The **Container Catalog** and standalone **Hermès Agent**
deployment are still stubs/aspirational.

Deep-dive docs (read before non-trivial changes):
- [`docs/vision.md`](docs/vision.md) — why this exists, principles, non-goals.
- [`docs/product.md`](docs/product.md) — personas, the three pillars, journeys, access model.
- [`docs/design.md`](docs/design.md) — **authoritative architecture**: data model, RBAC, runtime seams.
- [`docs/PRD.md`](docs/PRD.md) — scope, requirements, roadmap, metrics.
- [`docs/testing.md`](docs/testing.md) — the testing standard and the protection map of critical suites.
- [`DESIGN.md`](DESIGN.md) — the binding visual/UX contract for all frontend work.

---

## 2. Domain vocabulary — keep it consistent, do not invent synonyms

**The three pillars**
1. **Hermès Agents** — agents on the **Hermes** runtime, with **Granite** memory and **OpenRouter** model
   routing. *(Deployment surface is still being built.)*
2. **Curated Container Catalog** — org-admin-approved, digest-pinned images/templates, deployed 1-click.
   *(Stubbed.)*
3. **Skills Hub** — versioned `SKILL.md` packages in two libraries, organized by **labels** ("folders"),
   attached opt-in to agents. *(Implemented.)*

**Canonical terms**
- Hierarchy is **Organization → User**. There are **no teams**.
- Org roles: **Owner, Admin, Developer**.
- **Skills have two libraries (`skills.scope`).**
  - `org` = flat org-wide: every member can read it and **any** member can edit/publish/archive/delete it.
  - `personal` = private **My Skills**: visible and editable **only by its creator** — admins included,
    **no override**.
  - `creator_id` records who authored the row (provenance/Activity) and is the **owner** of a personal
    skill.
  - The one library transition is **Share** (`POST /v1/skills/:slug/share`, owner-only, one-way
    `personal → org`).
  - A slug is **workspace-unique across both scopes**.
  - "Installed" is not a copied row: *My Skills = your personal skills ∪ org skills you have a
    `skill_installs` row for*.
- **Labels organize within a library.** Org skills use an org-wide **shared** tree
  (`/v1/labels`, `/v1/skills/:slug/labels`); My Skills uses each member's **personal** tree
  (`/v1/personal-labels`, `/v1/skills/:slug/personal-labels`). A label is a slash-separated path
  (`marketing/seo`), multi-assigned, with optional per-path display name, color + icon; empty folders are
  allowed.
- **Skill Runs** are one-shot, creator-private, sandboxed skill executions. **Cowork Projects** are
  persistent, creator-private sandboxes multiplexing many OpenCode sessions over a shared filesystem.
- **Secrets** are envelope-encrypted, write-only over the API, referenced by id, injected at the last
  moment.

---

## 3. Actual repository layout

```
apps/
  api/       @companion/api    — Hono REST /v1/* server (+ a small tRPC router), Better Auth, migrations
  web/       @companion/web    — Next.js 15 App Router UI (React 19, tRPC/REST client, shadcn, PostHog)
  worker/    @companion/worker — supervisors + reconcilers, no HTTP surface
packages/
  auth/          @companion/auth            — Better Auth + Agent Auth config, Drizzle adapter
  billing/       @companion/billing         — Stripe checkout / subscriptions / webhooks
  companion-skill/ @companion/companion-skill — the bundled "Companion" management skill + loader
  contracts/     @companion/contracts       — shared Zod schemas + tRPC types (one source of truth)
  core/          @companion/core            — domain services, RBAC, runs/projects/secrets (NO Next.js)
  db/            @companion/db              — Drizzle schema, migrations, tenant context (data source of truth)
  email/         @companion/email           — transactional email (Resend / Mailpit / log)
  github/        @companion/github          — GitHub OAuth/App + deterministic repo writer
  sandbox/       @companion/sandbox         — runtime IMPLEMENTATIONS of core ports (@vercel/sandbox + @opencode-ai/sdk)
  skills/        @companion/skills          — SKILL.md parse / validate / pack / unpack
  storage/       @companion/storage         — S3-compatible object storage (MinIO in dev)
cli/             @companion/cli             — the `companion` CLI (talks REST /v1/*)
deploy/railway/  — Dockerfiles + railway.json for the Railway self-host target
docs/            — vision / product / design / PRD / testing
scripts/         — dev launchers + CI gates + verify-change
e2e/             — Playwright critical flows
examples/skills/ — sample skills
docker-compose.yml, DESIGN.md, turbo.json, tsconfig.base.json, pnpm-workspace.yaml
```

> **Known aspirational-vs-real gaps** (do not cite these as if they exist): there is **no**
> `packages/providers`, `packages/hermes`, `packages/granite`, `deploy/helm/`, or single
> `apps/worker/reconcile.ts`. There is no separate OpenAPI gateway package. The deploy-target provider
> abstraction (Docker/Fly/K8s/Modal) described in older docs is **not implemented**; today execution runs
> on **Vercel Sandbox** via `packages/sandbox`. Reconciliation lives in the worker supervisors
> (`apps/worker/src/*Supervisor.ts`, `runRuntimeReconciler.ts`).

### Anchor files — the contracts the system hinges on
- `packages/db/src/schema.ts` — every entity, the `org_id` tenant column, `creator_id` provenance/owner
  column, and `scope` (personal/org) on skills; the `labels`/`skillLabels` (org) and
  `personalLabels`/`personalSkillLabels` (per-user) folder tables. Migrations live in
  `packages/db/drizzle/`.
- `packages/core/src/authz.ts` — typed RBAC. Org-role gates (`isOrgAdmin`, `canManageOrg`, `canPerform`,
  `isLastOwner`) plus per-resource gates (`canAccessSkill`, `canManagePersonalSkill`,
  `canManagePublicSkill`, `canAccessRun`, `canAccessProject`, `canAccessSecret`, `canManageSecret`).
- `packages/core/src/runRuntime.ts` — the `RunSandboxRuntime` / `RunChatRuntime` port for one-shot
  sandboxed skill runs. Implemented by `packages/sandbox` (`vercel.ts`, `opencodeChat.ts`).
- `packages/core/src/projectWorkspaceRuntime.ts` — the persistent Cowork Project port
  (`ProjectWorkspaceRuntime` / `ProjectChatRuntime`), implemented by
  `packages/sandbox/{projectVercel.ts,projectOpencodeChat.ts}` and owned by
  `apps/worker/src/projectSupervisor.ts`.
- `apps/api/src/index.ts` — the REST `/v1/*` surface (skills, orgs, labels, secrets, runs, projects,
  billing, GitHub, onboarding, agent auth). `apps/api/src/trpc.ts` is the small tRPC router.
- `apps/worker/src/supervisors.ts` + `runRuntimeReconciler.ts` — the observe → diff → apply → drift loops.

---

## 4. Stack & non-negotiable invariants

- **Stack:** TypeScript everywhere; **pnpm workspaces + Turborepo**; **Drizzle ORM** (not Prisma);
  **Hono** for the REST `/v1/*` API with a small internal **tRPC** router; **Better Auth**; S3-compatible
  object storage (MinIO in compose); **Resend** in prod (Mailpit/log in dev); **Stripe** for managed seat
  billing. Redis/BullMQ are intentionally excluded; Temporal is the intended future workflow engine.
- **`packages/core` stays framework-free** — no Next.js, no Hono, no SDKs. Core defines ports; the worker
  and CLI import it directly; `packages/sandbox` provides the SDK-bound implementations that the worker
  injects.
- **One source of truth for types:** entities live in `packages/db`; shared contracts in
  `packages/contracts`. Do not redefine shapes ad hoc — extend the existing contract.
- **Authorization = tenant + role (+ scope for personal resources).** Every decision is a
  **tenant/membership gate** (is the actor a member of this org?) **plus** a **capability gate** (does the
  actor's role permit it?). **Org** skills carry no per-resource gate; **personal** skills, **runs**, and
  **Projects** add a creator-only gate with **no admin override**. Enforce in the **service layer**
  (`packages/core`) so web, REST, CLI, and worker share one path — never only in a route handler.
- **Provenance + ownership:** a skill records `creator_id` (owner of a personal skill). The library axis
  is `skills.scope`; Share is the only `personal → org` transition. Organize with **labels**, never
  ad-hoc access flags.
- **Desired-state + idempotency:** every deployable is a row of declared intent; supervisors converge
  reality and heal drift. Provisioning is keyed so retries never double-provision; destroy is idempotent.
- **Secrets are write-only.** Envelope-encrypted, referenced by id, injected by the runtime at the last
  moment. Never log, return, or persist plaintext secrets.
- **Security boundary (non-negotiable):** the control plane **never executes** untrusted skill scripts or
  pulled images. All such execution happens inside sandboxed workloads. Catalog images are admin-approved
  and digest-pinned.
- **Multi-tenancy:** every row carries `org_id`, and Postgres **row-level security** is defense-in-depth
  (see `rls.integration.test.ts` and the runtime-role split enforced by `apps/api/src/migrate.ts`). Any
  new query must be tenant-scoped.
- **Frontend must follow [`DESIGN.md`](DESIGN.md).** Any UI, styling, copy, component, layout, or
  interaction change must respect the visual contract, design tokens, product tone, accessibility, and
  the absolute bans.

---

## 5. Environment & development workflow

- Node **22** (`.nvmrc`; `engines` allows `>=20`), pnpm **9.12.0** (`packageManager`). Run
  `corepack enable` then `pnpm install`.

```bash
pnpm install
pnpm dev            # scripts/dev-stack.sh: Docker compose up → migrate → seed → api :3001 + worker + web :3000
```

Manual split loop (no wrapper):
```bash
pnpm compose:up     # postgres + minio + mailpit + bucket init (Docker)
pnpm db:migrate     # apply Drizzle migrations
pnpm db:seed        # seed an org + test user (+ a few labels)
pnpm dev:app        # api + worker + web via concurrently
```

CLI:
```bash
pnpm --filter @companion/cli build
node cli/dist/index.js login --url http://127.0.0.1:3001 --signup --email you@example.com
node cli/dist/index.js skills push examples/skills/incident-summary --everyone
node cli/dist/index.js skills list        # also: info, versions, validate, pull|install, status, sync
```
See `cli/README.md` for the full command + exit-code reference.

**Conductor** (checked-in `.conductor/settings.toml`) uses `scripts/dev-conductor.sh` — a **native,
Docker-free** launcher. It starts a per-workspace Postgres cluster plus optional native MinIO + Mailpit
under `.conductor-pg/`, migrates, seeds, then runs api + worker + web with `concurrently`. All ports
derive from `CONDUCTOR_PORT` (fallback `3000`): web `+0`, API `+1`, Postgres `+2`, MinIO API `+3`, MinIO
console `+4`, Mailpit SMTP `+5`, Mailpit UI `+6`. Auth cookies are namespaced `companion-<workspace>`. If
`minio`/`mailpit` are absent the stack still runs (S3 uploads disabled; email falls back to
`EMAIL_PROVIDER=log`). `bash scripts/dev-conductor.sh archive` stops services and removes `.conductor-pg/`.

In production the API start script applies pending Drizzle migrations (with runtime-role grants) before
listening; Railway runs the same migration as a pre-deploy step. See
[`deploy/railway/README.md`](deploy/railway/README.md).

---

## 6. Tests & quality gates

Follow [`docs/testing.md`](docs/testing.md): tests protect **product promises**, not implementation
details. Critical suites must explain the promise, the incident prevented, the test level, and the fault
that proves the test is sensitive. Prefer fewer behavior-level tests over mocks of internal query
builders.

```bash
pnpm lint              # turbo run lint (ESLint lives in apps/web via next)
pnpm typecheck         # turbo run typecheck
pnpm test              # turbo run test (Vitest across packages/apps)
pnpm test:integration  # DATABASE_URL=... — tenant / Skills / Secrets / RLS on disposable Postgres
pnpm test:e2e          # Playwright critical flows (e2e/critical-flows.spec.ts)
pnpm browser:smoke     # APP_URL=http://127.0.0.1:<port> pnpm browser:smoke — agent-browser core flow
pnpm design:lint       # @google/design.md lint DESIGN.md (required when DESIGN.md changes)
```

Standing expectations:
- **RBAC is table-driven and exhaustive.** When you touch authorization, add cases to the
  membership × role × action matrix and assert that non-members and cross-tenant access are denied.
- **Frontend browser validation is required after frontend changes.** Run the app and validate with
  `agent-browser` before finishing. Minimum smoke path: signed-out redirect → login → Skills list →
  filters → detail view → upload drawer → mobile viewport → no browser errors. Include the result in your
  handoff.
- **`DESIGN.md` follows the Google Design.md format** and must pass
  `npx --yes @google/design.md@0.2.0 lint DESIGN.md --format json`.
- **Reconcile idempotency:** re-applying a deployment must not create duplicates; destroy is idempotent
  and verified by re-observation.

CI (`.github/workflows/ci.yml`) is **scope-driven** via `scripts/ci-scope.mjs`, which classifies the
diff (docs / design / quality / build / database / browser / containers / dependencies / skill / full).
Jobs: Hygiene (script tests, actionlint, shellcheck, gitleaks, conditional skill + DESIGN checks),
Quality (lint/typecheck/test on Node 22), Application Build (+ CLI smoke), Database Integration (Postgres
+ `test:integration` + API smoke), Railway Containers (build + `ci-container-smoke.sh`), Browser Critical
Flows (RSC smoke + Playwright), Dependency Audit, Node 20 compatibility, and a final **CI Gate**
(`scripts/ci-gate.mjs`) that fails if a required scoped job did not succeed.

---

## 7. Bundled Companion skill — version + integrity discipline

Any change under `packages/companion-skill/skill/` **must**:
1. increase `packages/companion-skill/skill/companion.json` `version` (semver),
2. add a matching top changelog entry, and
3. refresh integrity with `pnpm --filter @companion/companion-skill update:integrity`
   (rewrites `companion.integrity.json`).

CI enforces this with `pnpm --filter @companion/companion-skill check:version-bump` (integrity check +
required version bump) when the skill scope is touched.

---

## 8. When you finish a change — the checklist

- **Run `pnpm verify:change`** before handing off. It diffs against `origin/main`, classifies scope, and
  runs the selected fast checks (hygiene, design lint, skill version/integrity, and turbo
  lint/typecheck/test/build on affected workspaces). **Exit code `2`** means the fast checks passed but
  the printed deferred gates (Postgres integration, browser smoke, container smoke, dependency audit) are
  still required — run the relevant ones. Use `pnpm verify:change -- --plan` to inspect the plan without
  executing.
- **If you changed architecture, the data model, RBAC, a runtime port, or a provider seam**, update
  [`docs/design.md`](docs/design.md) (and the anchor list in §3 here if paths moved). Keep docs and code
  in agreement.
- **If you changed the public skills API surface** (endpoints or request/response shapes for skills,
  comments, versions, dependencies, labels, runs, projects, etc.), update the bundled Companion skill in
  `packages/companion-skill/skill/` (`SKILL.md` and `reference/api.md`, plus `companion.json` if
  capabilities changed) so agent-facing docs match the API — and follow the §7 version/integrity bump.
- **If you changed frontend behavior**, include the `agent-browser` validation result in your handoff.
- **Match the surrounding code's style**; keep `packages/core` framework-free; extend
  `packages/contracts` rather than adding parallel shapes.
- **Git:** commit each logical change separately with a clear message; do not force-push or amend unless
  asked; stay on your branch. **PR titles use Commitizen style**, e.g. `feat(skills): add label recolor`.
