-- Companion is now a Skills Hub only. Runtime records are intentionally and irreversibly removed.
--
-- This migration must never erase the only durable references to provider or object-storage
-- resources. Operators first quiesce the old release and drain its cleanup workers; the guard then
-- fails closed until every externally backed runtime record is gone or marked cleaned.
DO $ensure_runtime_resources_drained$
DECLARE
  pending_storage bigint;
  pending_projects bigint;
  pending_sandboxes bigint;
  active_usage bigint;
BEGIN
  SELECT
    (SELECT count(*) FROM public.project_attachment_uploads)
    + (SELECT count(*) FROM public.project_attachments)
    + (SELECT count(*) FROM public.project_files)
    + (SELECT count(*) FROM public.project_file_versions)
    + (SELECT count(*) FROM public.skill_run_attachment_uploads)
    + (SELECT count(*) FROM public.skill_run_attachments)
    + (SELECT count(*) FROM public.skill_run_artifacts)
  INTO pending_storage;

  -- Every Project owns a deterministic provider identity and a durable S3 projection. Requiring
  -- the old release to finish Project deletion also proves its checkpoints and upload ledger were
  -- cleaned before their ownership graph disappears.
  SELECT count(*)
  INTO pending_projects
  FROM public.projects;

  SELECT
    (
      SELECT count(*)
      FROM public.skill_runs
      WHERE sandbox_cleaned_at IS NULL
        AND (sandbox_name IS NOT NULL OR sandbox_id IS NOT NULL)
    )
    + (
      SELECT count(*)
      FROM public.skill_run_prewarms
      WHERE sandbox_cleaned_at IS NULL
        AND (sandbox_name IS NOT NULL OR sandbox_id IS NOT NULL)
    )
  INTO pending_sandboxes;

  SELECT count(*)
  INTO active_usage
  FROM public.sandbox_usage_sessions
  WHERE ended_at IS NULL;

  IF pending_storage > 0
    OR pending_projects > 0
    OR pending_sandboxes > 0
    OR active_usage > 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '55000',
      MESSAGE = 'Skills Hub-only migration requires runtime resource cleanup first',
      DETAIL = format(
        'pending storage records=%s, Projects=%s, sandboxes=%s, active usage sessions=%s',
        pending_storage,
        pending_projects,
        pending_sandboxes,
        active_usage
      ),
      HINT = 'Keep the previous release quiesced with its cleanup worker and provider/storage credentials until the Skills Hub cutover preflight in deploy/railway/README.md passes.';
  END IF;
END
$ensure_runtime_resources_drained$;--> statement-breakpoint

-- Drop the shared helper first because its previous body referenced a run-configuration table.
DROP FUNCTION IF EXISTS public.companion_secret_usage_count(uuid, uuid);

-- CASCADE removes runtime-owned policies, triggers, indexes, constraints and table-returning helpers.
DROP TABLE IF EXISTS public.project_model_provider_inputs CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_secret_inputs CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_file_versions CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_files CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_attachments CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_attachment_uploads CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_questions CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_session_events CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_prompts CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_sessions CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_skill_snapshots CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_skills CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_workspaces CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_worker_lease_contexts CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.project_worker_heartbeats CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.projects CASCADE;

DROP TABLE IF EXISTS public.skill_run_artifacts CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_attachment_uploads CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_attachments CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_events CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_prompts CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_worker_heartbeats CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_jobs CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_variable_inputs CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_model_provider_inputs CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_secret_inputs CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_skills CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_runs CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_prewarm_skills CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_prewarms CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.sandbox_usage_sessions CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.user_run_preferences CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_config_variables CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_config_secrets CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.skill_run_configs CASCADE;

DROP TABLE IF EXISTS public.model_provider_credential_versions CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.model_provider_connections CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.user_model_preferences CASCADE;--> statement-breakpoint
DROP TABLE IF EXISTS public.org_model_preferences CASCADE;

-- Remove any remaining overloads or trigger helpers whose names are runtime-specific.
DO $cleanup_runtime_functions$
DECLARE
  runtime_function record;
BEGIN
  FOR runtime_function IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND (
        p.proname LIKE 'companion\_%skill\_run%' ESCAPE '\'
        OR p.proname LIKE 'companion\_run\_%' ESCAPE '\'
        OR p.proname LIKE 'companion\_project%' ESCAPE '\'
        OR p.proname LIKE 'companion\_%project%' ESCAPE '\'
        OR p.proname LIKE 'companion\_%model\_provider%' ESCAPE '\'
        OR p.proname LIKE 'companion\_%sandbox%' ESCAPE '\'
        OR p.proname IN ('companion_reject_run_snapshot_update', 'companion_detach_deleted_run_config')
      )
  LOOP
    EXECUTE format('DROP FUNCTION IF EXISTS %s CASCADE', runtime_function.signature);
  END LOOP;
END
$cleanup_runtime_functions$;--> statement-breakpoint

DROP TYPE IF EXISTS public.project_attachment_status CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.project_question_status CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.project_prompt_status CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.project_session_status CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.project_workspace_status CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.skill_run_prewarm_phase CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.skill_run_prewarm_status CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.skill_run_prompt_status CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.skill_run_prompt_kind CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.skill_run_job_status CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.skill_run_secret_provenance CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.skill_run_phase CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.skill_run_runtime_state CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.skill_run_status CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.sandbox_provider_state CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.sandbox_usage_runtime_policy CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.sandbox_usage_kind CASCADE;--> statement-breakpoint
DROP TYPE IF EXISTS public.model_provider_connection_scope CASCADE;

-- Skill secrets remain a first-class capability. Count only active skill bindings.
CREATE FUNCTION public.companion_secret_usage_count(p_org_id uuid, p_secret_id uuid)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  caller_id text;
  total bigint;
BEGIN
  caller_id := NULLIF(current_setting('app.user_id', true), '');
  IF caller_id IS NULL
    OR p_org_id <> NULLIF(current_setting('app.org_id', true), '')::uuid
    OR NOT EXISTS (
      SELECT 1 FROM public.memberships m
      WHERE m.org_id = p_org_id AND m.user_id = caller_id
    )
    OR NOT EXISTS (
      SELECT 1 FROM public.secrets s
      WHERE s.org_id = p_org_id AND s.id = p_secret_id AND s.owner_id = caller_id
    ) THEN
    RETURN 0;
  END IF;

  SELECT count(*)
  INTO total
  FROM public.skill_secret_bindings b
  WHERE b.org_id = p_org_id
    AND b.secret_id = p_secret_id
    AND b.revoked_at IS NULL;
  RETURN total;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_secret_usage_count(uuid, uuid) FROM PUBLIC;
