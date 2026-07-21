<div align="center">

# Companion

### The open hub for your team's AI agents, tools, and skills.

Self-hostable, multi-tenant control plane to **deploy**, **govern**, and **share** AI agents,
curated containers, and skills across your organization — with permissions from day one.

[Vision](docs/vision.md) · [Product](docs/product.md) · [Architecture](docs/design.md) · [PRD](docs/PRD.md) · [Contributing](CONTRIBUTING.md)

`MIT licensed` · `self-host first` · successor to [Companion v1](https://github.com/The-Vibe-Company/companion)

</div>

---

## What is Companion?

Companion v1 turned one operator's laptop into a fleet of personal AI agents — a CLI and
infrastructure-as-code engine (Hermes runtime, Granite memory, OpenRouter, pluggable infra).
It was built for **one person, one workspace**. It has no notion of organizations, teams, users,
or permissions.

**Companion v2 is the team version.** It takes that engine and wraps it in a web portal where an
**Organization → User** hierarchy with RBAC governs every resource. Publish a versioned
skill once, approve a container image once, define an agent template once — and the right people
across your org get **one-click, permissioned access**. No shell, no TOML, no infrastructure tickets.

Think *"GitHub for your team's agents"* — but open-source and running on **your** infrastructure.

## The three pillars

| Pillar | What it does | Who governs it |
|---|---|---|
| 🤖 **Hermès Agents** | Deploy curated AI agents (Hermes runtime + Granite memory) into a team and chat with them. | Builders define, members use |
| 📦 **Curated Container Catalog** | One-click deploy of admin-approved images & templates — databases, MCP servers, tools, web UIs. | Org Admins approve, members deploy |
| 🧩 **Skills Hub** | Upload, version, and share `SKILL.md` packages. Attach them opt-in to the agents that should have them. | Anyone publishes, owners attach |

Skills live in one of two libraries: private **My Skills** entries owned by their creator, or the
org-wide library editable by every member. A personal skill can be shared one-way to the org and both
libraries are organized with their own label trees.

## Why Companion

- **Governed, not chaotic.** Shadow AI tools become a curated, permissioned catalog with an audit trail.
- **Deploy anywhere.** A pluggable provider abstraction targets **local Docker**, **Fly.io Machines**,
  **Kubernetes**, and **Modal** — pick where each resource runs.
- **Open standards.** Built on the open [`SKILL.md`](https://github.com/anthropics/skills) format,
  MCP, and OpenRouter model routing. No lock-in.
- **Self-host first.** Your agents, your secrets, your infra. One command to run it.
- **Open source.** MIT, built in the open, continuing the Companion community.

## Status

> 🚧 **Early.** The **Skills Hub (Pillar 3)** is implemented as a greenfield self-host slice:
> Postgres + Drizzle, Better Auth, MinIO/S3 storage, a Hono API, a Next.js portal, and the
> `companion` CLI to upload, download, and keep skills up to date. Managed SaaS adds Free/Pro seat
> billing while self-hosted remains fully unlocked without Stripe. Agents and the Container Catalog are stubbed. See
> [Architecture](docs/design.md) for what exists and [PRD](docs/PRD.md) for the roadmap.

## Quickstart — Skills Hub (local)

```bash
pnpm install
pnpm test                                   # fast unit and contract tests
DATABASE_URL=postgres://... pnpm test:integration # critical tenant/Skills/Secrets tests on disposable Postgres

# 1) Full local stack. Needs Docker.
pnpm dev                                    # infra + migrations + seed + API :3001 + worker + web :3000

# 2) CLI
pnpm --filter @companion/cli build
node cli/dist/index.js login --url http://127.0.0.1:3001 --signup --email you@example.com
node cli/dist/index.js skills push examples/skills/incident-summary --everyone
node cli/dist/index.js skills list
node cli/dist/index.js skills pull incident-summary
node cli/dist/index.js skills status        # diff local copies vs the registry
```

`cli/README.md` has the full command + exit-code reference. The self-host target is a single
Docker Compose bundle plus the API, web, worker, and provider services (see the [PRD](docs/PRD.md)).
For a manual split loop, `pnpm compose:up`, `pnpm db:migrate`, `pnpm db:seed`, and `pnpm dev:app`
remain available.

In production, the standard API start script applies pending Drizzle migrations before the server listens.
Railway runs the same migration as an API pre-deploy command so a failed migration never replaces the live
deployment; see the [Railway deployment guide](deploy/railway/README.md) for the three-service and Stripe setup.

### Optional GitHub skill mirrors

Owners and admins can mirror organization skills from **Settings → GitHub**. Self-hosted operators register
their own GitHub App and split its credentials by trust boundary: the API receives the slug, client ID, and
client secret; the worker receives only the App ID and private key. Set `COMPANION_GITHUB_SYNC_ENABLED=true`
on the API only after the worker is configured. Enable user-to-server OAuth and grant **Metadata: read**, **Contents: read/write**, and
**Administration: read/write**; register
`${COMPANION_WEB_URL}/v1/integrations/github/callback` as the callback. Missing API credentials disable the
GitHub panel, while missing worker credentials independently disable the mirror supervisor. Companion never
accepts PATs for this integration and never imports skills from GitHub. The mirror updates only
`.companion-sync.json`, its previously tracked or currently selected `skills/<slug>` folders, and the section of
the root README between `<!-- COMPANION:START -->` and `<!-- COMPANION:END -->`; custom README content and all
other repository files are preserved. A managed repository may have one case-insensitive root `README.md` variant;
it must be a regular UTF-8 file and the merged README must remain at most 1 MiB. Invalid or duplicate markers,
ambiguous README casing, symlinks, invalid UTF-8, and oversized merged content stop synchronization without a commit.
The worker also needs `COMPANION_WEB_URL` so the generated README can link
to Companion previews and brand assets.

### Conductor workspaces

Conductor's Run button calls `bash scripts/dev-conductor.sh` — a **native, Docker-free** launcher
(modeled on `~/Dev/monkapps`). It starts a per-workspace Postgres cluster, plus optional native MinIO
and Mailpit, under `.conductor-pg/`, applies migrations, seeds the test user, then runs the API + worker + web
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
| Interface | CLI + IaC (TOML) | Web portal + API (+ CLI) |
| Access control | None | Org → User, RBAC, personal + org skill libraries |
| State | Local SQLite + files | Postgres, multi-tenant |
| Deploy targets | Fly.io | Docker · Fly · Kubernetes · Modal |
| Skills | Ad-hoc | Versioned registry + opt-in attach |
| Containers | Hand-written config | Admin-approved 1-click catalog |

v1 stays a first-class, supported path — Companion v2 keeps an API/CLI surface and aims to offer an
import bridge for existing fleets.

## Documentation

- **[Vision](docs/vision.md)** — why this exists and the bet we're making.
- **[Product](docs/product.md)** — personas, positioning, journeys, the three pillars.
- **[Architecture](docs/design.md)** — data model, RBAC, provider abstraction, runtime.
- **[PRD](docs/PRD.md)** — MVP scope, requirements, roadmap, metrics, risks.
- **[CLAUDE.md](CLAUDE.md)** — guide for contributors and Claude Code agents.

## License

[MIT](LICENSE) © The Vibe Company and contributors.
