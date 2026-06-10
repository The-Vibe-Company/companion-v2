# `companion` CLI

Upload, download, and keep your `SKILL.md` packages up to date against a Companion API registry.
TypeScript/Node; shares the exact validation + packaging code (`@companion/skills`) with the web portal.

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

## Commands

| Command | What it does |
|---|---|
| `skills list [--visibility private\|team\|everyone] [--mine]` | List registry skills you can see |
| `skills info <name>` | Show a skill's metadata |
| `skills versions <name>` | Immutable version history |
| `skills validate <dir>` | Validate a local package — offline, no network |
| `skills push <dir> [--owner-team slug --private --everyone --team slug --bump patch\|minor\|major --set-version --message --dry-run]` | Validate → package → upload → publish an immutable version |
| `skills pull <name>[@version] [--dir --force]` | Download + unpack a skill; record it in `companion.lock` |
| `skills status [--exit-code]` | Diff tracked skills vs the registry and your working tree |
| `skills sync [--dry-run --force]` | Fast-forward outdated, unpinned, unmodified skills |

Add `--json` for machine-readable output on any command.

## Keeping skills up to date

Pulled/pushed skills are tracked in a committed **`companion.lock`** (pin, resolved version, checksum).
`status` classifies each tracked skill by comparing three checksums — the local working tree, the lock
baseline, and the registry target (resolved from its pin):

`up-to-date` · `outdated` · `modified` · `conflict` · `pinned` · `not-published` · `missing`

`sync` fast-forwards `outdated` clean skills and **never** clobbers `modified`/`conflict` ones (use
`--force` to override). Exact pins never move; ranges (`^1.4.0`) move within range; unpinned floats to current.

## Exit codes

`0` ok · `2` usage · `3` auth required/expired · `4` not found · `5` validation failed ·
`6` conflict / immutability (version exists, downgrade, local changes) · `7` permission denied ·
`8` network/server · `9` drift detected (`status --exit-code`).

## Security

Validation is **metadata-only** — the CLI never executes a script in a package. Packing rejects
symlinks and enforces size caps; unpacking verifies the published `sha256` and re-applies
traversal/symlink guards before writing.
