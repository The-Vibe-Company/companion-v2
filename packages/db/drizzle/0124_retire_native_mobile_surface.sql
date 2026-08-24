-- 0124: retire the native_mobile client surface.
--
-- The native mobile app is an ordinary chat client now: every surface stages the same profile —
-- library Skills, the Skills Hub token, member MCP accounts, and the config catalog — so nothing
-- may key behaviour on which client sent a turn. This migration rewrites the historical label to
-- mobile_web, clears material and applied-profile snapshots that were captured under the reduced
-- profile and outruns in-flight operations that froze it (fail closed: those Boxes restage fully
-- before their next turn), rebuilds the enum
-- without the retired value, and re-creates every function that mentioned it with the surface
-- branches removed. Grants are re-applied by the runtime-role-grants pass that follows every
-- migration run.

ALTER TABLE "companion_runtime_instances" DROP CONSTRAINT "companion_runtime_instances_material_snapshot_check";
--> statement-breakpoint
ALTER TABLE "companion_operations" DROP CONSTRAINT "companion_operations_material_snapshot_check";
--> statement-breakpoint

-- The surface columns are guarded by immutability triggers; the history rewrite and the column
-- retype below both need them out of the way. They are re-created verbatim at the end.
DROP TRIGGER "companion_turns_surface_immutable" ON "companion_turns";
--> statement-breakpoint
DROP TRIGGER "companion_operations_snapshot_immutable" ON "companion_operations";
--> statement-breakpoint

-- History: turns and operations keep their row under the surviving mobile label.
UPDATE "companion_turns" SET "client_surface" = 'mobile_web' WHERE "client_surface" = 'native_mobile';
--> statement-breakpoint
UPDATE "companion_operations"
SET "material_staged_at" = NULL, "material_expires_at" = NULL
WHERE "client_surface" = 'native_mobile' AND "material_staged_at" IS NOT NULL AND "material_expires_at" IS NULL;
--> statement-breakpoint
-- An operation already enqueued under native_mobile carries the reduced resource snapshot its
-- intent trigger froze at insert (no skills, no MCP accounts, can_write_skills=false), and the
-- snapshot columns are immutable by design. Rather than rewrite them, bump the desired settings
-- revision past every such in-flight operation's target: when the operation settles, applied stays
-- behind desired, so the next turn restages the full profile instead of recording the reduced one
-- as applied.
UPDATE "companion_runtime_instances" i
SET "desired_settings_revision" = i."desired_settings_revision" + 1
WHERE EXISTS (
  SELECT 1 FROM "companion_operations" o
  WHERE o."org_id" = i."org_id" AND o."companion_id" = i."companion_id"
    AND o."client_surface" = 'native_mobile' AND o."settled_at" IS NULL
);
--> statement-breakpoint
UPDATE "companion_operations" SET "client_surface" = 'mobile_web' WHERE "client_surface" = 'native_mobile';
--> statement-breakpoint

-- A profile applied under the reduced surface is not a valid profile any more: mark those
-- instances as never staged so the next turn performs a full settings staging, and drop their
-- expiry-less material snapshots for the same reason.
UPDATE "companion_runtime_instances"
SET "applied_client_surface" = NULL, "applied_settings_revision" = 0
WHERE "applied_client_surface" = 'native_mobile';
--> statement-breakpoint
UPDATE "companion_runtime_instances"
SET "settings_claim_client_surface" = 'mobile_web'
WHERE "settings_claim_client_surface" = 'native_mobile';
--> statement-breakpoint
UPDATE "companion_runtime_instances"
SET "material_client_surface" = NULL, "material_pi_invocation_id" = NULL, "material_expires_at" = NULL
WHERE "material_client_surface" = 'native_mobile';
--> statement-breakpoint
UPDATE "companion_runtime_instances"
SET "settings_claim_material_client_surface" = NULL,
    "settings_claim_material_staged_at" = NULL,
    "settings_claim_material_expires_at" = NULL
WHERE "settings_claim_material_client_surface" = 'native_mobile';
--> statement-breakpoint

-- Function-owner RLS policies pin the claim/authorize functions by OID, so the drops below would
-- otherwise be refused. Capture every dependent policy verbatim, drop it, and re-create it after
-- the functions exist again; the captured expression re-resolves the regprocedure at re-creation.
CREATE TEMPORARY TABLE "retired_surface_policies" ON COMMIT DROP AS
SELECT
  pol.polname AS name,
  pol.polrelid::regclass::text AS table_name,
  pol.polpermissive AS permissive,
  CASE pol.polcmd
    WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE'
    ELSE 'ALL'
  END AS command,
  (SELECT string_agg(
     CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE quote_ident(pg_get_userbyid(role_oid)) END, ', ')
   FROM unnest(pol.polroles) role_oid) AS roles,
  pg_get_expr(pol.polqual, pol.polrelid) AS using_expr,
  pg_get_expr(pol.polwithcheck, pol.polrelid) AS check_expr
FROM pg_policy pol
WHERE EXISTS (
  SELECT 1 FROM pg_depend d
  JOIN pg_proc p ON p.oid = d.refobjid
  WHERE d.classid = 'pg_policy'::regclass
    AND d.objid = pol.oid
    AND d.refclassid = 'pg_proc'::regclass
    AND p.proname IN (
      'companion_api_enqueue_turn',
      'companion_api_enqueue_operation',
      'companion_api_retry_turn',
      'companion_runtime_record_material_snapshot',
      'companion_runtime_claim_work',
      'companion_runtime_claim_work_material_v1',
      'companion_runtime_claim_work_without_delete_resume_guard',
      'companion_runtime_claim_work_without_material_guard',
      'companion_runtime_renew_and_authorize'
    )
);
--> statement-breakpoint
DO $retire_native_mobile_drop_policies$
DECLARE
  captured record;
BEGIN
  FOR captured IN SELECT DISTINCT name, table_name FROM "retired_surface_policies" LOOP
    EXECUTE format('DROP POLICY %I ON %s', captured.name, captured.table_name);
  END LOOP;
END
$retire_native_mobile_drop_policies$;
--> statement-breakpoint

-- Rebuild the enum without the retired value. Functions whose signature or result carries the
-- type must be dropped first and re-created against the new type below.
DROP FUNCTION public.companion_api_enqueue_turn(uuid, uuid, uuid, text, public.companion_client_surface, jsonb, uuid, text, uuid, text);
--> statement-breakpoint
DROP FUNCTION public.companion_api_enqueue_operation(uuid, uuid, uuid, public.companion_operation_kind, public.companion_client_surface);
--> statement-breakpoint
DROP FUNCTION public.companion_api_retry_turn(uuid, uuid, uuid, uuid, public.companion_client_surface);
--> statement-breakpoint
DROP FUNCTION public.companion_runtime_record_material_snapshot(uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, public.companion_client_surface, timestamp with time zone);
--> statement-breakpoint
DROP FUNCTION public.companion_runtime_claim_work(text, integer, integer, bigint);
--> statement-breakpoint
DROP FUNCTION public.companion_runtime_claim_work(text, integer, integer, bigint, integer);
--> statement-breakpoint
DROP FUNCTION public.companion_runtime_claim_work(text, integer, integer, bigint, integer, integer);
--> statement-breakpoint
DROP FUNCTION public.companion_runtime_claim_work_material_v1(text, integer, integer, bigint, integer, integer);
--> statement-breakpoint
DROP FUNCTION public.companion_runtime_claim_work_without_delete_resume_guard(text, integer, integer, bigint, integer);
--> statement-breakpoint
DROP FUNCTION public.companion_runtime_claim_work_without_material_guard(text, integer, integer, bigint);
--> statement-breakpoint
DROP FUNCTION public.companion_runtime_renew_and_authorize(uuid, uuid, uuid, bigint, bigint, text, public.companion_runtime_work_kind, uuid, integer);
--> statement-breakpoint

ALTER TYPE "companion_client_surface" RENAME TO "companion_client_surface_retired";
--> statement-breakpoint
CREATE TYPE "companion_client_surface" AS ENUM ('web', 'mobile_web');
--> statement-breakpoint
ALTER TABLE "companion_turns" ALTER COLUMN "client_surface" TYPE "companion_client_surface" USING ("client_surface"::text::"companion_client_surface");
--> statement-breakpoint
ALTER TABLE "companion_operations" ALTER COLUMN "client_surface" TYPE "companion_client_surface" USING ("client_surface"::text::"companion_client_surface");
--> statement-breakpoint
ALTER TABLE "companion_runtime_instances" ALTER COLUMN "applied_client_surface" TYPE "companion_client_surface" USING ("applied_client_surface"::text::"companion_client_surface");
--> statement-breakpoint
ALTER TABLE "companion_runtime_instances" ALTER COLUMN "settings_claim_client_surface" TYPE "companion_client_surface" USING ("settings_claim_client_surface"::text::"companion_client_surface");
--> statement-breakpoint
ALTER TABLE "companion_runtime_instances" ALTER COLUMN "material_client_surface" TYPE "companion_client_surface" USING ("material_client_surface"::text::"companion_client_surface");
--> statement-breakpoint
ALTER TABLE "companion_runtime_instances" ALTER COLUMN "settings_claim_material_client_surface" TYPE "companion_client_surface" USING ("settings_claim_material_client_surface"::text::"companion_client_surface");
--> statement-breakpoint
DROP TYPE "companion_client_surface_retired";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_api_enqueue_turn(p_org_id uuid, p_companion_id uuid, p_client_message_id uuid, p_content text, p_client_surface companion_client_surface, p_attachments jsonb DEFAULT '[]'::jsonb, p_routine_id uuid DEFAULT NULL::uuid, p_routine_name text DEFAULT NULL::text, p_trigger_id uuid DEFAULT NULL::uuid, p_trigger_name text DEFAULT NULL::text)
 RETURNS TABLE(turn jsonb, operation jsonb, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_turn_id uuid;
  v_operation_id uuid;
  v_existing_actor_id text;
  v_existing_surface public.companion_client_surface;
  v_existing_content text;
  v_existing_author_id text;
  v_existing_routine_id uuid;
  v_existing_routine_name text;
  v_existing_trigger_id uuid;
  v_existing_trigger_name text;
  v_message_found boolean := false;
  v_message_ordinal integer;
  v_message_event_id text := 'msg:' || p_client_message_id::text;
  v_attachments jsonb := COALESCE(p_attachments, '[]'::jsonb);
  v_now timestamp with time zone := clock_timestamp();
  v_replayed boolean := false;
  v_needs_start boolean;
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_client_message_id IS NULL OR p_client_surface IS NULL
     OR p_content IS NULL OR char_length(btrim(p_content)) NOT BETWEEN 1 AND 16384 THEN
    RAISE EXCEPTION 'invalid Companion message' USING ERRCODE = '22023';
  END IF;
  IF (p_routine_id IS NULL) <> (p_routine_name IS NULL)
     OR (p_routine_name IS NOT NULL AND (
       char_length(p_routine_name) NOT BETWEEN 1 AND 80 OR p_routine_name ~ E'[\n\r]'
     )) THEN
    RAISE EXCEPTION 'invalid Companion routine origin' USING ERRCODE = '22023';
  END IF;
  IF (p_trigger_id IS NULL) <> (p_trigger_name IS NULL)
     OR (p_trigger_name IS NOT NULL AND (
       char_length(p_trigger_name) NOT BETWEEN 1 AND 80 OR p_trigger_name ~ E'[\n\r]'
     )) THEN
    RAISE EXCEPTION 'invalid Companion trigger origin' USING ERRCODE = '22023';
  END IF;
  IF p_routine_id IS NOT NULL AND p_trigger_id IS NOT NULL THEN
    RAISE EXCEPTION 'a Companion turn cannot carry both a routine and a trigger origin'
      USING ERRCODE = '22023';
  END IF;
  PERFORM public.companion_api_assert_message_attachments(
    p_org_id, p_companion_id, v_attachments
  );

  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;
  IF v_instance.retirement_state <> 'active' THEN
    RAISE EXCEPTION 'retired Companion cannot accept messages' USING ERRCODE = '55000';
  END IF;

  -- A direct warm dispatch is safe only when the observed Box/Pi pair is recent and the material
  -- activated in that Pi can outlive the full turn deadline plus its five-minute reserve.
  v_needs_start := NOT COALESCE((
    v_instance.box_state IN ('ready', 'idle', 'running')
    AND v_instance.pi_state = 'idle'
    AND v_instance.last_observed_at >= v_now - interval '2 minutes'
    AND v_instance.material_pi_invocation_id = v_instance.pi_invocation_id
    AND (
      v_instance.material_client_surface IS NOT NULL
        AND v_instance.material_expires_at > v_now + interval '2 hours 5 minutes'
    )
  ), false);

  SELECT queued_turn.id, queued_turn.actor_id, queued_turn.client_surface,
    queued_turn.routine_id, queued_turn.routine_name,
    queued_turn.trigger_id, queued_turn.trigger_name
  INTO v_turn_id, v_existing_actor_id, v_existing_surface,
    v_existing_routine_id, v_existing_routine_name,
    v_existing_trigger_id, v_existing_trigger_name
  FROM public.companion_turns queued_turn
  WHERE queued_turn.org_id = p_org_id
    AND queued_turn.companion_id = p_companion_id
    AND queued_turn.client_message_id = p_client_message_id;

  IF FOUND THEN
    v_replayed := true;
    SELECT entry.content, entry.author_id
    INTO v_existing_content, v_existing_author_id
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = p_org_id AND entry.companion_id = p_companion_id
      AND entry.event_id = v_message_event_id AND entry.role = 'user';
    v_message_found := FOUND;
    SELECT start_operation.id INTO v_operation_id
    FROM public.companion_operations start_operation
    WHERE start_operation.org_id = p_org_id
      AND start_operation.companion_id = p_companion_id
      AND start_operation.source_turn_id = v_turn_id
      AND start_operation.kind = 'start'
    ORDER BY start_operation.queue_sequence, start_operation.id
    LIMIT 1;
    IF NOT v_message_found THEN
      RAISE EXCEPTION 'idempotent Companion turn is incomplete' USING ERRCODE = '55000';
    END IF;
    IF v_existing_actor_id IS DISTINCT FROM v_actor_id
       OR v_existing_author_id IS DISTINCT FROM v_actor_id
       OR v_existing_surface IS DISTINCT FROM p_client_surface
       OR v_existing_content IS DISTINCT FROM btrim(p_content)
       OR v_existing_routine_id IS DISTINCT FROM p_routine_id
       OR v_existing_routine_name IS DISTINCT FROM p_routine_name
       OR v_existing_trigger_id IS DISTINCT FROM p_trigger_id
       OR v_existing_trigger_name IS DISTINCT FROM p_trigger_name
       OR public.companion_api_stored_attachment_intent(
            p_org_id, p_companion_id, v_message_event_id
          ) IS DISTINCT FROM public.companion_api_message_attachment_intent(v_attachments) THEN
      RAISE EXCEPTION 'client_message_id was reused with different message intent'
        USING ERRCODE = '23505', CONSTRAINT = 'companion_turns_client_message_uq';
    END IF;
  ELSE
    INSERT INTO public.companion_threads(
      org_id, companion_id, next_ordinal, last_message_at, created_at, updated_at
    ) VALUES (p_org_id, p_companion_id, 1, v_now, v_now, v_now)
    ON CONFLICT (companion_id) DO UPDATE
    SET next_ordinal = companion_threads.next_ordinal + 1,
        last_message_at = EXCLUDED.last_message_at,
        updated_at = EXCLUDED.updated_at
    WHERE companion_threads.org_id = EXCLUDED.org_id
    RETURNING companion_threads.next_ordinal - 1 INTO v_message_ordinal;
    IF v_message_ordinal IS NULL THEN
      RAISE EXCEPTION 'Companion thread allocation failed' USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.companion_transcript_entries(
      org_id, companion_id, event_id, ordinal, role, content, author_id, routine_name,
      trigger_name, created_at
    ) VALUES (
      p_org_id, p_companion_id, v_message_event_id, v_message_ordinal,
      'user', btrim(p_content), v_actor_id, p_routine_name, p_trigger_name, v_now
    );
    INSERT INTO public.companion_message_attachments(
      org_id, companion_id, entry_event_id, kind, storage_key,
      content_type, byte_size, sha256, filename, position, created_at
    )
    SELECT p_org_id, p_companion_id, v_message_event_id, 'user_upload',
      part.value ->> 'storage_key', part.value ->> 'content_type',
      (part.value ->> 'byte_size')::integer, part.value ->> 'sha256',
      part.value ->> 'filename', (part.ordinality - 1)::integer, v_now
    FROM jsonb_array_elements(v_attachments) WITH ORDINALITY AS part(value, ordinality);

    INSERT INTO public.companion_turns(
      org_id, companion_id, client_message_id, message_event_id, queue_sequence,
      actor_id, client_surface, status, created_at, updated_at, routine_id, routine_name,
      trigger_id, trigger_name
    ) VALUES (
      p_org_id, p_companion_id, p_client_message_id, v_message_event_id, 0,
      v_actor_id, p_client_surface, 'queued', v_now, v_now, p_routine_id, p_routine_name,
      p_trigger_id, p_trigger_name
    ) RETURNING companion_turns.id INTO v_turn_id;

    IF v_needs_start THEN
      INSERT INTO public.companion_operations(
        org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
        queue_sequence, turn_queue_cutoff, runtime_generation, status, created_at, updated_at
      ) VALUES (
        p_org_id, p_companion_id, p_client_message_id, 'start', 'turn', v_actor_id,
        v_turn_id, 0, 0, v_instance.generation, 'pending', v_now, v_now
      ) RETURNING companion_operations.id INTO v_operation_id;
    END IF;

    UPDATE public.companion_runtime_instances instance
    SET settings_actor_id = v_actor_id,
        settings_available_at = LEAST(instance.settings_available_at, v_now),
        updated_at = v_now
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
  END IF;

  RETURN QUERY SELECT
    public.companion_api_turn_json(p_org_id, p_companion_id, v_turn_id),
    public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id),
    v_replayed;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_record_material_snapshot(p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint, p_executor_id text, p_work_kind companion_runtime_work_kind, p_work_id uuid, p_client_surface companion_client_surface, p_material_expires_at timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_updated integer;
BEGIN
  IF p_client_surface IS NULL
     OR p_material_expires_at IS NULL
     OR p_material_expires_at <= v_now + interval '2 hours 5 minutes'
     OR p_material_expires_at > v_now + interval '7 days'
     OR p_work_kind NOT IN ('operation', 'settings') THEN
    RAISE EXCEPTION 'invalid staged Companion material snapshot' USING ERRCODE = '22023';
  END IF;

  PERFORM 1
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  WHERE lease.org_id = p_org_id
    AND lease.companion_id = p_companion_id
    AND lease.claim_token = p_claim_token
    AND lease.claim_epoch = p_claim_epoch
    AND lease.gate_epoch = p_gate_epoch
    AND lease.executor_id = p_executor_id
    AND lease.work_kind = p_work_kind
    AND lease.work_id = p_work_id
    AND lease.expires_at > v_now
    AND control.enabled
    AND control.gate_epoch = p_gate_epoch
  FOR UPDATE OF lease;
  IF NOT FOUND THEN RETURN false; END IF;

  IF p_work_kind = 'operation' THEN
    UPDATE public.companion_operations operation
    SET material_staged_at = v_now,
        material_expires_at = p_material_expires_at,
        updated_at = v_now
    WHERE operation.org_id = p_org_id
      AND operation.companion_id = p_companion_id
      AND operation.id = p_work_id
      AND operation.status = 'running'
      AND operation.claim_epoch = p_claim_epoch
      AND operation.client_surface = p_client_surface
      AND (
        operation.kind IN ('start', 'restart_box') AND operation.checkpoint = 'installing_layout'
        OR operation.kind = 'restart_pi' AND operation.checkpoint = 'pending'
        OR operation.kind = 'apply_settings' AND operation.checkpoint = 'applying_settings'
      );
  ELSE
    UPDATE public.companion_runtime_instances instance
    SET settings_claim_material_client_surface = p_client_surface,
        settings_claim_material_staged_at = v_now,
        settings_claim_material_expires_at = p_material_expires_at,
        updated_at = v_now
    WHERE instance.org_id = p_org_id
      AND instance.companion_id = p_companion_id
      AND p_work_id = instance.companion_id
      AND instance.settings_claim_epoch = p_claim_epoch
      AND instance.settings_claim_client_surface = p_client_surface
      AND instance.settings_checkpoint = 'applying';
  END IF;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN RETURN false; END IF;

  UPDATE public.companion_runtime_instances instance
  SET last_write_epoch = GREATEST(instance.last_write_epoch, p_claim_epoch),
      updated_at = v_now
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
  RETURN true;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_claim_work_without_material_guard(p_executor_id text, p_limit integer, p_lease_seconds integer, p_gate_epoch bigint)
 RETURNS TABLE(org_id uuid, companion_id uuid, claim_token uuid, claim_epoch bigint, gate_epoch bigint, work_kind companion_runtime_work_kind, work_id uuid, actor_id text, client_surface companion_client_surface, runtime_generation bigint, checkpoint text, checkpoint_sequence bigint, turn_id uuid, turn_status companion_turn_status, attempt_status companion_attempt_status, dispatch_state companion_dispatch_state, event_cursor bigint, unknown_event_count integer, malformed_event_count integer, oversized_event_count integer, cold_start_deadline_at timestamp with time zone, inactivity_deadline_at timestamp with time zone, absolute_deadline_at timestamp with time zone, operation_kind companion_operation_kind, operation_started_at timestamp with time zone, operation_attempt_count integer, provider_operation_id text, target_settings_revision bigint, target_skills_revision integer, decision_status companion_decision_status, decision_delivery_state companion_decision_delivery_state)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_enabled boolean;
  v_actual_gate_epoch bigint;
  v_org_id uuid;
  v_companion_id uuid;
  v_generation bigint;
  v_work_kind public.companion_runtime_work_kind;
  v_work_id uuid;
  v_actor_id text;
  v_client_surface public.companion_client_surface;
  v_checkpoint text;
  v_checkpoint_sequence bigint;
  v_claim_token uuid;
  v_claim_epoch bigint;
  v_turn_id uuid;
  v_decision_attempt_id uuid;
  v_attempt_number integer;
  v_operation_kind public.companion_operation_kind;
  v_operation_started_at timestamp with time zone;
  v_operation_attempt_count integer;
  v_operation_queue_sequence bigint;
  v_operation_turn_queue_cutoff bigint;
  v_companion_owner_id text;
  v_operation_actor_authorized boolean;
  v_provider_operation_id text;
  v_target_settings_revision bigint;
  v_target_skills_revision integer;
  v_model_id text;
  v_provider_ids jsonb;
  v_selected_skill_ids jsonb;
  v_selected_mcp_account_ids jsonb;
  v_skills_revision integer;
  v_turn_status public.companion_turn_status;
  v_attempt_status public.companion_attempt_status;
  v_dispatch_state public.companion_dispatch_state;
  v_event_cursor bigint;
  v_unknown_event_count integer;
  v_malformed_event_count integer;
  v_oversized_event_count integer;
  v_cold_start_deadline_at timestamp with time zone;
  v_inactivity_deadline_at timestamp with time zone;
  v_absolute_deadline_at timestamp with time zone;
  v_decision_status public.companion_decision_status;
  v_decision_delivery_state public.companion_decision_delivery_state;
  v_now timestamp with time zone;
  v_claimed integer := 0;
  v_examined_companion_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  IF p_gate_epoch IS NULL
     OR p_gate_epoch < 1
     OR p_executor_id IS NULL
     OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
     OR p_executor_id ~ E'[\n\r]'
     OR p_limit IS NULL
     OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL
     OR p_lease_seconds NOT BETWEEN 5 AND 300 THEN
    RAISE EXCEPTION 'invalid Runtime v2 claim arguments' USING ERRCODE = '22023';
  END IF;

  SELECT c.enabled, c.gate_epoch
  INTO v_enabled, v_actual_gate_epoch
  FROM public.companion_runtime_control c
  WHERE c.id = 'runtime-v2';

  IF NOT COALESCE(v_enabled, false) OR v_actual_gate_epoch <> p_gate_epoch THEN
    RETURN;
  END IF;

  WHILE v_claimed < p_limit LOOP
    v_now := clock_timestamp();
    v_org_id := NULL;
    v_companion_id := NULL;
    v_generation := NULL;
    v_client_surface := NULL;

    -- The durable lease row is the first mutex. SKIP LOCKED keeps bulk/multi-replica claims from
    -- ever waiting on another lease while already holding earlier leases in this transaction.
    SELECT i.org_id, i.companion_id
    INTO v_org_id, v_companion_id
    FROM public.companion_runtime_instances i
    JOIN public.companion_runtime_leases l
      ON l.org_id = i.org_id AND l.companion_id = i.companion_id
    WHERE i.retirement_state <> 'retired'
      AND (l.claim_token IS NULL OR l.expires_at <= v_now)
      AND NOT (i.companion_id = ANY(v_examined_companion_ids))
      AND (
        EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.status IN ('pending', 'running') AND o.available_at <= v_now
            AND (
              o.kind <> 'apply_settings'
              OR i.box_state IN ('ready', 'idle', 'running')
              OR EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
              )
            )
        )
        OR EXISTS (
          SELECT 1 FROM public.companion_decision_deliveries d
          WHERE d.org_id = i.org_id AND d.companion_id = i.companion_id
            AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
            AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
            AND EXISTS (
              SELECT 1 FROM public.companion_turn_attempts decision_attempt
              WHERE decision_attempt.org_id = d.org_id
                AND decision_attempt.companion_id = d.companion_id
                AND decision_attempt.turn_id = d.turn_id
                AND decision_attempt.id = d.attempt_id
                AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
            )
        )
        OR EXISTS (
          SELECT 1 FROM public.companion_turn_attempts a
          WHERE a.org_id = i.org_id AND a.companion_id = i.companion_id
            AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
        )
        OR (
          (
            i.desired_settings_revision > i.applied_settings_revision
            OR EXISTS (
              SELECT 1 FROM public.companion_turns profile_turn
              WHERE profile_turn.org_id = i.org_id
                AND profile_turn.companion_id = i.companion_id
                AND profile_turn.status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM public.companion_turns earlier_turn
                  WHERE earlier_turn.org_id = profile_turn.org_id
                    AND earlier_turn.companion_id = profile_turn.companion_id
                    AND earlier_turn.status = 'queued'
                    AND earlier_turn.queue_sequence < profile_turn.queue_sequence
                )
                AND (
                  i.applied_client_surface IS NULL
                )
            )
            OR (
              EXISTS (
                SELECT 1 FROM public.companions settings_companion
                WHERE settings_companion.org_id = i.org_id
                  AND settings_companion.id = i.companion_id
                  AND settings_companion.skills_revision > i.applied_skills_revision
              )
              AND EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
                  AND NOT EXISTS (
                    SELECT 1 FROM public.companion_turns earlier_turn
                    WHERE earlier_turn.org_id = settings_turn.org_id
                      AND earlier_turn.companion_id = settings_turn.companion_id
                      AND earlier_turn.status = 'queued'
                      AND earlier_turn.queue_sequence < settings_turn.queue_sequence
                  )
              )
            )
          )
          AND i.settings_actor_id IS NOT NULL
          AND i.settings_available_at <= v_now
          AND (
            i.box_state IN ('ready', 'idle', 'running')
            OR EXISTS (
              SELECT 1 FROM public.companion_turns settings_turn
              WHERE settings_turn.org_id = i.org_id
                AND settings_turn.companion_id = i.companion_id
                AND settings_turn.status = 'queued'
            )
          )
        )
        OR (
          EXISTS (
            SELECT 1 FROM public.companion_turns t
            WHERE t.org_id = i.org_id AND t.companion_id = i.companion_id
              AND t.status = 'queued'
              AND (
                (i.applied_client_surface IS NOT NULL
                  AND EXISTS (
                  SELECT 1 FROM public.companions queued_companion
                  WHERE queued_companion.org_id = i.org_id
                    AND queued_companion.id = i.companion_id
                    AND queued_companion.skills_revision = i.applied_skills_revision
                  ))
              )
              AND NOT EXISTS (
                SELECT 1 FROM public.companion_turns earlier_turn
                WHERE earlier_turn.org_id = t.org_id
                  AND earlier_turn.companion_id = t.companion_id
                  AND earlier_turn.status = 'queued'
                  AND earlier_turn.queue_sequence < t.queue_sequence
              )
          )
          AND i.desired_settings_revision = i.applied_settings_revision
          AND NOT EXISTS (
            SELECT 1 FROM public.companion_turns active_turn
            WHERE active_turn.org_id = i.org_id
              AND active_turn.companion_id = i.companion_id
              AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
          )
        )
        OR (i.health_due_at <= v_now AND i.retirement_state <> 'retired')
      )
    ORDER BY
      CASE
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        ) THEN 10
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind IN ('stop', 'restart_pi', 'restart_box')
            AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        ) THEN 20
        WHEN EXISTS (
          SELECT 1 FROM public.companion_decision_deliveries d
          WHERE d.org_id = i.org_id AND d.companion_id = i.companion_id
            AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
            AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
            AND EXISTS (
              SELECT 1 FROM public.companion_turn_attempts decision_attempt
              WHERE decision_attempt.org_id = d.org_id
                AND decision_attempt.companion_id = d.companion_id
                AND decision_attempt.turn_id = d.turn_id
                AND decision_attempt.id = d.attempt_id
                AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
            )
        ) THEN 30
        WHEN EXISTS (
          SELECT 1 FROM public.companion_turn_attempts a
          WHERE a.org_id = i.org_id AND a.companion_id = i.companion_id
            AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
        ) THEN 40
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind = 'start' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        ) THEN 45
        WHEN EXISTS (
          SELECT 1 FROM public.companion_operations o
          WHERE o.org_id = i.org_id AND o.companion_id = i.companion_id
            AND o.kind = 'apply_settings' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
            AND (
              i.box_state IN ('ready', 'idle', 'running')
              OR EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
              )
            )
        ) OR (
          (
            i.desired_settings_revision > i.applied_settings_revision
            OR EXISTS (
              SELECT 1 FROM public.companion_turns profile_turn
              WHERE profile_turn.org_id = i.org_id
                AND profile_turn.companion_id = i.companion_id
                AND profile_turn.status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM public.companion_turns earlier_turn
                  WHERE earlier_turn.org_id = profile_turn.org_id
                    AND earlier_turn.companion_id = profile_turn.companion_id
                    AND earlier_turn.status = 'queued'
                    AND earlier_turn.queue_sequence < profile_turn.queue_sequence
                )
                AND (
                  i.applied_client_surface IS NULL
                )
            )
            OR (
              EXISTS (
                SELECT 1 FROM public.companions settings_companion
                WHERE settings_companion.org_id = i.org_id
                  AND settings_companion.id = i.companion_id
                  AND settings_companion.skills_revision > i.applied_skills_revision
              )
              AND EXISTS (
                SELECT 1 FROM public.companion_turns settings_turn
                WHERE settings_turn.org_id = i.org_id
                  AND settings_turn.companion_id = i.companion_id
                  AND settings_turn.status = 'queued'
                  AND NOT EXISTS (
                    SELECT 1 FROM public.companion_turns earlier_turn
                    WHERE earlier_turn.org_id = settings_turn.org_id
                      AND earlier_turn.companion_id = settings_turn.companion_id
                      AND earlier_turn.status = 'queued'
                      AND earlier_turn.queue_sequence < settings_turn.queue_sequence
                  )
              )
            )
          )
          AND i.settings_actor_id IS NOT NULL
          AND i.settings_available_at <= v_now
          AND (
            i.box_state IN ('ready', 'idle', 'running')
            OR EXISTS (
              SELECT 1 FROM public.companion_turns settings_turn
              WHERE settings_turn.org_id = i.org_id
                AND settings_turn.companion_id = i.companion_id
                AND settings_turn.status = 'queued'
            )
          )
        ) THEN 50
        WHEN EXISTS (
          SELECT 1 FROM public.companion_turns t
          WHERE t.org_id = i.org_id AND t.companion_id = i.companion_id AND t.status = 'queued'
            AND (
              (i.applied_client_surface IS NOT NULL
                AND EXISTS (
                SELECT 1 FROM public.companions queued_companion
                WHERE queued_companion.org_id = i.org_id
                  AND queued_companion.id = i.companion_id
                  AND queued_companion.skills_revision = i.applied_skills_revision
                ))
            )
            AND NOT EXISTS (
              SELECT 1 FROM public.companion_turns earlier_turn
              WHERE earlier_turn.org_id = t.org_id
                AND earlier_turn.companion_id = t.companion_id
                AND earlier_turn.status = 'queued'
                AND earlier_turn.queue_sequence < t.queue_sequence
            )
        ) AND i.desired_settings_revision = i.applied_settings_revision
          AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns blocking_turn
          WHERE blocking_turn.org_id = i.org_id
            AND blocking_turn.companion_id = i.companion_id
            AND blocking_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
        ) THEN 60
        ELSE 70
      END,
      i.health_due_at,
      i.companion_id
    FOR UPDATE OF l SKIP LOCKED
    LIMIT 1;

    EXIT WHEN v_companion_id IS NULL;
    v_examined_companion_ids := array_append(v_examined_companion_ids, v_companion_id);

    -- Revalidate after winning the lease mutex. If disable committed between the optimistic read
    -- above and this lock, no old-epoch claim is materialized. If disable is still in flight, it
    -- waits on this lease and clears the completed claim before publishing the disabled gate.
    SELECT c.enabled, c.gate_epoch
    INTO v_enabled, v_actual_gate_epoch
    FROM public.companion_runtime_control c
    WHERE c.id = 'runtime-v2';
    IF NOT COALESCE(v_enabled, false) OR v_actual_gate_epoch <> p_gate_epoch THEN
      RETURN;
    END IF;

    -- Instance and work locks always follow the lease mutex. Recheck retirement after waiting for
    -- an API-side instance update; no work is selected from the optimistic candidate snapshot.
    SELECT i.generation
    INTO v_generation
    FROM public.companion_runtime_instances i
    WHERE i.org_id = v_org_id
      AND i.companion_id = v_companion_id
      AND i.retirement_state <> 'retired'
    FOR UPDATE;
    IF NOT FOUND THEN CONTINUE; END IF;

    v_work_kind := NULL;
    v_work_id := NULL;
    v_actor_id := NULL;
    v_checkpoint := NULL;
    v_checkpoint_sequence := 0;
    v_turn_id := NULL;
    v_decision_attempt_id := NULL;
    v_operation_kind := NULL;
    v_operation_started_at := NULL;
    v_operation_attempt_count := NULL;
    v_operation_queue_sequence := NULL;
    v_operation_turn_queue_cutoff := NULL;
    v_provider_operation_id := NULL;
    v_target_settings_revision := NULL;
    v_target_skills_revision := NULL;

    SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
           o.queue_sequence, o.turn_queue_cutoff
    INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
         v_operation_queue_sequence, v_operation_turn_queue_cutoff
    FROM public.companion_operations o
    WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
      AND o.kind = 'delete' AND o.status IN ('pending', 'running') AND o.available_at <= v_now
    ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
    LIMIT 1
    FOR UPDATE;
    IF FOUND THEN
      v_work_kind := 'operation';
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
             o.queue_sequence, o.turn_queue_cutoff
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
           v_operation_queue_sequence, v_operation_turn_queue_cutoff
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind IN ('stop', 'restart_pi', 'restart_box')
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'operation'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT d.id, d.actor_id, d.delivery_checkpoint, d.delivery_checkpoint_sequence,
             d.attempt_id
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence,
           v_decision_attempt_id
      FROM public.companion_decision_deliveries d
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id
        AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
        AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
        AND EXISTS (
          SELECT 1 FROM public.companion_turn_attempts decision_attempt
          WHERE decision_attempt.org_id = d.org_id
            AND decision_attempt.companion_id = d.companion_id
            AND decision_attempt.turn_id = d.turn_id
            AND decision_attempt.id = d.attempt_id
            AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
        )
      ORDER BY d.created_at, d.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'decision'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT a.id, a.actor_id, a.checkpoint, a.checkpoint_sequence
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence
      FROM public.companion_turn_attempts a
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
      ORDER BY a.created_at, a.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'attempt'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
             o.queue_sequence, o.turn_queue_cutoff
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
           v_operation_queue_sequence, v_operation_turn_queue_cutoff
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind = 'start'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'operation'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT o.id, o.actor_id, o.checkpoint, o.checkpoint_sequence, o.kind,
             o.queue_sequence, o.turn_queue_cutoff
      INTO v_work_id, v_actor_id, v_checkpoint, v_checkpoint_sequence, v_operation_kind,
           v_operation_queue_sequence, v_operation_turn_queue_cutoff
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.kind = 'apply_settings'
        AND o.status IN ('pending', 'running') AND o.available_at <= v_now
        AND (
          EXISTS (
            SELECT 1 FROM public.companion_runtime_instances warm_instance
            WHERE warm_instance.org_id = o.org_id
              AND warm_instance.companion_id = o.companion_id
              AND warm_instance.box_state IN ('ready', 'idle', 'running')
          )
          OR EXISTS (
            SELECT 1 FROM public.companion_turns settings_turn
            WHERE settings_turn.org_id = o.org_id
              AND settings_turn.companion_id = o.companion_id
              AND settings_turn.status = 'queued'
          )
        )
      ORDER BY CASE WHEN o.status = 'running' THEN 0 ELSE 1 END, o.queue_sequence, o.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN v_work_kind := 'operation'; END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT i.settings_actor_id, i.settings_checkpoint, i.settings_checkpoint_sequence
      INTO v_actor_id, v_checkpoint, v_checkpoint_sequence
      FROM public.companion_runtime_instances i
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND (
          i.desired_settings_revision > i.applied_settings_revision
          OR EXISTS (
            SELECT 1 FROM public.companion_turns profile_turn
            WHERE profile_turn.org_id = i.org_id
              AND profile_turn.companion_id = i.companion_id
              AND profile_turn.status = 'queued'
              AND NOT EXISTS (
                SELECT 1 FROM public.companion_turns earlier_turn
                WHERE earlier_turn.org_id = profile_turn.org_id
                  AND earlier_turn.companion_id = profile_turn.companion_id
                  AND earlier_turn.status = 'queued'
                  AND earlier_turn.queue_sequence < profile_turn.queue_sequence
              )
              AND (
                i.applied_client_surface IS NULL
              )
          )
          OR (
            EXISTS (
              SELECT 1 FROM public.companions settings_companion
              WHERE settings_companion.org_id = i.org_id
                AND settings_companion.id = i.companion_id
                AND settings_companion.skills_revision > i.applied_skills_revision
            )
            AND EXISTS (
              SELECT 1 FROM public.companion_turns settings_turn
              WHERE settings_turn.org_id = i.org_id
                AND settings_turn.companion_id = i.companion_id
                AND settings_turn.status = 'queued'
                AND NOT EXISTS (
                  SELECT 1 FROM public.companion_turns earlier_turn
                  WHERE earlier_turn.org_id = settings_turn.org_id
                    AND earlier_turn.companion_id = settings_turn.companion_id
                    AND earlier_turn.status = 'queued'
                    AND earlier_turn.queue_sequence < settings_turn.queue_sequence
                )
            )
          )
        )
        AND i.settings_actor_id IS NOT NULL AND i.settings_available_at <= v_now
        AND (
          i.box_state IN ('ready', 'idle', 'running')
          OR EXISTS (
            SELECT 1 FROM public.companion_turns settings_turn
            WHERE settings_turn.org_id = i.org_id
              AND settings_turn.companion_id = i.companion_id
              AND settings_turn.status = 'queued'
          )
        );
      IF FOUND THEN
        v_work_kind := 'settings';
        v_work_id := v_companion_id;
      END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT t.id, t.actor_id
      INTO v_turn_id, v_actor_id
      FROM public.companion_turns t
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id AND t.status = 'queued'
        AND EXISTS (
          SELECT 1
          FROM public.companion_runtime_instances queue_instance
          JOIN public.companions queue_companion
            ON queue_companion.org_id = queue_instance.org_id
           AND queue_companion.id = queue_instance.companion_id
          WHERE queue_instance.org_id = t.org_id
            AND queue_instance.companion_id = t.companion_id
            AND queue_instance.desired_settings_revision = queue_instance.applied_settings_revision
            AND (
              (queue_instance.applied_client_surface IS NOT NULL
                AND queue_instance.applied_skills_revision >= queue_companion.skills_revision)
            )
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns earlier_turn
          WHERE earlier_turn.org_id = t.org_id
            AND earlier_turn.companion_id = t.companion_id
            AND earlier_turn.status = 'queued'
            AND earlier_turn.queue_sequence < t.queue_sequence
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns active_turn
          WHERE active_turn.org_id = v_org_id
            AND active_turn.companion_id = v_companion_id
            AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
        )
      ORDER BY t.queue_sequence, t.id
      LIMIT 1
      FOR UPDATE;
      IF FOUND THEN
        v_work_kind := 'attempt';
        v_work_id := gen_random_uuid();
        v_checkpoint := 'starting';
        v_checkpoint_sequence := 0;
        SELECT COALESCE(MAX(a.attempt_number), 0) + 1
        INTO v_attempt_number
        FROM public.companion_turn_attempts a
        WHERE a.turn_id = v_turn_id;
        SELECT c.model_id, c.provider_ids, c.selected_skill_ids,
               c.selected_mcp_account_ids, c.skills_revision
        INTO v_model_id, v_provider_ids, v_selected_skill_ids,
             v_selected_mcp_account_ids, v_skills_revision
        FROM public.companions c
        WHERE c.org_id = v_org_id AND c.id = v_companion_id;
      END IF;
    END IF;

    IF v_work_kind IS NULL THEN
      SELECT 'health'::public.companion_runtime_work_kind, i.companion_id,
             i.health_checkpoint, i.health_checkpoint_sequence
      INTO v_work_kind, v_work_id, v_checkpoint, v_checkpoint_sequence
      FROM public.companion_runtime_instances i
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND i.health_due_at <= v_now AND i.retirement_state <> 'retired';
    END IF;

    -- A concurrent insert can make the selected instance no longer eligible. Continue rather than
    -- inventing work; the next sweep will see the new authoritative priority.
    IF v_work_kind IS NULL OR v_work_id IS NULL THEN
      CONTINUE;
    END IF;

    -- A persisted Box/Pi write intent whose lease is no longer current is ambiguous evidence. The
    -- old executor may have reached the provider even though its ACK never became durable, so
    -- takeover must not turn that intent into a success or replay it. Fence the expired epoch and
    -- interrupt the parent atomically before considering any other work for this Companion.
    IF v_work_kind = 'operation'
       AND v_operation_kind = 'start'
       AND v_checkpoint = 'creating_box' THEN
      SELECT o.source_turn_id INTO v_turn_id
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;

      UPDATE public.companion_operations o
      SET status = 'interrupted', settled_at = v_now,
          last_error_code = 'box_create_outcome_unknown',
          last_error_message = 'Box creation outcome is unknown after the lifecycle lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
        AND o.id = v_work_id AND o.status = 'running' AND o.checkpoint = 'creating_box';
      IF v_turn_id IS NOT NULL THEN
        UPDATE public.companion_turns t
        SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
            absolute_deadline_at = COALESCE(t.absolute_deadline_at, v_now),
            last_error_code = 'box_create_outcome_unknown',
            last_error_message = 'Box creation outcome is unknown after the lifecycle lease was lost.',
            last_error_action = 'retry', updated_at = v_now
        WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
          AND t.id = v_turn_id
          AND t.status IN ('queued', 'starting', 'dispatching', 'running', 'needs_input');
      END IF;

      UPDATE public.companion_runtime_leases l
      SET claim_token = NULL, claim_epoch = l.claim_epoch + 1, gate_epoch = NULL,
          executor_id = NULL, work_kind = NULL, work_id = NULL,
          claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
      RETURNING l.claim_epoch INTO v_claim_epoch;
      UPDATE public.companion_runtime_instances i
      SET last_write_epoch = GREATEST(i.last_write_epoch, v_claim_epoch), updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      CONTINUE;
    END IF;

    IF v_work_kind = 'attempt'
       AND v_turn_id IS NULL
       AND v_checkpoint IN ('dispatch_write_intent', 'dispatch_ambiguous') THEN
      SELECT a.turn_id INTO v_turn_id
      FROM public.companion_turn_attempts a
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id AND a.id = v_work_id;

      PERFORM public.companion_runtime_close_attempt_decisions(
        v_org_id, v_companion_id, v_work_id,
        'dispatch_ack_unknown',
        'Pi prompt acceptance is unknown after the dispatch lease was lost.',
        'retry'::public.companion_runtime_error_action,
        NULL
      );
      UPDATE public.companion_turn_attempts a
      SET status = 'interrupted', dispatch_state = 'ambiguous',
          checkpoint = 'dispatch_ambiguous',
          checkpoint_sequence = a.checkpoint_sequence
            + CASE WHEN a.checkpoint = 'dispatch_ambiguous' THEN 0 ELSE 1 END,
          settled_at = v_now,
          last_error_code = 'dispatch_ack_unknown',
          last_error_message = 'Pi prompt acceptance is unknown after the dispatch lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.id = v_work_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
        AND a.dispatch_state IN ('write_intent', 'ambiguous');
      UPDATE public.companion_turns t
      SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
          last_error_code = 'dispatch_ack_unknown',
          last_error_message = 'Pi prompt acceptance is unknown after the dispatch lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
        AND t.id = v_turn_id
        AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');

      UPDATE public.companion_runtime_leases l
      SET claim_token = NULL, claim_epoch = l.claim_epoch + 1, gate_epoch = NULL,
          executor_id = NULL, work_kind = NULL, work_id = NULL,
          claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
      RETURNING l.claim_epoch INTO v_claim_epoch;
      UPDATE public.companion_runtime_instances i
      SET last_write_epoch = GREATEST(i.last_write_epoch, v_claim_epoch), updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      CONTINUE;
    END IF;

    IF v_work_kind = 'decision'
       AND v_checkpoint IN ('write_intent', 'ambiguous') THEN
      SELECT d.turn_id, d.attempt_id INTO v_turn_id, v_decision_attempt_id
      FROM public.companion_decision_deliveries d
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id AND d.id = v_work_id;

      PERFORM public.companion_runtime_close_attempt_decisions(
        v_org_id, v_companion_id, v_decision_attempt_id,
        'decision_ack_unknown',
        'Pi decision acceptance is unknown after the delivery lease was lost.',
        'retry'::public.companion_runtime_error_action,
        NULL
      );
      UPDATE public.companion_turn_attempts a
      SET status = 'interrupted', settled_at = v_now,
          last_error_code = 'decision_ack_unknown',
          last_error_message = 'Pi decision acceptance is unknown after the delivery lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
        AND a.id = v_decision_attempt_id
        AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
      UPDATE public.companion_turns t
      SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
          last_error_code = 'decision_ack_unknown',
          last_error_message = 'Pi decision acceptance is unknown after the delivery lease was lost.',
          last_error_action = 'retry', updated_at = v_now
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
        AND t.id = v_turn_id
        AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');

      UPDATE public.companion_runtime_leases l
      SET claim_token = NULL, claim_epoch = l.claim_epoch + 1, gate_epoch = NULL,
          executor_id = NULL, work_kind = NULL, work_id = NULL,
          claimed_at = NULL, renewed_at = NULL, expires_at = NULL, updated_at = v_now
      WHERE l.org_id = v_org_id AND l.companion_id = v_companion_id
      RETURNING l.claim_epoch INTO v_claim_epoch;
      UPDATE public.companion_runtime_instances i
      SET last_write_epoch = GREATEST(i.last_write_epoch, v_claim_epoch), updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      CONTINUE;
    END IF;

    -- Basic lifecycle authority is locked and revalidated before claim performs any destructive
    -- precedence mutation. Full resource authorization is repeated by renew immediately before
    -- Box/Pi contact, but a revoked actor can never use an old operation row to interrupt work.
    IF v_work_kind = 'operation' THEN
      v_companion_owner_id := NULL;
      v_operation_actor_authorized := false;
      SELECT c.owner_id
      INTO v_companion_owner_id
      FROM public.companions c
      JOIN public.memberships m
        ON m.org_id = c.org_id AND m.user_id = v_actor_id
      WHERE c.org_id = v_org_id AND c.id = v_companion_id
      FOR NO KEY UPDATE OF c, m;

      IF FOUND AND v_companion_owner_id = v_actor_id THEN
        v_operation_actor_authorized := true;
      ELSIF FOUND AND v_operation_kind <> 'delete' THEN
        PERFORM 1
        FROM public.companion_workspace_access a
        WHERE a.org_id = v_org_id
          AND a.companion_id = v_companion_id
          AND a.role = 'editor'
        FOR NO KEY UPDATE;
        v_operation_actor_authorized := FOUND;
      END IF;

      IF NOT v_operation_actor_authorized THEN
        UPDATE public.companion_operations o
        SET status = 'failed', settled_at = v_now,
            last_error_code = 'actor_access_revoked',
            last_error_message = 'Runtime access was revoked before this operation began.',
            last_error_action = 'none', updated_at = v_now
        WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
          AND o.id = v_work_id AND o.status IN ('pending', 'running');

        IF v_operation_kind = 'start' THEN
          UPDATE public.companion_turns t
          SET status = 'failed', settled_at = v_now, state_changed_at = v_now,
              absolute_deadline_at = COALESCE(t.absolute_deadline_at, v_now),
              last_error_code = 'actor_access_revoked',
              last_error_message = 'Runtime access was revoked before this turn began.',
              last_error_action = 'none', updated_at = v_now
          WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
            AND t.id = (
              SELECT source.source_turn_id
              FROM public.companion_operations source
              WHERE source.org_id = v_org_id
                AND source.companion_id = v_companion_id
                AND source.id = v_work_id
            )
            AND t.status = 'queued';
        END IF;
        CONTINUE;
      END IF;

      IF v_operation_kind = 'apply_settings' THEN
        -- Only an operation whose actor was just revalidated may become a prerequisite for a
        -- queued Send. A stale pending binding is replaced; a running operation keeps its active
        -- binding so takeover observes the same deadline and source.
        UPDATE public.companion_operations selected_operation
        SET source_turn_id = (
          SELECT queued_turn.id
          FROM public.companion_turns queued_turn
          WHERE queued_turn.org_id = v_org_id
            AND queued_turn.companion_id = v_companion_id
            AND queued_turn.status = 'queued'
          ORDER BY queued_turn.queue_sequence, queued_turn.id
          LIMIT 1
        ),
            updated_at = v_now
        WHERE selected_operation.org_id = v_org_id
          AND selected_operation.companion_id = v_companion_id
          AND selected_operation.id = v_work_id
          AND (
            selected_operation.source_turn_id IS NULL
            OR (
              selected_operation.status = 'pending'
              AND NOT EXISTS (
                SELECT 1
                FROM public.companion_turns bound_turn
                WHERE bound_turn.org_id = selected_operation.org_id
                  AND bound_turn.companion_id = selected_operation.companion_id
                  AND bound_turn.id = selected_operation.source_turn_id
                  AND bound_turn.status = 'queued'
              )
            )
          )
          AND EXISTS (
            SELECT 1
            FROM public.companion_turns queued_turn
            WHERE queued_turn.org_id = v_org_id
              AND queued_turn.companion_id = v_companion_id
              AND queued_turn.status = 'queued'
          );
      END IF;
    END IF;

    -- Work selection and ACL locks may have waited. Lease lifetime starts from the actual claim
    -- publication time, never from the beginning of the SQL statement.
    v_now := clock_timestamp();
    v_claim_token := gen_random_uuid();
    v_claim_epoch := NULL;
    UPDATE public.companion_runtime_leases l
    SET claim_token = v_claim_token,
        claim_epoch = l.claim_epoch + 1,
        gate_epoch = p_gate_epoch,
        executor_id = p_executor_id,
        work_kind = v_work_kind,
        work_id = v_work_id,
        claimed_at = v_now,
        renewed_at = v_now,
        expires_at = v_now + make_interval(secs => p_lease_seconds),
        updated_at = v_now
    WHERE l.org_id = v_org_id
      AND l.companion_id = v_companion_id
      AND (l.claim_token IS NULL OR l.expires_at <= v_now)
    RETURNING l.claim_epoch INTO v_claim_epoch;

    IF v_claim_epoch IS NULL THEN
      CONTINUE;
    END IF;

    IF v_work_kind = 'operation' THEN
      -- A newly selected higher-priority operation atomically terminalizes a lower running one
      -- before acquiring the one-running slot. Explicit lifecycle is also an ordering barrier:
      -- pending Starts serialized before it are superseded, while Starts from later Sends survive.
      WITH superseded AS (
        UPDATE public.companion_operations o
        SET status = 'interrupted', settled_at = v_now,
            last_error_code = 'superseded_by_higher_priority',
            last_error_message = 'A higher-priority runtime operation superseded this operation.',
            last_error_action = 'none', updated_at = v_now
        WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id
          AND o.id <> v_work_id
          AND (
            (
              o.status = 'running'
              AND CASE
                WHEN o.kind = 'delete' THEN 10
                WHEN o.kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
                WHEN o.kind = 'start' THEN 45
                ELSE 50
              END > CASE
                WHEN v_operation_kind = 'delete' THEN 10
                WHEN v_operation_kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
                WHEN v_operation_kind = 'start' THEN 45
                ELSE 50
              END
            )
            OR (
              v_operation_kind IN ('stop', 'restart_pi', 'restart_box')
              AND o.status = 'pending'
              AND o.kind = 'start'
              AND o.queue_sequence < v_operation_queue_sequence
            )
          )
        RETURNING o.kind, o.source_turn_id
      )
      UPDATE public.companion_turns t
      SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
          absolute_deadline_at = COALESCE(t.absolute_deadline_at, v_now),
          last_error_code = 'runtime_lifecycle_preempted',
          last_error_message = CASE
            WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
            ELSE 'The Companion runtime restarted before this turn completed.'
          END,
          last_error_action = 'retry', updated_at = v_now
      WHERE v_operation_kind IN ('stop', 'restart_pi', 'restart_box')
        AND t.org_id = v_org_id AND t.companion_id = v_companion_id
        AND t.status = 'queued'
        AND t.queue_sequence <= v_operation_turn_queue_cutoff
        -- Referencing the DML CTE makes the operation/turn barrier visibly one SQL statement.
        AND (SELECT count(*) FROM superseded) >= 0;

      IF v_operation_kind IN ('delete', 'stop', 'restart_pi', 'restart_box') THEN
        -- Close decision outboxes before making their attempts terminal. A start never enters this
        -- branch: turn-triggered wake remains below an already-active attempt and cannot kill it.
        PERFORM public.companion_runtime_close_attempt_decisions(
          a.org_id, a.companion_id, a.id,
          'runtime_lifecycle_preempted',
          CASE
            WHEN v_operation_kind = 'delete' THEN 'The Companion was deleted before this turn completed.'
            WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
            ELSE 'The Companion runtime restarted before this turn completed.'
          END,
          CASE WHEN v_operation_kind = 'delete'
            THEN 'none'::public.companion_runtime_error_action
            ELSE 'retry'::public.companion_runtime_error_action
          END,
          NULL
        )
        FROM public.companion_turn_attempts a
        WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');

        UPDATE public.companion_turn_attempts a
        SET status = 'interrupted', settled_at = v_now,
            last_error_code = 'runtime_lifecycle_preempted',
            last_error_message = CASE
              WHEN v_operation_kind = 'delete' THEN 'The Companion was deleted before this turn completed.'
              WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
              ELSE 'The Companion runtime restarted before this turn completed.'
            END,
            last_error_action = CASE WHEN v_operation_kind = 'delete'
              THEN 'none'::public.companion_runtime_error_action
              ELSE 'retry'::public.companion_runtime_error_action
            END,
            updated_at = v_now
        WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');

        UPDATE public.companion_turns t
        SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
            last_error_code = 'runtime_lifecycle_preempted',
            last_error_message = CASE
              WHEN v_operation_kind = 'delete' THEN 'The Companion was deleted before this turn completed.'
              WHEN v_operation_kind = 'stop' THEN 'The Companion was stopped before this turn completed.'
              ELSE 'The Companion runtime restarted before this turn completed.'
            END,
            last_error_action = CASE WHEN v_operation_kind = 'delete'
              THEN 'none'::public.companion_runtime_error_action
              ELSE 'retry'::public.companion_runtime_error_action
            END,
            updated_at = v_now
        WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
          AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');

        IF v_operation_kind = 'delete' THEN
          UPDATE public.companion_turns t
          SET status = 'cancelled', settled_at = v_now, state_changed_at = v_now,
              last_error_code = NULL, last_error_message = NULL, last_error_action = NULL,
              updated_at = v_now
          WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id
            AND t.status = 'queued';

          -- Delete is terminal for this generation. Cancel every queued operation while the
          -- instance mutex is held, so no start/settings/lifecycle intent can recreate a Box after
          -- provider deletion succeeds and the instance becomes retired.
          UPDATE public.companion_operations o
          SET status = 'cancelled',
              settled_at = v_now,
              last_error_code = NULL,
              last_error_message = NULL,
              last_error_action = NULL,
              updated_at = v_now
          WHERE o.org_id = v_org_id
            AND o.companion_id = v_companion_id
            AND o.id <> v_work_id
            AND o.status = 'pending';
        END IF;
      END IF;
      UPDATE public.companion_operations o
      SET status = 'running', claim_epoch = v_claim_epoch,
          attempt_count = o.attempt_count + 1,
          started_at = COALESCE(o.started_at, v_now), updated_at = v_now
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;
    ELSIF v_work_kind = 'decision' THEN
      UPDATE public.companion_decision_deliveries d
      SET decision_status = CASE
            WHEN d.decision_status = 'pending' AND d.expires_at <= v_now
              THEN 'expired'::public.companion_decision_status
            ELSE d.decision_status
          END,
          responded_at = CASE
            WHEN d.decision_status = 'pending' AND d.expires_at <= v_now THEN v_now
            ELSE d.responded_at
          END,
          claim_epoch = v_claim_epoch,
          delivery_attempt_count = d.delivery_attempt_count + 1,
          updated_at = v_now
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id AND d.id = v_work_id;
    ELSIF v_work_kind = 'attempt' AND v_turn_id IS NOT NULL THEN
      INSERT INTO public.companion_turn_attempts (
        id, org_id, companion_id, turn_id, attempt_number, actor_id,
        runtime_generation, settings_revision, skills_revision, model_id,
        provider_ids, selected_skill_ids, selected_mcp_account_ids,
        claim_epoch, status, checkpoint, checkpoint_sequence,
        dispatch_state, started_at, updated_at
      ) VALUES (
        v_work_id, v_org_id, v_companion_id, v_turn_id, v_attempt_number, v_actor_id,
        v_generation,
        (SELECT i.applied_settings_revision FROM public.companion_runtime_instances i
         WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id),
        v_skills_revision, v_model_id, v_provider_ids, v_selected_skill_ids,
        v_selected_mcp_account_ids, v_claim_epoch, 'starting', 'starting', 0,
        'pending', v_now, v_now
      );
      UPDATE public.companion_turns t
      SET status = 'starting', inactivity_deadline_at = NULL,
          absolute_deadline_at = v_now + interval '2 hours',
          state_changed_at = v_now, updated_at = v_now
      WHERE t.org_id = v_org_id AND t.companion_id = v_companion_id AND t.id = v_turn_id;
    ELSIF v_work_kind = 'attempt' THEN
      UPDATE public.companion_turn_attempts a
      SET claim_epoch = v_claim_epoch, updated_at = v_now
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id AND a.id = v_work_id;
    ELSIF v_work_kind = 'settings' THEN
      v_turn_id := NULL;
      v_cold_start_deadline_at := NULL;
      SELECT t.id, t.client_surface, t.cold_start_deadline_at
      INTO v_turn_id, v_client_surface, v_cold_start_deadline_at
      FROM public.companion_turns t
      WHERE t.org_id = v_org_id
        AND t.companion_id = v_companion_id
        AND t.status = 'queued'
      ORDER BY t.queue_sequence, t.id
      LIMIT 1
      FOR UPDATE;
      IF NOT FOUND THEN
        v_client_surface := 'web';
      END IF;

      UPDATE public.companion_runtime_instances i
      SET settings_claim_epoch = v_claim_epoch,
          settings_claim_actor_id = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision
            THEN i.settings_actor_id ELSE i.settings_claim_actor_id END,
          settings_claim_client_surface = v_client_surface,
          settings_claim_turn_id = v_turn_id,
          settings_claim_cold_start_deadline_at = v_cold_start_deadline_at,
          settings_claim_revision = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision
            THEN i.desired_settings_revision ELSE i.settings_claim_revision END,
          settings_claim_skills_revision = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision
            THEN c.skills_revision
            ELSE i.settings_claim_skills_revision END,
          settings_claim_model_id = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision
            THEN c.model_id ELSE i.settings_claim_model_id END,
          settings_claim_persona = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision
            THEN c.persona ELSE i.settings_claim_persona END,
          settings_claim_can_write_skills = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision
            THEN c.can_write_skills
            ELSE i.settings_claim_can_write_skills END,
          settings_claim_provider_ids = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision
            THEN c.provider_ids ELSE i.settings_claim_provider_ids END,
          settings_claim_selected_skill_ids = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision
            THEN c.selected_skill_ids
            ELSE i.settings_claim_selected_skill_ids END,
          settings_claim_skill_refs = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision THEN
            (
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
              'skill_id', s.id,
              'current_version_id', s.current_version_id
            ) ORDER BY s.id), '[]'::jsonb)
            FROM public.skills s
            WHERE s.org_id = i.org_id
              AND EXISTS (
                SELECT 1 FROM jsonb_array_elements_text(c.selected_skill_ids) selected(skill_id)
                WHERE selected.skill_id = s.id::text
              )
          ) ELSE i.settings_claim_skill_refs END,
          settings_claim_selected_mcp_account_ids = CASE WHEN i.settings_claim_epoch IS NULL
              OR i.settings_claim_revision IS DISTINCT FROM i.desired_settings_revision
              OR i.settings_claim_client_surface IS DISTINCT FROM v_client_surface
              OR i.settings_claim_skills_revision IS DISTINCT FROM c.skills_revision
            THEN c.selected_mcp_account_ids
            ELSE i.settings_claim_selected_mcp_account_ids END,
          settings_checkpoint = 'applying',
          settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
          settings_attempt_count = i.settings_attempt_count + 1,
          updated_at = v_now
      FROM public.companions c
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND c.org_id = i.org_id AND c.id = i.companion_id;
      v_checkpoint := 'applying';
      v_checkpoint_sequence := v_checkpoint_sequence + 1;
    ELSIF v_work_kind = 'health' THEN
      UPDATE public.companion_runtime_instances i
      SET health_claim_epoch = v_claim_epoch,
          health_checkpoint = 'observing',
          health_checkpoint_sequence = i.health_checkpoint_sequence + 1,
          updated_at = v_now
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id;
      v_checkpoint := 'observing';
      v_checkpoint_sequence := v_checkpoint_sequence + 1;
    END IF;

    IF v_work_kind = 'operation' THEN
      SELECT o.started_at, o.attempt_count, o.provider_operation_id, o.source_turn_id,
             o.client_surface,
             o.target_settings_revision, o.target_skills_revision
      INTO v_operation_started_at, v_operation_attempt_count, v_provider_operation_id, v_turn_id,
           v_client_surface,
           v_target_settings_revision, v_target_skills_revision
      FROM public.companion_operations o
      WHERE o.org_id = v_org_id AND o.companion_id = v_companion_id AND o.id = v_work_id;
    END IF;

    v_claimed := v_claimed + 1;
    v_turn_status := NULL;
    v_attempt_status := NULL;
    v_dispatch_state := NULL;
    v_event_cursor := NULL;
    v_unknown_event_count := NULL;
    v_malformed_event_count := NULL;
    v_oversized_event_count := NULL;
    v_cold_start_deadline_at := NULL;
    v_inactivity_deadline_at := NULL;
    v_absolute_deadline_at := NULL;
    v_decision_status := NULL;
    v_decision_delivery_state := NULL;
    IF v_work_kind = 'operation' AND v_turn_id IS NOT NULL THEN
      SELECT t.status, t.cold_start_deadline_at,
             t.inactivity_deadline_at, t.absolute_deadline_at
      INTO v_turn_status, v_cold_start_deadline_at,
           v_inactivity_deadline_at, v_absolute_deadline_at
      FROM public.companion_turns t
      WHERE t.org_id = v_org_id
        AND t.companion_id = v_companion_id
        AND t.id = v_turn_id;
    ELSIF v_work_kind = 'attempt' THEN
      SELECT a.turn_id, t.client_surface, t.status, a.status, a.dispatch_state, a.event_cursor,
             a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
             t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at
      INTO v_turn_id, v_client_surface, v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
           v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
           v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at
      FROM public.companion_turn_attempts a
      JOIN public.companion_turns t
        ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
      WHERE a.org_id = v_org_id AND a.companion_id = v_companion_id AND a.id = v_work_id;
    ELSIF v_work_kind = 'decision' THEN
      SELECT d.turn_id, t.client_surface, t.status, a.status, a.dispatch_state, a.event_cursor,
             a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
             t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
             d.decision_status, d.delivery_state
      INTO v_turn_id, v_client_surface, v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
           v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
           v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
           v_decision_status, v_decision_delivery_state
      FROM public.companion_decision_deliveries d
      JOIN public.companion_turn_attempts a
        ON a.org_id = d.org_id AND a.companion_id = d.companion_id
       AND a.turn_id = d.turn_id AND a.id = d.attempt_id
      JOIN public.companion_turns t
        ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
      WHERE d.org_id = v_org_id AND d.companion_id = v_companion_id AND d.id = v_work_id;
    ELSIF v_work_kind = 'settings' THEN
      SELECT i.settings_claim_turn_id, i.settings_claim_cold_start_deadline_at,
             i.settings_claim_revision, i.settings_claim_skills_revision
      INTO v_turn_id, v_cold_start_deadline_at,
           v_target_settings_revision, v_target_skills_revision
      FROM public.companion_runtime_instances i
      WHERE i.org_id = v_org_id AND i.companion_id = v_companion_id
        AND i.settings_claim_epoch = v_claim_epoch;
    END IF;
    RETURN QUERY SELECT
      v_org_id, v_companion_id, v_claim_token, v_claim_epoch, p_gate_epoch,
      v_work_kind, v_work_id, v_actor_id, v_client_surface, v_generation,
      v_checkpoint, v_checkpoint_sequence,
      v_turn_id, v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
      v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
      v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
      v_operation_kind, v_operation_started_at, v_operation_attempt_count,
      v_provider_operation_id,
      v_target_settings_revision, v_target_skills_revision,
      v_decision_status, v_decision_delivery_state;
  END LOOP;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_renew_and_authorize(p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint, p_executor_id text, p_work_kind companion_runtime_work_kind, p_work_id uuid, p_lease_seconds integer)
 RETURNS TABLE(authorized boolean, denial_code text, lease_expires_at timestamp with time zone, authorization_actor_id text, decision_actor_id text, client_surface companion_client_surface, runtime_generation bigint, box_id text, box_state companion_box_observed_state, pi_state companion_pi_observed_state, pi_invocation_id text, disk_layout_version integer, applied_settings_revision bigint, applied_skills_revision integer, model_id text, persona text, can_write_skills boolean, provider_refs jsonb, skill_refs jsonb, mcp_refs jsonb, desired_settings_revision bigint, skills_revision integer, work_checkpoint text, work_checkpoint_sequence bigint, turn_id uuid, turn_status companion_turn_status, attempt_status companion_attempt_status, dispatch_state companion_dispatch_state, event_cursor bigint, unknown_event_count integer, malformed_event_count integer, oversized_event_count integer, cold_start_deadline_at timestamp with time zone, inactivity_deadline_at timestamp with time zone, absolute_deadline_at timestamp with time zone, operation_kind companion_operation_kind, operation_started_at timestamp with time zone, operation_attempt_count integer, provider_operation_id text, target_settings_revision bigint, target_skills_revision integer, decision_status companion_decision_status, decision_delivery_state companion_decision_delivery_state, decision_request_key text, decision_response_text text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_authorization_actor_id text;
  v_decision_actor_id text;
  v_operation_kind public.companion_operation_kind;
  v_operation_started_at timestamp with time zone;
  v_operation_attempt_count integer;
  v_operation_provider_operation_id text;
  v_decision_status public.companion_decision_status;
  v_decision_request_key text;
  v_decision_response_text text;
  v_attempt_id uuid;
  v_generation bigint;
  v_box_id text;
  v_box_state public.companion_box_observed_state;
  v_pi_state public.companion_pi_observed_state;
  v_pi_invocation_id text;
  v_disk_layout_version integer;
  v_applied_settings_revision bigint;
  v_applied_skills_revision integer;
  v_model_id text;
  v_persona text;
  v_can_write_skills boolean;
  v_provider_ids jsonb;
  v_skill_ids jsonb;
  v_mcp_ids jsonb;
  v_desired_settings_revision bigint;
  v_skills_revision integer;
  v_live_desired_settings_revision bigint;
  v_live_skills_revision integer;
  v_operation_target_settings_revision bigint;
  v_operation_target_skills_revision integer;
  v_operation_model_id text;
  v_operation_persona text;
  v_operation_can_write_skills boolean;
  v_operation_provider_ids jsonb;
  v_operation_skill_ids jsonb;
  v_operation_skill_refs jsonb;
  v_operation_mcp_ids jsonb;
  v_settings_claim_revision bigint;
  v_settings_claim_skills_revision integer;
  v_settings_model_id text;
  v_settings_persona text;
  v_settings_can_write_skills boolean;
  v_settings_provider_ids jsonb;
  v_settings_skill_ids jsonb;
  v_settings_skill_refs jsonb;
  v_settings_mcp_ids jsonb;
  v_provider_refs jsonb := '[]'::jsonb;
  v_skill_refs jsonb := '[]'::jsonb;
  v_attempt_skill_refs jsonb := '[]'::jsonb;
  v_has_pinned_resources boolean := false;
  v_mcp_refs jsonb := '[]'::jsonb;
  v_companion_owner_id text;
  v_denial_code text;
  v_requires_resources boolean := false;
  v_requires_skills_mcp boolean := false;
  v_client_surface public.companion_client_surface := 'web';
  v_actor_authorized boolean := false;
  v_responder_authorized boolean := true;
  v_work_priority integer;
  v_higher_priority_pending boolean := false;
  v_work_checkpoint text;
  v_work_checkpoint_sequence bigint;
  v_turn_id uuid;
  v_turn_status public.companion_turn_status;
  v_attempt_status public.companion_attempt_status;
  v_dispatch_state public.companion_dispatch_state;
  v_event_cursor bigint;
  v_unknown_event_count integer;
  v_malformed_event_count integer;
  v_oversized_event_count integer;
  v_cold_start_deadline_at timestamp with time zone;
  v_inactivity_deadline_at timestamp with time zone;
  v_absolute_deadline_at timestamp with time zone;
  v_decision_delivery_state public.companion_decision_delivery_state;
  v_cancel_requested_at timestamp with time zone;
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 300
     OR p_executor_id IS NULL
     OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
     OR p_executor_id ~ E'[\n\r]' THEN
    RAISE EXCEPTION 'invalid Runtime v2 renewal arguments' USING ERRCODE = '22023';
  END IF;

  -- There is intentionally no diagnostic row for a stale lease. Its token/epoch learns nothing and
  -- can perform no mutation, including after expiry but before another executor takes over.
  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  PERFORM 1
  FROM public.companion_runtime_instances i
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.actor_id, o.kind, o.client_surface,
           o.checkpoint, o.checkpoint_sequence, o.source_turn_id,
           o.started_at, o.attempt_count, o.provider_operation_id,
           o.target_settings_revision, o.target_skills_revision,
           o.model_id, o.persona, o.can_write_skills,
           o.provider_ids, o.selected_skill_ids, o.skill_refs,
           o.selected_mcp_account_ids,
           t.status, t.cold_start_deadline_at,
           t.inactivity_deadline_at, t.absolute_deadline_at
    INTO v_authorization_actor_id, v_operation_kind, v_client_surface,
         v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id,
         v_operation_started_at, v_operation_attempt_count, v_operation_provider_operation_id,
         v_operation_target_settings_revision, v_operation_target_skills_revision,
         v_operation_model_id, v_operation_persona, v_operation_can_write_skills,
         v_operation_provider_ids, v_operation_skill_ids, v_operation_skill_refs,
         v_operation_mcp_ids,
         v_turn_status, v_cold_start_deadline_at,
         v_inactivity_deadline_at, v_absolute_deadline_at
    FROM public.companion_operations o
    LEFT JOIN public.companion_turns t
      ON t.org_id = o.org_id AND t.companion_id = o.companion_id AND t.id = o.source_turn_id
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch;
    IF NOT FOUND THEN RETURN; END IF;
    v_requires_resources := v_operation_kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings');
  ELSIF p_work_kind = 'attempt' THEN
    SELECT a.actor_id, t.client_surface, a.checkpoint, a.checkpoint_sequence,
           a.turn_id, t.status, a.status, a.dispatch_state, a.event_cursor,
           a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
           t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
           t.cancel_requested_at
    INTO v_authorization_actor_id, v_client_surface, v_work_checkpoint,
         v_work_checkpoint_sequence, v_turn_id, v_turn_status, v_attempt_status,
         v_dispatch_state, v_event_cursor,
         v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
         v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
         v_cancel_requested_at
    FROM public.companion_turn_attempts a
    JOIN public.companion_turns t
      ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN; END IF;
    v_attempt_id := p_work_id;
    v_requires_resources := true;
  ELSIF p_work_kind = 'decision' THEN
    SELECT a.actor_id, d.actor_id, d.decision_status, d.request_key, d.response_text,
           t.client_surface,
           d.delivery_checkpoint, d.delivery_checkpoint_sequence, d.turn_id,
           t.status, a.status, a.dispatch_state, a.event_cursor,
           a.unknown_event_count, a.malformed_event_count, a.oversized_event_count,
           t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
           t.cancel_requested_at,
           d.delivery_state
    INTO v_authorization_actor_id, v_decision_actor_id, v_decision_status,
         v_decision_request_key, v_decision_response_text, v_client_surface,
         v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id,
         v_turn_status, v_attempt_status, v_dispatch_state, v_event_cursor,
         v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
         v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
         v_cancel_requested_at,
         v_decision_delivery_state
    FROM public.companion_decision_deliveries d
    JOIN public.companion_turn_attempts a
      ON a.org_id = d.org_id AND a.companion_id = d.companion_id
     AND a.turn_id = d.turn_id AND a.id = d.attempt_id
    JOIN public.companion_turns t
      ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
      AND d.decision_status <> 'pending'
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN; END IF;
    SELECT d.attempt_id INTO v_attempt_id
    FROM public.companion_decision_deliveries d
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id AND d.id = p_work_id;
    v_requires_resources := true;
  ELSIF p_work_kind = 'settings' THEN
    SELECT i.settings_claim_actor_id, i.settings_claim_client_surface,
           i.settings_checkpoint, i.settings_checkpoint_sequence,
           i.settings_claim_turn_id, i.settings_claim_cold_start_deadline_at,
           i.settings_claim_revision, i.settings_claim_skills_revision,
           i.settings_claim_model_id, i.settings_claim_persona,
           i.settings_claim_can_write_skills, i.settings_claim_provider_ids,
           i.settings_claim_selected_skill_ids, i.settings_claim_skill_refs,
           i.settings_claim_selected_mcp_account_ids
    INTO v_authorization_actor_id, v_client_surface,
         v_work_checkpoint, v_work_checkpoint_sequence,
         v_turn_id, v_cold_start_deadline_at,
         v_settings_claim_revision, v_settings_claim_skills_revision,
         v_settings_model_id, v_settings_persona, v_settings_can_write_skills,
         v_settings_provider_ids, v_settings_skill_ids, v_settings_skill_refs,
         v_settings_mcp_ids
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id AND i.settings_claim_epoch = p_claim_epoch
      AND i.settings_claim_actor_id IS NOT NULL AND i.settings_claim_revision IS NOT NULL;
    IF NOT FOUND THEN RETURN; END IF;
    v_requires_resources := true;
  ELSIF p_work_kind = 'health' THEN
    IF p_work_id <> p_companion_id OR NOT EXISTS (
      SELECT 1 FROM public.companion_runtime_instances i
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
        AND i.health_claim_epoch = p_claim_epoch
    ) THEN
      RETURN;
    END IF;
    -- Health may observe identifiers already in the runtime projection. It never receives an actor,
    -- model/resource selection, credential reference, or authority to wake/decrypt.
    v_actor_authorized := true;
    v_client_surface := NULL;
    SELECT i.health_checkpoint, i.health_checkpoint_sequence
    INTO v_work_checkpoint, v_work_checkpoint_sequence
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
  ELSE
    RETURN;
  END IF;
  v_work_priority := CASE
    WHEN p_work_kind = 'operation' AND v_operation_kind = 'delete' THEN 10
    WHEN p_work_kind = 'operation' AND v_operation_kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
    WHEN p_work_kind = 'operation' AND v_operation_kind = 'start' THEN 45
    WHEN p_work_kind = 'decision' THEN 30
    WHEN p_work_kind = 'attempt' THEN 40
    WHEN p_work_kind IN ('settings', 'operation') THEN 50
    ELSE 70
  END;

  -- Precedence remains live while a lease is held. Renewal reports a higher-priority durable intent
  -- instead of extending the lease; the executor can interrupt/release at its next safe checkpoint.
  SELECT EXISTS (
    SELECT 1 FROM public.companion_operations o
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.status IN ('pending', 'running') AND o.available_at <= v_now
      AND (p_work_kind <> 'operation' OR o.id <> p_work_id)
      -- A stale lifecycle intent must not preempt authorized work after its actor loses access.
      -- Claim will terminalize that row on the next sweep; until then it is invisible to live
      -- precedence. Delete remains owner-only, matching both claim and the final renew gate.
      AND EXISTS (
        SELECT 1
        FROM public.memberships candidate_membership
        JOIN public.companions candidate_companion
          ON candidate_companion.org_id = candidate_membership.org_id
         AND candidate_companion.id = o.companion_id
        WHERE candidate_membership.org_id = o.org_id
          AND candidate_membership.user_id = o.actor_id
          AND (
            candidate_companion.owner_id = o.actor_id
            OR (
              o.kind <> 'delete'
              AND EXISTS (
                SELECT 1
                FROM public.companion_workspace_access candidate_access
                WHERE candidate_access.org_id = o.org_id
                  AND candidate_access.companion_id = o.companion_id
                  AND candidate_access.role = 'editor'
                FOR NO KEY UPDATE
              )
            )
          )
        FOR NO KEY UPDATE OF candidate_membership, candidate_companion
      )
      AND (
        o.kind <> 'apply_settings'
        OR EXISTS (
          SELECT 1 FROM public.companion_runtime_instances warm_instance
          WHERE warm_instance.org_id = o.org_id
            AND warm_instance.companion_id = o.companion_id
            AND warm_instance.box_state IN ('ready', 'idle', 'running')
        )
        OR EXISTS (
          SELECT 1 FROM public.companion_turns settings_turn
          WHERE settings_turn.org_id = o.org_id
            AND settings_turn.companion_id = o.companion_id
            AND settings_turn.status = 'queued'
        )
      )
      AND CASE
        WHEN o.kind = 'delete' THEN 10
        WHEN o.kind IN ('stop', 'restart_pi', 'restart_box') THEN 20
        WHEN o.kind = 'start' THEN 45
        ELSE 50
      END < v_work_priority
    UNION ALL
    SELECT 1 FROM public.companion_decision_deliveries d
    WHERE v_work_priority > 30
      AND d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
      AND (d.decision_status <> 'pending' OR d.expires_at <= v_now)
      AND EXISTS (
        SELECT 1 FROM public.companion_turn_attempts decision_attempt
        WHERE decision_attempt.org_id = d.org_id
          AND decision_attempt.companion_id = d.companion_id
          AND decision_attempt.turn_id = d.turn_id
          AND decision_attempt.id = d.attempt_id
          AND decision_attempt.status IN ('starting', 'dispatching', 'running', 'needs_input')
      )
    UNION ALL
    SELECT 1 FROM public.companion_turn_attempts a
    WHERE v_work_priority > 40
      AND a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
    UNION ALL
    SELECT 1 FROM public.companion_runtime_instances settings_instance
    JOIN public.companions settings_companion
      ON settings_companion.org_id = settings_instance.org_id
     AND settings_companion.id = settings_instance.companion_id
    WHERE v_work_priority > 50
      AND settings_instance.org_id = p_org_id
      AND settings_instance.companion_id = p_companion_id
      AND settings_instance.settings_actor_id IS NOT NULL
      AND settings_instance.settings_available_at <= v_now
      AND (
        settings_instance.desired_settings_revision > settings_instance.applied_settings_revision
        OR EXISTS (
          SELECT 1 FROM public.companion_turns profile_turn
          WHERE profile_turn.org_id = settings_instance.org_id
            AND profile_turn.companion_id = settings_instance.companion_id
            AND profile_turn.status = 'queued'
            AND NOT EXISTS (
              SELECT 1 FROM public.companion_turns earlier_turn
              WHERE earlier_turn.org_id = profile_turn.org_id
                AND earlier_turn.companion_id = profile_turn.companion_id
                AND earlier_turn.status = 'queued'
                AND earlier_turn.queue_sequence < profile_turn.queue_sequence
            )
            AND (
              settings_instance.applied_client_surface IS NULL
            )
        )
        OR (
          settings_companion.skills_revision > settings_instance.applied_skills_revision
          AND EXISTS (
            SELECT 1 FROM public.companion_turns settings_turn
            WHERE settings_turn.org_id = settings_instance.org_id
              AND settings_turn.companion_id = settings_instance.companion_id
              AND settings_turn.status = 'queued'
              AND NOT EXISTS (
                SELECT 1 FROM public.companion_turns earlier_turn
                WHERE earlier_turn.org_id = settings_turn.org_id
                  AND earlier_turn.companion_id = settings_turn.companion_id
                  AND earlier_turn.status = 'queued'
                  AND earlier_turn.queue_sequence < settings_turn.queue_sequence
              )
          )
        )
      )
      AND (
        settings_instance.box_state IN ('ready', 'idle', 'running')
        OR EXISTS (
          SELECT 1 FROM public.companion_turns settings_turn
          WHERE settings_turn.org_id = settings_instance.org_id
            AND settings_turn.companion_id = settings_instance.companion_id
            AND settings_turn.status = 'queued'
        )
      )
    UNION ALL
    SELECT 1 FROM public.companion_turns t
    JOIN public.companion_runtime_instances queue_instance
      ON queue_instance.org_id = t.org_id AND queue_instance.companion_id = t.companion_id
    JOIN public.companions queue_companion
      ON queue_companion.org_id = t.org_id AND queue_companion.id = t.companion_id
    WHERE v_work_priority > 60
      AND t.org_id = p_org_id AND t.companion_id = p_companion_id AND t.status = 'queued'
      AND queue_instance.desired_settings_revision = queue_instance.applied_settings_revision
      AND (
        (queue_instance.applied_client_surface IS NOT NULL
          AND queue_instance.applied_skills_revision >= queue_companion.skills_revision)
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.companion_turns earlier_turn
        WHERE earlier_turn.org_id = t.org_id
          AND earlier_turn.companion_id = t.companion_id
          AND earlier_turn.status = 'queued'
          AND earlier_turn.queue_sequence < t.queue_sequence
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.companion_turns blocking_turn
        WHERE blocking_turn.org_id = t.org_id AND blocking_turn.companion_id = t.companion_id
          AND blocking_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
      )
  ) INTO v_higher_priority_pending;
  IF v_higher_priority_pending THEN
    v_denial_code := 'higher_priority_work_pending';
  END IF;
  v_requires_skills_mcp := v_requires_resources;

  SELECT i.generation, i.box_id, i.box_state, i.pi_state, i.pi_invocation_id,
         i.disk_layout_version, i.applied_settings_revision, i.applied_skills_revision,
         c.model_id, c.persona, c.can_write_skills, c.provider_ids,
         c.selected_skill_ids, c.selected_mcp_account_ids,
         i.desired_settings_revision, c.skills_revision, c.owner_id
  INTO v_generation, v_box_id, v_box_state, v_pi_state, v_pi_invocation_id,
       v_disk_layout_version, v_applied_settings_revision, v_applied_skills_revision,
       v_model_id, v_persona, v_can_write_skills, v_provider_ids,
       v_skill_ids, v_mcp_ids, v_live_desired_settings_revision, v_live_skills_revision,
       v_companion_owner_id
  FROM public.companion_runtime_instances i
  JOIN public.companions c
    ON c.org_id = i.org_id AND c.id = i.companion_id
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
  IF NOT FOUND THEN RETURN; END IF;

  v_desired_settings_revision := v_live_desired_settings_revision;
  v_skills_revision := v_live_skills_revision;

  -- Implicit settings work must apply the latest revision before every Box interaction. If the
  -- control plane changes either revision while this lease is held, deny renewal; release (or an
  -- expired-lease takeover) invalidates the stale snapshot and the next claim captures the latest.
  IF v_denial_code IS NULL
     AND p_work_kind = 'settings'
     AND (
       v_live_desired_settings_revision IS DISTINCT FROM v_settings_claim_revision
       OR v_live_skills_revision IS DISTINCT FROM v_settings_claim_skills_revision
     ) THEN
    v_denial_code := 'settings_changed_since_claim';
  END IF;

  -- Active turns use the snapshot captured at promotion. Resource-bearing lifecycle operations use
  -- the snapshot captured with their durable intent. A concurrent edit therefore produces later
  -- settings work instead of changing what a takeover stages or launches midway through a claim.
  IF v_attempt_id IS NOT NULL THEN
    SELECT a.model_id, a.persona, a.can_write_skills,
           a.provider_ids, a.selected_skill_ids, a.skill_refs,
           a.selected_mcp_account_ids, a.settings_revision, a.skills_revision
    INTO v_model_id, v_persona, v_can_write_skills,
         v_provider_ids, v_skill_ids, v_attempt_skill_refs,
         v_mcp_ids, v_desired_settings_revision, v_skills_revision
    FROM public.companion_turn_attempts a
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id AND a.id = v_attempt_id;
    IF NOT FOUND THEN RETURN; END IF;
    v_has_pinned_resources := true;
  ELSIF p_work_kind = 'operation' AND v_requires_resources THEN
    v_model_id := v_operation_model_id;
    v_persona := v_operation_persona;
    v_can_write_skills := v_operation_can_write_skills;
    v_provider_ids := v_operation_provider_ids;
    v_skill_ids := v_operation_skill_ids;
    v_attempt_skill_refs := v_operation_skill_refs;
    v_mcp_ids := v_operation_mcp_ids;
    v_desired_settings_revision := v_operation_target_settings_revision;
    v_skills_revision := v_operation_target_skills_revision;
    v_has_pinned_resources := true;
  ELSIF p_work_kind = 'settings' THEN
    v_model_id := v_settings_model_id;
    v_persona := v_settings_persona;
    v_can_write_skills := v_settings_can_write_skills;
    v_provider_ids := v_settings_provider_ids;
    v_skill_ids := v_settings_skill_ids;
    v_attempt_skill_refs := v_settings_skill_refs;
    v_mcp_ids := v_settings_mcp_ids;
    v_desired_settings_revision := v_settings_claim_revision;
    v_skills_revision := v_settings_claim_skills_revision;
    v_has_pinned_resources := true;
  END IF;

  IF v_denial_code IS NULL AND p_work_kind <> 'health' THEN
    -- These locks are part of the authorization result. They conflict with membership removal,
    -- ownership/share changes, and are held through the final lease CAS/transaction commit, so a
    -- concurrent revocation cannot slip between the decision and authorized=true.
    v_actor_authorized := false;
    SELECT c.owner_id
    INTO v_companion_owner_id
    FROM public.memberships m
    JOIN public.companions c ON c.org_id = m.org_id AND c.id = p_companion_id
    WHERE m.org_id = p_org_id AND m.user_id = v_authorization_actor_id
    FOR NO KEY UPDATE OF m, c;
    IF FOUND AND v_companion_owner_id = v_authorization_actor_id THEN
      v_actor_authorized := true;
    ELSIF FOUND AND v_operation_kind IS DISTINCT FROM 'delete' THEN
      PERFORM 1
      FROM public.companion_workspace_access a
      WHERE a.org_id = p_org_id
        AND a.companion_id = p_companion_id
        AND a.role = 'editor'
      FOR NO KEY UPDATE;
      v_actor_authorized := FOUND;
    END IF;

    IF NOT v_actor_authorized THEN
      v_denial_code := 'actor_access_revoked';
    END IF;

    IF v_denial_code IS NULL AND p_work_kind = 'decision' AND v_decision_actor_id IS NOT NULL THEN
      v_responder_authorized := false;
      PERFORM 1
      FROM public.memberships responder_membership
      WHERE responder_membership.org_id = p_org_id
        AND responder_membership.user_id = v_decision_actor_id
      FOR NO KEY UPDATE;
      IF FOUND AND v_companion_owner_id = v_decision_actor_id THEN
        v_responder_authorized := true;
      ELSIF FOUND THEN
        PERFORM 1
        FROM public.companion_workspace_access responder_access
        WHERE responder_access.org_id = p_org_id
          AND responder_access.companion_id = p_companion_id
          AND responder_access.role = 'editor'
        FOR NO KEY UPDATE;
        v_responder_authorized := FOUND;
      END IF;
      IF NOT v_responder_authorized THEN
        v_denial_code := 'decision_actor_access_revoked';
      END IF;
    ELSIF v_denial_code IS NULL AND p_work_kind = 'decision'
          AND v_decision_actor_id IS NULL AND v_decision_status <> 'expired' THEN
      v_denial_code := 'decision_actor_missing';
    END IF;
  END IF;

  IF v_denial_code IS NULL AND v_requires_resources THEN
    IF jsonb_typeof(v_provider_ids) <> 'array'
       OR (v_requires_skills_mcp AND jsonb_typeof(v_skill_ids) <> 'array')
       OR (v_requires_skills_mcp AND v_has_pinned_resources
           AND jsonb_typeof(v_attempt_skill_refs) <> 'array')
       OR (v_requires_skills_mcp AND jsonb_typeof(v_mcp_ids) <> 'array') THEN
      v_denial_code := 'invalid_resource_selection';
    ELSIF jsonb_array_length(v_provider_ids) <> 1
       OR v_model_id IS NULL
       OR char_length(v_model_id) NOT BETWEEN 1 AND 200
       OR v_model_id ~ E'[\n\r]' THEN
      v_denial_code := 'invalid_model_selection';
    ELSIF EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_provider_ids) selected(provider_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.companion_provider_connections p
        WHERE p.org_id = p_org_id AND p.provider_id = selected.provider_id
        FOR NO KEY UPDATE
      )
    ) THEN
      v_denial_code := 'provider_access_revoked';
    ELSIF v_requires_skills_mcp AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.skills s
        WHERE s.org_id = p_org_id
          AND s.id::text = selected.skill_id
          AND s.archived_at IS NULL
          AND (
            s.scope = 'org'
            OR (
              s.creator_id = v_authorization_actor_id
              AND (v_decision_actor_id IS NULL OR s.creator_id = v_decision_actor_id)
            )
          )
        FOR NO KEY UPDATE
      )
    ) THEN
      v_denial_code := 'skill_access_revoked';
    ELSIF v_requires_skills_mcp AND v_has_pinned_resources AND (
      EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_attempt_skill_refs) pinned(ref)
        WHERE jsonb_typeof(pinned.ref) <> 'object'
           OR COALESCE(jsonb_typeof(pinned.ref -> 'skill_id'), 'missing') <> 'string'
           OR COALESCE(jsonb_typeof(pinned.ref -> 'current_version_id'), 'missing')
                NOT IN ('string', 'null')
           OR NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
             WHERE selected.skill_id = pinned.ref ->> 'skill_id'
           )
           OR (
             pinned.ref ->> 'current_version_id' IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
               FROM public.skill_versions pinned_version
               WHERE pinned_version.org_id = p_org_id
                 AND pinned_version.skill_id::text = pinned.ref ->> 'skill_id'
                 AND pinned_version.id::text = pinned.ref ->> 'current_version_id'
               FOR KEY SHARE
             )
           )
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
        WHERE NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_attempt_skill_refs) pinned(ref)
          WHERE pinned.ref ->> 'skill_id' = selected.skill_id
        )
      )
    ) THEN
      v_denial_code := 'invalid_resource_selection';
    ELSIF v_requires_skills_mcp AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements_text(v_mcp_ids) selected(account_id)
      WHERE NOT EXISTS (
        SELECT 1 FROM public.companion_mcp_accounts a
        WHERE a.org_id = p_org_id
          AND a.id::text = selected.account_id
          AND a.owner_id = v_authorization_actor_id
          AND (v_decision_actor_id IS NULL OR a.owner_id = v_decision_actor_id)
        FOR NO KEY UPDATE
      )
    ) THEN
      v_denial_code := 'mcp_access_revoked';
    END IF;
  END IF;

  -- Re-sample after authorization/resource reads: those reads can wait behind concurrent ACL or
  -- configuration writes. Deadlines are authority boundaries, not informational timestamps.
  v_now := clock_timestamp();
  IF p_work_kind IN ('attempt', 'decision')
     AND v_absolute_deadline_at IS NOT NULL
     AND v_now >= v_absolute_deadline_at THEN
    v_denial_code := 'absolute_deadline_exceeded';
  ELSIF p_work_kind IN ('attempt', 'decision')
        AND v_inactivity_deadline_at IS NOT NULL
        AND v_now >= v_inactivity_deadline_at THEN
    v_denial_code := 'inactivity_deadline_exceeded';
  -- The three-minute cold-send budget follows the source turn across Start settlement and the
  -- attempt boundary. Once Pi has acknowledged the prompt, normal attempt deadlines take over.
  ELSIF v_cold_start_deadline_at IS NOT NULL
        AND v_now >= v_cold_start_deadline_at
        AND (
          (p_work_kind = 'operation' AND v_operation_kind IN ('start', 'apply_settings'))
          OR p_work_kind = 'settings'
          OR (p_work_kind = 'attempt' AND v_dispatch_state <> 'accepted')
        ) THEN
    v_denial_code := 'cold_start_deadline_exceeded';
  END IF;

  -- An Owner/Editor stop wins over higher-priority work and deadline denials. The executor must
  -- still see Box identity so it can abort Pi before settling; other denials keep that identity
  -- null.
  IF p_work_kind IN ('attempt', 'decision') AND v_cancel_requested_at IS NOT NULL THEN
    v_denial_code := 'turn_cancel_requested';
  END IF;

  IF v_denial_code IS NOT NULL THEN
    IF v_denial_code = 'turn_cancel_requested' THEN
      RETURN QUERY SELECT
        false, v_denial_code, v_lease_expires_at,
        v_authorization_actor_id, NULL::text, v_client_surface, v_generation, v_box_id,
        v_box_state, v_pi_state, v_pi_invocation_id, v_disk_layout_version,
        v_applied_settings_revision, v_applied_skills_revision, NULL::text,
        NULL::text, NULL::boolean,
        '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL::bigint, NULL::integer,
        v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id, v_turn_status,
        v_attempt_status, v_dispatch_state, v_event_cursor,
        v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
        v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
        v_operation_kind, v_operation_started_at, v_operation_attempt_count,
        v_operation_provider_operation_id,
        v_operation_target_settings_revision, v_operation_target_skills_revision,
        v_decision_status, v_decision_delivery_state,
        NULL::text, NULL::text;
      RETURN;
    END IF;
    RETURN QUERY SELECT
      false, v_denial_code, v_lease_expires_at,
      NULL::text, NULL::text, v_client_surface, NULL::bigint, NULL::text,
      NULL::public.companion_box_observed_state,
      NULL::public.companion_pi_observed_state,
      NULL::text, NULL::integer, NULL::bigint, NULL::integer, NULL::text,
      NULL::text, NULL::boolean,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, NULL::bigint, NULL::integer,
      v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id, v_turn_status,
      v_attempt_status, v_dispatch_state, v_event_cursor,
      v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
      v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
      v_operation_kind, v_operation_started_at, v_operation_attempt_count,
      v_operation_provider_operation_id,
      v_operation_target_settings_revision, v_operation_target_skills_revision,
      v_decision_status, v_decision_delivery_state,
      NULL::text, NULL::text;
    RETURN;
  END IF;

  IF v_requires_resources THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'provider_id', p.provider_id,
      'credential_generation', p.credential_generation,
      'credential_version', p.credential_version
    ) ORDER BY p.provider_id), '[]'::jsonb)
    INTO v_provider_refs
    FROM public.companion_provider_connections p
    WHERE p.org_id = p_org_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(v_provider_ids) selected(provider_id)
        WHERE selected.provider_id = p.provider_id
      );

    IF v_requires_skills_mcp THEN
      IF v_has_pinned_resources THEN
        v_skill_refs := v_attempt_skill_refs;
      ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'skill_id', s.id,
          'current_version_id', s.current_version_id
        ) ORDER BY s.id), '[]'::jsonb)
        INTO v_skill_refs
        FROM public.skills s
        WHERE s.org_id = p_org_id
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(v_skill_ids) selected(skill_id)
            WHERE selected.skill_id = s.id::text
          );
      END IF;

      SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'account_id', a.id,
        'credential_generation', a.credential_generation
      ) ORDER BY a.id), '[]'::jsonb)
      INTO v_mcp_refs
      FROM public.companion_mcp_accounts a
      WHERE a.org_id = p_org_id
        AND a.owner_id = v_authorization_actor_id
        AND (v_decision_actor_id IS NULL OR a.owner_id = v_decision_actor_id)
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(v_mcp_ids) selected(account_id)
          WHERE selected.account_id = a.id::text
        );
    END IF;
  END IF;

  -- Authorization may have waited on instance or ACL row locks. Re-sample wall time at the final
  -- fence so a call that began before expiry can never return authority after expiry or publish an
  -- already-dead renewal. Holding the lease-row lock prevents takeover between this CAS and return.
  v_now := clock_timestamp();
  UPDATE public.companion_runtime_leases l
  SET renewed_at = v_now,
      expires_at = v_now + make_interval(secs => p_lease_seconds),
      updated_at = v_now
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND NOT (
      p_work_kind IN ('attempt', 'decision')
      AND (
        (v_absolute_deadline_at IS NOT NULL AND v_now >= v_absolute_deadline_at)
        OR (v_inactivity_deadline_at IS NOT NULL AND v_now >= v_inactivity_deadline_at)
      )
    )
    AND NOT (
      v_cold_start_deadline_at IS NOT NULL
      AND v_now >= v_cold_start_deadline_at
      AND (
        (p_work_kind = 'operation' AND v_operation_kind IN ('start', 'apply_settings'))
        OR p_work_kind = 'settings'
        OR (p_work_kind = 'attempt' AND v_dispatch_state <> 'accepted')
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public.companion_runtime_control current_gate
      WHERE current_gate.id = 'runtime-v2'
        AND current_gate.enabled
        AND current_gate.gate_epoch = p_gate_epoch
    )
  RETURNING l.expires_at INTO v_lease_expires_at;
  IF NOT FOUND THEN RETURN; END IF;

  RETURN QUERY SELECT
    true, NULL::text, v_lease_expires_at,
    v_authorization_actor_id, v_decision_actor_id, v_client_surface,
    v_generation, v_box_id,
    v_box_state, v_pi_state, v_pi_invocation_id, v_disk_layout_version,
    v_applied_settings_revision, v_applied_skills_revision,
    CASE WHEN v_requires_resources THEN v_model_id ELSE NULL END,
    CASE WHEN v_requires_resources THEN v_persona ELSE NULL END,
    CASE WHEN v_requires_resources THEN v_can_write_skills ELSE NULL END,
    v_provider_refs, v_skill_refs, v_mcp_refs,
    v_desired_settings_revision, v_skills_revision,
    v_work_checkpoint, v_work_checkpoint_sequence, v_turn_id, v_turn_status,
    v_attempt_status, v_dispatch_state, v_event_cursor,
    v_unknown_event_count, v_malformed_event_count, v_oversized_event_count,
    v_cold_start_deadline_at, v_inactivity_deadline_at, v_absolute_deadline_at,
    v_operation_kind, v_operation_started_at, v_operation_attempt_count,
    v_operation_provider_operation_id,
    v_operation_target_settings_revision, v_operation_target_skills_revision,
    v_decision_status, v_decision_delivery_state,
    v_decision_request_key, v_decision_response_text;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_assign_attempt_snapshot()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_client_surface public.companion_client_surface;
  v_applied_ids jsonb;
  v_applied_refs jsonb;
  v_use_applied boolean;
BEGIN
  SELECT c.persona, t.client_surface,
         i.applied_selected_skill_ids, i.applied_skill_refs,
         i.applied_skills_digest IS NOT NULL AND i.applied_skills_revision >= c.skills_revision
  INTO NEW.persona, v_client_surface, v_applied_ids, v_applied_refs, v_use_applied
  FROM public.companions c
  JOIN public.companion_turns t
    ON t.org_id = c.org_id AND t.companion_id = c.id AND t.id = NEW.turn_id
  JOIN public.companion_runtime_instances i
    ON i.org_id = c.org_id AND i.companion_id = c.id
  WHERE c.org_id = NEW.org_id AND c.id = NEW.companion_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attempt Companion turn does not exist' USING ERRCODE = '23503';
  END IF;

    SELECT c.can_write_skills INTO NEW.can_write_skills
    FROM public.companions c WHERE c.org_id = NEW.org_id AND c.id = NEW.companion_id;
    IF v_use_applied THEN
      NEW.selected_skill_ids := v_applied_ids;
      NEW.skill_refs := v_applied_refs;
    ELSE
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'skill_id', s.id,
               'current_version_id', s.current_version_id
             ) ORDER BY s.id), '[]'::jsonb)
      INTO NEW.skill_refs
      FROM public.skills s
      WHERE s.org_id = NEW.org_id
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(NEW.selected_skill_ids) selected(skill_id)
          WHERE selected.skill_id = s.id::text
        );
    END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_assign_operation_intent()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_applied_revision integer;
  v_applied_ids jsonb;
  v_applied_refs jsonb;
  v_applied_digest text;
  v_required_revision integer;
  v_available_revision integer;
BEGIN
  UPDATE public.companion_runtime_instances i
  SET next_operation_sequence = i.next_operation_sequence + 1,
      updated_at = statement_timestamp()
  WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.companion_id
  RETURNING i.next_operation_sequence - 1, i.next_turn_sequence - 1,
    i.applied_skills_revision, i.applied_selected_skill_ids,
    i.applied_skill_refs, i.applied_skills_digest
  INTO NEW.queue_sequence, NEW.turn_queue_cutoff, v_applied_revision,
    v_applied_ids, v_applied_refs, v_applied_digest;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operation runtime instance does not exist' USING ERRCODE = '23503';
  END IF;

  IF NEW.kind IN ('start', 'restart_pi', 'restart_box', 'apply_settings', 'stop') THEN
    IF NEW.kind <> 'stop' THEN
      SELECT COALESCE(t.client_surface, NEW.client_surface, 'web'::public.companion_client_surface)
      INTO NEW.client_surface
      FROM (SELECT 1) singleton
      LEFT JOIN public.companion_turns t
        ON t.org_id = NEW.org_id AND t.companion_id = NEW.companion_id
       AND t.id = NEW.source_turn_id;
    ELSE
      NEW.client_surface := NULL;
    END IF;

    SELECT i.desired_settings_revision, c.skills_revision, c.skills_available_revision,
           c.model_id, c.persona, c.can_write_skills,
           c.provider_ids, c.selected_skill_ids, c.selected_mcp_account_ids
    INTO NEW.target_settings_revision, v_required_revision, v_available_revision,
         NEW.model_id, NEW.persona, NEW.can_write_skills,
         NEW.provider_ids, NEW.selected_skill_ids, NEW.selected_mcp_account_ids
    FROM public.companion_runtime_instances i
    JOIN public.companions c ON c.org_id = i.org_id AND c.id = i.companion_id
    WHERE i.org_id = NEW.org_id AND i.companion_id = NEW.companion_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'operation Companion does not exist' USING ERRCODE = '23503';
    END IF;

    IF NEW.kind = 'start' AND v_applied_digest IS NOT NULL
       AND v_applied_revision >= v_required_revision THEN
      NEW.target_skills_revision := v_applied_revision;
      NEW.selected_skill_ids := v_applied_ids;
      NEW.skill_refs := v_applied_refs;
    ELSE
      NEW.target_skills_revision := v_available_revision;
    END IF;

    IF NEW.skill_refs IS NULL THEN
      SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'skill_id', s.id,
               'current_version_id', s.current_version_id
             ) ORDER BY s.id), '[]'::jsonb)
      INTO NEW.skill_refs
      FROM public.skills s
      WHERE s.org_id = NEW.org_id
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements_text(NEW.selected_skill_ids) selected(skill_id)
          WHERE selected.skill_id = s.id::text
        );
    END IF;

    IF NEW.kind IN ('stop', 'restart_pi', 'restart_box', 'apply_settings') THEN
      NEW.skill_update_selected_skill_ids := NEW.selected_skill_ids;
      NEW.skill_update_refs := NEW.skill_refs;
      IF NEW.kind = 'stop' THEN
        NEW.selected_skill_ids := NULL;
        NEW.skill_refs := NULL;
      ELSIF v_applied_digest IS NOT NULL AND v_applied_revision >= v_required_revision THEN
        -- Resource-bearing lifecycle work only needs provider/MCP authority when it can preserve
        -- the proven installed tree. The separate update snapshot is authorized independently.
        NEW.selected_skill_ids := '[]'::jsonb;
        NEW.skill_refs := '[]'::jsonb;
      END IF;
    ELSE
      NEW.skill_update_selected_skill_ids := NULL;
      NEW.skill_update_refs := NULL;
    END IF;

    IF NEW.kind = 'stop' THEN
      NEW.target_settings_revision := NULL;
      NEW.model_id := NULL;
      NEW.persona := NULL;
      NEW.can_write_skills := NULL;
      NEW.provider_ids := NULL;
      NEW.selected_mcp_account_ids := NULL;
    END IF;
  ELSE
    NEW.client_surface := NULL;
    NEW.target_settings_revision := NULL;
    NEW.target_skills_revision := NULL;
    NEW.model_id := NULL;
    NEW.persona := NULL;
    NEW.can_write_skills := NULL;
    NEW.provider_ids := NULL;
    NEW.selected_skill_ids := NULL;
    NEW.skill_refs := NULL;
    NEW.skill_update_selected_skill_ids := NULL;
    NEW.skill_update_refs := NULL;
    NEW.selected_mcp_account_ids := NULL;
  END IF;

  IF NEW.kind = 'start' AND NEW.source_turn_id IS NOT NULL THEN
    UPDATE public.companion_turns t
    SET cold_start_deadline_at = COALESCE(t.cold_start_deadline_at, t.created_at + interval '3 minutes'),
        updated_at = statement_timestamp()
    WHERE t.org_id = NEW.org_id AND t.companion_id = NEW.companion_id
      AND t.id = NEW.source_turn_id AND t.status = 'queued';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'cold-start source turn must be queued' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_get_material(p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint, p_executor_id text, p_work_kind companion_runtime_work_kind, p_work_id uuid, p_lease_seconds integer)
 RETURNS TABLE(turn_id uuid, attempt_id uuid, message_event_id text, prompt_text text, decision_request_kind companion_decision_request_kind, decision_response_payload jsonb, provider_material jsonb, skill_material jsonb, mcp_material jsonb, model_input jsonb, has_visible_output boolean, attachments jsonb, credential_snapshot_matches boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_authorization record;
  v_turn_id uuid;
  v_message_event_id text;
  v_prompt_text text;
  v_request_kind public.companion_decision_request_kind;
  v_response_payload jsonb;
  v_provider_material jsonb := '[]'::jsonb;
  v_skill_material jsonb := '[]'::jsonb;
  v_mcp_material jsonb := '[]'::jsonb;
  v_attachments jsonb := '[]'::jsonb;
  v_attachment_bytes bigint := 0;
  v_visible_attempt_id uuid;
  v_has_visible_output boolean := false;
  v_pinned_provider_refs jsonb;
  v_pinned_mcp_refs jsonb;
  v_credential_snapshot_matches boolean := true;
  v_expected integer;
BEGIN
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN
    RETURN;
  END IF;

  v_turn_id := v_authorization.turn_id;
  IF p_work_kind = 'attempt' THEN
    v_visible_attempt_id := p_work_id;
    SELECT attempt.provider_credential_refs, attempt.mcp_credential_refs,
      turn_row.message_event_id, entry.content
    INTO v_pinned_provider_refs, v_pinned_mcp_refs, v_message_event_id, v_prompt_text
    FROM public.companion_turn_attempts attempt
    JOIN public.companion_turns turn_row
      ON turn_row.org_id = attempt.org_id
     AND turn_row.companion_id = attempt.companion_id
     AND turn_row.id = attempt.turn_id
    JOIN public.companion_transcript_entries entry
      ON entry.org_id = turn_row.org_id
     AND entry.companion_id = turn_row.companion_id
     AND entry.event_id = turn_row.message_event_id
    WHERE attempt.org_id = p_org_id
      AND attempt.companion_id = p_companion_id
      AND attempt.id = p_work_id
      AND attempt.turn_id = v_turn_id
      AND attempt.claim_epoch = p_claim_epoch
      AND entry.role = 'user'
      AND entry.author_id = turn_row.actor_id
    FOR UPDATE OF attempt;
    IF NOT FOUND OR v_prompt_text IS NULL OR octet_length(v_prompt_text) > 1048576 THEN
      RAISE EXCEPTION 'claimed turn prompt is unavailable' USING ERRCODE = '22023';
    END IF;

    -- Files the runtime must stage read-only on the Box before it dispatches this prompt. The
    -- storage key travels because only the runtime holds object-storage credentials; the digest
    -- travels so the bytes it downloads can be proven to be the bytes that were accepted.
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', attachment.id,
        'storage_key', attachment.storage_key,
        'content_type', attachment.content_type,
        'byte_size', attachment.byte_size,
        'sha256', attachment.sha256,
        'filename', attachment.filename,
        'position', attachment.position
      ) ORDER BY attachment.position), '[]'::jsonb),
      COALESCE(sum(attachment.byte_size), 0)
    INTO v_attachments, v_attachment_bytes
    FROM public.companion_message_attachments attachment
    WHERE attachment.org_id = p_org_id
      AND attachment.companion_id = p_companion_id
      AND attachment.entry_event_id = v_message_event_id
      AND attachment.kind = 'user_upload';
    IF jsonb_array_length(v_attachments) > 5 OR v_attachment_bytes > 52428800 THEN
      RAISE EXCEPTION 'claimed turn attachments exceed the bounded executor contract'
        USING ERRCODE = '22023';
    END IF;

    IF v_pinned_provider_refs IS NULL AND v_pinned_mcp_refs IS NULL THEN
      UPDATE public.companion_turn_attempts attempt
      SET provider_credential_refs = v_authorization.provider_refs,
          mcp_credential_refs = v_authorization.mcp_refs,
          updated_at = clock_timestamp()
      WHERE attempt.org_id = p_org_id
        AND attempt.companion_id = p_companion_id
        AND attempt.id = p_work_id
        AND attempt.claim_epoch = p_claim_epoch;
      v_pinned_provider_refs := v_authorization.provider_refs;
      v_pinned_mcp_refs := v_authorization.mcp_refs;
    ELSIF v_pinned_provider_refs IS NULL
       OR v_pinned_mcp_refs IS NULL
       OR v_pinned_provider_refs IS DISTINCT FROM v_authorization.provider_refs
       OR v_pinned_mcp_refs IS DISTINCT FROM v_authorization.mcp_refs THEN
      v_credential_snapshot_matches := false;
    END IF;
  END IF;

  IF p_work_kind = 'decision' THEN
    SELECT delivery.attempt_id, delivery.request_kind,
      CASE
        WHEN delivery.request_kind = 'question' AND delivery.decision_status = 'answered' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key,
            'value', delivery.response_text
          )
        WHEN delivery.request_kind::text IN ('confirmation', 'config_proposal', 'routine_proposal', 'trigger_proposal')
             AND delivery.decision_status = 'allowed' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'confirmed', true
          )
        WHEN delivery.request_kind::text IN ('confirmation', 'config_proposal', 'routine_proposal', 'trigger_proposal')
             AND delivery.decision_status = 'denied' THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'confirmed', false
          )
        WHEN delivery.decision_status IN ('denied', 'expired', 'cancelled') THEN
          jsonb_build_object(
            'type', 'extension_ui_response', 'id', delivery.request_key, 'cancelled', true
          )
        ELSE NULL
      END
    INTO v_visible_attempt_id, v_request_kind, v_response_payload
    FROM public.companion_decision_deliveries delivery
    WHERE delivery.org_id = p_org_id
      AND delivery.companion_id = p_companion_id
      AND delivery.id = p_work_id
      AND delivery.claim_epoch = p_claim_epoch;
    IF NOT FOUND OR v_response_payload IS NULL OR octet_length(v_response_payload::text) > 32768 THEN
      RAISE EXCEPTION 'claimed decision response is unavailable' USING ERRCODE = '22023';
    END IF;
  END IF;

  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'provider_id', connection.provider_id,
      'auth_method', connection.auth_method,
      'credential_generation', connection.credential_generation,
      'credential_version', connection.credential_version,
      'ciphertext', connection.ciphertext,
      'iv', connection.iv,
      'auth_tag', connection.auth_tag,
      'wrapped_dek', connection.wrapped_dek,
      'wrap_iv', connection.wrap_iv,
      'wrap_auth_tag', connection.wrap_auth_tag,
      'key_id', connection.key_id
    ) ORDER BY connection.provider_id), '[]'::jsonb)
  INTO v_provider_material
  FROM public.companion_provider_connections connection
  WHERE connection.org_id = p_org_id
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_authorization.provider_refs) ref
      WHERE ref ->> 'provider_id' = connection.provider_id
        AND ref ->> 'credential_generation' = connection.credential_generation::text
        AND (ref ->> 'credential_version')::integer = connection.credential_version
    );
  v_expected := jsonb_array_length(v_authorization.provider_refs);
  IF jsonb_array_length(v_provider_material) <> v_expected THEN
    RAISE EXCEPTION 'provider material changed after authorization' USING ERRCODE = '40001';
  END IF;

    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_authorization.skill_refs) ref
      WHERE jsonb_typeof(ref) <> 'object'
        OR COALESCE(jsonb_typeof(ref -> 'skill_id'), 'missing') <> 'string'
        OR COALESCE(jsonb_typeof(ref -> 'current_version_id'), 'missing') <> 'string'
    ) THEN
      RAISE EXCEPTION 'Skill material is not pinned to an immutable version' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'skill_id', skill.id,
        'slug', skill.slug,
        'version_id', version.id,
        'version', version.version,
        'checksum', version.checksum,
        'size_bytes', version.size_bytes,
        'storage_path', version.storage_path
      ) ORDER BY skill.id), '[]'::jsonb)
    INTO v_skill_material
    FROM public.skills skill
    JOIN public.skill_versions version
      ON version.org_id = skill.org_id AND version.skill_id = skill.id
    WHERE skill.org_id = p_org_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_authorization.skill_refs) ref
        WHERE ref ->> 'skill_id' = skill.id::text
          AND ref ->> 'current_version_id' = version.id::text
      );
    IF jsonb_array_length(v_skill_material) <> jsonb_array_length(v_authorization.skill_refs) THEN
      RAISE EXCEPTION 'Skill material changed after authorization' USING ERRCODE = '40001';
    END IF;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'account_id', account.id,
        'owner_id', account.owner_id,
        'provider', account.provider,
        'label', account.label,
        'transport', account.transport,
        'account_config', account.account_config,
        'credential_generation', account.credential_generation,
        'ciphertext', account.ciphertext,
        'iv', account.iv,
        'auth_tag', account.auth_tag,
        'wrapped_dek', account.wrapped_dek,
        'wrap_iv', account.wrap_iv,
        'wrap_auth_tag', account.wrap_auth_tag,
        'key_id', account.key_id
      ) ORDER BY account.id), '[]'::jsonb)
    INTO v_mcp_material
    FROM public.companion_mcp_accounts account
    WHERE account.org_id = p_org_id
      AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_authorization.mcp_refs) ref
        WHERE ref ->> 'account_id' = account.id::text
          AND ref ->> 'credential_generation' = account.credential_generation::text
      );
    IF jsonb_array_length(v_mcp_material) <> jsonb_array_length(v_authorization.mcp_refs) THEN
      RAISE EXCEPTION 'MCP material changed after authorization' USING ERRCODE = '40001';
    END IF;

  IF octet_length(v_provider_material::text) > 2097152
     OR octet_length(v_skill_material::text) > 2097152
     OR octet_length(v_mcp_material::text) > 4194304 THEN
    RAISE EXCEPTION 'authorized material exceeds the bounded executor contract' USING ERRCODE = '22023';
  END IF;

  IF v_visible_attempt_id IS NOT NULL THEN
    SELECT EXISTS (
      SELECT 1
      FROM public.companion_transcript_entries entry
      WHERE entry.org_id = p_org_id
        AND entry.companion_id = p_companion_id
        AND entry.event_id LIKE ('v2:' || v_visible_attempt_id::text || ':%')
        AND entry.role IN ('assistant', 'decision')
    ) INTO v_has_visible_output;
  END IF;

  RETURN QUERY SELECT
    v_turn_id, v_visible_attempt_id, v_message_event_id, v_prompt_text,
    v_request_kind, v_response_payload,
    v_provider_material, v_skill_material, v_mcp_material, NULL::jsonb,
    v_has_visible_output, v_attachments, v_credential_snapshot_matches;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_mint_hub_token(p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint, p_executor_id text, p_work_kind companion_runtime_work_kind, p_work_id uuid, p_lease_seconds integer)
 RETURNS TABLE(token text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_authorization record;
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_actor_id text;
  v_surface public.companion_client_surface;
  v_scopes jsonb;
  v_previous uuid;
  v_token_id uuid := gen_random_uuid();
  v_secret text;
  v_token text;
  v_now timestamp with time zone := clock_timestamp();
  v_expires_at timestamp with time zone := v_now + interval '6 hours';
BEGIN
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN RETURN; END IF;

  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;
  -- The currently fenced work is authoritative. An expired settings lease may leave its claim
  -- fields populated while a higher-priority Start is claimed, so consulting those fields first
  -- could mint (or suppress) credentials for the wrong actor/surface. Settings work already
  -- exposes its own claim actor and surface through renew_and_authorize.
  v_actor_id := v_authorization.authorization_actor_id;
  v_surface := v_authorization.client_surface;
  v_previous := v_instance.hub_token_id;

  IF v_actor_id IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM public.memberships membership
       WHERE membership.org_id = p_org_id AND membership.user_id = v_actor_id
     ) THEN
    IF v_previous IS NOT NULL THEN
      UPDATE public.companion_runtime_instances
      SET hub_token_id = NULL,
          material_client_surface = NULL,
          material_pi_invocation_id = NULL,
          material_expires_at = NULL,
          updated_at = v_now
      WHERE org_id = p_org_id AND companion_id = p_companion_id;
      UPDATE public.api_tokens SET revoked_at = v_now
      WHERE id = v_previous AND revoked_at IS NULL;
    END IF;
    RETURN;
  END IF;

  v_scopes := jsonb_build_array(
    'skills:read', 'skills:write', 'secrets:read', 'database:read', 'database:write'
  );
  v_secret := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 48);
  v_token := 'cmp_pat_' || v_secret;

  INSERT INTO public.api_tokens(
    id, org_id, user_id, name, token_prefix, token_hash, scopes,
    source_type, source_agent_id, target_workspace_id, expires_at
  ) VALUES (
    v_token_id, p_org_id, v_actor_id, 'Companion Skills Hub', left(v_token, 14),
    encode(sha256(convert_to(v_token, 'UTF8')), 'hex'), v_scopes,
    'companion', p_companion_id::text, NULL, v_expires_at
  );
  UPDATE public.companion_runtime_instances
  SET hub_token_id = v_token_id,
      material_client_surface = NULL,
      material_pi_invocation_id = NULL,
      material_expires_at = NULL,
      updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id;
  IF v_previous IS NOT NULL THEN
    UPDATE public.api_tokens SET revoked_at = v_now
    WHERE id = v_previous AND revoked_at IS NULL;
  END IF;
  INSERT INTO public.audit_log(org_id, actor_id, action, target_type, target_id, metadata)
  VALUES (
    p_org_id, v_actor_id, 'api_token.issue_companion_write', 'api_token', v_token_id::text,
    jsonb_build_object(
      'sourceType', 'companion', 'sourceAgentId', p_companion_id,
      'scopes', v_scopes, 'expiresAt', v_expires_at
    )
  );
  RETURN QUERY SELECT v_token, v_expires_at;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_mint_mcp_broker_token(p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint, p_executor_id text, p_work_kind companion_runtime_work_kind, p_work_id uuid, p_lease_seconds integer)
 RETURNS TABLE(token text, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_authorization record;
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_previous uuid;
  v_token_id uuid := gen_random_uuid();
  v_secret text;
  v_token text;
  v_now timestamp with time zone := clock_timestamp();
  v_expires_at timestamp with time zone := v_now + interval '6 hours';
BEGIN
  IF p_work_kind NOT IN ('operation', 'settings') THEN
    RAISE EXCEPTION 'MCP broker mint requires staging work' USING ERRCODE = '22023';
  END IF;
  SELECT authorized_row.* INTO v_authorization
  FROM public.companion_runtime_renew_and_authorize(
    p_org_id, p_companion_id, p_claim_token, p_claim_epoch, p_gate_epoch,
    p_executor_id, p_work_kind, p_work_id, p_lease_seconds
  ) authorized_row;
  IF NOT FOUND OR NOT COALESCE(v_authorization.authorized, false) THEN RETURN; END IF;

  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;
  v_previous := v_instance.mcp_broker_token_id;

  IF v_authorization.authorization_actor_id IS NULL
     OR jsonb_array_length(v_authorization.mcp_refs) = 0 THEN
    UPDATE public.companion_runtime_instances
    SET mcp_broker_token_id = NULL, updated_at = v_now
    WHERE org_id = p_org_id AND companion_id = p_companion_id;
    IF v_previous IS NOT NULL THEN
      UPDATE public.companion_mcp_broker_tokens
      SET revoked_at = v_now WHERE id = v_previous AND revoked_at IS NULL;
    END IF;
    RETURN;
  END IF;

  v_secret := left(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 48);
  v_token := 'cmp_mcp_' || v_secret;
  INSERT INTO public.companion_mcp_broker_tokens(
    id, org_id, companion_id, actor_id, token_prefix, token_hash, account_refs, expires_at
  ) VALUES (
    v_token_id, p_org_id, p_companion_id, v_authorization.authorization_actor_id,
    left(v_token, 14), encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
    v_authorization.mcp_refs, v_expires_at
  );
  UPDATE public.companion_runtime_instances
  SET mcp_broker_token_id = v_token_id,
      material_client_surface = NULL,
      material_pi_invocation_id = NULL,
      material_expires_at = NULL,
      updated_at = v_now
  WHERE org_id = p_org_id AND companion_id = p_companion_id;
  IF v_previous IS NOT NULL THEN
    UPDATE public.companion_mcp_broker_tokens
    SET revoked_at = v_now WHERE id = v_previous AND revoked_at IS NULL;
  END IF;
  RETURN QUERY SELECT v_token, v_expires_at;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_observe_instance(p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint, p_executor_id text, p_work_kind companion_runtime_work_kind, p_work_id uuid, p_runtime_generation bigint, p_expected_checkpoint_sequence bigint, p_box_id text, p_box_state companion_box_observed_state, p_pi_state companion_pi_observed_state, p_pi_invocation_id text, p_disk_layout_version integer, p_applied_settings_revision bigint, p_applied_skills_revision integer, p_observed_at timestamp with time zone)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_generation bigint;
  v_box_id text;
  v_pi_invocation_id text;
  v_disk_layout_version integer;
  v_desired_settings_revision bigint;
  v_applied_settings_revision bigint;
  v_applied_skills_revision integer;
  v_skills_revision integer;
  v_last_observed_at timestamp with time zone;
  v_checkpoint text;
  v_checkpoint_sequence bigint;
  v_operation_kind public.companion_operation_kind;
  v_client_surface public.companion_client_surface := 'web';
  v_target_settings_revision bigint;
  v_target_skills_revision integer;
  v_observation_checkpoint text;
  v_checkpoint_updated_at timestamp with time zone;
  v_ambiguous_create_interrupted_at timestamp with time zone;
  v_delete_create_ambiguous boolean := false;
  v_settings_claim_revision bigint;
  v_settings_claim_skills_revision integer;
  v_cold_start_deadline timestamp with time zone;
  v_next_sequence bigint;
BEGIN
  IF p_runtime_generation < 1
     OR p_expected_checkpoint_sequence < 0
     OR p_observed_at IS NULL
     OR p_observed_at > v_now + interval '5 minutes'
     OR (p_box_id IS NOT NULL AND p_box_id !~ '^bx_[23456789abcdefghjkmnpqrstuvwxyz]{8}$')
     OR (p_pi_invocation_id IS NOT NULL AND (
       char_length(p_pi_invocation_id) NOT BETWEEN 1 AND 200
       OR p_pi_invocation_id ~ E'[\n\r]'
     ))
     OR (p_disk_layout_version IS NOT NULL
       AND p_disk_layout_version NOT BETWEEN 0 AND 1000000)
     OR (p_applied_settings_revision IS NOT NULL AND p_applied_settings_revision < 0)
     OR (p_applied_skills_revision IS NOT NULL AND p_applied_skills_revision < 0)
     OR (p_box_id IS NULL AND p_box_state IS NULL AND p_pi_state IS NULL
       AND p_pi_invocation_id IS NULL AND p_disk_layout_version IS NULL
       AND p_applied_settings_revision IS NULL AND p_applied_skills_revision IS NULL)
     OR p_work_kind NOT IN ('operation', 'settings', 'health') THEN
    RAISE EXCEPTION 'invalid Runtime v2 instance observation' USING ERRCODE = '22023';
  END IF;

  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT i.generation, i.box_id, i.pi_invocation_id, i.disk_layout_version,
         i.desired_settings_revision, i.applied_settings_revision,
         i.applied_skills_revision, c.skills_available_revision, i.last_observed_at
  INTO v_generation, v_box_id, v_pi_invocation_id, v_disk_layout_version,
       v_desired_settings_revision, v_applied_settings_revision,
       v_applied_skills_revision, v_skills_revision, v_last_observed_at
  FROM public.companion_runtime_instances i
  JOIN public.companions c
    ON c.org_id = i.org_id AND c.id = i.companion_id
  WHERE i.org_id = p_org_id
    AND i.companion_id = p_companion_id
    AND i.generation = p_runtime_generation
  FOR UPDATE OF i;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now THEN RETURN NULL; END IF;

  IF (v_last_observed_at IS NOT NULL AND p_observed_at < v_last_observed_at)
     OR (p_disk_layout_version IS NOT NULL AND p_disk_layout_version < v_disk_layout_version)
     OR (p_applied_settings_revision IS NOT NULL AND (
       p_applied_settings_revision < v_applied_settings_revision
       OR p_applied_settings_revision > v_desired_settings_revision
     ))
     OR (p_applied_skills_revision IS NOT NULL AND (
       p_applied_skills_revision < v_applied_skills_revision
       OR p_applied_skills_revision > v_skills_revision
     )) THEN
    RETURN NULL;
  END IF;

  -- A Box id is immutable within one runtime generation. Delete settlement, not an observation,
  -- is the only path that clears it after terminal provider evidence.
  IF p_box_id IS NOT NULL AND v_box_id IS NOT NULL AND p_box_id <> v_box_id THEN
    RAISE EXCEPTION 'Box id is immutable within a runtime generation' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.kind, o.client_surface,
           o.checkpoint, o.checkpoint_sequence,
           o.target_settings_revision, o.target_skills_revision,
           t.cold_start_deadline_at, o.updated_at
    INTO v_operation_kind, v_client_surface, v_checkpoint, v_checkpoint_sequence,
         v_target_settings_revision, v_target_skills_revision,
         v_cold_start_deadline, v_checkpoint_updated_at
    FROM public.companion_operations o
    LEFT JOIN public.companion_turns t
      ON t.org_id = o.org_id AND t.companion_id = o.companion_id AND t.id = o.source_turn_id
    WHERE o.org_id = p_org_id
      AND o.companion_id = p_companion_id
      AND o.id = p_work_id
      AND o.runtime_generation = p_runtime_generation
      AND o.status = 'running'
      AND o.claim_epoch = p_claim_epoch
      AND o.checkpoint_sequence = p_expected_checkpoint_sequence
    FOR UPDATE OF o;
    IF NOT FOUND THEN RETURN NULL; END IF;

    IF v_operation_kind = 'delete' THEN
      SELECT MAX(ambiguous_start.updated_at)
      INTO v_ambiguous_create_interrupted_at
      FROM public.companion_operations ambiguous_start
      WHERE ambiguous_start.org_id = p_org_id
        AND ambiguous_start.companion_id = p_companion_id
        AND ambiguous_start.runtime_generation = p_runtime_generation
        AND ambiguous_start.kind = 'start'
        AND ambiguous_start.status = 'interrupted'
        AND ambiguous_start.checkpoint = 'creating_box';
      v_delete_create_ambiguous := v_ambiguous_create_interrupted_at IS NOT NULL;
    END IF;
  ELSIF p_work_kind = 'settings' THEN
    SELECT i.settings_checkpoint, i.settings_checkpoint_sequence,
           i.settings_claim_revision, i.settings_claim_skills_revision,
           i.settings_claim_client_surface, i.settings_claim_cold_start_deadline_at
    INTO v_checkpoint, v_checkpoint_sequence,
         v_settings_claim_revision, v_settings_claim_skills_revision, v_client_surface,
         v_cold_start_deadline
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id
      AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id
      AND i.generation = p_runtime_generation
      AND i.settings_claim_epoch = p_claim_epoch
      AND i.settings_checkpoint = 'applying'
      AND i.settings_checkpoint_sequence = p_expected_checkpoint_sequence;
    IF NOT FOUND THEN RETURN NULL; END IF;
  ELSE
    SELECT i.health_checkpoint, i.health_checkpoint_sequence
    INTO v_checkpoint, v_checkpoint_sequence
    FROM public.companion_runtime_instances i
    WHERE i.org_id = p_org_id
      AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id
      AND i.generation = p_runtime_generation
      AND i.health_claim_epoch = p_claim_epoch
      AND i.health_checkpoint = 'observing'
      AND i.health_checkpoint_sequence = p_expected_checkpoint_sequence;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;

  -- A cold Send's budget also fences the last configuration observation before dispatch. The
  -- runtime may still settle the work as interrupted, but it cannot publish an applied revision
  -- after the source turn's three-minute deadline.
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now
     OR (
       v_cold_start_deadline IS NOT NULL
       AND v_now >= v_cold_start_deadline
       AND (
         (
           p_work_kind = 'operation'
           AND v_operation_kind = 'start'
           -- Never discard causal identity evidence for a Box lookup/create already performed
           -- under a valid renewal. Recording the canonical id prevents an orphan; checkpoint and
           -- settlement still prohibit any subsequent effect or successful cold turn.
           AND NOT (
             v_checkpoint IN ('resolving_box', 'creating_box')
             AND p_box_id IS NOT NULL
           )
         )
         OR (p_work_kind = 'operation' AND v_operation_kind = 'apply_settings')
         OR p_work_kind = 'settings'
       )
     ) THEN
    RETURN NULL;
  END IF;

  -- A create POST cannot be cancelled after its write intent. When Delete preempts that exact
  -- generation, absence is not proof until the full cold-create outcome horizon has elapsed. A
  -- later second observation is still required below, so a delayed named Box is attached and
  -- permanently deleted instead of appearing after retirement.
  IF p_work_kind = 'operation'
     AND v_operation_kind = 'delete'
     AND v_checkpoint = 'pending'
     AND p_box_id IS NULL
     AND p_box_state = 'absent'
     AND v_delete_create_ambiguous
     AND v_now < v_ambiguous_create_interrupted_at + interval '3 minutes' THEN
    RETURN NULL;
  END IF;

  -- Health is observation-only: it may refresh typed states/timestamps, but it cannot discover a
  -- new Box identity or claim that layout/settings/skills were applied. The single exception is
  -- the Pi invocation id: a recycled daemon or a start that crashed after Pi started leaves a
  -- live idle invocation the durable projection does not know, so health may attach or replace
  -- that identity only with idle proof, mirroring the restart operation rule. Lifecycle work may
  -- attach a new Box only while a start is resolving it or immediately after the create write
  -- intent.
  IF p_work_kind = 'health' AND (
       (p_box_id IS NOT NULL AND (v_box_id IS NULL OR p_box_id <> v_box_id))
       OR (p_pi_invocation_id IS NOT NULL
         AND p_pi_invocation_id IS DISTINCT FROM v_pi_invocation_id
         AND p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state)
       OR p_disk_layout_version IS NOT NULL
       OR p_applied_settings_revision IS NOT NULL
       OR p_applied_skills_revision IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'health observation cannot mutate runtime identity or applied revisions'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'settings' AND (
       p_box_id IS NOT NULL
       OR p_box_state IS NOT NULL
       OR p_disk_layout_version IS NOT NULL
       OR p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state
       OR p_pi_invocation_id IS NULL
       OR p_pi_invocation_id IS NOT DISTINCT FROM v_pi_invocation_id
       OR p_applied_settings_revision IS DISTINCT FROM v_settings_claim_revision
       OR p_applied_skills_revision IS DISTINCT FROM v_settings_claim_skills_revision
     ) THEN
    RAISE EXCEPTION 'settings activation requires exact revisions and a new idle Pi invocation'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND p_box_id IS NOT NULL
     AND v_box_id IS NULL
     AND NOT (
       (v_operation_kind = 'start' AND v_checkpoint IN ('resolving_box', 'creating_box'))
       -- A Delete that preempted an ambiguous create must resolve the deterministic generation
       -- name before it may prove absence. If the provider list finds that Box, attach its id so
       -- the normal permanent-delete path is mandatory instead of orphaning the resource.
       OR (v_operation_kind = 'delete'
           AND v_checkpoint IN ('pending', 'box_absence_observed'))
     ) THEN
    RAISE EXCEPTION 'operation cannot attach a Box id at this checkpoint' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND p_pi_invocation_id IS DISTINCT FROM v_pi_invocation_id
     AND p_pi_invocation_id IS NOT NULL
     AND NOT (
       (v_operation_kind IN ('start', 'restart_pi', 'restart_box')
        AND v_checkpoint = 'starting_pi')
       OR (v_operation_kind = 'apply_settings'
           AND v_checkpoint = 'applying_settings')
     ) THEN
    RAISE EXCEPTION 'operation cannot replace the Pi invocation at this checkpoint'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND v_operation_kind IN ('restart_pi', 'restart_box', 'apply_settings')
     AND p_pi_invocation_id IS DISTINCT FROM v_pi_invocation_id
     AND p_pi_invocation_id IS NOT NULL
     AND p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state THEN
    RAISE EXCEPTION 'a restarted Pi invocation may be attached only with idle proof'
      USING ERRCODE = '22023';
  END IF;

  -- Applying settings is one activation proof: staged revisions become durable only when the same
  -- observation replaces the old daemon identity with a new idle Pi invocation.
  IF p_work_kind = 'operation'
     AND v_operation_kind = 'apply_settings'
     AND v_checkpoint = 'applying_settings'
     AND (
       p_pi_state IS DISTINCT FROM 'idle'::public.companion_pi_observed_state
       OR p_pi_invocation_id IS NULL
       OR p_pi_invocation_id IS NOT DISTINCT FROM v_pi_invocation_id
       OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
       OR p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
     ) THEN
    RAISE EXCEPTION 'settings activation requires exact revisions and a new idle Pi invocation'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND p_disk_layout_version IS NOT NULL
     AND NOT (
       v_operation_kind IN ('start', 'restart_box')
       AND v_checkpoint IN ('installing_layout', 'starting_pi', 'pi_ready')
     ) THEN
    RAISE EXCEPTION 'operation cannot apply a disk layout at this checkpoint'
      USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND (p_applied_settings_revision IS NOT NULL OR p_applied_skills_revision IS NOT NULL)
     AND NOT (
       (v_operation_kind IN ('start', 'restart_box')
         AND v_checkpoint IN ('installing_layout', 'starting_pi', 'pi_ready'))
       OR (v_operation_kind = 'apply_settings' AND v_checkpoint = 'applying_settings')
     ) THEN
    RAISE EXCEPTION 'operation cannot apply revisions at this checkpoint' USING ERRCODE = '22023';
  END IF;

  IF p_work_kind = 'operation'
     AND v_operation_kind IN ('start', 'restart_box', 'apply_settings')
     AND (p_applied_settings_revision IS NOT NULL OR p_applied_skills_revision IS NOT NULL)
     AND (v_target_settings_revision IS NULL
         OR v_target_skills_revision IS NULL
         OR p_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
         OR p_applied_skills_revision IS DISTINCT FROM v_target_skills_revision) THEN
    RAISE EXCEPTION 'operation observation must prove its exact captured revisions'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.companion_runtime_instances i
  SET box_id = COALESCE(i.box_id, p_box_id),
      box_state = COALESCE(p_box_state, i.box_state),
      pi_state = COALESCE(p_pi_state, i.pi_state),
      pi_invocation_id = CASE
        -- Absence is positive proof that no invocation remains. Retaining the previous id would
        -- pair an absent daemon state with stale identity and mislead the next health claimant.
        WHEN p_pi_state = 'absent'::public.companion_pi_observed_state THEN NULL
        ELSE COALESCE(p_pi_invocation_id, i.pi_invocation_id)
      END,
      disk_layout_version = COALESCE(p_disk_layout_version, i.disk_layout_version),
      applied_settings_revision = CASE
        WHEN p_work_kind = 'settings' THEN i.applied_settings_revision
        ELSE COALESCE(p_applied_settings_revision, i.applied_settings_revision)
      END,
      applied_skills_revision = CASE
        WHEN p_work_kind = 'settings' THEN i.applied_skills_revision
        ELSE COALESCE(p_applied_skills_revision, i.applied_skills_revision)
      END,
      applied_client_surface = CASE
        WHEN p_work_kind = 'operation' AND p_applied_settings_revision IS NOT NULL
          THEN v_client_surface
        ELSE i.applied_client_surface
      END,
      settings_checkpoint = CASE
        WHEN p_work_kind = 'settings' THEN 'applied'
        ELSE i.settings_checkpoint
      END,
      settings_checkpoint_sequence = i.settings_checkpoint_sequence
        + CASE WHEN p_work_kind = 'settings' THEN 1 ELSE 0 END,
      health_checkpoint = CASE
        WHEN p_work_kind = 'health' THEN 'observed'
        ELSE i.health_checkpoint
      END,
      health_checkpoint_sequence = i.health_checkpoint_sequence
        + CASE WHEN p_work_kind = 'health' THEN 1 ELSE 0 END,
      last_heartbeat_at = CASE
        WHEN p_work_kind = 'health' THEN GREATEST(COALESCE(i.last_heartbeat_at, p_observed_at), p_observed_at)
        ELSE i.last_heartbeat_at
      END,
      box_observed_at = CASE
        WHEN p_box_id IS NOT NULL OR p_box_state IS NOT NULL
          THEN GREATEST(COALESCE(i.box_observed_at, p_observed_at), p_observed_at)
        ELSE i.box_observed_at
      END,
      pi_observed_at = CASE
        WHEN p_pi_state IS NOT NULL OR p_pi_invocation_id IS NOT NULL
          THEN GREATEST(COALESCE(i.pi_observed_at, p_observed_at), p_observed_at)
        ELSE i.pi_observed_at
      END,
      last_observed_at = GREATEST(COALESCE(i.last_observed_at, p_observed_at), p_observed_at),
      last_write_epoch = GREATEST(i.last_write_epoch, p_claim_epoch),
      updated_at = v_now
  WHERE i.org_id = p_org_id
    AND i.companion_id = p_companion_id
    AND i.generation = p_runtime_generation
    AND (p_box_id IS NULL OR i.box_id IS NULL OR i.box_id = p_box_id)
    AND (
      p_work_kind <> 'health'
      OR (
        i.health_claim_epoch = p_claim_epoch
        AND i.health_checkpoint = 'observing'
        AND i.health_checkpoint_sequence = p_expected_checkpoint_sequence
      )
    )
    AND (
      p_work_kind <> 'settings'
      OR (
        i.settings_claim_epoch = p_claim_epoch
        AND i.settings_checkpoint = 'applying'
        AND i.settings_checkpoint_sequence = p_expected_checkpoint_sequence
      )
    );
  IF NOT FOUND THEN RETURN NULL; END IF;

  v_next_sequence := v_checkpoint_sequence
    + CASE WHEN p_work_kind IN ('settings', 'health') THEN 1 ELSE 0 END;
  IF p_work_kind = 'operation' THEN
    v_observation_checkpoint := CASE
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'resolving_box'
        AND p_box_id IS NULL
        AND p_box_state = 'absent' THEN 'box_absence_observed'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'resolving_box'
        AND p_box_id IS NOT NULL
        AND p_box_state IN ('ready', 'idle', 'running') THEN 'box_ready_observed'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'resolving_box'
        AND p_box_id IS NOT NULL THEN 'box_resolved'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'creating_box'
        AND p_box_id IS NOT NULL
        AND p_box_state IN ('ready', 'idle', 'running') THEN 'box_ready_observed'
      WHEN v_operation_kind = 'start'
        AND v_checkpoint = 'creating_box'
        AND p_box_id IS NOT NULL THEN 'box_created'
      WHEN v_operation_kind IN ('start', 'restart_box')
        AND v_checkpoint = 'waiting_ready'
        AND p_box_state IN ('ready', 'idle', 'running') THEN 'box_ready_observed'
      WHEN v_operation_kind = 'stop'
        AND v_checkpoint = 'waiting_archived'
        AND p_box_state = 'archived' THEN 'box_archived'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'pending'
        AND p_box_id IS NULL
        AND p_box_state = 'absent'
        AND v_delete_create_ambiguous THEN 'box_absence_observed'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'pending'
        AND p_box_id IS NULL
        AND p_box_state = 'absent'
        AND NOT v_delete_create_ambiguous THEN 'box_absent'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'box_absence_observed'
        AND p_box_id IS NULL
        AND p_box_state = 'absent'
        AND v_now >= v_checkpoint_updated_at + interval '30 seconds' THEN 'box_absent'
      WHEN v_operation_kind = 'delete'
        AND v_checkpoint = 'waiting_deleted'
        AND p_box_state = 'absent' THEN 'provider_deleted'
      WHEN v_operation_kind = 'apply_settings'
        AND v_checkpoint = 'applying_settings'
        AND p_pi_state = 'idle'
        AND p_pi_invocation_id IS NOT NULL
        AND (v_pi_invocation_id IS NULL OR p_pi_invocation_id <> v_pi_invocation_id)
        AND p_applied_settings_revision = v_target_settings_revision
        AND p_applied_skills_revision = v_target_skills_revision THEN 'settings_applied'
      WHEN v_operation_kind IN ('start', 'restart_pi', 'restart_box')
        AND v_checkpoint = 'starting_pi'
        AND p_pi_state = 'idle'
        AND p_pi_invocation_id IS NOT NULL
        AND (v_pi_invocation_id IS NULL OR p_pi_invocation_id <> v_pi_invocation_id)
        THEN 'pi_observed'
      ELSE NULL
    END;
  END IF;

  IF v_observation_checkpoint IS NOT NULL THEN
    UPDATE public.companion_operations o
    SET checkpoint = v_observation_checkpoint,
        checkpoint_sequence = o.checkpoint_sequence + 1,
        updated_at = v_now
    WHERE o.org_id = p_org_id
      AND o.companion_id = p_companion_id
      AND o.id = p_work_id
      AND o.runtime_generation = p_runtime_generation
      AND o.status = 'running'
      AND o.claim_epoch = p_claim_epoch
      AND o.checkpoint = v_checkpoint
      AND o.checkpoint_sequence = p_expected_checkpoint_sequence
    RETURNING o.checkpoint_sequence INTO v_next_sequence;
    IF v_next_sequence IS NULL THEN
      RAISE EXCEPTION 'failed to persist operation observation evidence' USING ERRCODE = '40001';
    END IF;
  END IF;

  RETURN v_next_sequence;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_prepare_queued_turn_material(p_gate_epoch bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_org_id uuid;
  v_companion_id uuid;
  v_turn_id uuid;
  v_actor_id text;
BEGIN
  -- Preserve Runtime v2's lease -> instance -> work lock order. The helper locks only one invalid
  -- candidate; the guarded claim wrapper repeats this before every row it asks the original claimer
  -- to return.
  SELECT lease.org_id, lease.companion_id
  INTO v_org_id, v_companion_id
  FROM public.companion_runtime_leases lease
  JOIN public.companion_runtime_control control ON control.id = 'runtime-v2'
  JOIN public.companion_runtime_instances instance
    ON instance.org_id = lease.org_id AND instance.companion_id = lease.companion_id
  WHERE control.enabled
    AND control.gate_epoch = p_gate_epoch
    AND (lease.claim_token IS NULL OR lease.expires_at <= v_now)
    AND instance.retirement_state <> 'retired'
    AND EXISTS (
      SELECT 1
      FROM public.companion_turns queued_turn
      JOIN public.companions queued_companion
        ON queued_companion.org_id = queued_turn.org_id
       AND queued_companion.id = queued_turn.companion_id
      WHERE queued_turn.org_id = instance.org_id
        AND queued_turn.companion_id = instance.companion_id
        AND queued_turn.status = 'queued'
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns earlier_turn
          WHERE earlier_turn.org_id = queued_turn.org_id
            AND earlier_turn.companion_id = queued_turn.companion_id
            AND earlier_turn.status = 'queued'
            AND earlier_turn.queue_sequence < queued_turn.queue_sequence
        )
        AND instance.desired_settings_revision = instance.applied_settings_revision
        AND (
          instance.applied_client_surface IS NOT NULL
            AND instance.applied_skills_revision >= queued_companion.skills_revision
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_turns active_turn
          WHERE active_turn.org_id = instance.org_id
            AND active_turn.companion_id = instance.companion_id
            AND active_turn.status IN (
              'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
            )
        )
        AND NOT COALESCE((
          instance.box_state IN ('ready', 'idle', 'running')
          AND instance.pi_state = 'idle'
          AND instance.last_observed_at >= v_now - interval '2 minutes'
          AND instance.material_pi_invocation_id = instance.pi_invocation_id
          AND (
            instance.material_client_surface IS NOT NULL
        AND instance.material_expires_at > v_now + interval '2 hours 5 minutes'
          )
        ), false)
        AND NOT EXISTS (
          SELECT 1 FROM public.companion_operations active_start
          WHERE active_start.org_id = queued_turn.org_id
            AND active_start.companion_id = queued_turn.companion_id
            AND active_start.source_turn_id = queued_turn.id
            AND active_start.kind = 'start'
            AND active_start.status IN ('pending', 'running')
        )
    )
  ORDER BY instance.health_due_at, instance.companion_id
  FOR UPDATE OF lease SKIP LOCKED
  LIMIT 1;
  IF NOT FOUND THEN RETURN false; END IF;

  SELECT queued_turn.id, queued_turn.actor_id
  INTO v_turn_id, v_actor_id
  FROM public.companion_runtime_instances instance
  JOIN public.companions queued_companion
    ON queued_companion.org_id = instance.org_id
   AND queued_companion.id = instance.companion_id
  JOIN public.companion_turns queued_turn
    ON queued_turn.org_id = instance.org_id
   AND queued_turn.companion_id = instance.companion_id
  WHERE instance.org_id = v_org_id
    AND instance.companion_id = v_companion_id
    AND instance.retirement_state <> 'retired'
    AND queued_turn.status = 'queued'
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_turns earlier_turn
      WHERE earlier_turn.org_id = queued_turn.org_id
        AND earlier_turn.companion_id = queued_turn.companion_id
        AND earlier_turn.status = 'queued'
        AND earlier_turn.queue_sequence < queued_turn.queue_sequence
    )
    AND instance.desired_settings_revision = instance.applied_settings_revision
    AND (
      instance.applied_client_surface IS NOT NULL
        AND instance.applied_skills_revision >= queued_companion.skills_revision
    )
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_turns active_turn
      WHERE active_turn.org_id = instance.org_id
        AND active_turn.companion_id = instance.companion_id
        AND active_turn.status IN ('starting', 'dispatching', 'running', 'needs_input', 'interrupted')
    )
    AND NOT COALESCE((
      instance.box_state IN ('ready', 'idle', 'running')
      AND instance.pi_state = 'idle'
      AND instance.last_observed_at >= v_now - interval '2 minutes'
      AND instance.material_pi_invocation_id = instance.pi_invocation_id
      AND (
        instance.material_client_surface IS NOT NULL
        AND instance.material_expires_at > v_now + interval '2 hours 5 minutes'
      )
    ), false)
    AND NOT EXISTS (
      SELECT 1 FROM public.companion_operations active_start
      WHERE active_start.org_id = queued_turn.org_id
        AND active_start.companion_id = queued_turn.companion_id
        AND active_start.source_turn_id = queued_turn.id
        AND active_start.kind = 'start'
        AND active_start.status IN ('pending', 'running')
    )
  ORDER BY queued_turn.queue_sequence, queued_turn.id
  LIMIT 1
  FOR UPDATE OF instance, queued_turn;
  IF NOT FOUND THEN RETURN false; END IF;

  UPDATE public.companion_turns
  SET cold_start_deadline_at = v_now + interval '3 minutes', updated_at = v_now
  WHERE org_id = v_org_id AND companion_id = v_companion_id AND id = v_turn_id;

  INSERT INTO public.companion_operations(
    org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
    queue_sequence, turn_queue_cutoff, runtime_generation, status, created_at, updated_at
  ) VALUES (
    v_org_id, v_companion_id, gen_random_uuid(), 'start', 'turn', v_actor_id, v_turn_id,
    0, 0,
    (SELECT generation FROM public.companion_runtime_instances
     WHERE org_id = v_org_id AND companion_id = v_companion_id),
    'pending', v_now, v_now
  )
  ON CONFLICT (companion_id, source_turn_id)
    WHERE kind = 'start' AND status IN ('pending', 'running') AND source_turn_id IS NOT NULL
  DO NOTHING;
  RETURN FOUND;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_settle(p_org_id uuid, p_companion_id uuid, p_claim_token uuid, p_claim_epoch bigint, p_gate_epoch bigint, p_executor_id text, p_work_kind companion_runtime_work_kind, p_work_id uuid, p_terminal_status text, p_error_code text, p_error_message text, p_error_action companion_runtime_error_action)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
DECLARE
  v_now timestamp with time zone := clock_timestamp();
  v_lease_expires_at timestamp with time zone;
  v_turn_id uuid;
  v_operation_kind public.companion_operation_kind;
  v_operation_actor_id text;
  v_operation_checkpoint text;
  v_target_settings_revision bigint;
  v_target_skills_revision integer;
  v_operation_box_id text;
  v_operation_box_state public.companion_box_observed_state;
  v_operation_pi_state public.companion_pi_observed_state;
  v_operation_pi_invocation_id text;
  v_operation_disk_layout_version integer;
  v_operation_applied_settings_revision bigint;
  v_operation_applied_skills_revision integer;
  v_operation_applied_client_surface public.companion_client_surface;
  v_client_surface public.companion_client_surface := 'web';
  v_cold_start_deadline timestamp with time zone;
  v_inactivity_deadline timestamp with time zone;
  v_absolute_deadline timestamp with time zone;
  v_live_desired_settings_revision bigint;
  v_live_skills_revision integer;
  v_settings_claim_revision bigint;
  v_settings_claim_skills_revision integer;
  v_settings_checkpoint text;
  v_dispatch_state public.companion_dispatch_state;
  v_attempt_checkpoint text;
  v_attempt_pi_invocation_id text;
  v_decision_delivery_state public.companion_decision_delivery_state;
  v_decision_attempt_id uuid;
  v_decision_command_id uuid;
  v_previous_runtime_protocol text;
  v_cancel_requested_at timestamp with time zone;
  v_success boolean := false;
BEGIN
  IF p_terminal_status NOT IN ('succeeded', 'failed', 'interrupted', 'cancelled')
     OR ((p_error_code IS NULL) <> (p_error_message IS NULL))
     OR ((p_error_code IS NULL) <> (p_error_action IS NULL))
     OR (p_error_code IS NOT NULL AND p_error_code !~ '^[a-z][a-z0-9_]{0,63}$')
     OR (p_error_message IS NOT NULL AND (
       char_length(p_error_message) > 500 OR p_error_message ~ E'[\n\r]'
     ))
     OR (p_terminal_status IN ('failed', 'interrupted') AND p_error_code IS NULL)
     OR (p_terminal_status IN ('succeeded', 'cancelled') AND p_error_code IS NOT NULL) THEN
    RAISE EXCEPTION 'invalid Runtime v2 settlement' USING ERRCODE = '22023';
  END IF;

  SELECT l.expires_at INTO v_lease_expires_at
  FROM public.companion_runtime_leases l
  JOIN public.companion_runtime_control c ON c.id = 'runtime-v2'
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id
    AND l.expires_at > clock_timestamp()
    AND c.enabled
    AND c.gate_epoch = p_gate_epoch
  FOR UPDATE OF l;
  IF NOT FOUND THEN RETURN false; END IF;

  PERFORM 1
  FROM public.companion_runtime_instances i
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
  FOR UPDATE;
  IF NOT FOUND THEN RETURN false; END IF;
  v_now := clock_timestamp();
  IF v_lease_expires_at <= v_now THEN RETURN false; END IF;

  IF p_work_kind = 'operation' THEN
    SELECT o.kind, o.actor_id, o.checkpoint, o.target_settings_revision, o.target_skills_revision,
           o.source_turn_id, o.client_surface,
           i.box_id, i.box_state, i.pi_state, i.pi_invocation_id,
           i.disk_layout_version, i.applied_settings_revision, i.applied_skills_revision,
           i.applied_client_surface
    INTO v_operation_kind, v_operation_actor_id, v_operation_checkpoint,
         v_target_settings_revision, v_target_skills_revision,
         v_turn_id, v_client_surface,
         v_operation_box_id, v_operation_box_state, v_operation_pi_state,
         v_operation_pi_invocation_id, v_operation_disk_layout_version,
         v_operation_applied_settings_revision, v_operation_applied_skills_revision,
         v_operation_applied_client_surface
    FROM public.companion_operations o
    JOIN public.companion_runtime_instances i
      ON i.org_id = o.org_id AND i.companion_id = o.companion_id
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch
    FOR UPDATE OF o;
    IF NOT FOUND THEN RETURN false; END IF;

    IF v_turn_id IS NOT NULL THEN
      SELECT t.cold_start_deadline_at
      INTO v_cold_start_deadline
      FROM public.companion_turns t
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id AND t.id = v_turn_id
      FOR UPDATE;
      IF NOT FOUND THEN RETURN false; END IF;
    END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND v_operation_kind IN ('start', 'apply_settings')
         AND v_cold_start_deadline IS NOT NULL
         AND v_now >= v_cold_start_deadline
       ) THEN
      RETURN false;
    END IF;

    IF p_terminal_status = 'succeeded' AND NOT (
      (v_operation_kind IN ('start', 'restart_pi', 'restart_box') AND v_operation_checkpoint = 'pi_ready')
      OR (v_operation_kind = 'stop' AND v_operation_checkpoint = 'box_archived')
      OR (v_operation_kind = 'apply_settings' AND v_operation_checkpoint = 'settings_applied')
      OR (v_operation_kind = 'delete' AND v_operation_checkpoint IN ('provider_deleted', 'box_absent'))
    ) THEN
      RAISE EXCEPTION 'operation lacks terminal checkpoint proof' USING ERRCODE = '22023';
    END IF;

    IF p_terminal_status = 'succeeded'
       AND v_operation_kind IN ('start', 'restart_pi', 'restart_box')
       AND (
         v_operation_box_id IS NULL
         OR v_operation_box_state NOT IN ('ready', 'idle', 'running')
         OR v_operation_pi_state <> 'idle'
         OR v_operation_pi_invocation_id IS NULL
         OR v_operation_disk_layout_version IS DISTINCT FROM 14
         OR (
           v_operation_kind IN ('start', 'restart_box')
           AND (
             v_target_settings_revision IS NULL
             OR v_target_skills_revision IS NULL
             OR v_operation_applied_settings_revision IS DISTINCT FROM v_target_settings_revision
             OR v_operation_applied_skills_revision IS DISTINCT FROM v_target_skills_revision
               OR v_operation_applied_client_surface IS NULL
           )
         )
       ) THEN
      RAISE EXCEPTION 'operation lacks terminal Box/Pi/layout observation proof'
        USING ERRCODE = '22023';
    END IF;

    IF p_terminal_status = 'succeeded'
       AND v_operation_kind = 'stop'
       AND v_operation_box_state <> 'archived' THEN
      RAISE EXCEPTION 'stop lacks archived Box observation proof' USING ERRCODE = '22023';
    END IF;

    IF p_terminal_status = 'succeeded'
       AND v_operation_kind = 'delete'
       AND v_operation_box_state <> 'absent' THEN
      RAISE EXCEPTION 'delete lacks absent Box observation proof' USING ERRCODE = '22023';
    END IF;

    IF v_operation_kind = 'apply_settings' AND p_terminal_status = 'succeeded' THEN
      IF v_target_settings_revision IS NULL OR v_target_skills_revision IS NULL OR NOT EXISTS (
        SELECT 1
        FROM public.companion_runtime_instances i
        JOIN public.companions c
          ON c.org_id = i.org_id AND c.id = i.companion_id
        WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
          AND v_target_settings_revision <= i.desired_settings_revision
          AND v_target_skills_revision <= c.skills_revision
          AND i.applied_settings_revision >= v_target_settings_revision
          AND i.applied_skills_revision >= v_target_skills_revision
            AND i.applied_client_surface IS NOT NULL
      ) THEN
        RAISE EXCEPTION 'settings operation target revisions are invalid' USING ERRCODE = '22023';
      END IF;
      UPDATE public.companion_runtime_instances i
      SET applied_settings_revision = GREATEST(i.applied_settings_revision, v_target_settings_revision),
          applied_skills_revision = GREATEST(i.applied_skills_revision, v_target_skills_revision),
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
    END IF;

    UPDATE public.companion_operations o
    SET status = p_terminal_status::public.companion_operation_status,
        checkpoint_sequence = o.checkpoint_sequence + 1,
        settled_at = v_now,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
      AND o.id = p_work_id AND o.status = 'running' AND o.claim_epoch = p_claim_epoch;
    v_success := FOUND;

    IF v_success
       AND v_operation_kind IN ('start', 'apply_settings')
       AND v_turn_id IS NOT NULL
       AND p_terminal_status <> 'succeeded' THEN
      UPDATE public.companion_turns t
      SET status = CASE
            WHEN p_error_code = 'cold_start_deadline_exceeded'
              THEN 'interrupted'::public.companion_turn_status
            ELSE p_terminal_status::public.companion_turn_status
          END,
          inactivity_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE t.inactivity_deadline_at
          END,
          absolute_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE COALESCE(t.absolute_deadline_at, v_now)
          END,
          state_changed_at = v_now,
          settled_at = v_now,
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
        AND t.id = v_turn_id
        AND t.status IN ('queued', 'starting', 'dispatching', 'running', 'needs_input');
    END IF;

    IF v_success AND v_operation_kind = 'delete' AND p_terminal_status = 'succeeded' THEN
      -- Provider proof is the irreversible cutover point. Preserve a minimal, sanitized audit row,
      -- then delete the aggregate root so legacy thread/transcript state and every Runtime v2 row
      -- disappear atomically. Provider connections, member MCP accounts, Skills, and their secrets
      -- are workspace resources and intentionally do not cascade from the Companion.
      INSERT INTO public.audit_log (
        org_id, actor_id, action, target_type, target_id, metadata
      ) VALUES (
        p_org_id,
        CASE WHEN EXISTS (
          SELECT 1 FROM public."user" u WHERE u.id = v_operation_actor_id
        ) THEN v_operation_actor_id ELSE NULL END,
        'companion.deleted',
        'companion',
        p_companion_id::text,
        jsonb_build_object(
          'operation_id', p_work_id::text,
          'provider_checkpoint', v_operation_checkpoint
        )
      );

      -- The legacy mutation fence is diagnostic rather than an authorization boundary. Pin it only
      -- around this SECURITY DEFINER-owned aggregate delete, avoiding CREATE FUNCTION SET clauses
      -- that require deployment-specific custom-parameter privileges from the migration owner.
      UPDATE public.companion_runtime_instances i
      SET settings_claim_turn_id = NULL,
          settings_claim_cold_start_deadline_at = NULL,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
      UPDATE public.companion_operations o
      SET source_turn_id = NULL, updated_at = v_now
      WHERE o.org_id = p_org_id AND o.companion_id = p_companion_id
        AND o.source_turn_id IS NOT NULL;

      v_previous_runtime_protocol := pg_catalog.current_setting(
        'app.companion_runtime_protocol', true
      );
      PERFORM pg_catalog.set_config('app.companion_runtime_protocol', '2', true);
      DELETE FROM public.companions c
      WHERE c.org_id = p_org_id AND c.id = p_companion_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'delete settlement lost Companion aggregate root' USING ERRCODE = '40001';
      END IF;
      PERFORM pg_catalog.set_config(
        'app.companion_runtime_protocol', COALESCE(v_previous_runtime_protocol, ''), true
      );
      RETURN true;
    END IF;

  ELSIF p_work_kind = 'attempt' THEN
    SELECT a.turn_id, a.dispatch_state, a.checkpoint, a.pi_invocation_id,
           t.cold_start_deadline_at, t.inactivity_deadline_at, t.absolute_deadline_at,
           t.cancel_requested_at
    INTO v_turn_id, v_dispatch_state, v_attempt_checkpoint, v_attempt_pi_invocation_id,
         v_cold_start_deadline, v_inactivity_deadline, v_absolute_deadline,
         v_cancel_requested_at
    FROM public.companion_turn_attempts a
    JOIN public.companion_turns t
      ON t.org_id = a.org_id AND t.companion_id = a.companion_id AND t.id = a.turn_id
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input')
    FOR UPDATE OF a, t;
    IF NOT FOUND THEN RETURN false; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND (
           (v_absolute_deadline IS NOT NULL AND v_now >= v_absolute_deadline)
           OR (v_inactivity_deadline IS NOT NULL AND v_now >= v_inactivity_deadline)
         )
       ) THEN
      RETURN false;
    END IF;
    IF v_dispatch_state = 'ambiguous' AND p_terminal_status <> 'interrupted'
       AND NOT (p_terminal_status = 'cancelled' AND v_cancel_requested_at IS NOT NULL) THEN
      RAISE EXCEPTION 'an ambiguous attempt may only settle interrupted' USING ERRCODE = '22023';
    END IF;
    IF v_dispatch_state = 'write_intent' AND p_terminal_status <> 'interrupted'
       AND NOT (p_terminal_status = 'cancelled' AND v_cancel_requested_at IS NOT NULL) THEN
      RAISE EXCEPTION 'a dispatch write intent without ACK may only settle interrupted'
        USING ERRCODE = '22023';
    END IF;
    IF v_dispatch_state = 'rejected' AND p_terminal_status NOT IN ('failed', 'interrupted') THEN
      RAISE EXCEPTION 'a rejected dispatch must settle failed or interrupted' USING ERRCODE = '22023';
    END IF;
    IF p_terminal_status = 'succeeded'
       AND (
         v_dispatch_state <> 'accepted'
         OR v_attempt_checkpoint <> 'agent_settled'
         OR v_attempt_pi_invocation_id IS NULL
       ) THEN
      RAISE EXCEPTION 'attempt lacks accepted dispatch, Pi invocation, and agent settlement proof'
        USING ERRCODE = '22023';
    END IF;

    UPDATE public.companion_turn_attempts a
    SET status = p_terminal_status::public.companion_attempt_status,
        checkpoint_sequence = a.checkpoint_sequence + 1,
        settled_at = v_now,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
      AND a.id = p_work_id AND a.claim_epoch = p_claim_epoch
      AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
    IF NOT FOUND THEN RETURN false; END IF;

    PERFORM public.companion_runtime_close_attempt_decisions(
      p_org_id, p_companion_id, p_work_id,
      p_error_code, p_error_message, p_error_action, NULL
    );

    UPDATE public.companion_turns t
    SET status = p_terminal_status::public.companion_turn_status,
        state_changed_at = v_now,
        settled_at = v_now,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
      AND t.id = v_turn_id AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');
    v_success := FOUND;

  ELSIF p_work_kind = 'decision' THEN
    SELECT d.turn_id, d.attempt_id, d.delivery_state, d.command_id,
           t.inactivity_deadline_at, t.absolute_deadline_at, t.cancel_requested_at
    INTO v_turn_id, v_decision_attempt_id, v_decision_delivery_state, v_decision_command_id,
         v_inactivity_deadline, v_absolute_deadline, v_cancel_requested_at
    FROM public.companion_decision_deliveries d
    JOIN public.companion_turns t
      ON t.org_id = d.org_id AND t.companion_id = d.companion_id AND t.id = d.turn_id
    WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
      AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
      AND d.decision_status <> 'pending'
      AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous')
    FOR UPDATE OF d, t;
    IF NOT FOUND THEN RETURN false; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND (
           (v_absolute_deadline IS NOT NULL AND v_now >= v_absolute_deadline)
           OR (v_inactivity_deadline IS NOT NULL AND v_now >= v_inactivity_deadline)
         )
       ) THEN
      RETURN false;
    END IF;

    IF p_terminal_status = 'succeeded' THEN
      IF v_decision_delivery_state <> 'write_intent' OR v_decision_command_id IS NULL THEN
        RAISE EXCEPTION 'decision success requires an unambiguous durable write intent'
          USING ERRCODE = '22023';
      END IF;
      UPDATE public.companion_decision_deliveries d
      SET delivery_state = 'delivered',
          delivery_checkpoint = 'delivered',
          delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
          delivered_at = v_now,
          last_error_code = NULL,
          last_error_message = NULL,
          last_error_action = NULL,
          updated_at = v_now
      WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
        AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
        AND d.decision_status <> 'pending'
        AND d.delivery_state = 'write_intent'
        AND d.command_id IS NOT NULL;
      v_success := FOUND;
    ELSE
      IF p_terminal_status = 'cancelled' THEN
        -- Owner/Editor stop is a real cancel, not a delivery protocol error. It must release the
        -- queue rather than leave the parent interrupted.
        IF v_cancel_requested_at IS NULL THEN
          RAISE EXCEPTION 'decision delivery cancellation must be explicit failure or interruption'
            USING ERRCODE = '22023';
        END IF;
        UPDATE public.companion_decision_deliveries d
        SET delivery_state = 'cancelled',
            delivery_checkpoint = 'cancelled',
            delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
            last_error_code = NULL,
            last_error_message = NULL,
            last_error_action = NULL,
            updated_at = v_now
        WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
          AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
          AND d.decision_status <> 'pending'
          AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous');
        v_success := FOUND;
        IF NOT v_success THEN RETURN false; END IF;
        PERFORM public.companion_runtime_close_attempt_decisions(
          p_org_id, p_companion_id, v_decision_attempt_id,
          NULL, NULL, NULL, p_work_id
        );
        UPDATE public.companion_turn_attempts a
        SET status = 'cancelled', settled_at = v_now,
            last_error_code = NULL,
            last_error_message = NULL,
            last_error_action = NULL,
            updated_at = v_now
        WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
          AND a.id = v_decision_attempt_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
        UPDATE public.companion_turns t
        SET status = 'cancelled', settled_at = v_now, state_changed_at = v_now,
            last_error_code = NULL,
            last_error_message = NULL,
            last_error_action = NULL,
            updated_at = v_now
        WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
          AND t.id = v_turn_id
          AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');
      ELSE
      UPDATE public.companion_decision_deliveries d
      SET delivery_state = CASE
            WHEN d.command_id IS NULL AND p_terminal_status = 'interrupted'
              THEN 'cancelled'::public.companion_decision_delivery_state
            WHEN d.command_id IS NULL THEN 'pending'::public.companion_decision_delivery_state
            ELSE 'ambiguous'::public.companion_decision_delivery_state
          END,
          delivery_checkpoint = CASE
            WHEN d.command_id IS NULL AND p_terminal_status = 'interrupted' THEN 'cancelled'
            WHEN d.command_id IS NULL THEN 'pending'
            ELSE 'ambiguous'
          END,
          delivery_checkpoint_sequence = d.delivery_checkpoint_sequence + 1,
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE d.org_id = p_org_id AND d.companion_id = p_companion_id
        AND d.id = p_work_id AND d.claim_epoch = p_claim_epoch
        AND d.decision_status <> 'pending'
        AND d.delivery_state IN ('pending', 'write_intent', 'ambiguous');
      v_success := FOUND;

      -- Do not mutate the parent after a failed delivery CAS. FOUND would otherwise be replaced by
      -- the later UPDATEs and settlement could report success after changing only the parent.
      IF NOT v_success THEN RETURN false; END IF;

      -- A pre-write failure remains retryable, but an explicit interruption is terminal even when
      -- authorization vanished before the write. Once a command id exists, the response may have
      -- reached Pi. Both paths close the parent visibly instead of reclaiming this decision forever.
      IF v_decision_command_id IS NOT NULL OR p_terminal_status = 'interrupted' THEN
        PERFORM public.companion_runtime_close_attempt_decisions(
          p_org_id, p_companion_id, v_decision_attempt_id,
          p_error_code, p_error_message, p_error_action, p_work_id
        );
        UPDATE public.companion_turn_attempts a
        SET status = 'interrupted', settled_at = v_now,
            last_error_code = p_error_code,
            last_error_message = p_error_message,
            last_error_action = p_error_action,
            updated_at = v_now
        WHERE a.org_id = p_org_id AND a.companion_id = p_companion_id
          AND a.id = v_decision_attempt_id
          AND a.status IN ('starting', 'dispatching', 'running', 'needs_input');
        UPDATE public.companion_turns t
        SET status = 'interrupted', settled_at = v_now, state_changed_at = v_now,
            last_error_code = p_error_code,
            last_error_message = p_error_message,
            last_error_action = p_error_action,
            updated_at = v_now
        WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
          AND t.id = v_turn_id
          AND t.status IN ('starting', 'dispatching', 'running', 'needs_input');
      END IF;
      END IF;
    END IF;
  ELSIF p_work_kind = 'settings' THEN
    SELECT i.settings_claim_revision, i.settings_claim_skills_revision,
           i.settings_claim_client_surface, i.settings_checkpoint,
           i.settings_claim_turn_id, i.settings_claim_cold_start_deadline_at,
           i.desired_settings_revision, c.skills_revision
    INTO v_settings_claim_revision, v_settings_claim_skills_revision,
         v_client_surface, v_settings_checkpoint,
         v_turn_id, v_cold_start_deadline,
         v_live_desired_settings_revision, v_live_skills_revision
    FROM public.companion_runtime_instances i
    JOIN public.companions c
      ON c.org_id = i.org_id AND c.id = i.companion_id
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id AND i.settings_claim_epoch = p_claim_epoch
    FOR UPDATE OF i, c;
    IF NOT FOUND THEN RETURN false; END IF;
    v_now := clock_timestamp();
    IF v_lease_expires_at <= v_now
       OR (
         p_terminal_status = 'succeeded'
         AND v_cold_start_deadline IS NOT NULL
         AND v_now >= v_cold_start_deadline
       ) THEN
      RETURN false;
    END IF;

    IF p_terminal_status = 'succeeded' THEN
      IF v_settings_checkpoint <> 'applied'
         OR v_settings_claim_revision IS DISTINCT FROM v_live_desired_settings_revision
         OR v_settings_claim_skills_revision IS DISTINCT FROM v_live_skills_revision THEN
        RETURN false;
      END IF;
      UPDATE public.companion_runtime_instances i
      SET applied_settings_revision = GREATEST(i.applied_settings_revision, v_settings_claim_revision),
          applied_skills_revision = GREATEST(i.applied_skills_revision, v_settings_claim_skills_revision),
          applied_client_surface = v_client_surface,
          settings_checkpoint = 'applied',
          settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
          settings_claim_epoch = NULL,
          settings_claim_actor_id = NULL,
          settings_claim_client_surface = NULL,
          settings_claim_turn_id = NULL,
          settings_claim_cold_start_deadline_at = NULL,
          settings_claim_revision = NULL,
          settings_claim_skills_revision = NULL,
          settings_claim_model_id = NULL,
          settings_claim_persona = NULL,
          settings_claim_can_write_skills = NULL,
          settings_claim_provider_ids = NULL,
          settings_claim_selected_skill_ids = NULL,
          settings_claim_skill_refs = NULL,
          settings_claim_selected_mcp_account_ids = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          last_error_action = NULL,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
    ELSE
      UPDATE public.companion_runtime_instances i
      SET settings_checkpoint = 'pending',
          settings_checkpoint_sequence = i.settings_checkpoint_sequence + 1,
          settings_claim_epoch = NULL,
          settings_claim_actor_id = NULL,
          settings_claim_client_surface = NULL,
          settings_claim_turn_id = NULL,
          settings_claim_cold_start_deadline_at = NULL,
          settings_claim_revision = NULL,
          settings_claim_skills_revision = NULL,
          settings_claim_model_id = NULL,
          settings_claim_persona = NULL,
          settings_claim_can_write_skills = NULL,
          settings_claim_provider_ids = NULL,
          settings_claim_selected_skill_ids = NULL,
          settings_claim_skill_refs = NULL,
          settings_claim_selected_mcp_account_ids = NULL,
          settings_available_at = v_now + interval '30 seconds',
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;
    END IF;
    v_success := FOUND;

    IF v_success AND v_turn_id IS NOT NULL AND p_terminal_status <> 'succeeded' THEN
      UPDATE public.companion_turns t
      SET status = CASE
            WHEN p_error_code = 'cold_start_deadline_exceeded'
              THEN 'interrupted'::public.companion_turn_status
            ELSE p_terminal_status::public.companion_turn_status
          END,
          inactivity_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE t.inactivity_deadline_at
          END,
          absolute_deadline_at = CASE
            WHEN p_terminal_status = 'cancelled' THEN NULL
            ELSE COALESCE(t.absolute_deadline_at, v_now)
          END,
          state_changed_at = v_now,
          settled_at = v_now,
          last_error_code = p_error_code,
          last_error_message = p_error_message,
          last_error_action = p_error_action,
          updated_at = v_now
      WHERE t.org_id = p_org_id AND t.companion_id = p_companion_id
        AND t.id = v_turn_id AND t.status = 'queued';
    END IF;

  ELSIF p_work_kind = 'health' THEN
    UPDATE public.companion_runtime_instances i
    SET health_checkpoint = CASE WHEN p_terminal_status = 'succeeded' THEN 'observed' ELSE 'pending' END,
        health_checkpoint_sequence = i.health_checkpoint_sequence + 1,
        health_claim_epoch = NULL,
        health_due_at = v_now + CASE
          WHEN p_terminal_status = 'succeeded' THEN interval '30 seconds'
          ELSE interval '15 seconds'
        END,
        last_error_code = p_error_code,
        last_error_message = p_error_message,
        last_error_action = p_error_action,
        updated_at = v_now
    WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id
      AND p_work_id = i.companion_id
      AND i.health_claim_epoch = p_claim_epoch
      AND (p_terminal_status <> 'succeeded' OR i.health_checkpoint = 'observed');
    v_success := FOUND;
  END IF;

  IF NOT v_success THEN RETURN false; END IF;

  UPDATE public.companion_runtime_instances i
  SET last_write_epoch = GREATEST(i.last_write_epoch, p_claim_epoch), updated_at = v_now
  WHERE i.org_id = p_org_id AND i.companion_id = p_companion_id;

  UPDATE public.companion_runtime_leases l
  SET claim_token = NULL,
      gate_epoch = NULL,
      executor_id = NULL,
      work_kind = NULL,
      work_id = NULL,
      claimed_at = NULL,
      renewed_at = NULL,
      expires_at = NULL,
      updated_at = v_now
  WHERE l.org_id = p_org_id
    AND l.companion_id = p_companion_id
    AND l.claim_token = p_claim_token
    AND l.claim_epoch = p_claim_epoch
    AND l.gate_epoch = p_gate_epoch
    AND l.executor_id = p_executor_id
    AND l.work_kind = p_work_kind
    AND l.work_id = p_work_id;
  RETURN FOUND;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_api_enqueue_operation(p_org_id uuid, p_companion_id uuid, p_request_id uuid, p_kind companion_operation_kind, p_client_surface companion_client_surface)
 RETURNS TABLE(operation jsonb, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_required text;
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_operation_id uuid;
  v_existing_kind public.companion_operation_kind;
  v_existing_surface public.companion_client_surface;
  v_requested_surface public.companion_client_surface;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  IF p_request_id IS NULL OR p_kind IS NULL
     OR p_kind NOT IN ('delete', 'stop', 'restart_pi', 'restart_box', 'start')
     OR p_kind IN ('start', 'restart_pi', 'restart_box') AND p_client_surface IS NULL THEN
    RAISE EXCEPTION 'invalid Companion operation request' USING ERRCODE = '22023';
  END IF;
  v_requested_surface := CASE
    WHEN p_kind IN ('start', 'restart_pi', 'restart_box') THEN p_client_surface
    ELSE NULL
  END;
  v_required := CASE WHEN p_kind = 'delete' THEN 'owner' ELSE 'editor' END;
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, v_required);
  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;

  SELECT existing.id, existing.kind, existing.client_surface
  INTO v_operation_id, v_existing_kind, v_existing_surface
  FROM public.companion_operations existing
  WHERE existing.org_id = p_org_id AND existing.companion_id = p_companion_id
    AND existing.request_id = p_request_id;
  IF FOUND THEN
    IF v_existing_kind <> p_kind
       OR v_existing_surface IS DISTINCT FROM v_requested_surface THEN
      RAISE EXCEPTION 'operation request id was reused for another intent' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT
      public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), true;
    RETURN;
  END IF;
  IF v_instance.retirement_state <> 'active' THEN
    RAISE EXCEPTION 'retired Companion cannot accept lifecycle operations' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.companion_operations(
    org_id, companion_id, request_id, kind, trigger, actor_id,
    queue_sequence, turn_queue_cutoff, runtime_generation, client_surface,
    status, created_at, updated_at
  ) VALUES (
    p_org_id, p_companion_id, p_request_id, p_kind, 'user', v_actor_id,
    0, 0, v_instance.generation, v_requested_surface, 'pending', v_now, v_now
  ) RETURNING companion_operations.id INTO v_operation_id;

  IF p_kind = 'delete' THEN
    UPDATE public.companion_runtime_instances instance
    SET retirement_state = 'requested', retirement_requested_at = v_now, updated_at = v_now
    WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id;
    INSERT INTO public.audit_log(
      org_id, actor_id, action, target_type, target_id, metadata
    ) VALUES (
      p_org_id,
      v_actor_id,
      'companion.delete.requested',
      'companion',
      p_companion_id::text,
      jsonb_build_object('operation_id', v_operation_id)
    );
  END IF;
  RETURN QUERY SELECT
    public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), false;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_api_retry_turn(p_org_id uuid, p_companion_id uuid, p_turn_id uuid, p_retry_id uuid, p_client_surface companion_client_surface)
 RETURNS TABLE(operation jsonb, replayed boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_actor_id text := public.companion_api_actor(p_org_id);
  v_instance public.companion_runtime_instances%ROWTYPE;
  v_turn public.companion_turns%ROWTYPE;
  v_operation_id uuid;
  v_operation_turn_id uuid;
  v_operation_kind public.companion_operation_kind;
  v_now timestamp with time zone := clock_timestamp();
BEGIN
  PERFORM public.companion_api_require_access(p_org_id, p_companion_id, 'editor');
  IF p_turn_id IS NULL OR p_retry_id IS NULL OR p_client_surface IS NULL THEN
    RAISE EXCEPTION 'invalid Companion retry request' USING ERRCODE = '22023';
  END IF;
  SELECT instance.* INTO STRICT v_instance
  FROM public.companion_runtime_instances instance
  WHERE instance.org_id = p_org_id AND instance.companion_id = p_companion_id
  FOR UPDATE;

  SELECT existing.id, existing.source_turn_id, existing.kind
  INTO v_operation_id, v_operation_turn_id, v_operation_kind
  FROM public.companion_operations existing
  WHERE existing.org_id = p_org_id AND existing.companion_id = p_companion_id
    AND existing.request_id = p_retry_id;
  IF FOUND THEN
    IF v_operation_turn_id IS DISTINCT FROM p_turn_id OR v_operation_kind <> 'restart_pi' THEN
      RAISE EXCEPTION 'retry id was reused for another turn' USING ERRCODE = '22023';
    END IF;
    RETURN QUERY SELECT
      public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), true;
    RETURN;
  END IF;
  IF v_instance.retirement_state <> 'active' THEN
    RAISE EXCEPTION 'retired Companion turn cannot be retried' USING ERRCODE = '55000';
  END IF;
  SELECT source_turn.* INTO STRICT v_turn
  FROM public.companion_turns source_turn
  WHERE source_turn.org_id = p_org_id AND source_turn.companion_id = p_companion_id
    AND source_turn.id = p_turn_id
  FOR UPDATE;
  IF v_turn.status <> 'interrupted' THEN
    RAISE EXCEPTION 'only an interrupted Companion turn can be retried' USING ERRCODE = '55000';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.companion_operations retry_operation
    WHERE retry_operation.org_id = p_org_id
      AND retry_operation.companion_id = p_companion_id
      AND retry_operation.source_turn_id = p_turn_id
      AND retry_operation.kind = 'restart_pi'
      AND retry_operation.status IN ('pending', 'running')
  ) THEN
    RAISE EXCEPTION 'a retry is already pending for this Companion turn' USING ERRCODE = '55000';
  END IF;

  INSERT INTO public.companion_operations(
    org_id, companion_id, request_id, kind, trigger, actor_id, source_turn_id,
    queue_sequence, turn_queue_cutoff, runtime_generation, client_surface,
    status, created_at, updated_at
  ) VALUES (
    p_org_id, p_companion_id, p_retry_id, 'restart_pi', 'user', v_actor_id,
    p_turn_id, 0, 0, v_instance.generation, p_client_surface, 'pending', v_now, v_now
  ) RETURNING companion_operations.id INTO v_operation_id;

  RETURN QUERY SELECT
    public.companion_api_operation_json(p_org_id, p_companion_id, v_operation_id), false;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_claim_work(p_executor_id text, p_limit integer, p_lease_seconds integer, p_gate_epoch bigint)
 RETURNS TABLE(org_id uuid, companion_id uuid, claim_token uuid, claim_epoch bigint, gate_epoch bigint, work_kind companion_runtime_work_kind, work_id uuid, actor_id text, client_surface companion_client_surface, runtime_generation bigint, checkpoint text, checkpoint_sequence bigint, turn_id uuid, turn_status companion_turn_status, attempt_status companion_attempt_status, dispatch_state companion_dispatch_state, event_cursor bigint, unknown_event_count integer, malformed_event_count integer, oversized_event_count integer, cold_start_deadline_at timestamp with time zone, inactivity_deadline_at timestamp with time zone, absolute_deadline_at timestamp with time zone, operation_kind companion_operation_kind, operation_started_at timestamp with time zone, operation_attempt_count integer, provider_operation_id text, target_settings_revision bigint, target_skills_revision integer, decision_status companion_decision_status, decision_delivery_state companion_decision_delivery_state)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
BEGIN
  RETURN;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_claim_work_without_delete_resume_guard(p_executor_id text, p_limit integer, p_lease_seconds integer, p_gate_epoch bigint, p_material_protocol integer)
 RETURNS TABLE(org_id uuid, companion_id uuid, claim_token uuid, claim_epoch bigint, gate_epoch bigint, work_kind companion_runtime_work_kind, work_id uuid, actor_id text, client_surface companion_client_surface, runtime_generation bigint, checkpoint text, checkpoint_sequence bigint, turn_id uuid, turn_status companion_turn_status, attempt_status companion_attempt_status, dispatch_state companion_dispatch_state, event_cursor bigint, unknown_event_count integer, malformed_event_count integer, oversized_event_count integer, cold_start_deadline_at timestamp with time zone, inactivity_deadline_at timestamp with time zone, absolute_deadline_at timestamp with time zone, operation_kind companion_operation_kind, operation_started_at timestamp with time zone, operation_attempt_count integer, provider_operation_id text, target_settings_revision bigint, target_skills_revision integer, decision_status companion_decision_status, decision_delivery_state companion_decision_delivery_state)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
DECLARE
  v_returned integer;
BEGIN
  IF p_gate_epoch IS NULL OR p_gate_epoch < 1
     OR p_executor_id IS NULL OR char_length(p_executor_id) NOT BETWEEN 1 AND 200
     OR p_executor_id ~ E'[\n\r]'
     OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
     OR p_lease_seconds IS NULL OR p_lease_seconds NOT BETWEEN 5 AND 300
     OR p_material_protocol IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'invalid Runtime v2 claim arguments' USING ERRCODE = '22023';
  END IF;

  FOR claim_index IN 1..p_limit LOOP
    PERFORM public.companion_runtime_repair_legacy_material_work(p_gate_epoch);
    PERFORM public.companion_runtime_prepare_queued_turn_material(p_gate_epoch);
    RETURN QUERY
      SELECT guarded.*
      FROM public.companion_runtime_claim_work_without_material_guard(
        p_executor_id, 1, p_lease_seconds, p_gate_epoch
      ) guarded;
    GET DIAGNOSTICS v_returned = ROW_COUNT;
    EXIT WHEN v_returned = 0;
  END LOOP;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_claim_work(p_executor_id text, p_limit integer, p_lease_seconds integer, p_gate_epoch bigint, p_material_protocol integer)
 RETURNS TABLE(org_id uuid, companion_id uuid, claim_token uuid, claim_epoch bigint, gate_epoch bigint, work_kind companion_runtime_work_kind, work_id uuid, actor_id text, client_surface companion_client_surface, runtime_generation bigint, checkpoint text, checkpoint_sequence bigint, turn_id uuid, turn_status companion_turn_status, attempt_status companion_attempt_status, dispatch_state companion_dispatch_state, event_cursor bigint, unknown_event_count integer, malformed_event_count integer, oversized_event_count integer, cold_start_deadline_at timestamp with time zone, inactivity_deadline_at timestamp with time zone, absolute_deadline_at timestamp with time zone, operation_kind companion_operation_kind, operation_started_at timestamp with time zone, operation_attempt_count integer, provider_operation_id text, target_settings_revision bigint, target_skills_revision integer, decision_status companion_decision_status, decision_delivery_state companion_decision_delivery_state)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
BEGIN
  RETURN;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_claim_work_material_v1(p_executor_id text, p_limit integer, p_lease_seconds integer, p_gate_epoch bigint, p_material_protocol integer, p_delete_resume_protocol integer)
 RETURNS TABLE(org_id uuid, companion_id uuid, claim_token uuid, claim_epoch bigint, gate_epoch bigint, work_kind companion_runtime_work_kind, work_id uuid, actor_id text, client_surface companion_client_surface, runtime_generation bigint, checkpoint text, checkpoint_sequence bigint, turn_id uuid, turn_status companion_turn_status, attempt_status companion_attempt_status, dispatch_state companion_dispatch_state, event_cursor bigint, unknown_event_count integer, malformed_event_count integer, oversized_event_count integer, cold_start_deadline_at timestamp with time zone, inactivity_deadline_at timestamp with time zone, absolute_deadline_at timestamp with time zone, operation_kind companion_operation_kind, operation_started_at timestamp with time zone, operation_attempt_count integer, provider_operation_id text, target_settings_revision bigint, target_skills_revision integer, decision_status companion_decision_status, decision_delivery_state companion_decision_delivery_state)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
BEGIN
  IF p_delete_resume_protocol IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'invalid Runtime v2 delete-resume protocol' USING ERRCODE = '22023';
  END IF;
  RETURN QUERY
    SELECT guarded.*
    FROM public.companion_runtime_claim_work_without_delete_resume_guard(
      p_executor_id, p_limit, p_lease_seconds, p_gate_epoch, p_material_protocol
    ) guarded;
END
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.companion_runtime_claim_work(p_executor_id text, p_limit integer, p_lease_seconds integer, p_gate_epoch bigint, p_material_protocol integer, p_delete_resume_protocol integer)
 RETURNS TABLE(org_id uuid, companion_id uuid, claim_token uuid, claim_epoch bigint, gate_epoch bigint, work_kind companion_runtime_work_kind, work_id uuid, actor_id text, client_surface companion_client_surface, runtime_generation bigint, checkpoint text, checkpoint_sequence bigint, turn_id uuid, turn_status companion_turn_status, attempt_status companion_attempt_status, dispatch_state companion_dispatch_state, event_cursor bigint, unknown_event_count integer, malformed_event_count integer, oversized_event_count integer, cold_start_deadline_at timestamp with time zone, inactivity_deadline_at timestamp with time zone, absolute_deadline_at timestamp with time zone, operation_kind companion_operation_kind, operation_started_at timestamp with time zone, operation_attempt_count integer, provider_operation_id text, target_settings_revision bigint, target_skills_revision integer, decision_status companion_decision_status, decision_delivery_state companion_decision_delivery_state)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
 SET row_security TO 'on'
AS $function$
BEGIN
  IF p_material_protocol IS DISTINCT FROM 2 THEN RETURN; END IF;
  RETURN QUERY SELECT * FROM public.companion_runtime_claim_work_material_v1(
    p_executor_id, p_limit, p_lease_seconds, p_gate_epoch, 1, p_delete_resume_protocol
  );
END
$function$;
--> statement-breakpoint
DO $retire_native_mobile_restore_policies$
DECLARE
  captured record;
BEGIN
  FOR captured IN SELECT * FROM "retired_surface_policies" LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %s AS %s FOR %s TO %s%s%s',
      captured.name,
      captured.table_name,
      CASE WHEN captured.permissive THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
      captured.command,
      captured.roles,
      CASE WHEN captured.using_expr IS NULL THEN '' ELSE format(' USING (%s)', captured.using_expr) END,
      CASE WHEN captured.check_expr IS NULL THEN '' ELSE format(' WITH CHECK (%s)', captured.check_expr) END
    );
  END LOOP;
END
$retire_native_mobile_restore_policies$;
--> statement-breakpoint
CREATE TRIGGER "companion_turns_surface_immutable" BEFORE UPDATE OF "client_surface" ON "companion_turns"
FOR EACH ROW EXECUTE FUNCTION companion_runtime_reject_turn_surface_change();
--> statement-breakpoint
CREATE TRIGGER "companion_operations_snapshot_immutable" BEFORE UPDATE OF "runtime_generation", "target_settings_revision", "target_skills_revision", "client_surface", "model_id", "persona", "can_write_skills", "provider_ids", "selected_skill_ids", "skill_refs", "skill_update_selected_skill_ids", "skill_update_refs", "selected_mcp_account_ids" ON "companion_operations"
FOR EACH ROW EXECUTE FUNCTION companion_runtime_reject_operation_snapshot_change();
--> statement-breakpoint

-- One material contract for every surface: a staged snapshot always names its expiry.
ALTER TABLE "companion_runtime_instances" ADD CONSTRAINT "companion_runtime_instances_material_snapshot_check" CHECK (
  (("material_client_surface" IS NULL) = ("material_pi_invocation_id" IS NULL))
  AND (("material_client_surface" IS NULL) = ("material_expires_at" IS NULL))
  AND ("material_pi_invocation_id" IS NULL OR
    (char_length("material_pi_invocation_id") BETWEEN 1 AND 200
      AND "material_pi_invocation_id" !~ E'[\n\r]'))
  AND (("settings_claim_material_client_surface" IS NULL) = ("settings_claim_material_staged_at" IS NULL))
  AND (("settings_claim_material_staged_at" IS NULL) = ("settings_claim_material_expires_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "companion_operations" ADD CONSTRAINT "companion_operations_material_snapshot_check" CHECK (
  ("material_staged_at" IS NULL) = ("material_expires_at" IS NULL)
);
