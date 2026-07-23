ALTER TABLE "skill_run_artifacts" DROP CONSTRAINT "skill_run_artifacts_preview_kind_check";--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" ADD CONSTRAINT "skill_run_artifacts_preview_kind_check"
  CHECK ("preview_kind" IS NULL OR "preview_kind" IN ('text', 'markdown', 'csv', 'html', 'image', 'video', 'pdf', 'xlsx'));--> statement-breakpoint
ALTER TABLE "skill_run_attachments" DROP CONSTRAINT "skill_run_attachments_preview_kind_check";--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ADD CONSTRAINT "skill_run_attachments_preview_kind_check"
  CHECK ("preview_kind" IS NULL OR "preview_kind" IN ('text', 'markdown', 'csv', 'html', 'image', 'video', 'pdf', 'xlsx'));--> statement-breakpoint

-- Keep v2 intact for rolling workers. v3 delegates its lease/quota/reservation checks to v2 and
-- applies the additive HTML renderer classification only after v2 accepted the exact worker lease.
CREATE FUNCTION companion_put_skill_run_artifact_metadata_v3(
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
  p_expires_at timestamp with time zone,
  p_preview_kind text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  stored boolean;
  previous_worker_context text;
  previous_worker_id text;
  previous_worker_org_id text;
  previous_worker_run_id text;
  previous_worker_creator_id text;
BEGIN
  IF p_preview_kind IS NOT NULL
    AND p_preview_kind NOT IN ('text', 'markdown', 'csv', 'html', 'image', 'video', 'pdf', 'xlsx') THEN
    RETURN false;
  END IF;

  stored := public.companion_put_skill_run_artifact_metadata_v2(
    p_org_id, p_run_id, p_creator_id, p_worker_id, p_id, p_path, p_file_name,
    p_content_type, p_byte_size, p_previewable, p_storage_key, p_ready, p_expires_at,
    CASE WHEN p_preview_kind = 'html' THEN NULL ELSE p_preview_kind END
  );
  IF NOT stored THEN
    RETURN false;
  END IF;

  IF p_preview_kind = 'html' THEN
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
    UPDATE public."skill_run_artifacts"
    SET "preview_kind" = 'html'
    WHERE "org_id" = p_org_id AND "run_id" = p_run_id AND "id" = p_id AND "path" = p_path;
    stored := FOUND;
    PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
    PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
    PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
    PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
    PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
    IF NOT stored THEN
      RETURN false;
    END IF;
  END IF;
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

REVOKE ALL ON FUNCTION companion_put_skill_run_artifact_metadata_v3(uuid, uuid, text, text, uuid, text, text, text, integer, boolean, text, boolean, timestamp with time zone, text) FROM PUBLIC;
