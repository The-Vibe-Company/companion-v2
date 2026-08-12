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
└── runtime/
    ├── sessions/          # Pi session tree files (`pi --session-dir`)
    ├── state/
    │   └── pi.rpc.in      # owner-only FIFO for the Pi JSON RPC stream
    └── logs/
        ├── pi.rpc.ndjson  # Pi JSON RPC output
        └── pi.stderr.log
~/.pi/agent/
└── auth.json             # owner-only Pi API key or refreshable OAuth entry
```

Layout version `1` is stored in the control-plane row. Runtime transcripts and files do not enter
PostgreSQL. A systemd user unit supervises Pi while Box is active; the lifecycle API restarts it
after a Box resume.

## Provider credentials

Provider management is workspace-scoped and Owner/Admin-only. API keys and one-provider Pi OAuth
entries are encrypted with `COMPANION_SECRETS_MASTER_KEY`; responses, logs, audit metadata, and
Companion rows never contain plaintext. Starting a Companion resolves only its selected provider,
decrypts the credential after the owner/editor wake guard, and writes a minimal owner-only
`~/.pi/agent/auth.json` to Box before restarting Pi. Direct credentials are rejected by the start
endpoint.

The auth file remains on snapshotted Box disk because Pi must update refreshable subscription
tokens. Reconnecting or disconnecting a provider replaces or removes the control-plane copy; the
next start replaces the Box file with only the selected provider. Later starts preserve Pi's
possibly refreshed OAuth entry until the encrypted connection generation changes. A failed
daemon-start transport best-effort removes a just-written auth file.

Subscription setup deliberately reuses Pi's authentication implementation. Run `/login` with the
same pinned Pi version on a trusted machine, then submit only that provider's `{ "type": "oauth",
... }` entry from `~/.pi/agent/auth.json`. Never submit the whole auth file. API keys are stored as
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

Boxes are always created/resumed with `noEnv: true` and receive only tenant/Companion identifiers.
Preinstall a pinned Pi version in the Box environment/template when possible. Otherwise set a
pinned, operator-controlled install command. The setup fails closed if `pi` remains unavailable.

