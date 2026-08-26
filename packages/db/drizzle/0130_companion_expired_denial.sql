-- Expiry is a fail-closed deadline: it must still prevent an allow/answer, but refusing an
-- already-expired request cannot grant authority or create a resource. A client can briefly retain
-- a pending card between the wall-clock deadline and the runtime expiry sweep; admit its explicit
-- deny so that the safe human intent wins that race instead of reflecting a raw database error.
-- Keep the generic, config, routine, and trigger decision surfaces consistent.
DO $companion_expired_denial$
DECLARE
  v_signature text;
  v_old_gate text := 'IF v_delivery.expires_at <= v_now THEN';
  v_new_gate text := 'IF p_action <> ''deny'' AND v_delivery.expires_at <= v_now THEN';
  v_old_actor_filter text := 'AND delivery.actor_id = v_actor_id';
  v_new_actor_filter text :=
    'AND (delivery.actor_id = v_actor_id OR ('
    || 'p_action = ''deny'' AND delivery.actor_id IS NULL '
    || 'AND delivery.decision_status IN (''expired'', ''cancelled'')))';
  v_old_deny_replay text :=
    '(p_action = ''deny'' AND v_delivery.decision_status = ''denied'')';
  v_new_deny_replay text :=
    '(p_action = ''deny'' AND v_delivery.decision_status '
    || 'IN (''denied'', ''expired'', ''cancelled''))';
  v_definition text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.companion_api_answer_decision(uuid,uuid,text,text,text)',
    'public.companion_api_answer_config_decision(uuid,uuid,text,text)',
    'public.companion_api_answer_routine_decision(uuid,uuid,text,text,uuid,timestamp with time zone)',
    'public.companion_api_answer_trigger_decision(uuid,uuid,text,text,uuid,text)'
  ] LOOP
    v_definition := pg_catalog.pg_get_functiondef(pg_catalog.to_regprocedure(v_signature));
    IF v_definition IS NULL THEN
      RAISE EXCEPTION 'Companion decision surface is missing: %', v_signature
        USING ERRCODE = '55000';
    END IF;
    IF (
      char_length(v_definition)
      - char_length(replace(v_definition, v_old_gate, ''))
    ) <> char_length(v_old_gate) THEN
      RAISE EXCEPTION 'Companion expiry gate did not match exactly once: %', v_signature
        USING ERRCODE = '55000';
    END IF;
    v_definition := replace(v_definition, v_old_gate, v_new_gate);
    IF (
      char_length(v_definition)
      - char_length(replace(v_definition, v_old_actor_filter, ''))
    ) <> char_length(v_old_actor_filter) THEN
      RAISE EXCEPTION 'Companion replay actor filter did not match exactly once: %', v_signature
        USING ERRCODE = '55000';
    END IF;
    v_definition := replace(v_definition, v_old_actor_filter, v_new_actor_filter);
    IF (
      char_length(v_definition)
      - char_length(replace(v_definition, v_old_deny_replay, ''))
    ) <> char_length(v_old_deny_replay) THEN
      RAISE EXCEPTION 'Companion deny replay gate did not match exactly once: %', v_signature
        USING ERRCODE = '55000';
    END IF;
    EXECUTE replace(v_definition, v_old_deny_replay, v_new_deny_replay);
  END LOOP;
END
$companion_expired_denial$;
