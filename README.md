<div align="center">

# Companion

### The open hub for your team's AI agents, tools, and skills.

Self-hostable, multi-tenant control plane to **deploy**, **govern**, and **share** AI agents,
curated containers, and skills across your organization — with permissions from day one.

[Vision](docs/vision.md) · [Product](docs/product.md) · [Architecture](docs/design.md) · [PRD](docs/PRD.md) · [Contributing](CLAUDE.md)

`MIT licensed` · `self-host first` · successor to [Companion v1](https://github.com/The-Vibe-Company/companion)

</div>

---

## What is Companion?

Companion v1 turned one operator's laptop into a fleet of personal AI agents — a CLI and
infrastructure-as-code engine (Hermes runtime, Granite memory, OpenRouter, pluggable infra).
It was built for **one person, one workspace**. It has no notion of organizations, teams, users,
or permissions.

**Companion v2 is the team version.** It takes that engine and wraps it in a web portal where an
**Organization → Team → User** hierarchy with RBAC governs every resource. Publish a versioned
skill once, approve a container image once, define an agent template once — and the right people
across your org get **one-click, scoped access**. No shell, no TOML, no infrastructure tickets.

Think *"GitHub for your team's agents"* — but open-source and running on **your** infrastructure.

## The three pillars

| Pillar | What it does | Who governs it |
|---|---|---|
| 🤖 **Hermès Agents** | Deploy curated AI agents (Hermes runtime + Granite memory) into a team and chat with them. | Builders define, members use |
| 📦 **Curated Container Catalog** | One-click deploy of admin-approved images & templates — databases, MCP servers, tools, web UIs. | Org Admins approve, members deploy |
| 🧩 **Skills Hub** | Upload, version, and share `SKILL.md` packages. Attach them opt-in to the agents that should have them. | Anyone publishes, owners attach |

Every agent, container, and skill carries a **visibility scope** — `private` (you), `team`, or
`org` — so sharing is explicit and access is always attributable.

## Why Companion

- **Governed, not chaotic.** Shadow AI tools become a curated, permissioned catalog with an audit trail.
- **Deploy anywhere.** A pluggable provider abstraction targets **local Docker**, **Fly.io Machines**,
  **Kubernetes**, and **Modal** — pick where each resource runs.
- **Open standards.** Built on the open [`SKILL.md`](https://github.com/anthropics/skills) format,
  MCP, and OpenRouter model routing. No lock-in.
- **Self-host first.** Your agents, your secrets, your infra. One command to run it.
- **Open source.** MIT, built in the open, continuing the Companion community.

## Status

> 🚧 **Early / pre-MVP.** This repository currently holds the launch documents. The codebase is
> being scaffolded. Star and watch to follow along — and read the [PRD](docs/PRD.md) for the
> roadmap.

## Quickstart (planned)

The MVP ships as a single self-host bundle:

```bash
git clone https://github.com/The-Vibe-Company/companion-v2
cd companion-v2
docker compose up
# → open http://localhost:3000, the first user becomes Org Owner
```

This brings up Postgres, Redis, object storage (MinIO), the web portal, and the reconcile worker.
Configure a deployment provider (local Docker by default) and a model provider (OpenRouter), then
deploy your first agent. See the [PRD](docs/PRD.md) for the exact MVP scope.

## How it relates to Companion v1

| | Companion v1 | Companion v2 |
|---|---|---|
| Primary user | Single operator | Organizations & teams |
| Interface | CLI + IaC (TOML) | Web portal + API (+ CLI) |
| Access control | None | Org → Team → User, RBAC, scopes |
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
