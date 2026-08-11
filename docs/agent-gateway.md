# Companion agent gateway

`companion-gateway` is an external, local resolver for coding agents. It lets Claude Code and Codex
discover Skills Hub packages without keeping those packages on the machine. Companion remains a
Skills Hub: it neither launches the gateway nor launches or executes an agent.

## Local v1

The gateway reads the existing schema-v3 `~/.companion/credentials.json` index and invokes the
bundled Agent Auth client for each connected workspace. `companion-gateway sync` requests one
immutable catalog snapshot per workspace, merges them, and writes metadata-only proxies to:

- Claude Code: `~/.claude/skills`
- Codex: `~/.agents/skills`

The old Codex `~/.codex/skills` path is treated as a legacy physical-install location; new gateway
proxies use the canonical shared Agent Skills path. Existing unmanaged folders are never overwritten.

Personal skills are always Remote for their creator. Organization skills enter the remote catalog
only after `PUT /v1/skills/{slug}/agent-catalog`. A durable copy reported through
`POST /v1/skills/{slug}/install` is independent. The UI describes the resulting states as Remote,
Local, or Both, under the Added view.

Snapshots default to eight hours and are capped at 24 hours. They contain exact version ids,
dependency closures, frontmatter metadata, transport checksums, and a stateless signed proof per
package—but never the `SKILL.md` body or package files. Package reads revalidate the originating
Agent Auth identity and its exact-workspace `skills:read` grant, membership, personal ownership,
Remote roots, and archive state; disconnect or grant revocation wins over an unexpired proof. The
gateway fails closed when offline or expired.

At resolve time the gateway downloads the exact root and dependency packages into a private
temporary directory, verifies byte count and SHA-256, rejects traversal, links, special files,
case-colliding paths, and Windows-reserved paths, then returns the root directory. Package URLs must
remain on the connected workspace API origin. Proxy ownership is recorded separately under private
Companion state, so an in-folder marker cannot claim an unmanaged directory. The catalog cache is
committed before proxies, so an interrupted sync cannot create an unresolvable new proxy. Stale
temporary sessions are removed on later starts. `companion-gateway run` executes a user-selected command from
that temporary directory. `--env-file` keeps values in the child environment; the explicit
`--legacy-env-file` compatibility option creates a mode-0600 temporary `.env` and removes it after
the child exits.

## Configuration

`~/.companion/gateway.json` contains no credential:

```json
{
  "client_path": "/absolute/path/to/companion-agent-client.mjs",
  "tools": ["claude-code", "codex"],
  "aliases": {
    "workspace-uuid/deploy": "deploy-acme"
  }
}
```

When two visible roots claim the same local name, sync stops before touching native directories.
Resolve it with an explicit `<workspace-id>/<slug>` alias. The gateway also exposes `mcp`, with
catalog sync and exact skill resolve tools, so agents can use the same resolver without shell-specific
integration.

From the repository:

```sh
cd clients/companion-gateway
go test ./...
go build -o companion-gateway .
./companion-gateway sync
```

CI runs tests, vet, and native builds on Linux, macOS, and Windows.

## Deferred phase

Vercel/FUSE support is intentionally not implemented in local v1. After the local resolver is
validated, the same Go binary may gain a `mount` mode for a sandbox launched by an external
integrator. That phase must remain non-persistent (`persistent:false`), use a credential broker and
target-bound short-lived token, and must not add agent launch, sandbox, deployment, or runtime
supervision to Companion.
