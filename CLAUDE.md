# CLAUDE.md

Guidance for Claude Code agents and human contributors working in this repository.

## Project overview

**Companion v2** is an open-source (MIT), self-hostable, multi-tenant **skills registry** to publish,
govern, version, share, and install AI skills (`SKILL.md` packages) across an organization and its
teams. It is the team edition of [Companion v1](https://github.com/The-Vibe-Company/companion),
rehomed around an **Organization → Team → User** hierarchy with RBAC and workspace-local visibility.

Read these before making non-trivial changes:
- [`docs/vision.md`](docs/vision.md) — why this exists, principles, non-goals.
- [`docs/product.md`](docs/product.md) — personas, the Skills Hub, journeys, access model.
- [`docs/design.md`](docs/design.md) — **authoritative architecture**: data model, RBAC, auth,
  onboarding, public API. *(Maintained by the core team — treat it as the source of truth and keep it
  in sync with the code.)*
- [`docs/PRD.md`](docs/PRD.md) — MVP scope, requirements, roadmap, metrics.

> **Status:** Skills Hub in flight (post-MVP slice shipped). The registry, RBAC, workspace visibility,
> dependencies, discussion, archive, companion skill, CLI, and PAT tokens are implemented end-to-end.
> Agents, the Container Catalog, providers, Temporal, and reconcile loops are **not in scope**
> (abandoned or exploration — see [`docs/vision.md`](docs/vision.md#where-were-heading-exploration-not-a-commitment)).

## The Skills Hub (domain vocabulary — keep it consistent)

The product is the **Skills Hub**: a versioned, governed registry of `SKILL.md` packages, with
one-click install and update detection on each member's assistants.

Canonical terms — **do not invent synonyms**:
- Hierarchy: **Organization → Team → User**.
- Org roles: **Owner, Admin, Member** (plus optional **Guest** for read-only on explicitly shared
  resources). *Note: the DB enum still uses the legacy `developer` value for Member — to be renamed.*
- Team roles: **Admin, Editor, Reader**.
- Skill visibility: **Private** is derived from `everyone=false` and no team shares; **Everyone** means
  every member of the current workspace; team shares are explicit and can be combined with Everyone.
- Skill ownership: a skill is owned by a user unless `owner_team_id` is set; owner-team Admins/Editors
  can modify that skill. Team visibility shares do not grant write access.
- **Target assistants**: any assistant that supports the open `SKILL.md` standard (Claude Code, Codex,
  Cursor, …). Companion is assistant-agnostic; it does not run a runtime of its own.

## Repository layout

```
apps/
  web/                # Next.js App Router — UI, calls the API (never Postgres or MinIO directly)
  api/                # Hono backend: Better Auth under /auth/*, REST under /v1/*, tRPC under /trpc/*
packages/
  db/                 # Drizzle schema, migrations, seeds  ← data source of truth
  auth/               # Better Auth config
  core/               # framework-free domain services: RBAC (authz.ts), scoping, onboarding
  storage/            # S3/MinIO wrapper for skill archives
  email/              # Mailpit/log/Resend providers
  contracts/          # shared Zod schemas + types (consumed by web, api, cli)
  skills/             # SKILL.md parse / validate / version / pack / unpack
  companion-skill/    # built-in helper skill: upload, validate, update detection
cli/                  # `companion` CLI — talks REST
docs/                 # vision / product / design / PRD
```

**Anchor files** (the contracts the system hinges on — see `docs/design.md`):
- `packages/db/src/schema.ts` — all entities + the `org_id` / visibility / `owner_id` / `owner_team_id`
  columns and the team-share / dependency / archive / install-tracking tables.
- `packages/core/src/authz.ts` — typed RBAC: visibility gate + capability gate.
- `packages/core/src/services.ts` — service-layer entrypoints; the **single enforcement path** for
  web, REST, and CLI.
- `packages/skills/src/validateSkill.ts` + `frontmatter.ts` — SKILL.md validation + frontmatter schema.
- `packages/contracts/src/skill.ts` — shared Zod schemas (read/write shapes, dependency plan, etc.).
- `packages/companion-skill/` — the bundled `companion` skill (manifest + packaged `SKILL.md`).
- `apps/api/src/index.ts` — Hono app, Better Auth mount, public REST + tRPC surface.

## Conventions & invariants

- **Stack:** TypeScript everywhere, pnpm workspaces + Turborepo, **Drizzle ORM** (not Prisma),
  **Better Auth** for auth (email/password + 6-digit OTP verification + Google OAuth), **Hono** for the
  API (REST + tRPC), Next.js App Router for the web, S3-compatible object storage (MinIO in compose),
  and Resend for production email. Redis/BullMQ and Temporal are intentionally excluded.
- **`packages/core` must not depend on Next.js** — the CLI imports it directly.
- **One source of truth for types:** entities live in `packages/db`; shared contracts in
  `packages/contracts`. Don't redefine shapes ad hoc.
- **Visibility × role are orthogonal.** Authorization = a **visibility gate** (can the actor see it?)
  **plus** a **capability gate** (can the actor do it?). Enforce in the **service layer**
  (`packages/core`) so web, REST, and the CLI share one path — never only in route handlers.
- **Ownership, visibility, and provenance are distinct:** `owner_id` / `owner_team_id` (who can edit),
  visibility state/share rows (who can read), and `creator_id` / audit (who acted).
- **Security boundary (non-negotiable):** the control plane **never executes** untrusted skill
  scripts. All such execution happens inside the user's assistant, never on the server. Skill
  `requirements` (secrets/env) are **declarations and install notes only — never secret values**;
  secrets themselves are envelope-encrypted and write-only over the API when they are introduced.
- **Multi-tenancy:** every row carries `org_id`; add Postgres row-level security as defense-in-depth.
  Any new query must be scoped to the tenant.
- **Frontend must follow [`DESIGN.md`](DESIGN.md).** Any UI, styling, copy, component, layout, or
  interaction change must respect the root `DESIGN.md` visual contract and keep design tokens, product
  tone, accessibility, and absolute bans intact.

## Development workflow

```bash
pnpm compose:up             # postgres + minio + mailpit for manual local dev
pnpm db:migrate             # apply Drizzle migrations
pnpm db:seed                # seed an org/team/user for local dev
pnpm dev                    # full stack: infra + migrations + seed + API :3001 + web :3000
pnpm dev:app                # app-only loop when infra is already prepared
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

- **RBAC is table-driven and exhaustive.** Add cases to the role × visibility × action matrix whenever
  you touch authorization; assert cross-tenant access is denied.
- **Frontend browser validation is required after frontend changes.** After any UI, route, auth, style,
  component, or browser-facing behavior change, run the app and validate it with `agent-browser` before
  finishing. Use the automated shortcut `APP_URL=http://127.0.0.1:<port> pnpm browser:smoke` for the
  core flow, and add manual `agent-browser` checks for any changed or risky path.
- **`DESIGN.md` follows the Google Design.md format.** Any change to the root `DESIGN.md` must pass
  `npx --yes @google/design.md@0.2.0 lint DESIGN.md --format json`; CI runs this automatically when
  `DESIGN.md` changes.
- **Skill validation is table-driven.** When you touch `packages/skills` (frontmatter, manifest,
  packing, dependency resolution), extend the validation tests with valid + invalid fixtures and assert
  the dependency plan (declared / already-published / must-upload / removed / archival candidates).

## When you finish a change

- If you changed architecture, the data model, RBAC, the install flow, or the public API, **update
  [`docs/design.md`](docs/design.md)** (and this file's anchors if paths moved). Keep the docs and the
  code in agreement.
- If you changed frontend behavior, include the `agent-browser` validation result in your handoff. The
  minimum smoke path is: signed-out redirect, login, Skills list, filters, detail view, upload drawer,
  mobile viewport, and browser errors.
- Match the surrounding code's style; keep `packages/core` framework-free.
- Prefer extending existing contracts in `packages/contracts` over introducing parallel ones.
- PR titles should use Commitizen style, for example `feat(skills): change skill visibility with dependency cascade`.
