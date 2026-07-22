-- Forward-repair workspaces that applied an earlier development draft of 0051 before the
-- rolling-worker wrapper and authoritative path reconciliation function were added. Fresh
-- databases also apply this idempotently after 0051.
CREATE OR REPLACE FUNCTION companion_put_skill_run_artifact_metadata(
  p_org_id uuid,
  p_run_id uuid,
  p_creator_id text,
  p_worker_id text,
  p_id uuid,
  p_path text,
  p_file_name text,
  p_content_type text,
  p_byte_size integer,
  p_previewable boolean,
  p_storage_key text,
  p_ready boolean,
  p_expires_at timestamp with time zone
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.companion_put_skill_run_artifact_metadata_v2(
    p_org_id, p_run_id, p_creator_id, p_worker_id, p_id, p_path, p_file_name,
    p_content_type, p_byte_size, p_previewable, p_storage_key, p_ready, p_expires_at, NULL
  )
$$;--> statement-breakpoint

CREATE OR REPLACE FUNCTION companion_reconcile_skill_run_artifact_paths(
  p_org_id uuid,
  p_run_id uuid,
  p_creator_id text,
  p_worker_id text,
  p_paths text[]
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text;
  previous_worker_id text;
  previous_worker_org_id text;
  previous_worker_run_id text;
  previous_worker_creator_id text;
BEGIN
  IF p_paths IS NULL OR cardinality(p_paths) > 20 OR array_position(p_paths, NULL) IS NOT NULL THEN
    RETURN false;
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  previous_worker_id := current_setting('app.run_worker_id', true);
  previous_worker_org_id := current_setting('app.run_worker_org_id', true);
  previous_worker_run_id := current_setting('app.run_worker_run_id', true);
  previous_worker_creator_id := current_setting('app.run_worker_creator_id', true);
  PERFORM set_config('app.run_worker', 'exact_lease', true);
  PERFORM set_config('app.run_worker_id', p_worker_id, true);
  PERFORM set_config('app.run_worker_org_id', p_org_id::text, true);
  PERFORM set_config('app.run_worker_run_id', p_run_id::text, true);
  PERFORM set_config('app.run_worker_creator_id', p_creator_id, true);
  IF NOT EXISTS (
    SELECT 1 FROM public."skill_run_jobs" j
    WHERE j."org_id" = p_org_id AND j."run_id" = p_run_id AND j."creator_id" = p_creator_id
      AND j."status" = 'leased' AND j."lease_owner" = p_worker_id
      AND j."lease_expires_at" > clock_timestamp()
  ) THEN
    PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
    PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
    PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
    PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
    PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
    RETURN false;
  END IF;
  PERFORM 1 FROM public."skill_runs" r
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id
  FOR UPDATE;
  UPDATE public."skill_run_artifacts" a
  SET "ready" = false,
      "expires_at" = LEAST(a."expires_at", clock_timestamp()),
      "updated_at" = clock_timestamp()
  WHERE a."org_id" = p_org_id AND a."run_id" = p_run_id AND a."ready"
    AND a."path" LIKE 'artifacts/%'
    AND NOT (a."path" = ANY(p_paths));
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  RAISE;
END
$$;--> statement-breakpoint

REVOKE ALL ON FUNCTION companion_reconcile_skill_run_artifact_paths(uuid, uuid, text, text, text[]) FROM PUBLIC;
