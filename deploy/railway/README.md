# Railway deployment

Companion runs as three Railway services from this repository plus a Railway Postgres service:

- `web`: the only public application service; it proxies `/auth`, `/v1`, and `/trpc` to `api`.
- `api`: private Hono service. Its pre-deploy command applies Drizzle migrations under an advisory lock.
- `worker`: private process with independent Stripe reconciliation, durable skill-run, and GitHub-mirror supervisors.
- `Postgres`: Railway's PostgreSQL template.

Keeping application traffic on the web origin avoids cross-origin session cookies. Stripe and CLI clients use the
same public web domain: the Stripe endpoint is `/v1/billing/webhooks/stripe`, and the CLI API base ends in `/v1`.

The application services build from the checked-in multi-stage Dockerfiles. Each build prunes the pnpm workspace to
the selected service before installing dependencies; the API and worker ship only their production bundle and the web
ships the Next.js standalone server. The service names must remain `api`, `worker`, and `web` because the shared backend
Dockerfile selects its target from Railway's `RAILWAY_SERVICE_NAME` build variable.

## 1. Create the services

Create `Postgres`, `api`, `worker`, and `web` in one Railway project/environment. Connect all three application
services to the same GitHub repository and leave their root directory at `/`. Configure each service's Railway
configuration-file path:

| Service | Railway config path | Public domain |
| --- | --- | --- |
| `api` | `/deploy/railway/api.railway.json` | No |
| `worker` | `/deploy/railway/worker.railway.json` | No |
| `web` | `/deploy/railway/web.railway.json` | Yes |

The config-file path is required: Railway does not discover these nested files automatically. Confirm the staged
service settings show the `DOCKERFILE` builder and the matching `deploy/railway/Dockerfile.*` path before deploying.
The Dockerfiles declare every build-time variable they consume; secrets remain runtime-only variables and must never
be added as Docker build arguments.

Generate the `web` Railway domain before adding variables that reference `web.RAILWAY_PUBLIC_DOMAIN`. The API and
worker communicate through Postgres and external providers. Deploy `api` once before enabling either worker
supervisor so
the first database migration has completed; later API deploys run migrations before replacing the live process.

Run the API and worker with a dedicated `NOSUPERUSER NOBYPASSRLS` login that neither owns database
objects nor belongs to the migration-owner role. Keep the Railway Postgres owner URL only in
`DATABASE_MIGRATION_URL` on the API (for its pre-deploy migration). Set `DATABASE_RUNTIME_ROLE` to the
runtime login name: the migration hook then applies the versioned least-privilege grants immediately
after every migration while it still holds the advisory lock. The checked-in script remains a manual
recovery/fallback path:

```bash
psql "$DATABASE_MIGRATION_URL" -v runtime_role=companion_runtime \
  -f packages/db/runtime-role-grants.sql
```

Set `DATABASE_URL` on API and worker to that runtime login's URL. This separation is required for
forced creator-only RLS; using the table owner, a superuser, or a `BYPASSRLS` role at runtime disables
that security boundary.

## 2. Configure variables

Use Railway reference variables instead of copying generated hostnames or database credentials. The service names
below assume the services are named exactly `web`, `api`, and `Postgres`.

### `api`

```dotenv
NODE_ENV=production
PORT=3001
COMPANION_API_HOST=0.0.0.0
DATABASE_URL=<companion_runtime NOSUPERUSER/NOBYPASSRLS URL>
DATABASE_MIGRATION_URL=${{Postgres.DATABASE_URL}}
DATABASE_RUNTIME_ROLE=companion_runtime
COMPANION_WEB_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
COMPANION_API_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
BETTER_AUTH_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
BETTER_AUTH_COOKIE_PREFIX=companion-production
BETTER_AUTH_SECRET=<random secret of at least 32 bytes>
COMPANION_SECRETS_MASTER_KEY=<shared base64 32-byte key; never rotate without a migration>
GITHUB_APP_SLUG=<GitHub App slug>
GITHUB_APP_CLIENT_ID=<GitHub App client id>
GITHUB_APP_CLIENT_SECRET=<secret>
GITHUB_APP_NAME=<user-facing App name>
COMPANION_GITHUB_SYNC_ENABLED=true
COMPANION_GITHUB_APP_MANAGED=false

EMAIL_PROVIDER=resend
EMAIL_FROM=Companion <noreply@your-domain.example>
RESEND_API_KEY=<secret>

S3_ENDPOINT=<S3-compatible HTTPS endpoint>
S3_REGION=<region>
S3_ACCESS_KEY_ID=<secret>
S3_SECRET_ACCESS_KEY=<secret>
S3_BUCKET_SKILL_ARCHIVES=<bucket>
S3_FORCE_PATH_STYLE=false

COMPANION_BILLING_MODE=stripe
COMPANION_ENTITLEMENTS_MODE=observe
COMPANION_ENTITLEMENT_PILOT_ORGS=
COMPANION_PRO_ORG_ALLOWLIST=
COMPANION_CHECKOUT_ENABLED=false
COMPANION_STRIPE_WEBHOOKS_ENABLED=false
STRIPE_SECRET_KEY=<Stripe live secret key>
STRIPE_WEBHOOK_SECRET=<endpoint signing secret>
STRIPE_PRO_PRICE_ID=<live price id>
STRIPE_PORTAL_CONFIGURATION_ID=<live portal configuration id>

# The API exposes run readiness/options but never receives Vercel credentials.
COMPANION_RUNS_ENABLED=true
COMPANION_RUN_PREWARM_ENABLED=true
COMPANION_GOLDEN_SNAPSHOT_ID=<same pinned OpenCode snapshot as worker>
OPENCODE_VERSION=1.17.13
COMPANION_SANDBOX_REGION=iad1
COMPANION_SANDBOX_TIMEOUT_MS=300000
```

`COMPANION_ENTITLEMENTS_MODE=observe` is the safe first production rollout. Enable webhooks, then Checkout, then use
`pilot` with explicit organization ids before switching to `enforce` globally.

### `web`

```dotenv
NODE_ENV=production
PORT=3000
COMPANION_API_URL=http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3001
COMPANION_WEB_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
NEXT_PUBLIC_COMPANION_API_BASE=https://${{web.RAILWAY_PUBLIC_DOMAIN}}/v1
NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN=<public project token, optional>
NEXT_PUBLIC_POSTHOG_HOST=https://us.i.posthog.com
```

`COMPANION_API_URL` is consumed while Next.js builds its rewrites, so add it before the first web build. Railway's
private DNS is not reachable from a browser; browser requests intentionally stay on the public web origin. The
`NEXT_PUBLIC_*` values are public by definition and are baked into the browser bundle.

### `worker`

```dotenv
NODE_ENV=production
DATABASE_URL=<same companion_runtime URL as api>
COMPANION_WEB_URL=https://${{web.RAILWAY_PUBLIC_DOMAIN}}
COMPANION_BILLING_MODE=stripe
COMPANION_ENTITLEMENTS_MODE=observe
STRIPE_SECRET_KEY=<same live secret key as api>
STRIPE_WEBHOOK_SECRET=<same endpoint signing secret as api>
STRIPE_PRO_PRICE_ID=<same live price id as api>
STRIPE_PORTAL_CONFIGURATION_ID=<same live portal configuration id as api>

COMPANION_SECRETS_MASTER_KEY=<exactly the same key as api>
GITHUB_APP_ID=<GitHub App id>
GITHUB_APP_PRIVATE_KEY=<base64-encoded PEM; worker only>
S3_ENDPOINT=<same endpoint as api>
S3_REGION=<same region as api>
S3_ACCESS_KEY_ID=<same access key as api>
S3_SECRET_ACCESS_KEY=<same secret key as api>
S3_BUCKET_SKILL_ARCHIVES=<same bucket as api>
S3_FORCE_PATH_STYLE=false

VERCEL_TOKEN=<sandbox token>
VERCEL_TEAM_ID=<sandbox team id>
VERCEL_PROJECT_ID=<sandbox project id>
COMPANION_RUNS_ENABLED=true
COMPANION_RUN_PREWARM_ENABLED=true
COMPANION_GOLDEN_SNAPSHOT_ID=<current pinned OpenCode snapshot>
OPENCODE_VERSION=1.17.13
COMPANION_SANDBOX_REGION=iad1
COMPANION_SANDBOX_TIMEOUT_MS=300000
COMPANION_RUN_CONCURRENCY=2
COMPANION_RUN_PREWARM_CONCURRENCY=2
COMPANION_RUN_CLAIM_INTERVAL_MS=1000
COMPANION_RUN_LEASE_SECONDS=30
COMPANION_RUN_HEARTBEAT_MS=10000
COMPANION_RUN_INACTIVITY_MS=120000
COMPANION_RUN_RECORDER_RECONNECT_MIN_MS=250
COMPANION_RUN_RECORDER_RECONNECT_MAX_MS=5000
COMPANION_RUN_EVENT_RETENTION_INTERVAL_MS=900000
COMPANION_RUN_SWEEP_INTERVAL_MS=60000
```

Billing and runs are independent supervisors: disabling billing must not stop run processing, and missing Vercel
configuration disables only RunSkill. The worker needs all four Stripe variables when Stripe billing is enabled, plus
the vault, S3, Vercel, and OpenCode settings for runs. It does not need a domain or `PORT`.

## 3. Configure Stripe

Production must use live-mode Stripe resources. Test-mode product, Price, Portal configuration, API keys, and webhook
secrets cannot be reused in live mode.

1. Create an active recurring Price with `licensed` usage, monthly interval, USD currency, and a unit amount of
   exactly 1000 cents.
2. Configure the Customer Portal to allow payment-method changes, invoice history, and cancellation at period end.
   Disable plan changes, quantity changes, and promotion codes.
3. Create a webhook endpoint at
   `https://${{web.RAILWAY_PUBLIC_DOMAIN}}/v1/billing/webhooks/stripe` and subscribe to:
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.paid`, and `invoice.payment_failed`.
4. Store that endpoint's `whsec_...` value as `STRIPE_WEBHOOK_SECRET` on both `api` and `worker`.
5. Enable Stripe Tax registrations appropriate to the business before accepting live payments.

## 4. Validate the deployment

After the first API deploy, confirm its `/health` check is green and that its pre-deploy logs contain
`Drizzle migrations applied`. Then verify:

1. The public web `/login` page loads and authentication sets cookies on the web domain.
2. Workspace → Billing loads for a signed-in member.
3. With Checkout still disabled, the page reports the rollout state without offering a live purchase.
4. Enable webhooks and send a Stripe test event; the endpoint must return a 2xx response.
5. Enable Checkout for a pilot org, complete a low-risk live verification, and confirm the worker changes the Stripe
   subscription quantity after adding or removing an active membership.

For build-performance validation, record the build duration and pushed image size from `railway logs --build`. Run a
second build from the same source snapshot and confirm the dependency-install layers are cached. The expected outcome
is a combined image payload at least 50% below the former Railpack baseline (1,089 MB across the three services) and a
warm web build below 120 seconds.

Rollback is non-destructive: set `COMPANION_CHECKOUT_ENABLED=false`,
`COMPANION_STRIPE_WEBHOOKS_ENABLED=false`, and `COMPANION_ENTITLEMENTS_MODE=off`. Do not delete Stripe identifiers or
cancel subscriptions as part of an application rollback.
