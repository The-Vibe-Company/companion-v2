# `companion` CLI

Authenticate to a Companion workspace and install/control the local headless Companion agent.
Skill package validation, publishing, installs, and updates are handled by the bundled Companion skill
and the web UI, not by CLI commands.

## Install / run

```bash
pnpm --filter @companion/cli build
node cli/dist/index.js --help          # or: pnpm --filter @companion/cli dev -- <args>
# (a published build would expose the `companion` bin directly)
```

## Auth

```bash
companion login --url http://127.0.0.1:3001 --email you@example.com
# password is prompted (or pass --password). The session is stored in ~/.companion (mode 600).
companion whoami
companion logout
```

Config + session live in `~/.companion/`. `--profile <name>` keeps multiple instances/orgs separate.
The CLI holds only your user session cookie and API URL. It never receives Postgres, MinIO, or email provider credentials.

## Local agent

```bash
companion agent install
companion agent status
companion agent stop
companion agent start
companion agent run        # foreground daemon loop
companion agent uninstall
```

`agent install` registers the current machine with the selected workspace, stores the one-time
`cmp_dev_…` device token in `~/.companion/agent.json` (mode 600), and on macOS installs a `launchd`
service. The daemon sends heartbeat inventory to `/v1/agent/heartbeat`; it does not execute skills or
containers.

## Commands

| Command | What it does |
|---|---|
| `login` / `logout` / `whoami` | Manage the Better Auth session used by registration and `whoami` |
| `agent install` | Register this machine and install/start the background agent |
| `agent status` | Show local credentials, pid, last heartbeat, and update notification status |
| `agent run` | Run the daemon in the foreground |
| `agent start` / `agent stop` / `agent uninstall` | Manage the macOS `launchd` service |

Add `--json` for machine-readable output on any command.

## Skill workflows

The old `companion skills list/info/versions/validate/push/pull/install/status/sync` commands are
removed. Use the bundled Companion skill for local deterministic skill workflows and the web UI for
reviewing, organizing, and sharing skills.

## Exit codes

`0` ok · `2` usage · `3` auth required/expired · `4` not found · `5` validation failed ·
`6` conflict · `7` permission denied · `8` network/server · `9` agent already running.

## Security

The control-plane CLI never executes untrusted skill scripts or pulled images. The local agent reads
local lockfile/config state and sends status heartbeats; deterministic skill changes still happen in
the bundled Companion skill scripts running on the user's machine.
