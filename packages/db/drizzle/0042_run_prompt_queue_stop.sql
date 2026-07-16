ALTER TABLE "skill_run_worker_heartbeats"
  ADD COLUMN "turn_stop_protocol" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "skill_run_worker_heartbeats"
  ADD CONSTRAINT "skill_run_worker_heartbeats_turn_stop_protocol_check"
  CHECK ("turn_stop_protocol" BETWEEN 0 AND 1);--> statement-breakpoint
ALTER TABLE "skill_run_prompts"
  ADD COLUMN "cancel_requested_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "skill_run_prompts_run_status_ordinal_idx"
  ON "skill_run_prompts" ("org_id", "run_id", "status", "ordinal");--> statement-breakpoint
ALTER TABLE "skill_run_attachments"
  ADD COLUMN "preview_content_type" text;--> statement-breakpoint

-- A canceled queued prompt that never entered processing keeps attachment metadata until S3
-- deletion succeeds. A stopped processing prompt retains its files with the partial transcript.
-- This makes deferred cleanup crash-safe and keeps unswept bytes charged against the run's cap.
CREATE OR REPLACE FUNCTION companion_lock_skill_run_attachment_orphan(
  p_storage_key text,
  p_before timestamp with time zone
)
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
    SELECT 1
    FROM public."skill_run_attachments" a
    LEFT JOIN public."skill_run_prompts" p
      ON p."org_id" = a."org_id" AND p."run_id" = a."run_id" AND p."id" = a."prompt_id"
    WHERE a."storage_key" = p_storage_key
      AND (p."id" IS NULL OR p."status" <> 'canceled' OR p."attempt" > 0)
  ) THEN
    DELETE FROM public."skill_run_attachment_uploads" WHERE "storage_key" = p_storage_key;
    RETURN false;
  END IF;
  RETURN true;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION companion_complete_skill_run_attachment_orphan(p_storage_key text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  DELETE FROM public."skill_run_attachments" a
  USING public."skill_run_prompts" p
  WHERE a."storage_key" = p_storage_key
    AND p."org_id" = a."org_id"
    AND p."run_id" = a."run_id"
    AND p."id" = a."prompt_id"
    AND p."status" = 'canceled'
    AND p."attempt" = 0;
  DELETE FROM public."skill_run_attachment_uploads" WHERE "storage_key" = p_storage_key;
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION companion_defer_skill_run_attachment_orphan(
  p_storage_key text,
  p_before timestamp with time zone
)
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
        SELECT 1
        FROM public."skill_run_attachments" a
        LEFT JOIN public."skill_run_prompts" p
          ON p."org_id" = a."org_id" AND p."run_id" = a."run_id" AND p."id" = a."prompt_id"
        WHERE a."storage_key" = p_storage_key
          AND (p."id" IS NULL OR p."status" <> 'canceled' OR p."attempt" > 0)
      )
    RETURNING 1
  )
  SELECT EXISTS (SELECT 1 FROM deferred)
$$;--> statement-breakpoint

-- Membership revocation bypasses creator RLS under an exact worker lease. Keep its bulk prompt
-- terminalization on the same replayable protocol as ordinary worker/API transitions.
CREATE OR REPLACE FUNCTION companion_terminalize_revoked_skill_run(
  p_org_id uuid,
  p_run_id uuid,
  p_creator_id text,
  p_worker_id text,
  p_cleanup_confirmed boolean DEFAULT false
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
  previous_org_id text;
  cancellation boolean;
  failure_phase "skill_run_phase";
  folded_sequence integer;
  next_sequence integer;
  prompt_record record;
  terminal_prompt_status "skill_run_prompt_status";
BEGIN
  IF p_org_id IS NULL OR p_run_id IS NULL OR p_creator_id IS NULL OR btrim(p_creator_id) = ''
    OR p_worker_id IS NULL OR btrim(p_worker_id) = '' THEN
    RAISE EXCEPTION 'complete worker lease identity is required' USING ERRCODE = '22023';
  END IF;
  previous_worker_context := current_setting('app.run_worker', true);
  previous_worker_id := current_setting('app.run_worker_id', true);
  previous_worker_org_id := current_setting('app.run_worker_org_id', true);
  previous_worker_run_id := current_setting('app.run_worker_run_id', true);
  previous_worker_creator_id := current_setting('app.run_worker_creator_id', true);
  previous_org_id := current_setting('app.org_id', true);
  PERFORM set_config('app.run_worker', 'exact_lease', true);
  PERFORM set_config('app.run_worker_id', p_worker_id, true);
  PERFORM set_config('app.run_worker_org_id', p_org_id::text, true);
  PERFORM set_config('app.run_worker_run_id', p_run_id::text, true);
  PERFORM set_config('app.run_worker_creator_id', p_creator_id, true);
  PERFORM set_config('app.org_id', p_org_id::text, true);

  SELECT r."cancel_requested_at" IS NOT NULL OR r."status" = 'canceled',
         r."phase", r."transcript_event_sequence"
  INTO cancellation, failure_phase, folded_sequence
  FROM public."skill_runs" r
  JOIN public."skill_run_jobs" j
    ON j."org_id" = r."org_id" AND j."run_id" = r."id" AND j."creator_id" = r."creator_id"
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id AND r."creator_id" = p_creator_id
    AND j."status" = 'leased' AND j."lease_owner" = p_worker_id
    AND j."lease_expires_at" > clock_timestamp()
    AND NOT EXISTS (
      SELECT 1 FROM public."memberships" m
      WHERE m."org_id" = r."org_id" AND m."user_id" = r."creator_id"
    )
  FOR UPDATE OF r, j;
  IF cancellation IS NULL THEN
    PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
    PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
    PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
    PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
    PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
    PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
    RETURN false;
  END IF;

  UPDATE public."skill_runs" r
  SET "status" = CASE WHEN cancellation THEN 'canceled'::"skill_run_status" ELSE 'error'::"skill_run_status" END,
      "phase" = CASE WHEN cancellation THEN 'complete'::"skill_run_phase" ELSE failure_phase END,
      "error_code" = CASE WHEN cancellation THEN NULL ELSE 'membership_revoked' END,
      "user_message" = CASE WHEN cancellation THEN NULL ELSE 'Run stopped because its owner is no longer an organization member' END,
      "frozen_at" = clock_timestamp(),
      "sandbox_cleaned_at" = CASE
        WHEN p_cleanup_confirmed THEN COALESCE(r."sandbox_cleaned_at", clock_timestamp())
        ELSE r."sandbox_cleaned_at"
      END,
      "updated_at" = clock_timestamp()
  WHERE r."org_id" = p_org_id AND r."id" = p_run_id AND r."creator_id" = p_creator_id;

  IF NOT cancellation THEN
    SELECT GREATEST(COALESCE(MAX(e."sequence"), 0), folded_sequence) + 1 INTO next_sequence
    FROM public."skill_run_events" e
    WHERE e."org_id" = p_org_id AND e."run_id" = p_run_id;
    INSERT INTO public."skill_run_events" ("org_id", "run_id", "sequence", "type", "payload")
    VALUES (
      p_org_id,
      p_run_id,
      next_sequence,
      'run.error',
      jsonb_build_object(
        'code', 'membership_revoked',
        'message', 'Run stopped because its owner is no longer an organization member',
        'phase', failure_phase::text
      )
    );
  END IF;

  terminal_prompt_status := CASE
    WHEN cancellation THEN 'canceled'::"skill_run_prompt_status"
    ELSE 'error'::"skill_run_prompt_status"
  END;
  FOR prompt_record IN
    SELECT p."id", p."message_id", p."ordinal"
    FROM public."skill_run_prompts" p
    WHERE p."org_id" = p_org_id AND p."run_id" = p_run_id
      AND p."status" IN ('queued', 'processing')
    ORDER BY p."ordinal"
    FOR UPDATE
  LOOP
    UPDATE public."skill_run_prompts" p
    SET "status" = terminal_prompt_status,
        "cancel_requested_at" = CASE
          WHEN cancellation THEN COALESCE(p."cancel_requested_at", clock_timestamp())
          ELSE p."cancel_requested_at"
        END,
        "error_code" = CASE WHEN cancellation THEN NULL ELSE 'membership_revoked' END,
        "user_message" = CASE WHEN cancellation THEN NULL ELSE 'Run stopped because its owner is no longer an organization member' END,
        "lease_owner" = NULL,
        "lease_expires_at" = NULL,
        "heartbeat_at" = clock_timestamp(),
        "completed_at" = clock_timestamp(),
        "updated_at" = clock_timestamp()
    WHERE p."org_id" = p_org_id AND p."run_id" = p_run_id AND p."id" = prompt_record."id";
    SELECT GREATEST(COALESCE(MAX(e."sequence"), 0), folded_sequence) + 1 INTO next_sequence
    FROM public."skill_run_events" e
    WHERE e."org_id" = p_org_id AND e."run_id" = p_run_id;
    INSERT INTO public."skill_run_events" ("org_id", "run_id", "sequence", "type", "payload")
    VALUES (
      p_org_id,
      p_run_id,
      next_sequence,
      'prompt.status',
      jsonb_build_object(
        'prompt_id', prompt_record."id",
        'message_id', prompt_record."message_id",
        'ordinal', prompt_record."ordinal",
        'status', terminal_prompt_status::text
      )
    );
  END LOOP;

  UPDATE public."skill_run_jobs" j
  SET "status" = CASE WHEN cancellation THEN 'canceled'::"skill_run_job_status" ELSE 'failed'::"skill_run_job_status" END,
      "phase" = CASE WHEN cancellation THEN 'complete'::"skill_run_phase" ELSE failure_phase END,
      "lease_owner" = NULL, "lease_expires_at" = NULL,
      "heartbeat_at" = clock_timestamp(), "last_error_code" = CASE WHEN cancellation THEN NULL ELSE 'membership_revoked' END,
      "updated_at" = clock_timestamp()
  WHERE j."org_id" = p_org_id AND j."run_id" = p_run_id AND j."creator_id" = p_creator_id
    AND j."status" = 'leased' AND j."lease_owner" = p_worker_id;

  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
  RETURN true;
EXCEPTION WHEN OTHERS THEN
  PERFORM set_config('app.run_worker', COALESCE(previous_worker_context, ''), true);
  PERFORM set_config('app.run_worker_id', COALESCE(previous_worker_id, ''), true);
  PERFORM set_config('app.run_worker_org_id', COALESCE(previous_worker_org_id, ''), true);
  PERFORM set_config('app.run_worker_run_id', COALESCE(previous_worker_run_id, ''), true);
  PERFORM set_config('app.run_worker_creator_id', COALESCE(previous_worker_creator_id, ''), true);
  PERFORM set_config('app.org_id', COALESCE(previous_org_id, ''), true);
  RAISE;
END
$$;--> statement-breakpoint

-- Old binaries may reuse a stable worker id during rollback. Their heartbeat must explicitly
-- clear capabilities introduced by newer binaries instead of retaining a stale value on conflict.
CREATE OR REPLACE FUNCTION companion_heartbeat_skill_run_worker(
  p_worker_id text,
  p_ttl_seconds integer DEFAULT 15
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
  INSERT INTO public."skill_run_worker_heartbeats" (
    "worker_id", "expires_at", "updated_at", "attachment_prompt_protocol", "turn_stop_protocol"
  ) VALUES (
    p_worker_id,
    clock_timestamp() + make_interval(secs => p_ttl_seconds),
    clock_timestamp(),
    0,
    0
  )
  ON CONFLICT ("worker_id") DO UPDATE
  SET "expires_at" = EXCLUDED."expires_at",
      "updated_at" = EXCLUDED."updated_at",
      "attachment_prompt_protocol" = 0,
      "turn_stop_protocol" = 0;
  DELETE FROM public."skill_run_worker_heartbeats"
  WHERE "expires_at" <= clock_timestamp() - interval '1 hour';
END
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION companion_heartbeat_skill_run_worker(
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
  INSERT INTO public."skill_run_worker_heartbeats" (
    "worker_id", "expires_at", "updated_at", "attachment_prompt_protocol", "turn_stop_protocol"
  ) VALUES (
    p_worker_id,
    clock_timestamp() + make_interval(secs => p_ttl_seconds),
    clock_timestamp(),
    p_attachment_prompt_protocol,
    0
  )
  ON CONFLICT ("worker_id") DO UPDATE
  SET "expires_at" = EXCLUDED."expires_at",
      "updated_at" = EXCLUDED."updated_at",
      "attachment_prompt_protocol" = EXCLUDED."attachment_prompt_protocol",
      "turn_stop_protocol" = 0;
  DELETE FROM public."skill_run_worker_heartbeats"
  WHERE "expires_at" <= clock_timestamp() - interval '1 hour';
END
$$;--> statement-breakpoint

-- Protocol 1 advertises both prompt-scoped attachment mounting and prompt-scoped stop barriers.
-- Keep the older overloads during rolling deploys; only this overload marks a worker stop-capable.
CREATE FUNCTION companion_heartbeat_skill_run_worker(
  p_worker_id text,
  p_ttl_seconds integer,
  p_attachment_prompt_protocol integer,
  p_turn_stop_protocol integer
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
  IF p_turn_stop_protocol <> 1 THEN
    RAISE EXCEPTION 'invalid turn stop protocol' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public."skill_run_worker_heartbeats" (
    "worker_id", "expires_at", "updated_at", "attachment_prompt_protocol", "turn_stop_protocol"
  ) VALUES (
    p_worker_id,
    clock_timestamp() + make_interval(secs => p_ttl_seconds),
    clock_timestamp(),
    p_attachment_prompt_protocol,
    p_turn_stop_protocol
  )
  ON CONFLICT ("worker_id") DO UPDATE
  SET "expires_at" = EXCLUDED."expires_at",
      "updated_at" = EXCLUDED."updated_at",
      "attachment_prompt_protocol" = EXCLUDED."attachment_prompt_protocol",
      "turn_stop_protocol" = EXCLUDED."turn_stop_protocol";
  DELETE FROM public."skill_run_worker_heartbeats"
  WHERE "expires_at" <= clock_timestamp() - interval '1 hour';
END
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_heartbeat_skill_run_worker(text, integer, integer, integer) FROM PUBLIC;--> statement-breakpoint

CREATE FUNCTION companion_skill_run_turn_stop_worker_ready(
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
      AND h."turn_stop_protocol" >= 1
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_skill_run_turn_stop_worker_ready(uuid, uuid, text) FROM PUBLIC;--> statement-breakpoint
CREATE FUNCTION companion_skill_run_turn_stop_worker_ready()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public."skill_run_worker_heartbeats" h
    WHERE h."expires_at" > clock_timestamp()
      AND h."turn_stop_protocol" >= 1
  )
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION companion_skill_run_turn_stop_worker_ready() FROM PUBLIC;--> statement-breakpoint

-- A rolling protocol-0 worker must not reclaim a run after queued follow-ups were admitted.
CREATE OR REPLACE FUNCTION companion_claim_skill_run_jobs(
  p_worker_id text,
  p_limit integer DEFAULT 1,
  p_lease_seconds integer DEFAULT 30
)
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
      AND (
        NOT EXISTS (
          SELECT 1 FROM public."skill_run_prompts" p
          WHERE p."org_id" = j."org_id" AND p."run_id" = j."run_id"
            AND (
              (p."kind" = 'follow_up' AND p."status" IN ('queued', 'processing'))
              OR (p."status" = 'processing' AND p."cancel_requested_at" IS NOT NULL)
            )
        )
        OR EXISTS (
          SELECT 1 FROM public."skill_run_worker_heartbeats" h
          WHERE h."worker_id" = p_worker_id
            AND h."expires_at" > clock_timestamp()
            AND h."turn_stop_protocol" >= 1
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
REVOKE ALL ON FUNCTION companion_claim_skill_run_jobs(text, integer, integer) FROM PUBLIC;
