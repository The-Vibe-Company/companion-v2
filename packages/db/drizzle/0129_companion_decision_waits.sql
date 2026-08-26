-- A send accepted while Pi is busy used to observe pi_state != idle and eagerly insert a Start.
-- That Start's three-minute deadline began at send time even though FIFO correctly kept it behind
-- the active turn. Once it reached the head it could therefore fail as a "cold start" without any
-- Box work, including when the same Box was still warm. Defer this derived lifecycle intent until
-- runtime can re-evaluate the queued head through companion_runtime_prepare_queued_turn_material.
CREATE FUNCTION public.companion_runtime_defer_busy_turn_start()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.kind = 'start'
     AND NEW.trigger = 'turn'
     AND NEW.source_turn_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.companion_turns active_turn
       WHERE active_turn.org_id = NEW.org_id
         AND active_turn.companion_id = NEW.companion_id
         AND active_turn.id <> NEW.source_turn_id
         AND active_turn.status IN (
           'starting', 'dispatching', 'running', 'needs_input', 'interrupted'
         )
     ) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_defer_busy_turn_start() FROM PUBLIC;
--> statement-breakpoint
-- PostgreSQL fires same-kind triggers by name. The 00 prefix makes this guard run before
-- companion_operations_assign_queue_sequence, so a deferred row consumes neither an operation
-- sequence nor the source turn's cold-start deadline.
CREATE TRIGGER "companion_operations_00_defer_busy_turn_start"
  BEFORE INSERT ON public.companion_operations
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_defer_busy_turn_start();
--> statement-breakpoint

-- A blocking ask/propose event changes the durable state to needs_input. The previous projection
-- kept re-arming inactivity_deadline_at anyway, so the ten-minute stall could beat a still-pending
-- human decision. Enforce the pause at the table boundary for current and rolling-deploy runtimes;
-- decision delivery already re-arms the inactivity clock when Pi resumes.
CREATE FUNCTION public.companion_runtime_pause_needs_input_inactivity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status = 'needs_input' THEN
    NEW.inactivity_deadline_at := NULL;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_pause_needs_input_inactivity() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "companion_turns_00_pause_needs_input_inactivity"
  BEFORE INSERT OR UPDATE OF status, inactivity_deadline_at ON public.companion_turns
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_pause_needs_input_inactivity();
--> statement-breakpoint

-- Automated expiry already re-enters Pi without a responder. A newer member message uses the same
-- fail-closed delivery path with the more precise `cancelled` state, so admit both terminal states
-- while continuing to reject every actorless allow/deny/answer. Preserve the large, established
-- authorization function and its split-role ACL through the repository's exact-rewrite convention.
DO $companion_actorless_decision_close$
DECLARE
  v_signature text :=
    'public.companion_runtime_renew_and_authorize(uuid,uuid,uuid,bigint,bigint,text,'
    || 'public.companion_runtime_work_kind,uuid,integer)';
  v_old_gate text :=
    'v_decision_actor_id IS NULL AND v_decision_status <> ''expired''';
  v_new_gate text :=
    'v_decision_actor_id IS NULL AND v_decision_status NOT IN (''expired'', ''cancelled'')';
  v_definition text;
BEGIN
  v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
  IF v_definition IS NULL THEN
    RAISE EXCEPTION 'Companion runtime authorization surface is missing' USING ERRCODE = '55000';
  END IF;
  IF (
    char_length(v_definition)
    - char_length(replace(v_definition, v_old_gate, ''))
  ) <> char_length(v_old_gate) THEN
    RAISE EXCEPTION 'actorless decision authorization gate did not match exactly once'
      USING ERRCODE = '55000';
  END IF;
  EXECUTE replace(v_definition, v_old_gate, v_new_gate);
END
$companion_actorless_decision_close$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_renew_and_authorize(
  uuid, uuid, uuid, bigint, bigint, text,
  public.companion_runtime_work_kind, uuid, integer
) FROM PUBLIC;
--> statement-breakpoint

-- A member who sends another message has moved the conversation on. Return the pending UI request
-- to Pi as cancelled so it can choose a safe fallback or finish the old turn; the new message stays
-- an ordinary queued turn and is never reinterpreted as an approval. Routine and webhook turns do
-- not speak for the member and therefore cannot supersede a decision.
CREATE FUNCTION public.companion_runtime_supersede_decision_on_member_turn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := statement_timestamp();
BEGIN
  IF NEW.status = 'queued'
     AND NEW.routine_id IS NULL AND NEW.routine_name IS NULL
     AND NEW.trigger_id IS NULL AND NEW.trigger_name IS NULL THEN
    -- Serialize with the deferred delivery-side reconciliation below. If event projection has
    -- already reached its commit boundary, this insert waits and then observes the delivery. If
    -- this insert wins, projection observes this queued turn before its own commit instead.
    PERFORM 1
    FROM public.companions companion
    WHERE companion.org_id = NEW.org_id AND companion.id = NEW.companion_id
    FOR UPDATE;

    UPDATE public.companion_decision_deliveries delivery
    SET decision_status = 'cancelled', responded_at = v_now, updated_at = v_now
    FROM public.companion_turns decision_turn
    WHERE delivery.org_id = NEW.org_id
      AND delivery.companion_id = NEW.companion_id
      AND delivery.decision_status = 'pending'
      AND decision_turn.org_id = delivery.org_id
      AND decision_turn.companion_id = delivery.companion_id
      AND decision_turn.id = delivery.turn_id
      AND decision_turn.queue_sequence < NEW.queue_sequence;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_supersede_decision_on_member_turn() FROM PUBLIC;
--> statement-breakpoint
-- Run after companion_turns_assign_queue_sequence so NEW carries its durable FIFO position.
CREATE TRIGGER "companion_turns_zz_supersede_decision_on_member_turn"
  BEFORE INSERT ON public.companion_turns
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_supersede_decision_on_member_turn();
--> statement-breakpoint

-- Event projection inserts a delivery before it changes the parent attempt/turn to needs_input.
-- More importantly, a concurrent member insert cannot see that uncommitted delivery. Reconcile at
-- the projection transaction's deferred boundary, after its transcript entry exists. The shared
-- Companion row lock above makes the two commit orders exhaustive: either the member-side trigger
-- observes the committed delivery, or this trigger observes the committed later member turn.
CREATE FUNCTION public.companion_runtime_reconcile_projected_decision_with_member_turn()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_now timestamp with time zone := statement_timestamp();
BEGIN
  PERFORM 1
  FROM public.companions companion
  WHERE companion.org_id = NEW.org_id AND companion.id = NEW.companion_id
  FOR UPDATE;

  UPDATE public.companion_decision_deliveries delivery
  SET decision_status = 'cancelled', responded_at = v_now, updated_at = v_now
  FROM public.companion_turns decision_turn
  WHERE delivery.org_id = NEW.org_id
    AND delivery.companion_id = NEW.companion_id
    AND delivery.id = NEW.id
    AND delivery.decision_status = 'pending'
    AND decision_turn.org_id = delivery.org_id
    AND decision_turn.companion_id = delivery.companion_id
    AND decision_turn.id = delivery.turn_id
    AND EXISTS (
      SELECT 1
      FROM public.companion_turns later_turn
      WHERE later_turn.org_id = delivery.org_id
        AND later_turn.companion_id = delivery.companion_id
        AND later_turn.queue_sequence > decision_turn.queue_sequence
        AND later_turn.status <> 'cancelled'
        AND later_turn.routine_id IS NULL AND later_turn.routine_name IS NULL
        AND later_turn.trigger_id IS NULL AND later_turn.trigger_name IS NULL
    );
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_reconcile_projected_decision_with_member_turn()
  FROM PUBLIC;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "companion_decision_deliveries_reconcile_member_turn"
  AFTER INSERT ON public.companion_decision_deliveries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.companion_runtime_reconcile_projected_decision_with_member_turn();
--> statement-breakpoint

-- Automatic expiry, stop cancellation, and the newer-message path have no member actor, so keep
-- the PostgreSQL-only transcript projection aligned without impersonating an approver.
CREATE FUNCTION public.companion_runtime_project_automatic_decision_close()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_event_id text;
BEGIN
  IF OLD.decision_status = 'pending'
     AND NEW.decision_status IN ('expired', 'cancelled')
     AND NEW.actor_id IS NULL THEN
    SELECT entry.event_id
    INTO v_event_id
    FROM public.companion_transcript_entries entry
    WHERE entry.org_id = NEW.org_id
      AND entry.companion_id = NEW.companion_id
      AND entry.role = 'decision'
      AND entry.decision ->> 'request_id' = NEW.request_key
      AND entry.decision ->> 'status' = 'pending'
    ORDER BY entry.ordinal DESC
    LIMIT 1
    FOR UPDATE;

    IF v_event_id IS NOT NULL THEN
      UPDATE public.companion_transcript_entries entry
      SET decision = entry.decision || jsonb_build_object(
        'status', NEW.decision_status,
        'answer', NULL,
        'decided_by_id', NULL,
        'decided_by_name', NULL,
        'decided_at', to_char(
          NEW.responded_at AT TIME ZONE 'UTC',
          'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
        )
      )
      WHERE entry.org_id = NEW.org_id
        AND entry.companion_id = NEW.companion_id
        AND entry.event_id = v_event_id;
    END IF;
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION public.companion_runtime_project_automatic_decision_close() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER "companion_decision_deliveries_project_automatic_close"
  AFTER UPDATE OF decision_status ON public.companion_decision_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.companion_runtime_project_automatic_decision_close();
--> statement-breakpoint

UPDATE public.companion_turns
SET inactivity_deadline_at = NULL,
    updated_at = statement_timestamp()
WHERE status = 'needs_input' AND inactivity_deadline_at IS NOT NULL;
--> statement-breakpoint
ALTER TABLE public.companion_turns
  DROP CONSTRAINT companion_turns_deadline_check;
--> statement-breakpoint
ALTER TABLE public.companion_turns
  ADD CONSTRAINT companion_turns_deadline_check CHECK (
    (cold_start_deadline_at IS NULL OR cold_start_deadline_at >= created_at)
    AND (status <> 'needs_input' OR inactivity_deadline_at IS NULL)
    AND (
      status IN ('queued', 'cancelled')
        AND inactivity_deadline_at IS NULL
        AND absolute_deadline_at IS NULL
      OR status <> 'queued'
        AND absolute_deadline_at IS NOT NULL
        AND (
          inactivity_deadline_at IS NULL
          OR absolute_deadline_at >= inactivity_deadline_at
        )
    )
  );
