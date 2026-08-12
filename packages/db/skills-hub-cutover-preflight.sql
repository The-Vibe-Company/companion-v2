-- Skills Hub-only cutover preflight (read-only).
--
-- Migration 0063_skills_hub_only.sql refuses to drop the retired Project and run tables while they
-- still hold the only references to objects in the configured bucket and to sandboxes and
-- checkpoints at the provider. Until those obligations are settled, the API pre-deploy command
-- (`node dist/migrate.js`) fails and no later migration can apply.
--
-- Run this against the migration-owner database URL before and after the cutover:
--
--   psql "$DATABASE_MIGRATION_URL" -f packages/db/skills-hub-cutover-preflight.sql
--
-- Query 1 mirrors the migration guard exactly: when every column is zero, 0063 applies. Queries 2-5
-- name what is still outstanding. Nothing here writes, and no secret column is selected.
--
-- If these relations do not exist, the cutover has already been applied and there is nothing to do.
-- See "Skills Hub-only cutover" in deploy/railway/README.md for the full runbook.

-- 1. Guard parity. Four zeroes mean the pre-deploy migration will succeed.
select
  (select count(*) from public.project_attachment_uploads)
    + (select count(*) from public.project_attachments)
    + (select count(*) from public.project_files)
    + (select count(*) from public.project_file_versions)
    + (select count(*) from public.skill_run_attachment_uploads)
    + (select count(*) from public.skill_run_attachments)
    + (select count(*) from public.skill_run_artifacts) as pending_storage,
  (select count(*) from public.projects) as pending_projects,
  (select count(*)
     from public.skill_runs
     where sandbox_cleaned_at is null
       and (sandbox_name is not null or sandbox_id is not null))
    + (select count(*)
         from public.skill_run_prewarms
         where sandbox_cleaned_at is null
           and (sandbox_name is not null or sandbox_id is not null)) as pending_sandboxes,
  (select count(*) from public.sandbox_usage_sessions where ended_at is null) as active_usage;

-- 2. Which tables hold the outstanding object references.
select 'project_attachment_uploads' as source, count(*) as row_count from public.project_attachment_uploads
union all select 'project_attachments', count(*) from public.project_attachments
union all select 'project_files', count(*) from public.project_files
union all select 'project_file_versions', count(*) from public.project_file_versions
union all select 'skill_run_attachment_uploads', count(*) from public.skill_run_attachment_uploads
union all select 'skill_run_attachments', count(*) from public.skill_run_attachments
union all select 'skill_run_artifacts', count(*) from public.skill_run_artifacts
order by source;

-- 3. Every object key still referenced, in the bucket named by S3_BUCKET_SKILL_ARCHIVES. These are
--    the only remaining references: save this result before settling the cutover. Skills, Skill
--    Databases, public releases, logos, avatars, and comment images share the bucket and are never
--    listed here.
--
--    Export it with psql:
--      \copy (<the select below>) to 'cutover-objects.csv' with (format csv)
select distinct storage_key from public.project_attachment_uploads
union select storage_key from public.project_attachments
union select storage_key from public.project_files
union select storage_key from public.project_file_versions
union select storage_key from public.skill_run_attachment_uploads
union select storage_key from public.skill_run_attachments
union select storage_key from public.skill_run_artifacts
order by storage_key;

-- 4. Sandbox and checkpoint identities held at the provider. No code in this release can reach
--    them, so they must be released with the provider's own tooling.
select 'skill_runs' as source, org_id, sandbox_name, sandbox_id, null::text as checkpoint_id
  from public.skill_runs
  where sandbox_cleaned_at is null and (sandbox_name is not null or sandbox_id is not null)
union all
select 'skill_run_prewarms', org_id, sandbox_name, sandbox_id, null::text
  from public.skill_run_prewarms
  where sandbox_cleaned_at is null and (sandbox_name is not null or sandbox_id is not null)
union all
select 'project_workspaces', org_id, sandbox_name, sandbox_id, checkpoint_id
  from public.project_workspaces
  where sandbox_name is not null or checkpoint_id is not null
order by source, sandbox_name;

-- 5. Usage sessions that were never settled. These bill nothing external, but their billing record
--    ends with the cutover.
select id, org_id, started_at
from public.sandbox_usage_sessions
where ended_at is null
order by started_at;
