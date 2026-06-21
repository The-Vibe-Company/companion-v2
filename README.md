<div align="center">

# Companion

### Where teams share and govern their AI skills.

Self-hostable, multi-tenant registry to **publish**, **version**, **share**, and **install** AI skills
across your organization — governed from day one.

[Vision](docs/vision.md) · [Product](docs/product.md) · [Architecture](docs/design.md) · [PRD](docs/PRD.md) · [Contributing](CLAUDE.md)

`MIT licensed` · `self-host first` · successor to [Companion v1](https://github.com/The-Vibe-Company/companion)

</div>

---

## What is Companion?

Companion v1 turned one operator's laptop into a personal AI agent fleet — a CLI and
infrastructure-as-code engine. It was built for **one person, one workspace**. It has no notion of
organizations, teams, users, or permissions.

**Companion v2 is the team version.** Same mission — give a team governed access to AI capabilities —
pivoted to where the value actually compounds today: **skills**. It is a web portal where an
**Organization → Team → User** hierarchy with RBAC governs every published `SKILL.md` package.
Publish a versioned skill once, set its visibility once — and the right people across your org get
**one-click install and automatic update detection** on their assistants. No shell, no TOML, no
copy-pasted folders.

Think *"GitHub for your team's AI skills"* — open-source and running on **your** infrastructure.

## The Skills Hub

The Skills Hub is both a **registry** (publish, version, browse, share) and a **delivery mechanism**
(one-click install on each member's machine, with update detection).

- **Validate & version.** A `SKILL.md` package is validated on upload; a valid upload produces an
  immutable, checksummed, semver-tagged version.
- **Workspace visibility.** **Private** by default, **Everyone** for the whole workspace, and optional
  team shares for one or more teams. Everyone is organization-local; there is no internet-wide or
  cross-org visibility.
- **Ownership is separate from visibility.** A skill is owned by a user or by a team; team-owned
  skills can be edited by that team's Admins and Editors. Visibility only decides who can read.
- **Dependencies.** A version may declare required skills (slugs); missing, cyclic, or
  visibility-mismatched edges hard-block publishing.
- **Discussion & archive.** Threaded discussion per skill (optionally pinned to a version); soft
  archive keeps skills restorable and downloadable while anything still references them.
- **Companion skill.** A built-in helper that uploads, validates, analyzes dependencies, and checks
  which of a user's installed skills are out of date against the registry.

## Why Companion

- **Governed, not chaotic.** Shadow prompt folders and scattered repos become a curated, permissioned
  registry with an audit trail.
- **Assistant-agnostic.** A skill is a portable asset — it works with any assistant that supports the
  open [`SKILL.md`](https://github.com/anthropics/skills) standard: Claude Code, Codex, Cursor, and
  what comes next.
- **Open standards.** Built on `SKILL.md` and MCP. No lock-in.
- **Self-host first.** Your skills, your secrets, your infra. One command to run it.
- **Open source.** MIT, built in the open, continuing the Companion community.

## Status

> 🚧 **Early — Skills Hub shipped.** The registry, RBAC, workspace visibility, dependencies,
> discussion, archive, companion skill, CLI, and PAT tokens are implemented end-to-end on Postgres +
> Drizzle, Better Auth, MinIO/S3, a Hono API, a Next.js portal, and the `companion` CLI.
> **Agents and the Container Catalog are abandoned** in favor of the skills wedge; hosted
> opencode-based agents are an **exploration** (not a commitment). See
> [Architecture](docs/design.md) for what exists and [PRD](docs/PRD.md) for the roadmap.

## Quickstart — Skills Hub (local)

```bash
pnpm install
pnpm test                                   # shared packages: validation + authz matrix

# 1) Full local stack. Needs Docker.
pnpm dev                                    # infra + migrations + seed + API :3001 + web :3000

# 2) CLI
pnpm --filter @companion/cli build
node cli/dist/index.js login --url http://127.0.0.1:3001 --signup --email you@example.com
node cli/dist/index.js skills push examples/skills/incident-summary --everyone
node cli/dist/index.js skills list
node cli/dist/index.js skills pull incident-summary
node cli/dist/index.js skills status        # diff local copies vs the registry
```

`cli/README.md` has the full command + exit-code reference. The self-host target is a single Docker
Compose bundle plus the API and web services (see the [PRD](docs/PRD.md)). For a manual split loop,
`pnpm compose:up`, `pnpm db:migrate`, `pnpm db:seed`, and `pnpm dev:app` remain available.

In production, the API start script applies pending Drizzle migrations before the server listens. If
migrations fail, startup fails rather than serving newer code against an older database schema.

### Conductor workspaces

Conductor's Run button calls `bash scripts/dev-conductor.sh` — a **native, Docker-free** launcher
(modeled on `~/Dev/monkapps`). It starts a per-workspace Postgres cluster, plus optional native MinIO
and Mailpit, under `.conductor-pg/`, applies migrations, seeds the test user, then runs the API + web
with `concurrently`. All ports derive from `CONDUCTOR_PORT` (fallback `3000` outside Conductor):

| Service | Port |
|---|---|
| Web | `CONDUCTOR_PORT` |
| API | `CONDUCTOR_PORT + 1` |
| Postgres | `CONDUCTOR_PORT + 2` |
| MinIO API | `CONDUCTOR_PORT + 3` |
| MinIO console | `CONDUCTOR_PORT + 4` |
| Mailpit SMTP | `CONDUCTOR_PORT + 5` |
| Mailpit UI | `CONDUCTOR_PORT + 6` |

Auth cookies are namespaced with a `companion-<workspace>` prefix so sessions never leak between
workspaces. If `minio`/`mailpit` aren't installed (the `setup` step best-effort `brew install`s them),
the stack still runs — S3 uploads are disabled and email falls back to `EMAIL_PROVIDER=log`. A cleanup
trap stops every native service on Ctrl+C. Archiving a workspace runs
`bash scripts/dev-conductor.sh archive`, which stops the services and removes `.conductor-pg/`.

The non-Conductor `pnpm dev` path is unchanged and still uses Docker Compose (`scripts/dev-stack.sh`).

## How it relates to Companion v1

| | Companion v1 | Companion v2 |
|---|---|---|
| Primary user | Single operator | Organizations & teams |
| Interface | CLI + IaC (TOML) | Web portal + API + CLI |
| Access control | None | Org → Team → User, RBAC, workspace visibility |
| State | Local SQLite + files | Postgres, multi-tenant |
| Skills | Ad-hoc, per fleet | Versioned registry + dependencies + discussion + archive |
| Target assistants | One fixed runtime | Any `SKILL.md`-compatible assistant (Claude Code, Codex, Cursor, …) |
| Install | Manual file copies | One-click install + auto-update detection per machine |
| Governance | None | Ownership, visibility, and audit fully separated |

v2 inherits v1's mission and brand, and keeps an API/CLI surface so the existing 2.4k-star community
feels at home. The implementation pivots from a personal runtime to a team skills registry.

## Documentation

- **[Vision](docs/vision.md)** — why this exists and the bet we're making.
- **[Product](docs/product.md)** — personas, positioning, journeys, the Skills Hub.
- **[Architecture](docs/design.md)** — data model, RBAC, auth, onboarding, public API.
- **[PRD](docs/PRD.md)** — MVP scope, requirements, roadmap, metrics, risks.
- **[CLAUDE.md](CLAUDE.md)** — guide for contributors and Claude Code agents.

## License

[MIT](LICENSE) © The Vibe Company and contributors.
