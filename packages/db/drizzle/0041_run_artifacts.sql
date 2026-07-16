CREATE TABLE "skill_run_artifacts" (
  "id" uuid PRIMARY KEY NOT NULL,
  "org_id" uuid NOT NULL,
  "run_id" uuid NOT NULL,
  "path" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "previewable" boolean DEFAULT false NOT NULL,
  "storage_key" text NOT NULL,
  "ready" boolean DEFAULT false NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_run_artifacts_storage_key_uq" UNIQUE("storage_key"),
  CONSTRAINT "skill_run_artifacts_run_path_uq" UNIQUE("org_id", "run_id", "path"),
  CONSTRAINT "skill_run_artifacts_path_check" CHECK (char_length("path") BETWEEN 1 AND 1024 AND "path" !~ '(^|/)\.\.?(/|$)'),
  CONSTRAINT "skill_run_artifacts_file_name_check" CHECK (char_length("file_name") BETWEEN 1 AND 255),
  CONSTRAINT "skill_run_artifacts_size_check" CHECK ("byte_size" > 0 AND "byte_size" <= 10485760)
);--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" ADD CONSTRAINT "skill_run_artifacts_run_fk"
  FOREIGN KEY ("org_id", "run_id") REFERENCES "skill_runs"("org_id", "id") ON DELETE cascade;--> statement-breakpoint
CREATE INDEX "skill_run_artifacts_run_idx" ON "skill_run_artifacts" ("org_id", "run_id", "ready", "expires_at");--> statement-breakpoint
CREATE INDEX "skill_run_artifacts_expiry_idx" ON "skill_run_artifacts" ("expires_at", "updated_at");--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_artifacts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint

CREATE POLICY "skill_run_artifacts_creator" ON "skill_run_artifacts"
USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM "skill_runs" r
    WHERE r."org_id" = "skill_run_artifacts"."org_id"
      AND r."id" = "skill_run_artifacts"."run_id"
      AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')
  )
)
WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM "skill_runs" r
    WHERE r."org_id" = "skill_run_artifacts"."org_id"
      AND r."id" = "skill_run_artifacts"."run_id"
      AND r."creator_id" = NULLIF(current_setting('app.user_id', true), '')
  )
);--> statement-breakpoint

-- The worker never receives a tenant-wide bypass. A write is valid only for its exact live lease.
CREATE POLICY "skill_run_artifacts_exact_worker_lease_select" ON "skill_run_artifacts" FOR SELECT USING (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM "skill_run_jobs" j
    WHERE j."org_id" = "skill_run_artifacts"."org_id"
      AND j."run_id" = "skill_run_artifacts"."run_id"
      AND j."creator_id" = NULLIF(current_setting('app.run_worker_creator_id', true), '')
      AND j."status" = 'leased'
      AND j."lease_owner" = NULLIF(current_setting('app.run_worker_id', true), '')
      AND j."lease_expires_at" > clock_timestamp()
  )
);--> statement-breakpoint
CREATE POLICY "skill_run_artifacts_exact_worker_lease_insert" ON "skill_run_artifacts" FOR INSERT WITH CHECK (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM "skill_run_jobs" j
    WHERE j."org_id" = "skill_run_artifacts"."org_id"
      AND j."run_id" = "skill_run_artifacts"."run_id"
      AND j."creator_id" = NULLIF(current_setting('app.run_worker_creator_id', true), '')
      AND j."status" = 'leased'
      AND j."lease_owner" = NULLIF(current_setting('app.run_worker_id', true), '')
      AND j."lease_expires_at" > clock_timestamp()
  )
);--> statement-breakpoint
CREATE POLICY "skill_run_artifacts_exact_worker_lease_update" ON "skill_run_artifacts" FOR UPDATE
USING (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
)
WITH CHECK (
  companion_run_policy_definer()
  AND current_setting('app.run_worker', true) = 'exact_lease'
  AND "org_id" = NULLIF(current_setting('app.run_worker_org_id', true), '')::uuid
  AND "run_id" = NULLIF(current_setting('app.run_worker_run_id', true), '')::uuid
  AND EXISTS (
    SELECT 1 FROM "skill_run_jobs" j
    WHERE j."org_id" = "skill_run_artifacts"."org_id"
      AND j."run_id" = "skill_run_artifacts"."run_id"
      AND j."creator_id" = NULLIF(current_setting('app.run_worker_creator_id', true), '')
      AND j."status" = 'leased'
      AND j."lease_owner" = NULLIF(current_setting('app.run_worker_id', true), '')
      AND j."lease_expires_at" > clock_timestamp()
  )
);--> statement-breakpoint

-- Establish the exact lease context around reservation/finalization. The object upload occurs
-- between these calls, so readers can never observe metadata before the bytes exist.
CREATE FUNCTION companion_put_skill_run_artifact_metadata(
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
  -- Serialize reservations for one run so repeated turns cannot evade the run-wide caps by each
  -- presenting a valid bounded batch. Replacing the same path subtracts its previous size.
  PERFORM 1 FROM public."skill_runs" r
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id
  FOR UPDATE;
  IF (
    SELECT count(*) >= 20
    FROM public."skill_run_artifacts" a
    WHERE a."org_id" = p_org_id AND a."run_id" = p_run_id AND a."path" <> p_path
  ) OR (
    SELECT COALESCE(sum(a."byte_size"), 0) + p_byte_size > 104857600
    FROM public."skill_run_artifacts" a
    WHERE a."org_id" = p_org_id AND a."run_id" = p_run_id AND a."path" <> p_path
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
    "previewable", "storage_key", "ready", "expires_at", "updated_at"
  ) VALUES (
    p_id, p_org_id, p_run_id, p_path, p_file_name, p_content_type, p_byte_size,
    p_previewable, p_storage_key, p_ready, p_expires_at, clock_timestamp()
  )
  ON CONFLICT ("org_id", "run_id", "path") DO UPDATE SET
    "file_name" = EXCLUDED."file_name", "content_type" = EXCLUDED."content_type",
    "byte_size" = EXCLUDED."byte_size", "previewable" = EXCLUDED."previewable",
    "storage_key" = EXCLUDED."storage_key", "ready" = EXCLUDED."ready",
    "expires_at" = EXCLUDED."expires_at", "updated_at" = clock_timestamp();
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
REVOKE ALL ON FUNCTION companion_put_skill_run_artifact_metadata(uuid, uuid, text, text, uuid, text, text, text, integer, boolean, text, boolean, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_list_expired_skill_run_artifacts(p_stale_before timestamp with time zone, p_limit integer DEFAULT 250)
RETURNS TABLE ("id" uuid, "storage_key" text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT a."id", a."storage_key"
  FROM public."skill_run_artifacts" a
  WHERE (a."ready" AND a."expires_at" <= clock_timestamp())
     OR (NOT a."ready" AND a."updated_at" < p_stale_before)
  ORDER BY a."expires_at", a."updated_at", a."id"
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_list_expired_skill_run_artifacts(timestamp with time zone, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_lock_expired_skill_run_artifact(p_id uuid, p_storage_key text, p_stale_before timestamp with time zone)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE candidate uuid;
BEGIN
  SELECT a."id" INTO candidate
  FROM public."skill_run_artifacts" a
  WHERE a."id" = p_id AND a."storage_key" = p_storage_key
    AND ((a."ready" AND a."expires_at" <= clock_timestamp())
      OR (NOT a."ready" AND a."updated_at" < p_stale_before))
  FOR UPDATE;
  RETURN candidate IS NOT NULL;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_lock_expired_skill_run_artifact(uuid, text, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_complete_expired_skill_run_artifact(p_id uuid, p_storage_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  DELETE FROM public."skill_run_artifacts" WHERE "id" = p_id AND "storage_key" = p_storage_key
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_complete_expired_skill_run_artifact(uuid, text) FROM PUBLIC;
