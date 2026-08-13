# Companion v2

Companion v2 is an open-source, self-hostable, multi-tenant **Skills Hub** for organizations and the coding agents their members already use.

It manages personal and organization `SKILL.md` libraries, labels, safe uploads, validation, immutable versions, dependencies, comments, installs and updates, public releases, GitHub synchronization, write-only skill secrets, and hosted Skill Databases.

Companion does **not** create, launch, run, resume, chat with, or deploy agents. External coding agents connect as delegated Skills Hub clients through Agent Auth.

## Product model

- Hierarchy: **Organization → User**
- Roles: **Owner, Admin, Developer**
- Libraries: private **My Skills** (`personal`) and shared organization skills (`org`)
- Organization skills are manageable by every member.
- Personal skills are creator-only, including against admins.
- **Share** is the one-way, owner-only `personal → org` transition.
- Labels organize each library; install rows track organization skills used by a member.

## Repository

```text
apps/web       Next.js Skills workspace
apps/api       REST/tRPC API
apps/worker    GitHub, billing, and Skill Database maintenance
cli            Companion skill CLI
packages/      auth, billing, contracts, core, db, skills, skilldb, storage, GitHub
docs/          product and architecture
deploy/        self-hosted and Railway deployment
```

See [vision](docs/vision.md), [product](docs/product.md), [architecture](docs/design.md), [PRD](docs/PRD.md), and [testing](docs/testing.md).

## Local development

Requirements: Node.js 20+, pnpm 9, PostgreSQL, and optionally MinIO/Mailpit.

```bash
corepack enable
pnpm install
cp .env.example .env
pnpm compose:up
pnpm db:migrate
pnpm db:seed
pnpm dev
```

Conductor uses `.conductor/settings.toml` and `bash scripts/dev-conductor.sh` for isolated native services.

### Companions runtime

Companions are disabled by default. To expose the authenticated list/create shell, workspace
provider connections, and control-plane API, set the same server-side flag for both web and API,
then restart:

```bash
COMPANION_COMPANIONS_ENABLED=true
# Required exact-domain allowlist (comma-separated and case-insensitive):
COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=thevibecompany.co
```

With the flag unset or `false`, `/companions`, `/v1/companions`, and `/v1/companion-providers`
return not found and no Companions navigation is rendered. The harness remains API-only: the web
shell has a compact provider picker but no Pi, runtime, or desktop controls.
The same fail-closed behavior applies when the flag is `true` but the allowlist is unset or empty.
With both values configured, users need an exact matching email domain. Missing or malformed emails
are always denied.

Configured Owner/Editor lifecycle calls use Pi inside a no-env [Box](https://box.ascii.dev). Set:

```bash
COMPANION_BOX_API_KEY=box_...
# Optional overrides:
COMPANION_BOX_API_BASE=https://ascii.dev/api/box/v1
COMPANION_BOX_ENVIRONMENT=base
COMPANION_BOX_TTL_SECONDS=3600
COMPANION_PI_INSTALL_COMMAND='npm install --global @earendil-works/pi-coding-agent@<pin>'
COMPANION_PI_MCP_ADAPTER_PACKAGE=npm:pi-mcp-adapter@2.12.1
```

Prefer a Box environment/template with Pi already pinned and omit the install command. Never put
provider credentials in these variables; workspace model-provider credentials are
envelope-encrypted and only the selected Pi auth entry is delivered to Box. Web and mobile-web
lifecycle starts inject the actor's valid Installed packages as native Pi Skills. Native-mobile
starts inject no skills. Labeled MCP accounts are accepted by the same start API and converted to
adapter config with environment references only, while their values travel in the transient
`mcp_credentials` channel. See `docs/companions-runtime.md`.

## Verification

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm verify:change
APP_URL=http://127.0.0.1:3000 pnpm browser:smoke
```

License: MIT.
