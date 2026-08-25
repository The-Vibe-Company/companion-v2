# Railway GraphQL API notes

Endpoint used by `railway_status.py`, `railway_logs.py`, and
`railway_restart.py`:

```
POST https://backboard.railway.com/graphql/v2
Content-Type: application/json
```

## Authentication — two header styles

Railway accepts different headers depending on the token kind. The scripts try
(1) first and automatically fall back to (2) on a 401/403 or a
"Not Authorized" GraphQL error:

1. **Personal or team token**

   ```
   Authorization: Bearer <RAILWAY_API_TOKEN>
   ```

2. **Project access token** (scoped to one project + environment)

   ```
   Project-Access-Token: <RAILWAY_API_TOKEN>
   ```

Both use the same `RAILWAY_API_TOKEN` value from `~/.companion-prod.env`; set
whichever kind you provisioned. A project token is the least-privilege choice
for this skill.

## UNVERIFIED schema — needs one live probe

The exact query/mutation shapes below follow Railway's public API v2
documentation but have **not been probed with a real token from this skill
yet**. Field names (`deployments(first:, input: { environmentId })`, `meta`,
`deploymentLogs`, `deploymentRestart`) may differ from the live schema. The
scripts fail closed with an actionable error naming the mismatched path
instead of guessing.

To verify once, with a real token:

```bash
python3 scripts/railway_status.py --json
```

If it fails with a schema-mismatch or GraphQL error, run an introspection
probe (redact the output before sharing):

```bash
# Careful: do NOT paste the token into a transcript. The scripts build the
# header in-process; if you must probe manually, use an env var reference.
python3 - <<'EOF'
import json, sys
sys.path.insert(0, ".claude/skills/debug-companions-prod/scripts")
import prodlib, railway_status
env = prodlib.load_env()
query = '{"query": "query { project(id: \"...\") { __typename } }"}'
EOF
```

then adjust `STATUS_QUERY` / `LOGS_QUERY` / `RESTART_MUTATION` in the scripts
and update this file. Known likely variance points:

- `deployments` filtering may take `input: DeploymentListInput` or flat
  arguments (`environmentId:`) depending on schema version.
- `meta` may be a JSON scalar (object) or a JSON string; `commit_from_meta`
  handles both and searches nested objects for
  `commitHash`/`commitSha`/`commit`.
- `deploymentLogs` may cap `limit` server-side and may name the entries
  `timestamp`/`severity`/`message` differently.
- `deploymentRestart` may return a boolean or an object.

## Queries used

Status (per service, latest 5 deployments in the environment):

```graphql
query CompanionDebugStatus($projectId: String!, $environmentId: String!, $first: Int!) {
  project(id: $projectId) {
    name
    services {
      edges {
        node {
          id
          name
          deployments(first: $first, input: { environmentId: $environmentId }) {
            edges { node { id status createdAt meta } }
          }
        }
      }
    }
  }
}
```

Logs (one deployment):

```graphql
query CompanionDebugLogs($deploymentId: String!, $limit: Int!) {
  deploymentLogs(deploymentId: $deploymentId, limit: $limit) {
    timestamp
    severity
    message
  }
}
```

Restart (mutating — double-gated in `railway_restart.py`; never `release`):

```graphql
mutation CompanionDebugRestart($deploymentId: String!) {
  deploymentRestart(id: $deploymentId)
}
```

## Service topology reminder

From `deploy/railway/README.md`: `web` and `api` are public; `worker` and
`runtime` are private with no inbound route; `release` is a one-shot
owner-migration job and must never be restarted (the restart script refuses
it). Runtime `/healthz` is private — do not try to reach it over the public
internet; use logs and `db_query.py health` instead.
