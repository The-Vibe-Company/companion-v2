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

The API service runs `node dist/migrate.js` as its `preDeployCommand`, so a database that still
holds Project and run rows fails **every** API deployment on the `0063` guard, with SQLSTATE `55000`
and the message `Skills Hub-only migration requires runtime resource cleanup first`. Web and worker
have no pre-deploy migration and keep deploying successfully, so the symptom looks like an
API-only, commit-independent build failure. The deploy log prints the pending counts and the
remediation below.

Once the new worker is deployed, the old release's cleanup worker no longer exists, so steps 2–3
above can no longer drain anything. Finish the cutover instead:

1. Confirm from the deploy log's `DETAIL` line which obligations remain.
2. Delete the historical Project and run objects with your object-storage administration tooling
   (every key named by `project_attachment_uploads`, `project_attachments`, `project_files`,
   `project_file_versions`, `skill_run_attachments`, `skill_run_attachment_uploads`, and
   `skill_run_artifacts`) and release any sandbox or golden-snapshot resource still held at the
   provider. Nothing else references those objects, so this is the last chance to remove them.
3. Set `COMPANION_SKILLS_HUB_CUTOVER_ACK=external-cleanup-complete` on the API service and redeploy.
   The pre-deploy migration then empties the retired runtime tables inside the migration lock, logs
   the per-table row counts it discarded, and lets `0063` and later migrations apply.
4. Remove the variable after the deploy succeeds. Leaving it set is harmless — the retired tables no
   longer exist — but it should not outlive the cutover. Any other value fails fast rather than
   discarding rows whose external objects may still exist.

The acknowledgement only empties the tables `0063` drops moments later; Skills, organizations,
users, auth, Agent Auth, secrets, Skill Databases, GitHub, billing, and public-release data are
untouched.

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

- `COMPANION_BOX_API_KEY` — required for Box lifecycle calls (start/stop/status).
- `COMPANION_SECRETS_MASTER_KEY` — the base64 32-byte Skills master key also envelope-encrypts
  companion provider subscription credentials; it is already required by Secrets in production.
- `COMPANION_PI_INSTALL_COMMAND` — set an operator-pinned Pi install command unless the Box template
  preinstalls Pi.

Optional tuning variables (`COMPANION_BOX_API_BASE`, `COMPANION_BOX_ENVIRONMENT`,
`COMPANION_BOX_TTL_SECONDS`, `COMPANION_PI_MCP_ADAPTER_PACKAGE`) fall back to the safe defaults in
`.env.example`. When the flag is `true` but a required secret is unset, the API still boots and logs a
single startup warning naming the missing variables; Box and provider actions fail until they are set.

## Health and rollback

Use `/health` for API availability and the Railway process status for worker/web. A rollback across migration 0062 restores code but not intentionally dropped runtime data; restore the pre-deploy database backup only if the product decision itself is rolled back. Skills, organizations, users, auth, Agent Auth, secrets, Skill Databases, GitHub, billing, and public-release data are preserved by the migration.
