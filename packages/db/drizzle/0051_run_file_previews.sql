ALTER TABLE "skill_run_artifacts" ADD COLUMN "preview_kind" text;--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ADD COLUMN "preview_kind" text;--> statement-breakpoint

ALTER TABLE "skill_run_artifacts" ADD CONSTRAINT "skill_run_artifacts_preview_kind_check"
  CHECK ("preview_kind" IS NULL OR "preview_kind" IN ('text', 'markdown', 'csv', 'image', 'video', 'pdf', 'xlsx'));--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ADD CONSTRAINT "skill_run_attachments_preview_kind_check"
  CHECK ("preview_kind" IS NULL OR "preview_kind" IN ('text', 'markdown', 'csv', 'image', 'video', 'pdf', 'xlsx'));--> statement-breakpoint

-- Only backfill formats whose existing metadata was already established by server-side signature
-- checks, or text formats which remain safe when rendered as escaped text. HTML and SVG stay null.
UPDATE "skill_run_artifacts"
SET "preview_kind" = CASE
  WHEN "previewable" AND "content_type" LIKE 'image/%' AND "content_type" <> 'image/svg+xml' THEN 'image'
  WHEN "previewable" AND "content_type" LIKE 'video/%' THEN 'video'
  WHEN "content_type" LIKE 'text/markdown%' THEN 'markdown'
  WHEN "content_type" LIKE 'text/csv%' THEN 'csv'
  WHEN "content_type" LIKE 'text/plain%' OR "content_type" IN ('application/json', 'application/yaml') THEN 'text'
  ELSE NULL
END;--> statement-breakpoint
UPDATE "skill_run_attachments"
SET "preview_kind" = CASE
  WHEN "preview_content_type" LIKE 'image/%' AND "preview_content_type" <> 'image/svg+xml' THEN 'image'
  WHEN "preview_content_type" LIKE 'video/%' THEN 'video'
  ELSE NULL
END;--> statement-breakpoint

CREATE FUNCTION companion_put_skill_run_artifact_metadata_v2(
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
  previous_worker_context text;
  previous_worker_id text;
  previous_worker_org_id text;
  previous_worker_run_id text;
  previous_worker_creator_id text;
BEGIN
  IF p_preview_kind IS NOT NULL AND p_preview_kind NOT IN ('text', 'markdown', 'csv', 'image', 'video', 'pdf', 'xlsx') THEN
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
  IF (
    SELECT count(*) >= 20
    FROM public."skill_run_artifacts" a
    WHERE a."org_id" = p_org_id AND a."run_id" = p_run_id AND a."ready" AND a."path" <> p_path
  ) OR (
    SELECT COALESCE(sum(a."byte_size"), 0) + p_byte_size > 104857600
    FROM public."skill_run_artifacts" a
    WHERE a."org_id" = p_org_id AND a."run_id" = p_run_id AND a."ready" AND a."path" <> p_path
  ) THEN
    PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
    PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
    PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
    PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
    PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
    RETURN false;
  END IF;
  INSERT INTO public."skill_run_artifacts" (
    "id", "org_id", "run_id", "path", "file_name", "content_type", "byte_size",
    "previewable", "preview_kind", "storage_key", "ready", "expires_at", "updated_at"
  ) VALUES (
    p_id, p_org_id, p_run_id, p_path, p_file_name, p_content_type, p_byte_size,
    p_previewable, p_preview_kind, p_storage_key, p_ready, p_expires_at, clock_timestamp()
  )
  ON CONFLICT ("org_id", "run_id", "path") DO UPDATE SET
    "file_name" = EXCLUDED."file_name", "content_type" = EXCLUDED."content_type",
    "byte_size" = EXCLUDED."byte_size", "previewable" = EXCLUDED."previewable",
    "preview_kind" = EXCLUDED."preview_kind", "storage_key" = EXCLUDED."storage_key",
    "ready" = EXCLUDED."ready", "expires_at" = EXCLUDED."expires_at",
    "updated_at" = clock_timestamp();
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

CREATE FUNCTION companion_reconcile_skill_run_artifact_paths(
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
    -- A full scan is authoritative only for the managed ./artifacts tree. Raster files opened
    -- explicitly elsewhere are immutable cached snapshots and remain available until their TTL.
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
REVOKE ALL ON FUNCTION companion_put_skill_run_artifact_metadata_v2(uuid, uuid, text, text, uuid, text, text, text, integer, boolean, text, boolean, timestamp with time zone, text) FROM PUBLIC;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_reconcile_skill_run_artifact_paths(uuid, uuid, text, text, text[]) FROM PUBLIC;
