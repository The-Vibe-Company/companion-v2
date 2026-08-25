# Railway deployment

Companion runs as four long-lived application services, one one-shot release job, and managed
dependencies:

| Service | Config | Responsibility | Network |
| --- | --- | --- | --- |
| `web` | `web.railway.json` | Next.js UI | Public |
| `api` | `api.railway.json` | Auth, REST/tRPC, durable runtime intent | Public |
| `worker` | `worker.railway.json` | GitHub, billing, Skill Database cleanup, Companion routines | Private, no inbound route |
| `runtime` | `runtime.railway.json` | Sole Box/Pi owner and Runtime v2 executor | Private, no public domain |
| `release` | `release.railway.json` | Owner-only migrations and grant cutover, then exit | One-shot, no route |

PostgreSQL, S3-compatible object storage, and the configured email provider are dependencies. Keep
all four services, the release job, and PostgreSQL in the same Railway project and environment so
API can use Railway's private network for the runtime desktop request. Runtime and release must not
have Public Networking or a TCP proxy enabled.

The backend Dockerfile selects `@companion/api`, `@companion/worker`, or `@companion/runtime` from
Railway's `RAILWAY_SERVICE_NAME`; `release` deliberately packages the API's migration entrypoints
without starting its HTTP server. Name the services exactly `api`, `worker`, `runtime`, and
`release`, or set the build argument explicitly.

## Credential boundary

Do not paste one combined `.env` into every service. Railway exposes service variables to builds and
deployments, so scope each secret deliberately:

| Variable or credential | web | api | worker | runtime | release |
| --- | :---: | :---: | :---: | :---: | :---: |
| Companions flag and email allowlist | yes | yes | no | yes | no |
| API PostgreSQL URL | no | yes | no | no | no |
| Worker PostgreSQL URL | no | no | yes | no | no |
| Runtime PostgreSQL URL | no | no | no | yes | no |
| Migration-owner URL and role names | no | **never** | no | no | yes |
| `COMPANION_BOX_API_KEY` and Box/Pi tuning | no | **never** | **never** | yes | no |
| Runtime desktop HMAC secret | no | yes | no | yes | no |
| Secrets envelope master key | no | yes | no | yes | no |
| S3 Skill archive access | no | read/write | cleanup as required | read-only | historical cutover only |
| GitHub MCP OAuth client id/secret | no | yes | no | yes | no |
| GitHub App private key / billing worker secrets | no | no | yes | no | no |

Use sealed values for provider, database, HMAC, envelope, OAuth, S3, email, and billing secrets.
Generate `COMPANION_RUNTIME_DESKTOP_HMAC_SECRET` independently from
`COMPANION_SECRETS_MASTER_KEY`; both are base64 encodings of 32 random bytes. Share the HMAC only
with API and runtime.

The long-lived/current `release` job has no S3 credential. The table's historical-cutover exception
means an operator may attach matching S3 access only to an ephemeral maintenance execution while
settling pre-0063 storage obligations below, then must remove it before restoring the normal release
entrypoint.

The GitHub MCP OAuth client id and secret also belong on API and runtime. API owns the browser OAuth
flow; runtime uses the same deployment credential only to refresh an expiring encrypted MCP account
immediately before staging. Runtime must not write either value into Box files or Pi environment.
Define both once as Railway shared variables, then reference them from both services:

```dotenv
COMPANION_MCP_GITHUB_CLIENT_ID=${{shared.COMPANION_MCP_GITHUB_CLIENT_ID}}
COMPANION_MCP_GITHUB_CLIENT_SECRET=${{shared.COMPANION_MCP_GITHUB_CLIENT_SECRET}}
```

Never keep independent direct copies: API performs the initial exchange, while runtime must present
the exact same OAuth App credential during refresh. After correcting drift, redeploy runtime and
send a new message; a previously failed turn remains terminal and must not be replayed. If the client
id itself changed, restore the OAuth App that issued existing grants or reconnect GitHub in Plugins:
sharing a new id cannot refresh a grant issued to the old client.

### Runtime private address

Set these service variables:

```dotenv
# api
COMPANION_RUNTIME_PRIVATE_URL=http://${{runtime.RAILWAY_PRIVATE_DOMAIN}}:${{runtime.PORT}}
COMPANION_RUNTIME_DESKTOP_HMAC_SECRET=${{shared.COMPANION_RUNTIME_DESKTOP_HMAC_SECRET}}

# runtime
PORT=3007
COMPANION_RUNTIME_HOST=::
COMPANION_RUNTIME_DESKTOP_HMAC_SECRET=${{shared.COMPANION_RUNTIME_DESKTOP_HMAC_SECRET}}
```

Use HTTP for Railway private networking. Define `PORT` explicitly on runtime because a cross-service
`${{runtime.PORT}}` reference resolves a service variable, not Railway's dynamically injected port.
Do not also define `COMPANION_RUNTIME_PORT`; runtime reads `PORT`. Binding `::` supports Railway's
IPv4/IPv6 and legacy IPv6-only private networks. `/healthz` is the platform healthcheck, but it is
not an authorization boundary; the absence of a public route and the HMAC-protected desktop
endpoint are both required.

`COMPANION_API_URL` on runtime must be the API's public HTTPS origin. It is staged into the Box for
Skills Hub access, so a `*.railway.internal` address is not usable there.

Set `COMPANION_PI_BUNDLE_BASE_URL` on the runtime service to the public base URL of the
`companion-pi-bundles` bucket (for example `https://<bucket>.fly.storage.tigris.dev`). Runtime reads
it to have each Box download and checksum-verify the pinned Pi bundle
(`packages/box-runtime/src/piBundle.ts`) instead of installing Pi from npm at boot. Only the pinned
checksum, never this host, is trusted, so a public read-only bucket is sufficient; the value is a
deployment input and is never hardcoded. Leaving it empty keeps the escape-hatch
`COMPANION_PI_INSTALL_COMMAND` install path. Publishing new bundle artifacts (the
`.github/workflows/pi-bundle.yml` job) uses separate write credentials
(`PI_BUNDLE_S3_*` secrets and the `PI_BUNDLE_S3_BUCKET` variable) that the runtime service never has.

## PostgreSQL roles

Create four credentials:

- a migration owner used only by the one-shot `release` job;
- `companion_api`, a `LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` role;
- `companion_worker`, with the same restrictions;
- `companion_runtime_v2`, with the same restrictions and only the narrow Runtime v2
  `SECURITY DEFINER` functions.

The three application roles must be distinct and must not own tables. Configure the services as
follows:

```dotenv
# api service
DATABASE_URL=postgres://companion_api:...@.../companion

# release job only
DATABASE_MIGRATION_URL=postgres://migration_owner:...@.../companion
DATABASE_API_ROLE=companion_api
DATABASE_WORKER_ROLE=companion_worker
DATABASE_COMPANION_RUNTIME_ROLE=companion_runtime_v2
# Upgrade only, after NOLOGIN + session drain + membership removal:
# DATABASE_RETIRED_RUNTIME_ROLE=companion_runtime_legacy

# worker service
DATABASE_URL=postgres://companion_worker:...@.../companion

# runtime service
DATABASE_COMPANION_RUNTIME_URL=postgres://companion_runtime_v2:...@.../companion
```

`node dist/migrate.js` applies compatible migrations through additive desktop-replay repair 0093,
executes `packages/db/runtime-role-grants.sql`, then admits cutover 0094 and every later migration in
the full journal only on that same physical PostgreSQL connection after the grant block records
success. The 0093 checkpoint is one-way: a missing role, drifted object, live retired
session/membership, or incomplete ACL revocation leaves 0094 unapplied, but does not undo 0090-0093.
Keep the flag disabled and do not restart an old executor while correcting the preflight. The
`release` deployment exits with status
zero and becomes Railway `Completed` only after the full run succeeds. API connects through its
ordinary restricted `DATABASE_URL`; never add the owner URL or role-name variables to API, worker,
runtime, or web.

The API package's `start` command is exactly `node dist/index.js`; it does not invoke
`dist/migrate.js`. This is also the required self-host boundary: run
`pnpm --filter @companion/api migrate` (or the built `node dist/migrate.js`) as an explicit one-shot
release action, then run `pnpm --filter @companion/api start` with only the restricted API URL.

## Base service configuration

Configure public API/web origins, Better Auth secret and cookie prefix, S3, email, and optional
GitHub/Stripe/PostHog integrations from `.env.example`. Keep Companions disabled for a fresh deploy:

```dotenv
COMPANION_COMPANIONS_ENABLED=false
COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=
```

The disabled runtime still requires its dedicated database URL and serves `/healthz`; it does not
require Box, HMAC, master-key, or S3 credentials and durably keeps the shared claim gate disabled.

Railway [GitHub-push deployments](https://docs.railway.com/deployments/deployment-actions#when-ordering-does-not-apply)
of separate services are independent and do not provide migration ordering. Disable GitHub
autodeploy on `api`, `worker`, `runtime`, and `web`. Either trigger `release` manually as well, or
leave autodeploy enabled only for `release` with **Wait for CI**. For every production release, use
this two-phase sequence from one immutable commit:

1. Back up PostgreSQL and object storage.
2. Create the three restricted application roles.
3. Deploy `release` for the target commit and require the deployment to reach `Completed`. A failed,
   crashed, skipped, or still-active deployment does not authorize application rollout.
4. Verify the default branch has not advanced. Then deploy API, worker, runtime, and web from that
   exact same commit; if it advanced, restart at step 3 for the new commit.
5. Require API `/health`, runtime `/healthz`, login, Skills browser smoke, and public package checks.
6. Leave Companions disabled until the Runtime v2 cutover below is complete.

For the 0110 credential-snapshot migration, step 3 intentionally quarantines new claims from
pre-0110 runtime replicas while allowing their existing leases to finish or expire. Deploy runtime
from the same commit promptly in step 4; its versioned claimer rewinds and restages any expired
legacy operation/settings work that crossed staging without the new expiry ledger. Never restore
the legacy claim path or publish material metadata manually during this window.

## Historical Skills Hub-only guard

Installations older than migration `0063_skills_hub_only.sql` may still own retired Project/run
objects or provider resources. This is an historical cleanup obligation, not a current product
surface. The migration intentionally fails with `SQLSTATE 55000` until its four preflight counts are
zero.

If that guard stops the one-shot `release` job:

1. Keep public traffic stopped and take a PostgreSQL/object-storage backup.
2. Run the release image's owner-only maintenance entrypoint without applying later migrations:

   ```bash
   node dist/cutover.js report
   node dist/cutover.js purge --dry-run
   ```

3. Save the inventory. Release every listed sandbox/checkpoint through the historical provider and
   retain anything that must survive. The database cannot discover provider resources configured
   outside its rows.
4. With `DATABASE_MIGRATION_URL`, the matching S3 credentials, and explicit confirmation, settle
   the obligations:

   ```bash
   node dist/cutover.js purge --confirm-provider-cleanup
   ```

   The command deletes each named object before its ownership row and then rechecks the same four
   migration counts. Use `--skip-object-delete` only when those exact objects were already moved or
   deleted independently.
5. Restore `node dist/migrate.js` as the release job's start command and redeploy that job. Do not
   bypass or edit migration `0063`; historical migrations remain immutable. Do not move the owner
   URL into API as a workaround.

## Runtime v2 upgrade and cutover

Legacy Companions, transcripts, state, and Boxes are deleted rather than migrated. Encrypted
provider connections and member MCP accounts survive. An existing installation must use the
purge-capable staged release before deploying a release that removes the legacy schema/executor.

1. Back up PostgreSQL and record the deployed commit and Box account/environment.
2. Set `COMPANION_COMPANIONS_ENABLED=false` on web, API, worker, and runtime. Deploy all four and
   wait for active work to reach an interrupted checkpoint. Verify the database runtime gate is
   disabled. The worker reads the flag only to decide whether Companion routines may enqueue turns;
   it never holds a Box credential.
3. Run the [legacy purge](../../docs/runbooks/companions-runtime.md#legacy-purge) from an ephemeral,
   private maintenance execution of the **runtime image**. Give that command the migration-owner URL
   and Box key only for its lifetime; do not add the owner URL to the long-lived runtime service.
4. Save the report. It must show no remaining legacy database ownership, exact-name provider Box,
   pending/blocked delete operation, or unresolved external resource.
5. Deploy the asynchronous API/web and Runtime v2 service with the flag still disabled. Do not let
   any legacy binary execute v2 rows.
6. Configure the flag and allowlist on web, API, worker, and runtime. Runtime additionally receives
   Box/Pi, envelope master key, public API origin, and read-only Skill archive credentials. API and
   runtime receive the shared desktop HMAC. Deploy runtime first, then API, worker, and web, while
   user traffic stays quiesced. Leaving the flag off the worker is a supported configuration: every
   other Companion surface works and only scheduled routines stay dormant.
7. Confirm runtime `/healthz` is healthy, inspect the disabled gate epoch, and have the database
   owner call `companion_runtime_enable(<observed_epoch>, '<change-id>')`. This compare-and-set is
   intentionally unavailable to the runtime role.
8. Restore traffic and execute a disposable Companion cold-send, response, desktop authorization,
   stop, wake-on-send, second response, and permanent deletion.

This release already contains the guarded final legacy-removal migration. Do not deploy it until the
saved purge report is empty and no P0/P1 runtime incident is open. If an installation has not met
those prerequisites, keep its currently deployed purge-capable release disabled and postpone this
release.

## Health and operations

- API readiness: `/health`. The JSON `release_id` is the deployed git commit SHA from Railway's
  injected `RAILWAY_GIT_COMMIT_SHA` (no operator-managed release pin).
- Runtime readiness: `/healthz`, healthy only when PostgreSQL responds, the claim loop is alive, and
  the last two-second sweep is fresh. It exposes the same automatic `release_id`.
- Worker and web: Railway process state plus the configured web healthcheck.
- Runtime draining: keep Railway `drainingSeconds` at 30 or more and
  `COMPANION_RUNTIME_SHUTDOWN_DRAIN_MS` below the fixed 30-second lease (default 25 seconds).

Do not enable Railway Serverless/App Sleeping for runtime: wake-on-send is a Box product rule, not a
license to suspend the durable claim loop.

The [Runtime v2 operations runbook](../../docs/runbooks/companions-runtime.md) is authoritative for
the kill switch, legacy purge, incidents, and rollback. In particular:

- an ambiguous prompt dispatch becomes `interrupted`; never replay it automatically;
- Full Box restart is user-confirmed only and is not incident healing;
- a rollback after v2 data exists disables claims and rolls forward to a compatible v2 build; it
  never starts a legacy executor;
- provider payloads, raw Pi lines, signed desktop URLs, tokens, and plaintext credentials must not
  be copied into logs, tickets, or durable error fields.
