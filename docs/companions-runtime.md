# Companions runtime

Companion is the control plane; Pi is the only agent harness and runs inside a no-env
[Box](https://box.ascii.dev). The integration uses the Box v1 HTTP API directly and has no Cursor,
OpenCode, or Vercel runtime dependency.

## Control-plane and wake boundary

PostgreSQL stores list/open metadata plus workspace provider connections. Provider credential
payloads are envelope-encrypted in `companion_provider_connections`; ordinary reads expose only the
provider id, authentication method, and timestamps. `GET /v1/companions`,
`GET /v1/companions/:id`, and the default
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
| `PUT` | `/v1/companions/:id/provider` | Never; owner-only, unconfigured Companions only |
| `GET` | `/v1/companions/:id/runtime` | Never |
| `GET` | `/v1/companions/:id/runtime?live=true` | Owner/editor only; observes without resuming |
| `POST` | `/v1/companions/:id/runtime/start` | Creates or resumes Box, then starts Pi |
| `POST` | `/v1/companions/:id/runtime/stop` | Stops Pi, then snapshots/archives Box |
| `POST` | `/v1/companions/:id/runtime/desktop` | Owner/editor only; never resumes Box |
| `GET` | `/v1/companion-providers` | Never |
| `PUT` | `/v1/companion-providers/:provider` | Never; Owner/Admin only |
| `DELETE` | `/v1/companion-providers/:provider` | Never; Owner/Admin only |
| `PUT` | `/v1/companion-providers/default` | Never; Owner/Admin only |

Desktop responses are secret-bearing and are returned only to the authorized caller. They are never
stored. The response advertises `automation: "lux"` so THE-323 can attach the Box desktop/Lux UI
without changing the lifecycle boundary.

## Box disk layout

Box stop archives the disk, so runtime sessions survive stop/resume at:

```text
~/.companion/
├── bin/pi-daemon
├── pi/                    # isolated PI_CODING_AGENT_DIR
│   ├── auth.json          # owner-only Pi API key or refreshable OAuth entry
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

Layout version `2` is written to the control-plane row after a successful Skills/MCP-aware start and
to an on-disk marker keyed by the adapter package. Starts repair older Box snapshots before resource
injection. Runtime transcripts and files do not enter PostgreSQL. A systemd user unit supervises Pi
while Box is active; the lifecycle API restarts it after a Box resume.

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

Adapter JSON contains only transport metadata and `${ENV_KEY}` references. Their values travel in
the start request's `mcp_credentials` array, are written to a transient environment file that the
systemd unit reads, and are removed immediately after Pi inherits them. Every referenced env key
must have a matching `mcp_credentials` entry. Model-provider authentication never uses this channel.
Host-config discovery, MCP sampling, and MCP elicitation are disabled. This gives THE-321 a real
multi-account injection API without adding its Plugins management UI here.

## Provider credentials

Provider management is workspace-scoped and Owner/Admin-only. API keys and one-provider Pi OAuth
entries are encrypted with `COMPANION_SECRETS_MASTER_KEY`; responses, logs, audit metadata, and
Companion rows never contain plaintext. Starting a Companion resolves only its selected provider,
decrypts the credential after the owner/editor wake guard, and writes a minimal owner-only
`~/.companion/pi/auth.json` inside Pi's isolated agent directory before restarting Pi. The start
endpoint accepts no model-provider credentials; its only credential input is the MCP-scoped
`mcp_credentials` array.

Companions created before provider support may have no provider id. Their owner can attach one
connected provider once through `PUT /v1/companions/:id/provider`; this does not contact or wake Box.
After a provider is attached it is immutable, matching the creation flow.

The auth file remains on snapshotted Box disk because Pi must update refreshable subscription
tokens. Reconnecting or disconnecting a provider replaces or removes the control-plane copy; the
next start replaces the Box file with only the selected provider. Later starts preserve Pi's
possibly refreshed OAuth entry until the encrypted connection generation changes or the Companion
is provisioned onto a new Box. A failed daemon start still best-effort removes the transient
`mcp_credentials` environment file.

Subscription setup deliberately reuses Pi's authentication implementation. Run `/login` with the
same pinned Pi version on a trusted machine, then submit only that provider's `{ "type": "oauth",
... }` entry from Pi's `auth.json`. Never submit the whole auth file. API keys are stored as
literal Pi `api_key` entries, so shell-command and environment interpolation are not accepted.

Provider failures use stable codes suitable for the chat surface:
`provider_not_configured`, `provider_auth_invalid`, `provider_auth_expired`, and
`provider_unavailable`. Messages name the provider and the corrective action; raw Pi output and
credential material must remain behind the adapter boundary.

## V1 providers

| Picker label | Pi auth key | Authentication |
|---|---|---|
| Claude | `anthropic` | Anthropic API key or Claude Pro/Max Pi OAuth entry |
| Codex | `openai-codex` | ChatGPT Plus/Pro Pi OAuth entry |
| z.ai | `zai` | z.ai API key, including Coding Plan keys |

The web picker intentionally shows only this short list. The API and storage key use Pi provider
ids and accept any valid lowercase Pi provider id, so another built-in provider can be connected
without a schema change. To add one to the picker:

1. verify its auth-file key and supported auth methods against the pinned Pi `providers.md`;
2. add one entry to `COMPANION_PROVIDER_CATALOG` in `packages/contracts/src/companions.ts`;
3. add contract and Box adapter coverage for its auth entry;
4. update this table.

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

