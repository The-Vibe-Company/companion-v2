# Companions runtime

Companion is the control plane; Pi is the only agent harness and runs inside a no-env
[Box](https://box.ascii.dev). The integration uses the Box v1 HTTP API directly and has no Cursor,
OpenCode, or Vercel runtime dependency.

## Control-plane and wake boundary

PostgreSQL stores only list/open metadata: owner, Box id, last observed Box/Pi state, provider ids,
desktop availability, and timestamps. `GET /v1/companions`, `GET /v1/companions/:id`, and the default
`GET /v1/companions/:id/runtime` read only this projection and never call Box.

Lifecycle claims are conditional updates. A claim abandoned by a crashed API process becomes
retryable after five minutes; starts recover a Box by its deterministic `Companion <uuid>` name
before creating another one, following every Box-list page. A new Box initially gets a maximum
five-minute TTL; only after its id is durable does the adapter apply the configured TTL and name.
If the id cannot be persisted, the adapter best-effort archives the Box immediately.

The current access projection is owner or viewer. Lifecycle, live status, and desktop routes call
`getCompanionForRuntime` first and permit only owner/editor access. Editors are reserved for
THE-322's share grants; until those grants exist only the creator is an owner and every other
organization member is a no-wake viewer.

Runtime starts identify their client surface as `web`, `mobile_web`, or `native_mobile`. Web and
mobile-web starts resolve the actor's Installed library (personal skills they own plus organization
skills they installed) and inject only valid current packages. Native-mobile starts always inject
an empty skill set. This is enforced by the API and again by the Box adapter before Pi is restarted.

| Method | Path | Box contact |
|---|---|---|
| `POST` | `/v1/companions` | Never |
| `GET` | `/v1/companions` | Never |
| `GET` | `/v1/companions/:id` | Never |
| `GET` | `/v1/companions/:id/runtime` | Never |
| `GET` | `/v1/companions/:id/runtime?live=true` | Owner/editor only; observes without resuming |
| `POST` | `/v1/companions/:id/runtime/start` | Creates or resumes Box, then starts Pi |
| `POST` | `/v1/companions/:id/runtime/stop` | Stops Pi, then snapshots/archives Box |
| `POST` | `/v1/companions/:id/runtime/desktop` | Owner/editor only; never resumes Box |

Desktop responses are secret-bearing and are returned only to the authorized caller. They are never
stored. The response advertises `automation: "lux"` so THE-323 can attach the Box desktop/Lux UI
without changing the lifecycle boundary.

## Box disk layout

Box stop archives the disk, so runtime sessions survive stop/resume at:

```text
~/.companion/
├── bin/pi-daemon
├── pi/
│   └── mcp.json           # pi-mcp-adapter config; environment references only
└── runtime/
    ├── skills/            # exact current packages exposed through Pi native Skills
    ├── sessions/          # Pi session tree files (`pi --session-dir`)
    ├── state/
    │   ├── mcp-accounts.json # account ids, labels, adapter names, and transports
    │   ├── skills.json    # injected surface/version/checksum projection
    │   └── pi.rpc.in      # owner-only FIFO for the Pi JSON RPC stream
    └── logs/
        ├── pi.rpc.ndjson  # Pi JSON RPC output
        └── pi.stderr.log
```

Layout version `1` is stored in the control-plane row. Runtime transcripts and files do not enter
PostgreSQL. A systemd user unit supervises Pi while Box is active; the lifecycle API restarts it
after a Box resume.

## Pi Skills injection

Pi starts with `--no-skills` so ambient Box or package skills cannot leak into a Companion. For a
web or mobile-web start, the API:

1. resolves the authorized actor's Installed library in the tenant transaction;
2. reads each exact current archive from object storage;
3. stages the archives through the Box file API and extracts them into a replacement
   `~/.companion/runtime/skills` tree;
4. starts Pi with that tree as an explicit repeatable native `--skill` source.

The replacement is prepared before the old tree is swapped, and invalid, archived, unpublished,
or inaccessible packages are excluded. The browser chat consumes Pi's normal Skills capability;
Companion does not add Pi tool/skill chrome inside the thread. Native mobile receives no skill
archives or `--skill` source even if a caller supplies stale client state.

## MCP adapter injection

The Box setup installs the pinned `pi-mcp-adapter` package into the isolated
`PI_CODING_AGENT_DIR`. `POST .../runtime/start` accepts up to 50 labeled MCP accounts. Each account
has a stable Companion id, a user-facing label, and either an HTTP or stdio transport. Companion
maps the label plus a stable id digest to a unique adapter server name, so multiple accounts for
one MCP provider cannot collide.

Adapter JSON contains only transport metadata and `${ENV_KEY}` references. Values use the same
transient credential environment file as model-provider credentials: Pi inherits them, then the
file is removed. Host-config discovery, MCP sampling, and MCP elicitation are disabled. This gives
THE-321 a real multi-account injection API without adding its Plugins management UI here.

## Provider credentials

`POST .../runtime/start` accepts multiple `{ provider, env_key, value }` entries. Values are:

1. validated and kept out of response bodies and control-plane persistence;
2. written through the Box file API to an owner-only transient environment file;
3. inherited by the restarted Pi process; and
4. removed immediately after systemd starts the process.

If the start command transport fails after the file write, the adapter makes a separate
best-effort removal call before returning the error.

Only provider ids are persisted. THE-324 can resolve subscriptions/secrets and send the same input
without changing the Box adapter. Credential values must be single-line and environment keys must
be unique.

## Configuration

`COMPANION_BOX_API_KEY` is required for live lifecycle calls. Missing credentials produce a
configuration error without fabricating a Box.

Optional settings:

- `COMPANION_BOX_API_BASE` (default `https://ascii.dev/api/box/v1`)
- `COMPANION_BOX_ENVIRONMENT`
- `COMPANION_BOX_TTL_SECONDS` (default `3600`)
- `COMPANION_BOX_POLL_INTERVAL_MS` (default `1000`)
- `COMPANION_BOX_READY_TIMEOUT_MS` (default `120000`)
- `COMPANION_PI_INSTALL_COMMAND`
- `COMPANION_PI_MCP_ADAPTER_PACKAGE` (default pinned to `npm:pi-mcp-adapter@2.12.1`)

Boxes are always created/resumed with `noEnv: true` and receive only tenant/Companion identifiers.
Preinstall pinned Pi and MCP adapter versions in the Box environment/template when possible.
Otherwise set a pinned, operator-controlled Pi install command; the setup installs the configured
adapter package and fails closed if either dependency is unavailable.

