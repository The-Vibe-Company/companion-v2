ALTER TABLE "skill_run_prompts" ADD COLUMN "user_text" text;--> statement-breakpoint
UPDATE "skill_run_prompts" p
SET "user_text" = CASE
  WHEN p."kind" = 'initial' THEN r."prompt"
  ELSE p."prompt"
END
FROM "skill_runs" r
WHERE r."org_id" = p."org_id" AND r."id" = p."run_id";--> statement-breakpoint
CREATE FUNCTION companion_fill_legacy_skill_run_prompt_user_text()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW."user_text" IS NULL THEN
    IF NEW."kind" = 'initial' THEN
      SELECT r."prompt" INTO NEW."user_text"
      FROM public."skill_runs" r
      WHERE r."org_id" = NEW."org_id" AND r."id" = NEW."run_id";
    ELSE
      NEW."user_text" := NEW."prompt";
    END IF;
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "skill_run_prompts_legacy_user_text"
BEFORE INSERT OR UPDATE ON "skill_run_prompts"
FOR EACH ROW EXECUTE FUNCTION companion_fill_legacy_skill_run_prompt_user_text();--> statement-breakpoint
ALTER TABLE "skill_run_prompts" ALTER COLUMN "user_text" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skill_run_prompts" ADD CONSTRAINT "skill_run_prompts_identity_uq" UNIQUE("org_id", "run_id", "id");--> statement-breakpoint

ALTER TABLE "skill_run_attachments" ADD COLUMN "prompt_id" uuid;--> statement-breakpoint
UPDATE "skill_run_attachments" a
SET "prompt_id" = p."id"
FROM "skill_run_prompts" p
WHERE p."org_id" = a."org_id" AND p."run_id" = a."run_id" AND p."ordinal" = 0;--> statement-breakpoint
ALTER TABLE "skill_run_attachments" ADD CONSTRAINT "skill_run_attachments_prompt_fk"
  FOREIGN KEY ("org_id", "run_id", "prompt_id")
  REFERENCES "skill_run_prompts"("org_id", "run_id", "id") ON DELETE cascade;--> statement-breakpoint
CREATE FUNCTION companion_link_legacy_skill_run_attachment_prompt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
  initial_prompt_id uuid;
BEGIN
  IF NEW."prompt_id" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  SELECT p."id" INTO initial_prompt_id
  FROM public."skill_run_prompts" p
  WHERE p."org_id" = NEW."org_id" AND p."run_id" = NEW."run_id" AND p."ordinal" = 0;
  IF initial_prompt_id IS NULL THEN
    RAISE EXCEPTION 'run attachment requires a durable prompt' USING ERRCODE = '23502';
  END IF;
  UPDATE public."skill_run_attachments"
  SET "prompt_id" = initial_prompt_id
  WHERE "id" = NEW."id" AND "prompt_id" IS NULL;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "skill_run_attachments_legacy_prompt"
AFTER INSERT OR UPDATE ON "skill_run_attachments"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW WHEN (NEW."prompt_id" IS NULL)
EXECUTE FUNCTION companion_link_legacy_skill_run_attachment_prompt();--> statement-breakpoint

ALTER TABLE "skill_run_worker_heartbeats"
  ADD COLUMN "attachment_prompt_protocol" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "skill_run_worker_heartbeats"
  ADD CONSTRAINT "skill_run_worker_heartbeats_attachment_protocol_check"
  CHECK ("attachment_prompt_protocol" BETWEEN 0 AND 1);--> statement-breakpoint
CREATE FUNCTION companion_heartbeat_skill_run_worker(
  p_worker_id text,
  p_ttl_seconds integer,
  p_attachment_prompt_protocol integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF p_worker_id IS NULL OR length(btrim(p_worker_id)) < 1 OR length(p_worker_id) > 512 THEN
    RAISE EXCEPTION 'valid worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_ttl_seconds < 5 OR p_ttl_seconds > 300 THEN
    RAISE EXCEPTION 'invalid worker heartbeat ttl' USING ERRCODE = '22023';
  END IF;
  IF p_attachment_prompt_protocol <> 1 THEN
    RAISE EXCEPTION 'invalid attachment prompt protocol' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public."skill_run_worker_heartbeats"
    ("worker_id", "expires_at", "updated_at", "attachment_prompt_protocol")
  VALUES (
    p_worker_id,
    clock_timestamp() + make_interval(secs => p_ttl_seconds),
    clock_timestamp(),
    p_attachment_prompt_protocol
  )
  ON CONFLICT ("worker_id") DO UPDATE
  SET "expires_at" = EXCLUDED."expires_at",
      "updated_at" = EXCLUDED."updated_at",
      "attachment_prompt_protocol" = EXCLUDED."attachment_prompt_protocol";
  DELETE FROM public."skill_run_worker_heartbeats"
  WHERE "expires_at" <= clock_timestamp() - interval '1 hour';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_heartbeat_skill_run_worker(text, integer, integer) FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION companion_skill_run_attachment_worker_ready(
  p_org_id uuid,
  p_run_id uuid,
  p_creator_id text
)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."skill_run_jobs" j
    JOIN public."skill_run_worker_heartbeats" h ON h."worker_id" = j."lease_owner"
    WHERE j."org_id" = p_org_id
      AND j."run_id" = p_run_id
      AND j."creator_id" = p_creator_id
      AND j."status" = 'leased'
      AND j."lease_expires_at" > clock_timestamp()
      AND h."expires_at" > clock_timestamp()
      AND h."attachment_prompt_protocol" >= 1
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_skill_run_attachment_worker_ready(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION companion_skill_run_attachment_worker_ready()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."skill_run_worker_heartbeats" h
    WHERE h."expires_at" > clock_timestamp()
      AND h."attachment_prompt_protocol" >= 1
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_skill_run_attachment_worker_ready() FROM PUBLIC;--> statement-breakpoint

-- A rolling protocol-0 worker must not reclaim a job after a protocol-1 worker accepted files.
CREATE OR REPLACE FUNCTION companion_claim_skill_run_jobs(p_worker_id text, p_limit integer DEFAULT 1, p_lease_seconds integer DEFAULT 30)
RETURNS SETOF "skill_run_jobs"
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  previous_worker_context text;
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'worker id is required' USING ERRCODE = '22023';
  END IF;
  IF p_limit < 1 OR p_limit > 32 OR p_lease_seconds < 5 OR p_lease_seconds > 300 THEN
    RAISE EXCEPTION 'invalid claim limits' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  PERFORM set_config('app.run_worker', 'claim', true);
  RETURN QUERY
  WITH candidates AS (
    SELECT j."id"
    FROM public."skill_run_jobs" j
    WHERE j."available_at" <= clock_timestamp()
      AND (
        (j."status" = 'queued' AND j."attempt" < j."max_attempts")
        OR (j."status" = 'leased' AND j."lease_expires_at" <= clock_timestamp())
      )
      AND (
        NOT EXISTS (
          SELECT 1
          FROM public."skill_run_prompts" p
          JOIN public."skill_run_attachments" a
            ON a."org_id" = p."org_id" AND a."run_id" = p."run_id" AND a."prompt_id" = p."id"
          WHERE p."org_id" = j."org_id" AND p."run_id" = j."run_id"
            AND p."kind" = 'follow_up'
            AND p."status" IN ('queued', 'processing')
        )
        OR EXISTS (
          SELECT 1 FROM public."skill_run_worker_heartbeats" h
          WHERE h."worker_id" = p_worker_id
            AND h."expires_at" > clock_timestamp()
            AND h."attachment_prompt_protocol" >= 1
        )
      )
    ORDER BY j."available_at", j."created_at", j."id"
    FOR UPDATE OF j SKIP LOCKED
    LIMIT p_limit
  )
  UPDATE public."skill_run_jobs" j
  SET "status" = 'leased',
      "attempt" = CASE WHEN j."status" = 'queued' THEN j."attempt" + 1 ELSE j."attempt" END,
      "lease_reclaim_count" = CASE WHEN j."status" = 'leased' THEN j."lease_reclaim_count" + 1 ELSE j."lease_reclaim_count" END,
      "lease_owner" = p_worker_id,
      "lease_expires_at" = clock_timestamp() + make_interval(secs => p_lease_seconds),
      "heartbeat_at" = clock_timestamp(),
      "updated_at" = clock_timestamp()
  FROM candidates c
  WHERE j."id" = c."id"
  RETURNING j.*;
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_claim_skill_run_jobs(text, integer, integer) FROM PUBLIC;--> statement-breakpoint

CREATE TABLE "skill_run_attachment_uploads" (
  "storage_key" text PRIMARY KEY,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "creator_id" text NOT NULL REFERENCES "user"("id") ON DELETE cascade,
  "touched_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint
CREATE INDEX "skill_run_attachment_uploads_age_idx" ON "skill_run_attachment_uploads" ("touched_at");--> statement-breakpoint
ALTER TABLE "skill_run_attachment_uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "skill_run_attachment_uploads" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "skill_run_attachment_uploads_creator" ON "skill_run_attachment_uploads"
USING (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
)
WITH CHECK (
  "org_id" = NULLIF(current_setting('app.org_id', true), '')::uuid
  AND "creator_id" = NULLIF(current_setting('app.user_id', true), '')
);--> statement-breakpoint
CREATE FUNCTION companion_lock_skill_run_attachment_orphan(p_storage_key text, p_before timestamp with time zone)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE candidate text;
BEGIN
  SELECT u."storage_key" INTO candidate
  FROM public."skill_run_attachment_uploads" u
  WHERE u."storage_key" = p_storage_key AND u."touched_at" < p_before
  FOR UPDATE;
  IF candidate IS NULL THEN RETURN false; END IF;
  IF EXISTS (
    SELECT 1 FROM public."skill_run_attachments" a WHERE a."storage_key" = p_storage_key
  ) THEN
    -- A retry may recreate a reservation after the original request committed, then fail before
    -- replaying it. The durable attachment proves the object must stay; only the stale reservation
    -- is redundant. Removing it here also prevents old referenced rows from starving the sweep.
    DELETE FROM public."skill_run_attachment_uploads" WHERE "storage_key" = p_storage_key;
    RETURN false;
  END IF;
  RETURN true;
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_lock_skill_run_attachment_orphan(text, timestamp with time zone) FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION companion_complete_skill_run_attachment_orphan(p_storage_key text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  DELETE FROM public."skill_run_attachment_uploads" WHERE "storage_key" = p_storage_key
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_complete_skill_run_attachment_orphan(text) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION companion_defer_skill_run_attachment_orphan(p_storage_key text, p_before timestamp with time zone)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH deferred AS (
    UPDATE public."skill_run_attachment_uploads" u
    SET "touched_at" = clock_timestamp()
    WHERE u."storage_key" = p_storage_key
      AND u."touched_at" < p_before
      AND NOT EXISTS (
        SELECT 1 FROM public."skill_run_attachments" a WHERE a."storage_key" = p_storage_key
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM deferred)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_defer_skill_run_attachment_orphan(text, timestamp with time zone) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION companion_list_skill_run_attachment_orphans(p_before timestamp with time zone, p_limit integer)
RETURNS TABLE (storage_key text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT u."storage_key"
  FROM public."skill_run_attachment_uploads" u
  WHERE u."touched_at" < p_before
  ORDER BY u."touched_at", u."storage_key"
  LIMIT LEAST(GREATEST(p_limit, 1), 1000)
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_list_skill_run_attachment_orphans(timestamp with time zone, integer) FROM PUBLIC;
