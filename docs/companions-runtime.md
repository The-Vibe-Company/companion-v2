# Companions runtime

Companion is the control plane; Pi is the only agent harness and runs inside a no-env
[Box](https://box.ascii.dev). The integration uses the Box v1 HTTP API directly and has no Cursor,
OpenCode, or Vercel runtime dependency.

## Control-plane and wake boundary

PostgreSQL stores only list/open metadata: owner, Box id, last observed Box/Pi state, provider ids,
desktop availability, and timestamps. `GET /v1/companions`, `GET /v1/companions/:id`, and the default
`GET /v1/companions/:id/runtime` read only this projection and never call Box.

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
```

Layout version `1` is stored in the control-plane row. Runtime transcripts and files do not enter
PostgreSQL. A systemd user unit supervises Pi while Box is active; the lifecycle API restarts it
after a Box resume.

## Provider credentials

`POST .../runtime/start` accepts multiple `{ provider, env_key, value }` entries. Values are:

1. validated and kept out of response bodies and control-plane persistence;
2. written through the Box file API to an owner-only transient environment file;
3. inherited by the restarted Pi process; and
4. removed immediately after systemd starts the process.

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

Boxes are always created/resumed with `noEnv: true` and receive only tenant/Companion identifiers.
Preinstall a pinned Pi version in the Box environment/template when possible. Otherwise set a
pinned, operator-controlled install command. The setup fails closed if `pi` remains unavailable.

