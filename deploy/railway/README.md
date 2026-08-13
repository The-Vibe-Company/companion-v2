# Railway deployment

Companion deploys as three services plus managed dependencies:

- `web`: Next.js Skills Hub
- `api`: REST/tRPC, authentication, skills, secrets, Skill Databases, public releases
- `worker`: GitHub sync, billing reconciliation, Skill Database object cleanup
- PostgreSQL and S3-compatible object storage; email provider as configured

There is no sandbox, Project, run, model-provider, or agent-execution service.

## Order

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
4. Verify the cutover preflight query below returns four zeroes. Also remove any shared golden
   snapshot or provider resource configured outside PostgreSQL; the database cannot discover it.
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

```sql
select
  (select count(*) from project_attachment_uploads)
    + (select count(*) from project_attachments)
    + (select count(*) from project_files)
    + (select count(*) from project_file_versions)
    + (select count(*) from skill_run_attachment_uploads)
    + (select count(*) from skill_run_attachments)
    + (select count(*) from skill_run_artifacts) as pending_storage,
  (select count(*) from projects) as pending_projects,
  (select count(*) from skill_runs
    where sandbox_cleaned_at is null
      and (sandbox_name is not null or sandbox_id is not null))
    + (select count(*) from skill_run_prewarms
      where sandbox_cleaned_at is null
        and (sandbox_name is not null or sandbox_id is not null)) as pending_sandboxes,
  (select count(*) from sandbox_usage_sessions where ended_at is null) as active_usage;
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

The guard is correct, not a false positive. Those rows hold the only remaining references to objects
in the configured bucket and to sandboxes and checkpoints at the provider. Dropping them without
deleting the external resources first strands sensitive objects and billable resources permanently.
The earlier procedure relied on the previous release's cleanup worker to drain them; once the new
worker is deployed that release no longer exists, so the one-shot `cutover` command below performs
that cleanup instead. It always deletes an object before removing the row that names it.

### Runbook

Everything below runs against the migration-owner database URL and the same S3 credentials the API
uses. Take a PostgreSQL backup first.

1. **Get the current API image running.** The cutover command ships in the API image, which cannot
   become active while the pre-deploy migration fails. In the Railway API service settings,
   temporarily clear the pre-deploy command (or set it to `node dist/cutover.js report`) and
   redeploy. This also quiesces the database on its own: the new API and web have no Project or run
   surface, so nothing can create new runtime rows while you work.

2. **Inventory the obligations.** `railway ssh` into the API service and run:

   ```bash
   node dist/cutover.js report
   ```

   This is read-only. It prints the same four counts the migration checks, every distinct object key
   still referenced, every sandbox and checkpoint identity, and every unsettled usage session.
   **Save this output.** After the cutover it is the only record of which external objects existed.
   If you used the pre-deploy override instead of `railway ssh`, the deploy log holds the same
   output.

3. **Handle anything you want to keep.** Copy or relocate any object from the printed list that
   should outlive the cutover. Then release the printed sandboxes and checkpoints at the provider;
   no code in this release can reach them.

4. **Settle the obligations.**

   ```bash
   node dist/cutover.js purge --confirm-provider-cleanup
   ```

   The command refuses to delete anything until `--confirm-provider-cleanup` asserts step 3 is done,
   deletes each object from the bucket and only then removes the rows naming it, empties the retired
   runtime tables, and re-checks the guard's four counts before reporting success. Add `--dry-run`
   first to see exactly what it would do. Add `--skip-object-delete` only when you have already
   moved or deleted the objects yourself; the rows are then discarded without touching the bucket.

   Objects belonging to Skills, Skill Databases, public releases, logos, avatars, and comment images
   share the bucket and are never in the list, because the command only deletes keys the retired
   tables reference.

5. **Restore the pre-deploy command** to `node dist/migrate.js` and redeploy. Migrations `0063`
   through the current head apply, and the API becomes healthy again.

If a new Project or run row appears between steps 2 and 4, the final verification fails with the
remaining counts rather than reporting success; stop web and API traffic and re-run step 4.

## Shared configuration

Configure public API/web origins, Better Auth secret/cookie prefix, PostgreSQL role URLs, S3 credentials, and email. Configure `COMPANION_SECRETS_MASTER_KEY` for skill secrets. Optional integrations use GitHub App, Stripe, and PostHog variables documented in `.env.example`.

API and worker should use distinct `LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT` PostgreSQL roles. Apply `packages/db/runtime-role-grants.sql` after migrations. The API owns request paths; the worker receives only billing, GitHub, and Skill Database cleanup grants.

The worker needs no Vercel, OpenCode, model-provider, golden snapshot, or runtime lifecycle variables.

## Companions (optional, default off)

`COMPANION_COMPANIONS_ENABLED` gates the Companions control plane on both web and API. It defaults to
`false` when unset, so a fresh Railway deployment boots with Companions disabled and none of the
Box/Pi/provider variables are required — leave the flag unset to keep it off. The API registers no
Companion routes and the web shell hides the Companions surface until the flag is `true`.

Set the flag to `true` on both `web` and `api` only when you intend to run Companions, and provide the
runtime secrets it needs:

- `COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS` — optional comma-separated, case-insensitive exact
  domains. When set, only authenticated users with a matching email domain can see the web surface or
  use Companion API routes. Missing or malformed user emails are denied. When unset or empty, the
  current behavior is preserved for authenticated workspace users with valid emails while the master
  flag is `true`.
- `COMPANION_BOX_API_KEY` — required for Box lifecycle calls (start/stop/status).
- `COMPANION_SECRETS_MASTER_KEY` — the base64 32-byte Skills master key also envelope-encrypts
  companion provider subscription credentials; it is already required by Secrets in production.
- `COMPANION_PI_INSTALL_COMMAND` — set an operator-pinned Pi install command unless the Box template
  preinstalls Pi.

Optional tuning variables (`COMPANION_BOX_API_BASE`, `COMPANION_BOX_ENVIRONMENT`,
`COMPANION_BOX_TTL_SECONDS`, `COMPANION_PI_MCP_ADAPTER_PACKAGE`) fall back to the safe defaults in
`.env.example`. When the flag is `true` but a required secret is unset, the API still boots and logs a
single startup warning naming the missing variables; Box and provider actions fail until they are set.

For the initial production rollout, set these exact values on both the Railway `api` and `web`
services:

```dotenv
COMPANION_COMPANIONS_ENABLED=true
COMPANION_COMPANIONS_ALLOWED_EMAIL_DOMAINS=thevibecompany.co
```

## Health and rollback

Use `/health` for API availability and the Railway process status for worker/web. A rollback across migration 0062 restores code but not intentionally dropped runtime data; restore the pre-deploy database backup only if the product decision itself is rolled back. Skills, organizations, users, auth, Agent Auth, secrets, Skill Databases, GitHub, billing, and public-release data are preserved by the migration.
