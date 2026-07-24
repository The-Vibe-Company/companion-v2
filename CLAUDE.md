# CLAUDE.md

Guidance for Claude Code agents and human contributors working in this repository.

## Project overview

**Companion v2** is an open-source (MIT), self-hostable, multi-tenant **portal** to deploy, govern, and
share AI agents, curated containers, and skills across an organization. It is the team
version of [Companion v1](https://github.com/The-Vibe-Company/companion) (a single-operator CLI/IaC tool
for personal agent fleets), built around an **Organization → User** hierarchy with RBAC and
org-wide resource sharing.

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
3. **Skills Hub** — versioned `SKILL.md` packages in two libraries (private **My Skills** + the org-wide library), organized by **labels** ("folders"), attached opt-in to agents.

Canonical terms — **do not invent synonyms**:
- Hierarchy: **Organization → User**. There are no teams.
- Org roles: **Owner, Admin, Developer**.
- **Skills have two libraries (`skills.scope`).** `org` = flat org-wide: every member can read it, and **any** member can edit/publish/archive/delete it. `personal` = private "My Skills", visible and editable **only by its creator** (admins included — no override). `creator_id` records who authored the row (provenance/Activity) and is also the **owner** of a personal skill. The one transition is **Share** (`POST /v1/skills/:slug/share`, owner-only, one-way `personal → org`). A slug is **workspace-unique across both scopes**. "Installed" is not a copied row: My Skills = own personal skills ∪ org skills you have a `skill_installs` row for.
- **Labels organize within a library.** Org skills use an org-wide **shared** tree (`/v1/labels`, `/v1/skills/:slug/labels`); My Skills uses each member's **personal** tree (`/v1/personal-labels`, `/v1/skills/:slug/personal-labels`). A label is a slash-separated path (e.g. `marketing/seo`), multi-assigned, with optional per-path display name, color + icon, and empty folders allowed. Personal folders organize authored personal skills only.
- Deploy targets are **providers**: **Docker (local), Fly, Kubernetes, Modal**.

## Target repository layout

```
apps/
  web/        # Next.js App Router — UI, tRPC/API client
  api/        # tRPC routers + REST/OpenAPI gateway (service layer entrypoints)
  worker/     # supervisors + job runner (no HTTP surface)
packages/
  github/     # GitHub App OAuth, installation tokens, deterministic repository writer
  db/         # Drizzle schema, migrations, query helpers  ← data source of truth
  core/       # domain services (authz, scoping, deploy orchestration) — NO Next.js deps
  providers/  # provider port + adapters: docker/, fly/, k8s/, modal/
  hermes/     # Hermes config builder + runtime sync
  granite/    # vault provisioning + mount/share
  skills/     # SKILL.md parse / validate / version / package
  contracts/  # shared Zod schemas + tRPC types (consumed by web, api, worker, cli)
  auth/       # Better Auth config
cli/          # `companion` CLI — talks REST/OpenAPI
deploy/       # docker-compose.yaml (self-host) + helm/ chart
docs/         # vision / product / design / PRD
```

**Anchor files** (the contracts the system hinges on — see `docs/design.md`):
- `packages/db/src/schema.ts` — all entities + the `org_id` tenant column, the `creator_id` provenance/owner column and the `scope` (personal/org) column on skills; the `labels`/`skill_labels` (org) and `personal_labels`/`personal_skill_labels` (per-user) folder tables.
- `packages/core/src/authz.ts` — typed RBAC: tenant/membership gate + org-role capability gate, plus `canAccessSkill`/`canManagePersonalSkill` (personal-skill privacy: owner-only, no admin override), `canAccessRun`, and `canAccessProject` (runs and Projects are creator-only with the same no-admin-override shape). Org skills carry no per-resource gate; personal skills, runs, and Projects do.
- `packages/core/src/runRuntime.ts` — the `RunSandboxRuntime` port for one-shot sandboxed skill runs (fork golden → push workspace → serve → health → stop/destroy), implemented by `packages/sandbox` (`@vercel/sandbox` + `@opencode-ai/sdk`, pinned exactly). Core stays SDK-free; `apps/worker` composes and injects it while the API only persists commands and serves creator-scoped state.
- `packages/core/src/projectWorkspaceRuntime.ts` — the separate persistent Cowork Project port: one
  named Vercel sandbox and one OpenCode server host many independent sessions over a shared managed
  filesystem. `apps/worker/src/projectSupervisor.ts` owns its fenced lifecycle; the API only persists
  creator-private commands.
- `packages/providers/port.ts` — the `DeploymentProvider` interface + neutral `DeploySpec`.
- `apps/worker/reconcile.ts` — observe → diff → apply → drift loop.
- `packages/hermes/configBuilder.ts` — agent + skills + vault + model + secrets → `DeploySpec`.

## Conventions & invariants

- **Stack:** TypeScript everywhere, pnpm workspaces + Turborepo, **Drizzle ORM** (not Prisma),
  **tRPC** internally with a thin REST/OpenAPI gateway for the CLI and integrations, **Better Auth**
  for auth, S3-compatible object storage (MinIO in compose), and Resend for production email.
  Redis/BullMQ are intentionally excluded; Temporal is the future workflow engine for long-running
  deployments, reconcile loops, retries, and schedules.
- **`packages/core` and `packages/providers` must not depend on Next.js** — the worker and CLI import
  them directly.
- **One source of truth for types:** entities live in `packages/db`; shared contracts in
  `packages/contracts`. Don't redefine shapes ad hoc.
- **Authorization = tenant + role (+ scope for personal skills).** A permission decision is a
  **tenant/membership gate** (is the actor a member of this org?) **plus** a **capability gate** (does the
  actor's org role permit the action?). **Org** skills carry no per-resource gate (any member can do
  anything). **Personal** skills add a per-resource gate: only the creator can read/edit/share/delete
  them — admins included (`canAccessSkill`/`canManagePersonalSkill`). Enforce in the **service layer**
  (`packages/core`) so web, REST, and the worker share one path — never only in route handlers.
- **Provenance + ownership:** a skill records `creator_id` (who authored the row, for Activity/audit),
  which is also the **owner** of a personal skill. The library axis is `skills.scope` (personal/org);
  Share is the only `personal → org` transition. Organize skills with **labels** (org shared folders +
  personal private folders), never with ad-hoc access flags.
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
pnpm compose:up             # postgres + minio + mailpit for manual local dev
pnpm db:migrate             # apply Drizzle migrations
pnpm db:seed                # seed an org + user (and a few labels) for local dev
pnpm dev                    # run API + web in watch mode
```

For Conductor, use the checked-in `.conductor/settings.toml`: setup runs `corepack enable && pnpm install`
(and best-effort `brew install postgresql@17 minio mailpit`), run executes `bash scripts/dev-conductor.sh`, and archive
executes `bash scripts/dev-conductor.sh archive`. The Conductor run path is **native — no Docker**:
`scripts/dev-conductor.sh` (modeled on `~/Dev/monkapps`) starts a per-workspace Postgres cluster, plus
optional native MinIO + Mailpit, under `.conductor-pg/`, then launches the API + web via `concurrently`.
All ports derive from `CONDUCTOR_PORT` (fallback `3000`): web `+0`, API `+1`, Postgres `+2`, MinIO API
`+3`, MinIO console `+4`, Mailpit SMTP `+5`, Mailpit UI `+6`. Better Auth cookies are namespaced by a
`companion-<workspace>` prefix. If `minio`/`mailpit` aren't installed the stack still runs (S3 uploads
disabled; email falls back to `EMAIL_PROVIDER=log`). A cleanup trap stops every native service on Ctrl+C,
and `archive` stops them then removes `.conductor-pg/`. The non-Conductor `pnpm dev` path is unchanged and
still uses Docker Compose (`scripts/dev-stack.sh`).

## Tests & quality gates

- **Testing standard:** follow [`docs/testing.md`](docs/testing.md). Critical suites must explain the
  product promise, regression caught, reason for their test level, and the fault that proves the test
  is sensitive. Prefer fewer behavior-level tests over mocks of internal query builders.

- **RBAC is table-driven and exhaustive.** Add cases to the membership × org-role × action matrix whenever
  you touch authorization; assert that non-members and cross-tenant access are denied.
- **Frontend browser validation is required after frontend changes.** After any UI, route, auth, style,
  component, or browser-facing behavior change, run the app and validate it with `agent-browser` before
  finishing. Use the automated shortcut `APP_URL=http://127.0.0.1:<port> pnpm browser:smoke` for the
  core flow, and add manual `agent-browser` checks for any changed or risky path.
- **`DESIGN.md` follows the Google Design.md format.** Any change to the root `DESIGN.md` must pass
  `npx --yes @google/design.md@0.2.0 lint DESIGN.md --format json`; CI runs this automatically when
  `DESIGN.md` changes.
- **Bundled Companion skill changes require a version bump.** Any change under
  `packages/companion-skill/skill/` must increase `packages/companion-skill/skill/companion.json`
  `version`, add a matching top changelog entry, and refresh `companion.integrity.json` with
  `pnpm --filter @companion/companion-skill update:integrity`. CI enforces this with
  `pnpm --filter @companion/companion-skill check:version-bump`.
- **Provider conformance suite.** Every provider adapter must pass the same contract tests; verify the
  `capabilities()` declaration matches real behavior (e.g., exec, persistent volumes, scale-to-zero).
- **Reconcile idempotency.** Re-applying a deployment must not create duplicates; destroy must be
  idempotent and verified by re-observation.

## When you finish a change

- Run `pnpm verify:change` before handing off any change. It runs the fast checks selected from the
  current diff against `origin/main`; exit code `2` means those checks passed but the printed Postgres,
  browser, container, or dependency follow-up gates are still required. Use `pnpm verify:change -- --plan`
  to inspect the validation plan without executing it.
- If you changed architecture, the data model, RBAC, the provider seam, or a runtime integration,
  **update [`docs/design.md`](docs/design.md)** (and this file's anchors if paths moved). Keep the docs
  and the code in agreement.
- If you changed the public skills API surface (endpoints, or the request/response shapes for skills,
  comments, versions, dependencies, labels, etc.), **update the bundled Companion skill** in
  `packages/companion-skill/skill/` (`SKILL.md` and `reference/api.md`, plus `companion.json` if the
  capabilities changed) so the agent-facing docs match the API. Because this touches the bundled skill,
  also bump `companion.json.version`, add the matching top changelog entry, and refresh
  `companion.integrity.json`.
- If you changed any **e-road API** behavior or contract, explicitly verify whether the bundled
  Companion skill in this repository must be updated for those API changes, and update
  `packages/companion-skill/skill/` when the skill-facing workflow, endpoint contract, or docs changed.
  Any such bundled-skill update must include the version/changelog/integrity update above.
- If you changed frontend behavior, include the `agent-browser` validation result in your handoff. The
  minimum smoke path is: signed-out redirect, login, Skills list, filters, detail view, upload drawer,
  mobile viewport, and browser errors.
- Match the surrounding code's style; keep `packages/core`/`providers` framework-free.
- Prefer extending existing contracts in `packages/contracts` over introducing parallel ones.
- PR titles should use Commitizen style, for example `feat(conductor): add isolated local workflows`.
