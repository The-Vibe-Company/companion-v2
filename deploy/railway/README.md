# Railway deployment

Companion deploys as three services plus managed dependencies:

- `web`: Next.js Skills Hub
- `api`: REST/tRPC, authentication, skills, secrets, Skill Databases, public releases
- `worker`: GitHub sync, billing reconciliation, Skill Database object cleanup
- PostgreSQL and S3-compatible object storage; email provider as configured

There is no sandbox, Project, run, model-provider, or agent-execution service.

## Order

This is the original upgrade path, and it only applies while the **previous release is still
deployed**, because steps 2 and 3 depend on its cleanup worker. A deployment that already runs the
new worker cannot drain anything this way; use "Skills Hub-only cutover" below instead.

1. Back up PostgreSQL and object storage.
2. While still on the previous release, stop web/API traffic so no Project, run, upload, artifact,
   prewarm, or sandbox can be created. Keep the old worker and its S3/Vercel credentials running.
3. With the migration-owner URL, run the lifecycle-only block below to queue every Project for the
   old worker. This does not read or grant access to private Project content. Wait for Project rows
   plus `project_attachment_uploads` to drain. Cancel/expire every run and prewarm, wait for
   `sandbox_cleaned_at` and usage settlement, then delete every key named by
   `skill_run_attachments`, `skill_run_attachment_uploads`, and `skill_run_artifacts` with the
   configured object-storage administration tooling. Delete those legacy metadata rows only after
   the corresponding external delete succeeds.
4. Verify `packages/db/skills-hub-cutover-preflight.sql` returns four zeroes. Also remove any shared
   golden snapshot or provider resource configured outside PostgreSQL; the database cannot discover
   it.
5. Deploy the new API image and run `node dist/migrate.js` with the migration-owner URL.
6. Deploy worker and web from the same commit.
7. Run health, Skills browser smoke, and public package checks.

```sql
begin;

-- Public traffic is already stopped. Temporarily suspend the creator-only policies solely to mark
-- lifecycle metadata, including Projects whose creator is no longer an organization member.
alter table public.projects disable row level security;
alter table public.project_workspaces disable row level security;

update public.projects
set delete_requested_at = clock_timestamp(),
    revision = revision + 1,
    updated_at = clock_timestamp()
where delete_requested_at is null;

update public.project_workspaces workspace
set status = case
      when workspace.status = 'deleted' then workspace.status
      else 'deleting'::public.project_workspace_status
    end,
    available_at = clock_timestamp(),
    idle_deadline_at = null,
    updated_at = clock_timestamp()
where exists (
  select 1
  from public.projects project
  where project.org_id = workspace.org_id
    and project.id = workspace.project_id
    and project.creator_id = workspace.creator_id
    and project.delete_requested_at is not null
);

alter table public.projects enable row level security;
alter table public.projects force row level security;
alter table public.project_workspaces enable row level security;
alter table public.project_workspaces force row level security;
commit;
```

The preflight lives in `packages/db/skills-hub-cutover-preflight.sql` so it cannot drift from the
guard. Run it read-only against the migration-owner URL:

```bash
psql "$DATABASE_MIGRATION_URL" -f packages/db/skills-hub-cutover-preflight.sql
```

Migration `0063_skills_hub_only.sql` intentionally deletes historical runtime data. Its first
statement repeats the preflight and aborts before any `DROP` when an external cleanup obligation
remains. It must finish before starting the new API/worker version. Historical migrations are not
rewritten.

## Skills Hub-only cutover

### Symptom

The API service runs `node dist/migrate.js` as its `preDeployCommand`, so a database that still
holds Project and run rows fails **every** API deployment on the `0063` guard:

```
Skills Hub-only migration requires runtime resource cleanup first
SQLSTATE: 55000
DETAIL: pending storage records=..., Projects=..., sandboxes=..., active usage sessions=...
```

Web and worker have no pre-deploy migration, so they keep deploying successfully from the same
commit. The symptom therefore looks like an API-only build failure that is unrelated to whatever
was merged, and it repeats on every commit until the cutover below is finished. The image builds
fine; only the pre-deploy step fails.

### Why this needs an operator

The guard is correct, not a false positive, and nothing in the runbook relaxes it. Each count exists
because the rows it covers are the last reference to something outside PostgreSQL:

- `pending_storage` counts rows in the seven tables that carry a `storage_key`. Every key names an
  object in the configured bucket; dropping the row makes the object unreachable and permanent. An
  uncommitted upload row may name an object that was never written, which is why the cutover deletes
  by key and tolerates a key that is already absent rather than assuming either way.
- `pending_projects` counts every Project, because each one owns a workspace with a deterministic
  sandbox identity and a durable object projection.
- `pending_sandboxes` counts only runs and prewarms that named a sandbox and were never marked
  cleaned, so runs that never reached a provider are already excluded.
- `active_usage` counts usage sessions that were never settled. These hold nothing external, but
  discarding them ends their billing record, so the cutover surfaces them rather than hiding them.

The earlier procedure relied on the previous release's cleanup worker to drain all of this; once the
new worker is deployed that release no longer exists, so the one-shot `cutover` command below does
that work instead, in the order the guard requires: an object is always deleted before the row that
names it, and rows naming an unreleased provider resource are never discarded without an explicit
operator confirmation.

### Runbook

Everything below runs against the migration-owner database URL and the same S3 credentials the API
uses. Take a PostgreSQL backup first.

1. **See what is outstanding.** No deployment is required for this: run the read-only preflight
   against the migration-owner URL.

   ```bash
   psql "$DATABASE_MIGRATION_URL" -f packages/db/skills-hub-cutover-preflight.sql
   ```

   Its first query is the migration guard verbatim, so four zeroes mean the pre-deploy migration
   will already succeed. The remaining queries list every object key still referenced, every sandbox
   and checkpoint identity, and every unsettled usage session. Railway exposes the database over a
   TCP proxy; use that public URL, because `*.railway.internal` does not resolve outside the project.

2. **Get the current API image running.** The cutover command ships in the API image, which cannot
   become active while the pre-deploy migration fails. In the Railway API service settings,
   temporarily clear the pre-deploy command (or set it to `node dist/cutover.js report`) and
   redeploy. This also quiesces the database on its own: the new API and web have no Project or run
   surface, so nothing can create new runtime rows while you work. Until this deploy lands the API is
   still the previous release, which does serve Projects.

3. **Inventory the obligations.** `railway ssh` into the API service and run:

   ```bash
   node dist/cutover.js report
   ```

   This is read-only. It prints the same four counts the migration checks, every distinct object key
   still referenced, every sandbox and checkpoint identity, and every unsettled usage session.
   **Save this output.** After the cutover it is the only record of which external objects existed.
   If you used the pre-deploy override instead of `railway ssh`, the deploy log holds the same
   output.

4. **Handle anything you want to keep.** Copy or relocate any object from the printed list that
   should outlive the cutover. Then release the printed sandboxes and checkpoints at the provider;
   no code in this release can reach them.

5. **Settle the obligations.**

   ```bash
   node dist/cutover.js purge --confirm-provider-cleanup
   ```

   The command refuses to delete anything until `--confirm-provider-cleanup` asserts step 4 is done,
   deletes each object from the bucket and only then removes the rows naming it, empties the retired
   runtime tables, and re-checks the guard's four counts before reporting success. Add `--dry-run`
   first to see exactly what it would do. Add `--skip-object-delete` only when you have already
   moved or deleted the objects yourself; the rows are then discarded without touching the bucket.

   Objects belonging to Skills, Skill Databases, public releases, logos, avatars, and comment images
   share the bucket and are never in the list, because the command only deletes keys the retired
   tables reference.

6. **Redeploy in order: `api`, then `worker`, then `web`.** Restore the API service's pre-deploy
   command to `node dist/migrate.js` and redeploy it first, so migrations `0063` through the current
   head apply before anything else starts against the new schema. Wait for `/health`, then redeploy
   `worker` and `web` from the same commit. Re-run the preflight from step 1 to confirm the retired
   relations are gone.

If a new Project or run row appears between steps 3 and 5, the final verification fails with the
remaining counts rather than reporting success; stop web and API traffic and re-run step 5.

### Without the API image

The command is a convenience, not a requirement. An operator with `psql` and object-storage tooling
can do the same work in the same order:

1. Export the object keys from query 3 of the preflight, for example with
   `\copy (...) to 'cutover-objects.csv' with (format csv)`. Keep the file: after the cutover nothing
   else references those objects.
2. Delete each exported key from the bucket named by `S3_BUCKET_SKILL_ARCHIVES`, and release the
   sandboxes and checkpoints from query 4 at the provider.
3. Delete the rows only after their objects are gone, then run
   `node dist/cutover.js purge --confirm-provider-cleanup --skip-object-delete` to finish the
   database side, or empty the retired tables yourself and confirm the preflight returns four zeroes.

Either way the invariant is the same: an object is deleted before the row naming it, and no row that
names an unreleased provider resource is discarded.

## Shared configuration

Configure public API/web origins, Better Auth secret/cookie prefix, PostgreSQL role URLs, S3 credentials, and email. Configure `COMPANION_SECRETS_MASTER_KEY` for skill secrets. Optional integrations use GitHub App, Stripe, and PostHog variables documented in `.env.example`.

API and worker should use distinct `LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` PostgreSQL roles. Apply `packages/db/runtime-role-grants.sql` after migrations. The API owns request paths; the worker receives only billing, GitHub, and Skill Database cleanup grants.

The worker needs no Vercel, OpenCode, model-provider, golden snapshot, or runtime lifecycle variables.

## Companions (optional, default off)

`COMPANION_COMPANIONS_ENABLED` gates the Companions control plane on both web and API. It defaults to
`false` when unset, so a fresh Railway deployment boots with Companions disabled and none of the
Box/Pi/provider variables are required — leave the flag unset to keep it off. The API registers no
Companion routes and the web shell hides the Companions surface until the flag is `true` and a
non-empty allowlist is configured.

Set the flag and allowlist on both `web` and `api` only when you intend to run Companions, and
provide the runtime secrets it needs:

- `COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS` — required comma-separated, case-insensitive exact
  domains. Only authenticated users with a matching email domain can see the web surface or use
  Companion API routes. Missing or malformed user emails are denied. When unset or empty, Companions
  stays disabled and the API registers no Companion routes even if the master flag is `true`.
- `COMPANION_BOX_API_KEY` — required for Box lifecycle calls (start/stop/status).
- `COMPANION_SECRETS_MASTER_KEY` — the base64 32-byte Skills master key also envelope-encrypts
  companion provider subscriptions, MCP OAuth grants, and pending OAuth callbacks; it is already
  required by Secrets in production.
- `COMPANION_MCP_GITHUB_CLIENT_ID` and `COMPANION_MCP_GITHUB_CLIENT_SECRET` — set on `api` only from
  the deployment's GitHub OAuth App. Register
  `${COMPANION_WEB_URL}/v1/companion-plugins/oauth/callback` as its callback URL. Linear and Notion
  MCP OAuth use dynamic client registration and do not need deployment-owned client credentials.
- `COMPANION_PI_INSTALL_COMMAND` — set an operator-pinned Pi install command unless the Box template
  preinstalls Pi.

Optional tuning variables (`COMPANION_BOX_API_BASE`, `COMPANION_BOX_ENVIRONMENT`,
`COMPANION_BOX_TTL_SECONDS`, `COMPANION_PI_MCP_ADAPTER_PACKAGE`) fall back to the safe defaults in
`.env.example`. When the flag is `true`, the allowlist is non-empty, and a required secret is unset,
the API still boots and logs a single startup warning naming the missing variables; Box and provider
actions fail until they are set.

Set `COMPANION_BOX_TTL_SECONDS=21600` on the Railway `api` service. Successful message delivery
refreshes that TTL, making the six-hour idle window run from the last message rather than the last
wake. The web and worker services do not contact Box and do not need this variable.

For the initial production rollout, set these exact values on both the Railway `api` and `web`
services:

```dotenv
COMPANION_COMPANIONS_ENABLED=true
COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=thevibecompany.co
```

## Health and rollback

Use `/health` for API availability and the Railway process status for worker/web. A rollback across migration 0062 restores code but not intentionally dropped runtime data; restore the pre-deploy database backup only if the product decision itself is rolled back. Skills, organizations, users, auth, Agent Auth, secrets, Skill Databases, GitHub, billing, and public-release data are preserved by the migration.
